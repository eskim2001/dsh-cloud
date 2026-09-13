import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerSetupRoutes, type SetupDeps } from './setup-routes.js'

/**
 * 引导态的 setup 端点：**平台在配好域名之前唯一对公网开着的写口**。
 *
 * 盯四件事：token 是硬门（错就拒、没配就谁也别想配）、域名形状、DNS 只警告不拦、
 * 以及「重启必须在响应刷完之后」—— 顺序倒了浏览器那边会看到提交失败。
 */
describe('setup 端点', () => {
  let app: FastifyInstance
  const saved: Array<{ baseDomain: string; consoleDomain: string }> = []
  let restarts = 0

  const deps = (over: Partial<SetupDeps> = {}): SetupDeps => ({
    configured: false,
    token: 'tok',
    saveDomains: async (domains) => {
      saved.push(domains)
    },
    restart: () => {
      restarts++
    },
    resolveSubdomain: async () => ['203.0.113.7'],
    ...over,
  })

  beforeEach(() => {
    saved.length = 0
    restarts = 0
  })

  async function build(over: Partial<SetupDeps> = {}): Promise<FastifyInstance> {
    const instance = Fastify()
    registerSetupRoutes(instance, deps(over))
    await instance.ready()
    return instance
  }

  afterEach(async () => {
    await app?.close()
  })

  it('state：引导态回 false，已配置回 true（控制台靠它决定显示哪套界面）', async () => {
    app = await build()
    expect((await app.inject({ method: 'GET', url: '/api/setup/state' })).json()).toEqual({
      configured: false,
    })
    await app.close()

    app = await build({ configured: true })
    expect((await app.inject({ method: 'GET', url: '/api/setup/state' })).json()).toEqual({
      configured: true,
    })
  })

  it('token 不对 → 401，且**什么都没写**', async () => {
    app = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: 'wrong', baseDomain: 'example.com' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid-token' })
    expect(saved).toEqual([])
    expect(restarts).toBe(0)
  })

  it('没配 token（空串）→ 一样拒：别让「没开 setup」变成「谁都能配」', async () => {
    app = await build({ token: '' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: '', baseDomain: 'example.com' },
    })
    expect(res.statusCode).toBe(401)
    expect(saved).toEqual([])
  })

  it('已配置 → 409，不再接受改域名', async () => {
    app = await build({ configured: true })
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: 'tok', baseDomain: 'example.com' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'already-configured' })
    expect(saved).toEqual([])
  })

  it('域名形状不对 → 400（没有点、大写、带路径都拒）', async () => {
    app = await build()
    for (const baseDomain of ['localhost', 'Example.com', 'example.com/evil', '']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { token: 'tok', baseDomain },
      })
      expect(res.statusCode, baseDomain).toBe(400)
      expect(res.json().error, baseDomain).toBe('invalid-domain')
    }
    expect(saved).toEqual([])
  })

  it('通过：算出 console.<父域>、落库、并安排重启', async () => {
    app = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: 'tok', baseDomain: 'example.com' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().consoleDomain).toBe('console.example.com')
    // 回结构化结果（不是一句中文）：文案归双语的 UI 组
    expect(res.json().dns).toEqual({ probe: expect.stringContaining('.example.com'), resolved: true })
    expect(saved).toEqual([{ baseDomain: 'example.com', consoleDomain: 'console.example.com' }])

    // 重启挂在响应的 finish 上 —— 注入的响应跑完，回调应当已经触发
    await new Promise((r) => setTimeout(r, 10))
    expect(restarts).toBe(1)
  })

  it('泛解析查不到 → **只警告不拦**（解析可能是反代 / 生效中，平台判不了）', async () => {
    app = await build({ resolveSubdomain: async () => [] })
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: 'tok', baseDomain: 'example.com' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().dns.resolved).toBe(false)
    // 只回事实、不拦：域名照样落库 —— 否则操作者会被卡在一个他无法从面板里修的状态
    expect(saved).toHaveLength(1)
  })
})
