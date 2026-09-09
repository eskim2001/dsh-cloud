import { fromNodeHeaders } from 'better-auth/node'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import type { Auth } from './auth.js'
import type { Db } from './db/client.js'
import { findInstanceBySlug, listInstancesByOwner, findInstanceById } from './db/instance-repo.js'
import { listRecentMetrics } from './db/metric-repo.js'
import {
  listInstancesWithOwner,
  listUsersWithInstanceCount,
  revokeUserSessions,
  setUserBanned,
  setUserQuota,
} from './db/user-repo.js'
import { trustedOrigins, type Env } from './env.js'
import { registerAdminRoutes } from './http/admin-routes.js'
import { registerForwardAuth } from './http/forward-auth-route.js'
import { registerSessionRoutes } from './http/session-routes.js'
import { registerInstanceRoutes } from './http/instance-routes.js'
import { streamContainerLogs } from './http/log-stream.js'
import type { HostStorage } from './instance/host-storage.js'
import type { InstanceOrchestrator } from './instance/orchestrator.js'
import type { InstanceProvisioner } from './instance/provisioner.js'

export interface AppDeps {
  env: Env
  db: Db
  auth: Auth
  provisioner: InstanceProvisioner
  /** 直接读容器的地方（用量快照、日志流）走它。 */
  orchestrator: InstanceOrchestrator
  /** 实例数据在宿主上的存储（读用量）。 */
  storage: HostStorage
  logger?: boolean
}

interface SessionUser {
  id: string
  role: string
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    // Traefik 在前面：X-Forwarded-* 是可信的，登录回跳和 cookie 都靠它
    trustProxy: true,
  })
  await app.register(cookie)

  const allowedOrigins = new Set(trustedOrigins(deps.env))
  app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
    if (request.headers.origin === undefined || !allowedOrigins.has(request.headers.origin)) {
      return reply.code(403).send({ error: 'Untrusted request origin' })
    }
  })

  const sessionUser = async (headers: FastifyRequest['headers']): Promise<SessionUser | undefined> => {
    const session = await deps.auth.api.getSession({ headers: fromNodeHeaders(headers) })
    return session == null || session.session.impersonatedBy != null
      ? undefined
      : { id: session.user.id, role: session.user.role ?? 'user' }
  }

  // 日志流：实例面和管理面共用同一条实现（鉴权各自在路由层完成）
  const streamLogs = (
    req: FastifyRequest,
    reply: Parameters<typeof streamContainerLogs>[1],
    containerId: string,
    opts: { tail: number },
  ) =>
    streamContainerLogs(
      req,
      reply,
      containerId,
      opts,
      (id, o) => deps.orchestrator.logs(id, o),
      (raw, out, err) => deps.orchestrator.demuxStream(raw, out, err),
    )

  // ① forward-auth：数据面的门（D8 ②）
  registerForwardAuth(app, {
    baseDomain: deps.env.BASE_DOMAIN,
    publicScheme: deps.env.PUBLIC_SCHEME,
    gateSecret: deps.env.PLATFORM_SECRET,
    findInstanceBySlug: (slug) => findInstanceBySlug(deps.db, slug),
    resolveUserId: (cookieHeader) =>
      cookieHeader === undefined
        ? Promise.resolve(undefined)
        : sessionUser({ cookie: cookieHeader }).then((u) => u?.id),
  })

  // ② 认证端点（better-auth 自己处理登录/登出/会话）
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      const url = new URL(request.url, `${deps.env.PUBLIC_SCHEME}://${request.headers.host}`)
      if (decodeURIComponent(url.pathname).startsWith('/api/auth/admin/')) {
        return reply.code(403).send({ error: 'Platform account administration is not exposed here' })
      }
      const headers = fromNodeHeaders(request.headers)
      const init: RequestInit = { method: request.method, headers }
      if (request.body !== undefined && request.method !== 'GET') {
        init.body = JSON.stringify(request.body)
      }
      const response = await deps.auth.handler(new Request(url, init))
      reply.status(response.status)
      response.headers.forEach((value, key) => reply.header(key, value))
      return reply.send(response.body === null ? null : await response.text())
    },
  })

  // ③ 管理台 API
  await registerInstanceRoutes(app, {
    env: deps.env,
    provisioner: deps.provisioner,
    listMine: (ownerId) => listInstancesByOwner(deps.db, ownerId),
    getById: (id) => findInstanceById(deps.db, id),
    listContainerStates: () => deps.orchestrator.listContainerStates(),
    readStats: (containerId) => deps.orchestrator.stats(containerId),
    readDisk: (slug, quotaMb) => deps.storage.usage(slug, quotaMb),
    listMetrics: (instanceId, limit) => listRecentMetrics(deps.db, instanceId, limit),
    listLocalImages: () => deps.orchestrator.listImageTags(),
    readSnapshot: (slug) => deps.storage.snapshotUsage(slug),
    streamLogs,
    getUserId: (req) => sessionUser(req.headers).then((u) => u?.id),
  })

  // ④ 会话管理
  await registerSessionRoutes(app, {
    auth: deps.auth,
    getUserId: (req) => sessionUser(req.headers).then((u) => u?.id),
  })

  // ⑤ 平台管理面（仅 admin）
  await registerAdminRoutes(app, {
    env: deps.env,
    listUsers: () => listUsersWithInstanceCount(deps.db),
    listInstances: () => listInstancesWithOwner(deps.db),
    listContainerStates: () => deps.orchestrator.listContainerStates(),
    // 封禁 = 打标记 + 踢掉所有会话。少一半都封不住（见 user-repo 注释）。
    ban: async (userId, reason) => {
      if (!(await setUserBanned(deps.db, userId, true, reason))) return false
      await revokeUserSessions(deps.db, userId)
      return true
    },
    unban: (userId) => setUserBanned(deps.db, userId, false, null),
    setQuota: (userId, quota) => setUserQuota(deps.db, userId, quota),
    // 实例不存在返回 false（404）；重建容器失败会抛出去，让管理员看到原因
    setInstanceQuota: async (id, quota) => {
      if ((await findInstanceById(deps.db, id)) === undefined) return false
      await deps.provisioner.setQuota(id, quota)
      return true
    },
    findInstanceContainer: async (id) => (await findInstanceById(deps.db, id))?.containerId,
    findInstanceImage: async (id) => {
      const row = await findInstanceById(deps.db, id)
      return row === undefined
        ? undefined
        : { storageKey: row.storageKey, image: row.image, previousImage: row.previousImage }
    },
    listLocalImages: () => deps.orchestrator.listImageTags(),
    readSnapshot: (slug) => deps.storage.snapshotUsage(slug),
    // 管理员可选**任意**本地镜像，不受 INSTANCE_STABLE_IMAGES 限制
    setInstanceImage: async (id, image) => {
      if ((await findInstanceById(deps.db, id)) === undefined) return false
      await deps.provisioner.setImage(id, image, { allowAny: true })
      return true
    },
    rollbackInstanceImage: async (id) => {
      if ((await findInstanceById(deps.db, id)) === undefined) return false
      await deps.provisioner.rollbackImage(id)
      return true
    },
    streamLogs,
    getSessionUser: (req) => sessionUser(req.headers),
  })

  app.get('/healthz', async () => ({ ok: true }))

  return app
}
