/**
 * 容器注册表（当前是 GHCR）的只读客户端（D23）：列出 tag、取每个 tag 的 manifest digest。
 *
 * 只做「读」。公开包匿名即可——但**仍要走 token 换取**（`/token?scope=...`），
 * 不是裸 GET；私有包则配 `INSTANCE_IMAGE_REGISTRY_USER` + `..._TOKEN` 走 Basic。
 * `fetch` 由外部注入，便于单测。
 */

/** OCI / Docker 的 manifest 媒体类型——少给一个，注册表可能答 404 或 406。 */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',')

const DEFAULT_TIMEOUT_MS = 10_000

/** Docker tag 的合法形状（长度与字符集），防止把路径/查询串拼进 URL。 */
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/

export interface RegistryRepo {
  registry: string
  namespace: string
  name: string
}

/** `ghcr.io/eskim2001/dsh-instance` → `{registry, namespace, name}`。 */
export function parseImageRepo(repo: string): RegistryRepo {
  const slash = repo.indexOf('/')
  if (slash <= 0) {
    throw new Error(`镜像仓库名不合法（期望 host/namespace/name）：${repo}`)
  }
  const registry = repo.slice(0, slash)
  const rest = repo.slice(slash + 1)
  const lastSlash = rest.lastIndexOf('/')
  const namespace = lastSlash > 0 ? rest.slice(0, lastSlash) : rest
  const name = lastSlash > 0 ? rest.slice(lastSlash + 1) : ''
  if (name === '') {
    throw new Error(`镜像仓库名不合法（缺镜像名）：${repo}`)
  }
  return { registry, namespace, name }
}

export interface RegistryClient {
  /** 仓库里的全部 tag（未排序；调用方自己过滤/排序）。 */
  listTags(): Promise<string[]>
  /** 某个 tag 的 manifest digest，形如 `sha256:…`。 */
  tagDigest(tag: string): Promise<string>
}

export interface RegistryClientOptions {
  repo: string
  fetch: typeof globalThis.fetch
  user?: string
  token?: string
  timeoutMs?: number
}

export function createRegistryClient(opts: RegistryClientOptions): RegistryClient {
  const { registry, namespace, name } = parseImageRepo(opts.repo)
  const base = `https://${registry}/v2/${namespace}/${name}`
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // token 换取是额外一跳，同步一次要取 N+1 次；按 expires_in 缓存，别每次都换。
  let cached: { token: string; expiresAt: number } | undefined

  async function pullToken(): Promise<string> {
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.token

    const url = `https://${registry}/token?service=${registry}&scope=repository:${namespace}/${name}:pull`
    const headers: Record<string, string> = {}
    if (opts.user !== undefined && opts.token !== undefined) {
      headers.authorization = `Basic ${Buffer.from(`${opts.user}:${opts.token}`).toString('base64')}`
    }
    const res = await opts.fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) {
      throw new Error(`拿不到 ${registry} 的拉取凭据（HTTP ${res.status}）`)
    }
    const body = (await res.json()) as { token?: string; access_token?: string; expires_in?: number }
    const token = body.token ?? body.access_token
    if (token === undefined || token === '') {
      throw new Error(`${registry} 没有返回拉取凭据`)
    }
    const ttlSec = Math.max(60, Math.min(body.expires_in ?? 300, 3600))
    cached = { token, expiresAt: Date.now() + ttlSec * 1000 }
    return token
  }

  return {
    async listTags(): Promise<string[]> {
      const token = await pullToken()
      const res = await opts.fetch(`${base}/tags/list`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`列 tag 失败（HTTP ${res.status}）`)
      const body = (await res.json()) as { tags?: string[] | null }
      return body.tags ?? []
    },

    async tagDigest(tag: string): Promise<string> {
      if (!TAG.test(tag)) throw new Error(`tag 不合法：${tag}`)
      const token = await pullToken()
      const res = await opts.fetch(`${base}/manifests/${encodeURIComponent(tag)}`, {
        method: 'HEAD',
        headers: { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`读 ${tag} 的 digest 失败（HTTP ${res.status}）`)
      const digest = res.headers.get('docker-content-digest')
      if (digest === null || digest === '') throw new Error(`${tag} 没有返回 digest`)
      return digest
    },
  }
}
