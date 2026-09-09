import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../env.js'
import { ImageRejectedError, NoRollbackError, ShrinkBelowUsageError } from '../instance/provisioner.js'
import { registerAdminRoutes, type AdminRouteDeps } from './admin-routes.js'

const env = { MAX_INSTANCES_PER_USER: 3, INSTANCE_IMAGE: 'dsh-instance:0.1.0' } as Env

const ADMIN = { id: 'admin-1', role: 'admin' }
const USER = { id: 'user-1', role: 'user' }

/**
 * 管理面**全部**路由。新增一条就要加到这里——下面会拿它和 Fastify 实际
 * 注册的路由做集合比对，对不上就红。这是「漏挂一条路由不会报错，只有洞」
 * 的机械化防线：手写清单会跟着人一起忘，集合比对不会。
 */
const EXPECTED_ROUTES = [
  { method: 'GET', url: '/api/admin/users' },
  { method: 'GET', url: '/api/admin/instances' },
  { method: 'POST', url: '/api/admin/users/:id/ban' },
  { method: 'POST', url: '/api/admin/users/:id/unban' },
  { method: 'PATCH', url: '/api/admin/users/:id/quota' },
  { method: 'PATCH', url: '/api/admin/instances/:id/quota' },
  { method: 'GET', url: '/api/admin/instances/:id/image' },
  { method: 'PATCH', url: '/api/admin/instances/:id/image' },
  { method: 'POST', url: '/api/admin/instances/:id/image/rollback' },
  { method: 'GET', url: '/api/admin/instances/:id/logs' },
]

const ATTACKS = EXPECTED_ROUTES.map((r) => ({ ...r, url: r.url.replace(':id', 'user-1') }))

interface CollectedRoute {
  method: string
  url: string
}

/**
 * 打一条请求。`route.method` 是 onRoute 收上来的 string，而 inject 只收字面量联合
 * （fastify 自己的 HTTPMethods 比它宽一个 'search'，两边对不上），这里做一次类型收口。
 * 运行时传的就是原始字符串，没有改动。
 */
const call = (app: FastifyInstance, route: CollectedRoute) =>
  app.inject({ method: route.method as 'GET', url: route.url, payload: {} })

async function build(
  session: { id: string; role: string } | undefined,
  over: Partial<AdminRouteDeps> = {},
) {
  const app = Fastify()
  const routes: CollectedRoute[] = []
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    // Fastify 给每个 GET 自动配一个 HEAD，它和 GET 共用 handler 和钩子，不用单测
    for (const method of methods) {
      if (method !== 'HEAD') routes.push({ method, url: route.url })
    }
  })
  await registerAdminRoutes(app, {
    env,
    listUsers: async () => [],
    listInstances: async () => [],
    // 单测里没有 Docker：默认让它失败，路由回退到 DB 快照
    listContainerStates: async () => {
      throw new Error('单测没有 Docker')
    },
    ban: async () => true,
    unban: async () => true,
    setQuota: async () => true,
    setInstanceQuota: async () => true,
    findInstanceContainer: async () => null,
    findInstanceImage: async () => ({ storageKey: 'alice', image: 'dsh-instance:0.1.0', previousImage: null }),
    listLocalImages: async () => [],
    readSnapshot: async () => undefined,
    setInstanceImage: async () => true,
    rollbackInstanceImage: async () => true,
    streamLogs: async () => {},
    getSessionUser: async () => session,
    ...over,
  })
  return { app, routes }
}

describe('平台管理面：注册面 = 测试面', () => {
  it('实际注册的路由集合与清单一致', async () => {
    const { routes } = await build(ADMIN)
    const actual = routes.map((r) => `${r.method} ${r.url}`).sort()
    const expected = EXPECTED_ROUTES.map((r) => `${r.method} ${r.url}`).sort()
    expect(actual).toEqual(expected)
  })
})

