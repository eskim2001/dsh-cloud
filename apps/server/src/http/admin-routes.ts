import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AdminInstanceRow, AdminUserRow } from '../db/user-repo.js'
import type { Env } from '../env.js'
import type { QuotaInput } from '../instance/provisioner.js'
import { platformTags } from '../instance/image-catalog.js'
import {
  isImageFailure,
  ShrinkBelowUsageError,
  ShrinkFailedError,
} from '../instance/provisioner.js'
import { resolveRuntimeStatus, type ContainerStates } from '../instance/runtime-status.js'
import type { LogStreamOptions } from './log-stream.js'
import { LogsQuerySchema } from './log-stream.js'

const BanBodySchema = z.object({ reason: z.string().max(200).optional() })
const QuotaBodySchema = z.object({ quota: z.number().int().min(0).max(100).nullable() })
const ImageBodySchema = z.object({ image: z.string().min(1).max(255) })

/**
 * 改实例资源配额。上限取 `instance-spec` 的 QuotaSchema（64 核 / 256GB / 4096 pids），
 * **比用户自助创建的额度宽**——用户最多 8 核 / 16GB（见 instance-routes 的 CreateBodySchema），
 * 管理员可以按合同给更高的规格。
 */
const InstanceQuotaBodySchema = z.object({
  cpus: z.number().positive().max(64),
  memoryMb: z.number().int().positive().max(262_144),
  pidsLimit: z.number().int().positive().max(4_096),
  // 管理员能给到 1TB，比用户自助的 100GB 宽（D17）
  diskMb: z.number().int().min(128).max(1_048_576),
})

export interface AdminRouteDeps {
  env: Env
  listUsers(): Promise<AdminUserRow[]>
  listInstances(): Promise<AdminInstanceRow[]>
  /** 全部容器的实时状态（一次 `docker ps -a`）。实例状态以它为准。 */
  listContainerStates(): Promise<ContainerStates>
  ban(userId: string, reason: string | null): Promise<boolean>
  unban(userId: string): Promise<boolean>
  setQuota(userId: string, quota: number | null): Promise<boolean>
  /** 改实例的 CPU / 内存 / pids。实例不存在 → false。**会重建容器**（几秒中断）。 */
  setInstanceQuota(id: string, quota: QuotaInput): Promise<boolean>
  /** 实例的镜像信息（当前 / 可回滚的上一版 / 数据文件）。实例不存在 → undefined。 */
  findInstanceImage(
    id: string,
  ): Promise<{ storageKey: string; image: string; previousImage: string | null } | undefined>
  /** 宿主上已有的镜像 tag——管理员可选**任意**本地版本，不受稳定版白名单限制。 */
  listLocalImages(): Promise<string[]>
  /** 升级前快照的实占（MB）。没有快照 / 读不到都返回 undefined。 */
  readSnapshot(slug: string): Promise<number | undefined>
  /** 换镜像 / 回滚。实例不存在 → false。失败会抛（见 isImageFailure）。 */
  setInstanceImage(id: string, image: string): Promise<boolean>
  rollbackInstanceImage(id: string): Promise<boolean>
  /** 取实例的容器 id（看日志用）。实例不存在 → undefined；还没容器 → null。 */
  findInstanceContainer(id: string): Promise<string | null | undefined>
  /** 把容器日志推成 SSE。**实现负责 hijack**（见 log-stream.ts）。 */
  streamLogs(
    req: FastifyRequest,
    reply: FastifyReply,
    containerId: string,
    opts: LogStreamOptions,
  ): Promise<void>
  /** 从请求解析登录者（含 role）；未登录返回 undefined。 */
  getSessionUser(req: FastifyRequest): Promise<{ id: string; role: string } | undefined>
}

interface AuthedRequest extends FastifyRequest {
  adminId?: string
}

/**
 * 平台管理面。**只有 role='admin' 能进**——管理员是平台运营方，不是实例 owner。
 *
 * 这里能改的是**账号与配额**（封禁、实例数上限、看全站实例状态），
 * 也能**看容器日志**（排障必需，日志里可能带用户内容——用户已确认可以）。
 * **不能**做的是直接浏览用户的 `/data` 卷：跨实例隔离是对客户的承诺，
 * 给管理员开个「进卷里翻文件」的按钮就破功了；真需要看数据走宿主，不在这里开按钮
 * （ARCHITECTURE §四）。
 */
