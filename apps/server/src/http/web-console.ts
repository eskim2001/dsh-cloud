import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import { existsSync } from 'node:fs'

/**
 * 同源提供管理台静态文件。
 *
 * **只有平台镜像会调它** —— 本地开发走 Vite dev server，`WEB_DIST_DIR` 留空，
 * 这条路径根本不注册。
 *
 * 管理台用 BrowserRouter，所以深链接（`/instances/<id>`）刷新时必须回落
 * `index.html`，否则用户拿到的是 404 而不是页面。
 */
export async function registerWebConsole(app: FastifyInstance, root: string): Promise<void> {
  if (!existsSync(root)) {
    throw new Error(`WEB_DIST_DIR 指向的目录不存在：${root}（平台镜像里应该是 /app/web）`)
  }

  // 用默认的 wildcard 路由（`/*`）：它只在文件**真的存在**时接管，找不到就走
  // `callNotFound()` → 下面的 notFoundHandler。别关掉它——关了之后静态资源也没人管了。
  // 具体路由（`/api/*`、`/healthz`）比 `/*` 更短，路由优先级上本来就赢。
  await app.register(fastifyStatic, { root, index: ['index.html'] })

  app.setNotFoundHandler((request, reply) => {
    // 认不出的是接口就还是 404 —— 把接口的 404 换成一张 HTML，调用方拿到的是
    // 「解析 JSON 失败」而不是「404」，排查方向直接跑偏。
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send({ error: 'Not found' })
    }

    const path = (request.raw.url ?? '/').split('?')[0] ?? '/'
    if (path === '/healthz' || /^\/(api|auth|\.well-known)(\/|$)/.test(path)) {
      return reply.code(404).send({ error: 'Not found' })
    }

    return reply.sendFile('index.html')
  })
}
