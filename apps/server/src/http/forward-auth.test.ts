import { describe, expect, it } from 'vitest'
import {
  GATE_INSTANCE_HEADER,
  GATE_TOKEN_HEADER,
} from '@dsh-cloud/instance-spec'
import {
  decideForwardAuth,
  instanceSlugFromHost,
  type ForwardAuthDeps,
  type ForwardAuthInput,
} from './forward-auth.js'
import { gateToken } from '../instance/gate-token.js'

const BASE = 'app.example.com'
const SECRET = 'test-gate-secret'

function deps(over: Partial<ForwardAuthDeps> = {}): ForwardAuthDeps {
  return {
    baseDomain: BASE,
    publicScheme: 'https',
    gateSecret: SECRET,
    findInstanceBySlug: async (slug) =>
      slug === 'alice' ? { slug: 'alice', ownerId: 'user-alice' } : undefined,
    resolveUserId: async (cookie) => (cookie === 'sid=alice' ? 'user-alice' : undefined),
    ...over,
  }
}

function input(host: string | undefined, cookie?: string): ForwardAuthInput {
  return { host, cookie, originalUrl: `https://${host ?? 'nowhere'}/x/y?z=1` }
}

describe('instanceSlugFromHost', () => {
  it('取出单标签子域', () => {
    expect(instanceSlugFromHost('alice.app.example.com', BASE)).toBe('alice')
  })

  it('忽略端口', () => {
    expect(instanceSlugFromHost('alice.app.example.com:8443', BASE)).toBe('alice')
  })

  it('大小写不敏感', () => {
    expect(instanceSlugFromHost('ALICE.APP.EXAMPLE.COM', BASE)).toBe('alice')
  })

  it('拒绝裸基域', () => {
    expect(instanceSlugFromHost(BASE, BASE)).toBeUndefined()
  })

  it('拒绝多级子域（否则 a.b. 能绕过前缀判断）', () => {
    expect(instanceSlugFromHost('a.b.app.example.com', BASE)).toBeUndefined()
  })

  it('拒绝别的域', () => {
    expect(instanceSlugFromHost('alice.app.example.com.evil.com', BASE)).toBeUndefined()
    expect(instanceSlugFromHost('alice.evil.com', BASE)).toBeUndefined()
    expect(instanceSlugFromHost('evil-app.example.com', BASE)).toBeUndefined()
  })

  it('拒绝保留字', () => {
    expect(instanceSlugFromHost('admin.app.example.com', BASE)).toBeUndefined()
  })

  it('拒绝非法 slug 字符', () => {
    expect(instanceSlugFromHost('alice_1.app.example.com', BASE)).toBeUndefined()
  })
})

describe('decideForwardAuth', () => {
  it.each([
    'dsh_cloud.session_token=secret',
    '__Secure-dsh_cloud.session_token=secret',
    '__Host-dsh_cloud.session_token=secret',
    'dsh_cloud.session_data.0=secret; dsh_cloud.admin_session=secret',
  ])('removes platform cookies after authentication: %s', async (platformCookie) => {
    let authenticatedCookie: string | undefined
    const cookie = `${platformCookie}; dsh_session=instance-token`
    const result = await decideForwardAuth(
      input('alice.app.example.com', cookie),
      deps({ resolveUserId: async (value) => {
        authenticatedCookie = value
        return 'user-alice'
      } }),
    )
    expect(authenticatedCookie).toBe(cookie)
    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error('expected authorization')
    expect(result.headers.Cookie).toBe('dsh_session=instance-token')
  })

  it('replaces a platform-only cookie header with an empty header', async () => {
    const result = await decideForwardAuth(
      input('alice.app.example.com', 'dsh_cloud.session_token=secret'),
      deps({ resolveUserId: async () => 'user-alice' }),
    )
    if (result.status !== 200) throw new Error('expected authorization')
    expect(result.headers.Cookie).toBe('')
  })

  it('未知实例 → 404', async () => {
    expect(await decideForwardAuth(input('bob.app.example.com'), deps())).toEqual({
      status: 404,
    })
  })

  it('非实例域 → 404', async () => {
    expect(await decideForwardAuth(input('app.example.com'), deps())).toEqual({
      status: 404,
    })
  })

  it('未登录 → 302 回基域登录页，且带上原始地址', async () => {
    const r = await decideForwardAuth(input('alice.app.example.com'), deps())
    expect(r.status).toBe(302)
    if (r.status !== 302) return
    // 只能跳基域：不能把 Host 拼进 location（开放重定向）
    expect(r.location.startsWith(`https://${BASE}/login?next=`)).toBe(true)
    expect(r.location).toContain(encodeURIComponent('https://alice.app.example.com/x/y?z=1'))
  })

  it('回跳 scheme 跟随 publicScheme（本地 http 开发时不指向 https）', async () => {
    const r = await decideForwardAuth(
      input('alice.app.example.com'),
      deps({ publicScheme: 'http' }),
    )
    if (r.status !== 302) throw new Error('expected 302')
    expect(r.location.startsWith(`http://${BASE}/login`)).toBe(true)
  })

  it('登录了但不是 owner → 403（授权，不只是认证）', async () => {
    const r = await decideForwardAuth(
      input('alice.app.example.com', 'sid=alice'),
      deps({ resolveUserId: async () => 'user-bob' }),
    )
    expect(r).toEqual({ status: 403 })
  })

  it('owner → 200 并注入桥要的两个 header', async () => {
    const r = await decideForwardAuth(input('alice.app.example.com', 'sid=alice'), deps())
    expect(r.status).toBe(200)
    if (r.status !== 200) return
    expect(r.headers[GATE_INSTANCE_HEADER]).toBe('alice')
    expect(r.headers[GATE_TOKEN_HEADER]).toBe(gateToken('alice', SECRET))
  })

  it('header token 由 slug 派生，换实例就不同', async () => {
    const r = await decideForwardAuth(
      input('alice.app.example.com', 'sid=alice'),
      deps({ findInstanceBySlug: async () => ({ slug: 'alice', ownerId: 'user-alice' }) }),
    )
    if (r.status !== 200) throw new Error('expected 200')
    expect(r.headers[GATE_TOKEN_HEADER]).not.toBe(gateToken('bob', SECRET))
  })
})