export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminRouteDeps,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('preHandler', async (req: AuthedRequest, reply) => {
      const user = await deps.getSessionUser(req)
      if (user === undefined) {
        await reply.code(401).send({ error: '未登录' })
        return
      }
      // 非管理员一律 403。**每一条路由都过这个钩子**——漏一条就是一个洞。
      if (user.role !== 'admin') {
        await reply.code(403).send({ error: '需要管理员权限' })
        return
      }
      req.adminId = user.id
    })

    scope.get('/api/admin/users', async () => ({
      users: await deps.listUsers(),
      maxInstancesPerUser: deps.env.MAX_INSTANCES_PER_USER,
    }))

    scope.get('/api/admin/instances', async (req) => {
      const rows = await deps.listInstances()
      // 状态以 Docker 为准，DB 的 status 只是意图（见 instance/runtime-status.ts）
      let states: ContainerStates | undefined
      try {
        states = await deps.listContainerStates()
      } catch (err) {
        req.log.warn({ err }, '读容器实时状态失败，本次回退到 DB 快照')
      }
      return {
        instances: rows.map((row) => {
          const { status, statusText } = resolveRuntimeStatus(row, states)
          return { ...row, status, statusText }
        }),
      }
    })

    scope.post('/api/admin/users/:id/ban', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      const parsed = BanBodySchema.safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })
      // 封自己 = 把自己锁在门外，没有恢复路径，直接拒绝
      if (id === req.adminId) return reply.code(400).send({ error: '不能封禁自己' })

      if (!(await deps.ban(id, parsed.data.reason ?? null))) {
        return reply.code(404).send({ error: '用户不存在' })
      }
      return { ok: true }
    })

    scope.post('/api/admin/users/:id/unban', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      if (!(await deps.unban(id))) return reply.code(404).send({ error: '用户不存在' })
      return { ok: true }
    })

    scope.patch('/api/admin/users/:id/quota', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      const parsed = QuotaBodySchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({
          error: '参数不合法',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        })
      }
      if (!(await deps.setQuota(id, parsed.data.quota))) {
        return reply.code(404).send({ error: '用户不存在' })
      }
      return { ok: true }
    })

    /** 改实例资源配额（D17）。会重建容器——前端要提示「有几秒不可用」。 */
    scope.patch('/api/admin/instances/:id/quota', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      const parsed = InstanceQuotaBodySchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({
          error: '参数不合法',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        })
      }
      try {
        if (!(await deps.setInstanceQuota(id, parsed.data))) {
          return reply.code(404).send({ error: '实例不存在' })
        }
      } catch (err) {
        // 缩容缩不动是**请求本身**的问题（配额要得比已用还小），不是服务端故障
        if (err instanceof ShrinkBelowUsageError || err instanceof ShrinkFailedError) {
          return reply.code(400).send({ error: err.message })
        }
        throw err
      }
      return { ok: true }
    })

    /**
     * 版本信息。管理员看到的 `local` 是宿主上**全部**镜像 tag——用户面只有稳定版白名单。
     */
    scope.get('/api/admin/instances/:id/image', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      const info = await deps.findInstanceImage(id)
      if (info === undefined) return reply.code(404).send({ error: '实例不存在' })

      const local = platformTags(
        await deps.listLocalImages().catch((): string[] => []),
        deps.env.INSTANCE_IMAGE,
      )
      const snapshotMb = await deps.readSnapshot(info.storageKey).catch(() => undefined)
      return {
        image: info.image,
        previousImage: info.previousImage,
        local,
        snapshotMb: snapshotMb ?? null,
      }
    })

    /** 换镜像（升级 / 降级）。**先给数据打快照**，会停机——见 provisioner.setImage。 */
    scope.patch('/api/admin/instances/:id/image', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      const parsed = ImageBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })

      try {
        if (!(await deps.setInstanceImage(id, parsed.data.image))) {
          return reply.code(404).send({ error: '实例不存在' })
        }
      } catch (err) {
        if (isImageFailure(err)) return reply.code(400).send({ error: err.message })
        throw err
      }
      return { ok: true }
    })

    scope.post('/api/admin/instances/:id/image/rollback', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      try {
        if (!(await deps.rollbackInstanceImage(id))) {
          return reply.code(404).send({ error: '实例不存在' })
        }
      } catch (err) {
        if (isImageFailure(err)) return reply.code(400).send({ error: err.message })
        throw err
      }
      return { ok: true }
    })

    /** 容器日志（SSE），排障用。与实例面同一实现——鉴权在 hijack 之前。 */
    scope.get('/api/admin/instances/:id/logs', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      const containerId = await deps.findInstanceContainer(id)
      if (containerId === undefined) return reply.code(404).send({ error: '实例不存在' })
      if (containerId === null) return reply.code(409).send({ error: '实例还没有容器' })

      const parsed = LogsQuerySchema.safeParse(req.query)
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })

      return deps.streamLogs(req, reply, containerId, { tail: parsed.data.tail })
    })
  })
}
