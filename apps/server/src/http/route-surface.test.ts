import { describe, expect, it } from 'vitest'
import { buildApp, type AppDeps } from '../app.js'

/**
 * 注册面清单（铁律 6）。
 *
 * 认证是**逐条 router 显式挂的**，漏挂不报错、不告警——它只表现为「照常 200」。
 * 所以「新增一个 GET 路由」必须是一次人工决定：加进这份清单，顺带想清楚
 * 「谁认证它、谁授权它」。有副作用的 GET（SSE 之类）尤其要在这里交代清楚。
 */
const ALLOWED_GET_ROUTES = [
  'GET /auth/verify', // 入口调它判定数据面（Traefik forward-auth）
  'GET /api/auth/*', // better-auth 自己的端点（登录 / 登出 / 会话）
  'GET /healthz', // 存活探针，无数据
  'GET /api/sessions', // 自己的会话列表
  // 实例面：全部带 owner 维度
  'GET /api/instances',
  'GET /api/images', // 建实例可选的已发布版本，登录即可
  'GET /api/instances/:id',
  'GET /api/instances/:id/stats',
  'GET /api/instances/:id/metrics',
  'GET /api/instances/:id/image',
  'GET /api/instances/:id/logs',
  // 管理面：全部要 admin
  'GET /api/admin/users',
  'GET /api/admin/instances',
  'GET /api/admin/instances/:id/image',
  'GET /api/admin/instances/:id/logs',
  'GET /api/admin/images',
  // 有副作用的 GET：EventSource 只能 GET，起 docker pull 的那一下靠 admin 鉴权兜底
  'GET /api/admin/images/pull',
]

function dependencies(onRoute: AppDeps['onRoute']): AppDeps {
  return {
    env: {
      BASE_DOMAIN: 'app.example.com',
      CONSOLE_DOMAIN: 'console.app.example.com',
      PUBLIC_SCHEME: 'https',
      PLATFORM_SECRET: 'test-platform-secret',
      EXTRA_TRUSTED_ORIGINS: '',
      INSTANCE_IMAGE_REPO: 'ghcr.io/example/dsh-instance',
      INSTANCE_IMAGE_REGISTRY_USER: '',
      INSTANCE_IMAGE_REGISTRY_TOKEN: '',
    },
    auth: {
      handler: async () => new Response('{}'),
      api: { getSession: async () => null },
    },
    db: {},
    provisioner: {},
    orchestrator: {},
    storage: {},
    onRoute,
  } as unknown as AppDeps
}

async function collect(): Promise<Array<{ method: string; url: string }>> {
  const routes: Array<{ method: string; url: string }> = []
  const app = await buildApp(
    dependencies((route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      for (const method of methods) {
        // HEAD 是 Fastify 给每条 GET 自动挂的，不是独立的路由面
        if (method !== 'HEAD') routes.push({ method, url: route.url })
      }
    }),
  )
  await app.ready()
  await app.close()
  return routes
}

describe('注册面：GET 必须逐一交代清楚', () => {
  it('实际注册的 GET 路由与白名单完全一致', async () => {
    const actual = (await collect())
      .filter((r) => r.method === 'GET')
      .map((r) => `${r.method} ${r.url}`)
      .sort()
    expect(actual).toEqual([...ALLOWED_GET_ROUTES].sort())
  })

  it('写操作只用 POST / PATCH / DELETE（没有把副作用藏在别的动词里）', async () => {
    const methods = new Set((await collect()).map((r) => r.method))
    expect([...methods].sort()).toEqual(['DELETE', 'GET', 'PATCH', 'POST'])
  })
})
