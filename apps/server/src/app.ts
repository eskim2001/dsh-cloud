import { fromNodeHeaders } from 'better-auth/node'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import type { Auth } from './auth.js'
import type { Db } from './db/client.js'
import { findInstanceBySlug, listInstancesByOwner, findInstanceById } from './db/instance-repo.js'
import {
  listImageReleases,
  publishImageRelease,
  setDefaultImageRelease,
  unpublishImageRelease,
} from './db/image-release-repo.js'
import { listImageCatalog } from './db/image-catalog-repo.js'
import { listRecentMetrics } from './db/metric-repo.js'
import {
  countAdmins,
  findUserById,
  listInstancesWithOwner,
  listUsersWithInstanceCount,
  revokeUserSessions,
  setUserBanned,
  setUserQuota,
  setUserRole,
} from './db/user-repo.js'
import { trustedOrigins, type Env } from './env.js'
import { registerAdminRoutes } from './http/admin-routes.js'
import { registerForwardAuth } from './http/forward-auth-route.js'
import { registerSessionRoutes } from './http/session-routes.js'
import { registerInstanceRoutes } from './http/instance-routes.js'
import { streamContainerLogs } from './http/log-stream.js'
import type { DataStore } from './instance/data-store.js'
import { syncImageCatalog } from './instance/image-sync.js'
import type { InstanceOrchestrator } from './instance/orchestrator.js'
import type { InstanceProvisioner } from './instance/provisioner.js'
import { createRegistryClient } from './instance/registry.js'

export interface AppDeps {
  env: Env
  db: Db
  auth: Auth
  provisioner: InstanceProvisioner
  /** 直接读实例的地方（用量快照、日志）走它。 */
  orchestrator: InstanceOrchestrator
  /** 实例数据在宿主上的目录（读用量、快照占用）。 */
  dataStore: DataStore
  logger?: boolean
  /**
   * 测试用：观察**实际注册**的路由集合。Fastify 没有公开的路由枚举 API
   * （`printRoutes` 会把通配路由的路径前缀吃掉），而漏挂认证只能靠「注册面清单」
   * 测试兜住（铁律 6）。见 http/route-surface.test.ts。
   */
  onRoute?: (route: { method: string | string[]; url: string }) => void
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

  if (deps.onRoute !== undefined) app.addHook('onRoute', deps.onRoute)

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
      (machineName, o) => deps.orchestrator.logs(machineName, o),
      // 驱动已经把 Docker 的「8 字节头 + 负载」复用帧拆干净了（见 `DockerDriver.logs`），
      // 到这里就是纯文本，原样转发即可。
      (raw, out) => {
        raw.pipe(out)
      },
    )

  // 注册表只读客户端（D23）。公开包匿名即可，所以凭据是**可选**的——
  // 只设一半会被忽略（见 registry.ts），免得出现半截 Basic 头。
  const registry = createRegistryClient({
    repo: deps.env.INSTANCE_IMAGE_REPO,
    fetch: globalThis.fetch,
    ...(deps.env.INSTANCE_IMAGE_REGISTRY_USER !== '' &&
    deps.env.INSTANCE_IMAGE_REGISTRY_TOKEN !== ''
      ? {
          user: deps.env.INSTANCE_IMAGE_REGISTRY_USER,
          token: deps.env.INSTANCE_IMAGE_REGISTRY_TOKEN,
        }
      : {}),
  })

  // ① forward-auth：数据面的门（D8 ②）
  registerForwardAuth(app, {
    baseDomain: deps.env.BASE_DOMAIN,
    consoleDomain: deps.env.CONSOLE_DOMAIN,
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
    listContainerStates: () => deps.orchestrator.listInstanceStates(),
    readStats: (containerId) => deps.orchestrator.stats(containerId),
    readDisk: async (storageKey, quotaMb) => {
      const u = await deps.dataStore.usage(storageKey)
      return u === undefined ? undefined : { usedMb: u.usedMb, quotaMb }
    },
    listMetrics: (instanceId, limit) => listRecentMetrics(deps.db, instanceId, limit),
    listLocalImages: () => deps.orchestrator.listImageTags(),
    listImageReleases: () => listImageReleases(deps.db),
    readSnapshot: async (storageKey) => (await deps.dataStore.snapshotUsage(storageKey))?.usedMb,
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
    listContainerStates: () => deps.orchestrator.listInstanceStates(),
    // 封禁 = 打标记 + 踢掉所有会话。少一半都封不住（见 user-repo 注释）。
    ban: async (userId, reason) => {
      if (!(await setUserBanned(deps.db, userId, true, reason))) return false
      await revokeUserSessions(deps.db, userId)
      return true
    },
    unban: (userId) => setUserBanned(deps.db, userId, false, null),
    setQuota: (userId, quota) => setUserQuota(deps.db, userId, quota),
    // 降级最后一名管理员 = 所有人都进不了管理台，只能靠 db:seed 恢复。
    // 查两次再写，两个管理员同时自降的窗口极窄，单运营者场景不值得上事务。
    setRole: async (userId, role) => {
      const target = await findUserById(deps.db, userId)
      if (target === undefined) return 'missing'
      if (role === 'user' && target.role === 'admin' && (await countAdmins(deps.db)) <= 1) {
        return 'last-admin'
      }
      await setUserRole(deps.db, userId, role)
      return 'ok'
    },
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
    listImageReleases: () => listImageReleases(deps.db),
    listImageCatalog: () => listImageCatalog(deps.db),
    syncImages: () => syncImageCatalog(deps.db, registry, deps.env.INSTANCE_IMAGE_REPO),
    pullImageStream: (ref) => deps.orchestrator.openImagePull(ref),
    publishImage: (ref, defaultIfFirst) => publishImageRelease(deps.db, ref, defaultIfFirst),
    unpublishImage: (ref) => unpublishImageRelease(deps.db, ref),
    setDefaultImage: (ref) => setDefaultImageRelease(deps.db, ref),
    readSnapshot: async (storageKey) => (await deps.dataStore.snapshotUsage(storageKey))?.usedMb,
    // 管理员可选**任意**平台仓库的本地镜像，不受已发布列表限制
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
