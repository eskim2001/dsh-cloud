import { describe, expect, it, vi } from 'vitest'
import { createRegistryClient, parseImageRepo } from './registry.js'

const REPO = 'ghcr.io/eskim2001/dsh-instance'

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

/** 记录每次请求，按顺序给出预设响应。 */
function fakeFetch(responses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init === undefined ? {} : { init }) })
    const next = responses.shift()
    if (next === undefined) throw new Error(`没有预设的第 ${calls.length} 个响应：${String(url)}`)
    return next
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

describe('parseImageRepo', () => {
  it('拆出 host / namespace / name', () => {
    expect(parseImageRepo(REPO)).toEqual({
      registry: 'ghcr.io',
      namespace: 'eskim2001',
      name: 'dsh-instance',
    })
  })

  it('没有 `/` → 抛（`INSTANCE_IMAGE_REPO` 写错了要在启动时就炸）', () => {
    expect(() => parseImageRepo('dsh-instance')).toThrow(/不合法/)
  })

  it('只有 namespace 没有镜像名 → 抛', () => {
    expect(() => parseImageRepo('ghcr.io/eskim2001/')).toThrow(/缺镜像名/)
  })
})

describe('注册表客户端', () => {
  it('先换 token 再列 tag；token 按 expires_in 缓存，第二次不再换', async () => {
    const { fetch, calls } = fakeFetch([
      json({ token: 'tok-1', expires_in: 300 }),
      json({ tags: ['0.1.2-rc.1_2', 'latest'] }),
      json({ tags: ['0.1.2-rc.1_2'] }),
    ])
    const client = createRegistryClient({ repo: REPO, fetch })

    expect(await client.listTags()).toEqual(['0.1.2-rc.1_2', 'latest'])
    expect(await client.listTags()).toEqual(['0.1.2-rc.1_2'])

    // 1 次换 token + 2 次列 tag
    expect(calls).toHaveLength(3)
    expect(calls[0]?.url).toBe(
      'https://ghcr.io/token?service=ghcr.io&scope=repository:eskim2001/dsh-instance:pull',
    )
    expect(calls[1]?.url).toBe('https://ghcr.io/v2/eskim2001/dsh-instance/tags/list')
    expect(calls[1]?.init?.headers).toMatchObject({ authorization: 'Bearer tok-1' })
  })

  it('tags 为 null → 空数组（GHCR 对空仓库就这么回）', async () => {
    const { fetch } = fakeFetch([json({ token: 'tok' }), json({ tags: null })])
    expect(await createRegistryClient({ repo: REPO, fetch }).listTags()).toEqual([])
  })

  it('取 digest 用 HEAD，并带上全部 manifest 媒体类型', async () => {
    const { fetch, calls } = fakeFetch([
      json({ token: 'tok' }),
      new Response(null, {
        status: 200,
        headers: { 'docker-content-digest': 'sha256:abc' },
      }),
    ])
    const client = createRegistryClient({ repo: REPO, fetch })

    expect(await client.tagDigest('0.1.2-rc.1_2')).toBe('sha256:abc')
    const head = calls[1]
    expect(head?.init?.method).toBe('HEAD')
    expect(head?.url).toBe('https://ghcr.io/v2/eskim2001/dsh-instance/manifests/0.1.2-rc.1_2')
    const accept = (head?.init?.headers as Record<string, string> | undefined)?.['accept'] ?? ''
    // 少给一种，注册表可能答 404 或 406
    expect(accept).toContain('application/vnd.oci.image.index.v1+json')
    expect(accept).toContain('application/vnd.docker.distribution.manifest.v2+json')
  })

  it('配了 user + token 才发 Basic 头（只配一半就当匿名）', async () => {
    const withCreds = fakeFetch([json({ token: 'tok' }), json({ tags: [] })])
    await createRegistryClient({
      repo: REPO,
      fetch: withCreds.fetch,
      user: 'eskim2001',
      token: 'ghp_x',
    }).listTags()
    expect(withCreds.calls[0]?.init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from('eskim2001:ghp_x').toString('base64')}`,
    })

    const half = fakeFetch([json({ token: 'tok' }), json({ tags: [] })])
    await createRegistryClient({ repo: REPO, fetch: half.fetch, user: 'eskim2001' }).listTags()
    expect(half.calls[0]?.init?.headers).not.toHaveProperty('authorization')
  })

  it('换 token 失败 → 抛，带上 HTTP 状态（别静默当空仓库）', async () => {
    const { fetch } = fakeFetch([new Response('denied', { status: 401 })])
    await expect(createRegistryClient({ repo: REPO, fetch }).listTags()).rejects.toThrow(/401/)
  })

  it('tag 形状不合法 → 在发请求之前就抛（防路径/查询串注入）', async () => {
    const { fetch, calls } = fakeFetch([])
    const client = createRegistryClient({ repo: REPO, fetch })
    await expect(client.tagDigest('../../evil')).rejects.toThrow(/tag 不合法/)
    await expect(client.tagDigest('a?b=c')).rejects.toThrow(/tag 不合法/)
    expect(calls).toHaveLength(0)
  })

  it('HEAD 没有 digest 头 → 抛（不能把「读不到」当成某个值）', async () => {
    const { fetch } = fakeFetch([json({ token: 'tok' }), new Response(null, { status: 200 })])
    await expect(
      createRegistryClient({ repo: REPO, fetch }).tagDigest('0.1.2-rc.1_2'),
    ).rejects.toThrow(/没有返回 digest/)
  })
})