describe('平台管理面：每条路由都必须过 admin 钩子', () => {
  it('未登录 → 401', async () => {
    const { app, routes } = await build(undefined)
    for (const route of routes) {
      const res = await call(app, route)
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401)
    }
  })

  it('登录了但不是管理员 → 403', async () => {
    const { app, routes } = await build(USER)
    for (const route of routes) {
      const res = await call(app, route)
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(403)
    }
  })

  it('非管理员触发的动作不会落到回调上', async () => {
    const ban = vi.fn(async () => true)
    const setQuota = vi.fn(async () => true)
    const setInstanceQuota = vi.fn(async () => true)
    const setInstanceImage = vi.fn(async () => true)
    const rollbackInstanceImage = vi.fn(async () => true)
    const { app } = await build(USER, {
      ban,
      setQuota,
      setInstanceQuota,
      setInstanceImage,
      rollbackInstanceImage,
    })
    for (const route of ATTACKS) {
      await call(app, route)
    }
    expect(ban).not.toHaveBeenCalled()
    expect(setQuota).not.toHaveBeenCalled()
    expect(setInstanceQuota).not.toHaveBeenCalled()
    expect(setInstanceImage).not.toHaveBeenCalled()
    expect(rollbackInstanceImage).not.toHaveBeenCalled()
  })
})

