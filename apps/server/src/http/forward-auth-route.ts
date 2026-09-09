import type { FastifyInstance, FastifyRequest } from 'fastify'
import { decideForwardAuth, type ForwardAuthDeps } from './forward-auth.js'

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

/** Traefik forwardAuth 的接入点。**必须挂在控制面上**，且要覆盖页面/API/WS。 */
export function registerForwardAuth(app: FastifyInstance, deps: ForwardAuthDeps): void {
  app.get('/auth/verify', async (req: FastifyRequest, reply) => {
    const host = firstHeader(req.headers['x-forwarded-host']) ?? req.hostname
    const proto = firstHeader(req.headers['x-forwarded-proto']) ?? 'https'
    const uri = firstHeader(req.headers['x-forwarded-uri']) ?? req.url

    const result = await decideForwardAuth(
      {
        host,
        cookie: firstHeader(req.headers.cookie),
        originalUrl: `${proto}://${host}${uri}`,
      },
      deps,
    )

    if (result.status === 200) {
      for (const [k, v] of Object.entries(result.headers)) reply.header(k, v)
      // 2xx = 放行；body 无意义，别让 Traefik 把它转发给上游
      return reply.code(200).send()
    }
    if (result.status === 302) {
      return reply.code(302).header('location', result.location).send()
    }
    return reply.code(result.status).send()
  })
}
