import { fromNodeHeaders } from 'better-auth/node'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Auth } from '../auth.js'

export interface SessionRouteDeps {
  auth: Auth
  /** 从请求解析登录用户；未登录返回 undefined。 */
  getUserId(req: FastifyRequest): Promise<string | undefined>
}

/**
 * 会话管理 API。
 *
 * **不返回 session token**——它等同于凭据，前端只拿 id 指认设备，
 * 撤销时由服务端换算成 token。listSessions 已按当前用户过滤，
 * 所以「查不到」就等于「不是你的」，不必区分 404 / 403。
 */
export async function registerSessionRoutes(
  app: FastifyInstance,
  deps: SessionRouteDeps,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('preHandler', async (req, reply) => {
      const userId = await deps.getUserId(req)
      if (userId === undefined) {
        await reply.code(401).send({ error: '未登录' })
        return
      }
    })

    scope.get('/api/sessions', async (req) => {
      const headers = fromNodeHeaders(req.headers)
      const [current, all] = await Promise.all([
        deps.auth.api.getSession({ headers }),
        deps.auth.api.listSessions({ headers }),
      ])
      const currentId = current?.session.id

      return {
        sessions: all.map((s) => ({
          id: s.id,
          ipAddress: s.ipAddress ?? null,
          userAgent: s.userAgent ?? null,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
          current: s.id === currentId,
        })),
      }
    })

    scope.delete('/api/sessions/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      const headers = fromNodeHeaders(req.headers)
      const all = await deps.auth.api.listSessions({ headers })
      const target = all.find((s) => s.id === id)
      if (target === undefined) return reply.code(404).send({ error: '会话不存在' })

      await deps.auth.api.revokeSession({ headers, body: { token: target.token } })
      return { ok: true }
    })
  })
}