describe('平台管理面：管理员路径', () => {
  it('用户列表带平台默认上限', async () => {
    const { app } = await build(ADMIN)
    const res = await app.inject({ method: 'GET', url: '/api/admin/users' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ users: [], maxInstancesPerUser: 3 })
  })

  it('不能封禁自己', async () => {
    const { app } = await build(ADMIN)
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${ADMIN.id}/ban`,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('封禁把原因透传给回调（回调负责顺带踢会话）', async () => {
    const ban = vi.fn(async () => true)
    const { app } = await build(ADMIN, { ban })
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users/u-x/ban',
      payload: { reason: '刷接口' },
    })
    expect(res.statusCode).toBe(200)
    expect(ban).toHaveBeenCalledWith('u-x', '刷接口')
  })

  it('封禁不带原因 → null', async () => {
    const ban = vi.fn(async () => true)
    const { app } = await build(ADMIN, { ban })
    await app.inject({ method: 'POST', url: '/api/admin/users/u-x/ban', payload: {} })
    expect(ban).toHaveBeenCalledWith('u-x', null)
  })

  it('目标用户不存在 → 404', async () => {
    const { app } = await build(ADMIN, { ban: async () => false })
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users/nobody/ban',
      payload: {},
    })
    expect(res.statusCode).toBe(404)
  })

  it('配额越界 / 非整数 → 400', async () => {
    const { app } = await build(ADMIN)
    for (const quota of [999, -1, 1.5]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/users/u-x/quota',
        payload: { quota },
      })
      expect(res.statusCode, `quota=${quota}`).toBe(400)
    }
  })

  it('配额可清空为 null（回落到平台默认）', async () => {
    const setQuota = vi.fn(async () => true)
    const { app } = await build(ADMIN, { setQuota })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/users/u-x/quota',
      payload: { quota: null },
    })
    expect(res.statusCode).toBe(200)
    expect(setQuota).toHaveBeenCalledWith('u-x', null)
  })

  it('改实例配额：越界 / 非整数 → 400，不动回调', async () => {
    const setInstanceQuota = vi.fn(async () => true)
    const { app } = await build(ADMIN, { setInstanceQuota })
    const bad = [
      { cpus: 0, memoryMb: 2048, pidsLimit: 512, diskMb: 10_240 },
      { cpus: 1, memoryMb: 1.5, pidsLimit: 512, diskMb: 10_240 },
      { cpus: 1, memoryMb: 2048, pidsLimit: 99_999, diskMb: 10_240 },
      { cpus: 1, memoryMb: 2048, pidsLimit: 512, diskMb: 64 }, // 磁盘太小
      { cpus: 1, memoryMb: 2048 }, // 缺字段
    ]
    for (const payload of bad) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/instances/i-x/quota',
        payload,
      })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(setInstanceQuota).not.toHaveBeenCalled()
  })

  it('改实例配额：实例不存在 → 404', async () => {
    const { app } = await build(ADMIN, { setInstanceQuota: async () => false })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/instances/nope/quota',
      payload: { cpus: 2, memoryMb: 4096, pidsLimit: 512, diskMb: 10_240 },
    })
    expect(res.statusCode).toBe(404)
  })

  it('改实例配额：四元组原样透传给回调', async () => {
    const setInstanceQuota = vi.fn(async () => true)
    const { app } = await build(ADMIN, { setInstanceQuota })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/instances/i-x/quota',
      payload: { cpus: 4, memoryMb: 8192, pidsLimit: 1024, diskMb: 20_480 },
    })
    expect(res.statusCode).toBe(200)
    expect(setInstanceQuota).toHaveBeenCalledWith('i-x', {
      cpus: 4,
      memoryMb: 8192,
      pidsLimit: 1024,
      diskMb: 20_480,
    })
  })

  it('缩容缩不动 → 400 + 服务端文案（不是 500，也不是笼统的「操作失败」）', async () => {
    const { app } = await build(ADMIN, {
      setInstanceQuota: async () => {
        throw new ShrinkBelowUsageError(5_000, 1_024)
      },
    })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/instances/i-x/quota',
      payload: { cpus: 1, memoryMb: 2048, pidsLimit: 512, diskMb: 1_024 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('已用 5000 MB')
  })

  it('看日志：实例不存在 → 404，还没容器 → 409', async () => {
    const { app } = await build(ADMIN, { findInstanceContainer: async () => undefined })
    const missing = await app.inject({ method: 'GET', url: '/api/admin/instances/nope/logs' })
    expect(missing.statusCode).toBe(404)

    const { app: noContainer } = await build(ADMIN, { findInstanceContainer: async () => null })
    const empty = await noContainer.inject({ method: 'GET', url: '/api/admin/instances/i-x/logs' })
    expect(empty.statusCode).toBe(409)
  })

  it('看版本：管理员拿到本地全部**平台**镜像（不受稳定版白名单限制，但别人的镜像不列）', async () => {
    const { app } = await build(ADMIN, {
      findInstanceImage: async () => ({
        storageKey: 'alice',
        image: 'dsh-instance:0.1.0',
        previousImage: 'dsh-instance:0.0.9',
      }),
      listLocalImages: async () => ['dsh-instance:0.1.1', 'dsh-instance:0.1.0', 'alpine:3.20'],
      readSnapshot: async () => 128,
    })

    const res = await app.inject({ method: 'GET', url: '/api/admin/instances/i-x/image' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      image: 'dsh-instance:0.1.0',
      previousImage: 'dsh-instance:0.0.9',
      // alpine 换不上去（准入按仓库拒），所以根本不该出现在选择列表里
      local: ['dsh-instance:0.1.1', 'dsh-instance:0.1.0'],
      snapshotMb: 128,
    })
  })

  it('看版本：实例不存在 → 404', async () => {
    const { app } = await build(ADMIN, { findInstanceImage: async () => undefined })
    const res = await app.inject({ method: 'GET', url: '/api/admin/instances/nope/image' })
    expect(res.statusCode).toBe(404)
  })

  it('换镜像：透传目标版本', async () => {
    const setInstanceImage = vi.fn(async () => true)
    const { app } = await build(ADMIN, { setInstanceImage })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/instances/i-x/image',
      payload: { image: 'dsh-instance:0.1.1' },
    })
    expect(res.statusCode).toBe(200)
    expect(setInstanceImage).toHaveBeenCalledWith('i-x', 'dsh-instance:0.1.1')
  })

  it('换镜像：实例不存在 → 404，镜像被拒 → 400 带原话', async () => {
    const { app } = await build(ADMIN, { setInstanceImage: async () => false })
    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/admin/instances/nope/image',
      payload: { image: 'dsh-instance:0.1.1' },
    })
    expect(missing.statusCode).toBe(404)

    const { app: rejected } = await build(ADMIN, {
      setInstanceImage: async () => {
        throw new ImageRejectedError('宿主上没有镜像 dsh-instance:9.9.9')
      },
    })
    const bad = await rejected.inject({
      method: 'PATCH',
      url: '/api/admin/instances/i-x/image',
      payload: { image: 'dsh-instance:9.9.9' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toContain('宿主上没有镜像')
  })

  it('回滚：没有快照 → 400', async () => {
    const { app } = await build(ADMIN, {
      rollbackInstanceImage: async () => {
        throw new NoRollbackError()
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/instances/i-x/image/rollback',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('没有可回滚')
  })
})
