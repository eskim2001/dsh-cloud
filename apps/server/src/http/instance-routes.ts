import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  ImageRefSchema,
  InstanceSlugSchema,
  isReservedSlug,
} from '@dsh-cloud/instance-spec'
import { z } from 'zod'
import { SlugTakenError, QuotaExceededError } from '../db/instance-repo.js'
import type { ImageReleaseRow, InstanceMetricRow, InstanceRow } from '../db/schema.js'
import { consoleLabel, type Env } from '../env.js'
import type { ContainerUsage } from '../instance/container-stats.js'
import type { DiskUsage } from '../instance/data-store.js'
import { platformTags } from '../instance/image-catalog.js'
import type { InstanceProvisioner, ProvisionInput, RemoveInput } from '../instance/provisioner.js'
import { isImageFailure, SlugConfirmMismatchError } from '../instance/provisioner.js'
import { resolveRuntimeStatus, type ContainerStates } from '../instance/runtime-status.js'
import type { LogStreamOptions } from './log-stream.js'
import { LogsQuerySchema } from './log-stream.js'

const CreateBodySchema = z.object({
  // 保留字是**创建期命名政策**，只在这里生效——库里已有的行只做形状校验，
  // 否则扩表会让存量实例连删都删不掉（见 DECISIONS 的域名拆分 ADR）。
  slug: InstanceSlugSchema.refine((s) => !isReservedSlug(s), '该 slug 是保留字'),
  cpus: z.number().positive().max(8).default(1),
  memoryMb: z.number().int().positive().max(16_384).default(2048),
  pidsLimit: z.number().int().positive().max(4096).default(512),
  // 自助上限比管理员宽（D17）：这里 100GB，管理员能到 1TB。
  // 下限 128MB —— 卷声明容量的下限（命名卷没有硬配额，这个值只记进 label）。
  diskMb: z.number().int().min(128).max(102_400).default(10_240),
  /** 自选版本，留空用平台默认版本。合法性（已发布 / 平台仓库）由 provisioner 判。 */
  image: ImageRefSchema.optional(),
})

const MetricsQuerySchema = z.object({
  /** 默认 120 条 = 最近 2 小时（一分钟一条）。 */
  limit: z.coerce.number().int().positive().max(1000).default(120),
})

/** 换镜像。合法性（仓库前缀 / 白名单 / 本地存在）由 provisioner 判，这里只挡形状。 */
const ImageBodySchema = z.object({ image: z.string().min(1).max(255) })

/**
 * 路由用到的编排动作。收成接口而不是直接依赖 `InstanceProvisioner`——
 * 那个类有私有成员（结构性类型对不上），测试里没法塞假实现，只能造 dockerode。
 */
export interface InstanceOps {
  create(input: ProvisionInput): Promise<InstanceRow>
  restart(id: string): Promise<InstanceRow>
  stop(id: string): Promise<InstanceRow>
  start(id: string): Promise<InstanceRow>
  remove(id: string, opts?: RemoveInput): Promise<void>
  /** 换镜像（升级）。用户只能选已发布的版本——`allowAny` 只有管理员面传。 */
  setImage(id: string, image: string, opts?: { allowAny?: boolean }): Promise<InstanceRow>
  rollbackImage(id: string): Promise<InstanceRow>
}

export interface InstanceRouteDeps {
  env: Env
  provisioner: InstanceOps
  listMine(ownerId: string): Promise<InstanceRow[]>
  getById(id: string): Promise<InstanceRow | undefined>
  /**
   * 全部容器的实时状态（一次 `docker ps -a`）。
   * 实例状态以它为准——DB 的 `status` 只是意图（见 runtime-status.ts）。
   */
  listContainerStates(): Promise<ContainerStates>
  /** 实时用量。容器不在 / 首帧没差值时返回 undefined。 */
  readStats(containerId: string): Promise<ContainerUsage | undefined>
  /** 已用磁盘（读文件系统超级块，不是估算）。未挂载返回 undefined。 */
  readDisk(slug: string, quotaMb: number): Promise<DiskUsage | undefined>
  /** 历史采样，按时间升序。 */
  listMetrics(instanceId: string, limit: number): Promise<InstanceMetricRow[]>
  /** 宿主上已有的镜像 tag——用户可选列表要拿它过滤（本地没有的不摆出来）。 */
  listLocalImages(): Promise<string[]>
  /** 平台已发布的镜像版本（D21）。默认版本决定「哪个仓库是我们的」。 */
  listImageReleases(): Promise<ImageReleaseRow[]>
  /** 升级前快照的实占（MB）。没有快照 / 读不到都返回 undefined。 */
  readSnapshot(slug: string): Promise<number | undefined>
  /** 把容器日志推成 SSE。**实现负责 hijack**（见 log-stream.ts）。 */
  streamLogs(
    req: FastifyRequest,
    reply: FastifyReply,
    containerId: string,
    opts: LogStreamOptions,
  ): Promise<void>
  /** 从请求解析登录用户；未登录返回 undefined。 */
  getUserId(req: FastifyRequest): Promise<string | undefined>
}

interface AuthedRequest extends FastifyRequest {
  userId?: string
}

/** 管理台 API。**每一条都要求登录**，且只操作自己的实例。 */
export async function registerInstanceRoutes(
  app: FastifyInstance,
  deps: InstanceRouteDeps,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('preHandler', async (req: AuthedRequest, reply) => {
      const userId = await deps.getUserId(req)
      if (userId === undefined) {
        await reply.code(401).send({ error: '未登录' })
        return
      }
      req.userId = userId
    })

    /** 取路径上的实例，**顺带做 owner 校验**：不是自己的返回 undefined（调用方一律 404）。 */
    const ownedRow = async (req: AuthedRequest): Promise<InstanceRow | undefined> => {
      const { id } = req.params as { id: string }
      const row = await deps.getById(id)
      // 不是 owner 一律 404，不泄漏"这个 id 存在但不属于你"
      return row === undefined || row.ownerId !== req.userId ? undefined : row
    }

    /**
     * 本次请求的容器实时状态。取不到返回 `undefined`，调用方退回 DB 快照——
     * Docker daemon 抖一下不该让列表页 500，更不该谎报「所有实例都已停止」。
     */
    const liveStates = async (req: FastifyRequest): Promise<ContainerStates | undefined> => {
      try {
        return await deps.listContainerStates()
      } catch (err) {
        req.log.warn({ err }, '读容器实时状态失败，本次回退到 DB 快照')
        return undefined
      }
    }

    /** 磁盘用量取不到就返回 undefined——页面显示「暂无数据」，不 500。 */
    const readDiskOf = async (req: FastifyRequest, row: InstanceRow): Promise<DiskUsage | undefined> => {
      try {
        return await deps.readDisk(row.storageKey, row.diskMb)
      } catch (err) {
        req.log.warn({ err, slug: row.slug }, '读磁盘用量失败')
        return undefined
      }
    }

    scope.get('/api/instances', async (req: AuthedRequest) => {
      const rows = await deps.listMine(req.userId!)
      const states = await liveStates(req)
      return { instances: rows.map((r) => toPublicInstance(r, deps.env, states)) }
    })

    /**
     * 建实例时可选的版本：**全部已发布**的版本。宿主上没有的也列——`create` 会自动拉（D23）。
     * 不返回「需下载」之类的标记：用户对此没有可操作性，只会让选择变犹豫。
     */
    scope.get('/api/images', async () => {
      const releases = await deps.listImageReleases()
      return {
        default: releases.find((r) => r.isDefault)?.ref ?? null,
        // 新的在前：版本选择器第一眼该看到最新版
        published: releases.map((r) => r.ref).reverse(),
      }
    })

    scope.post('/api/instances', async (req: AuthedRequest, reply) => {
      const parsed = CreateBodySchema.safeParse(req.body)
      if (!parsed.success) {
        // 前端只显示 `error`——「参数不合法」在表单里帮不上忙，把第一条具体原因顶上去
        const [first] = parsed.error.issues
        return reply.code(400).send({
          error: first?.message ?? '参数不合法',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        })
      }

      // 兜一层：控制台域名可以配成任何词，静态保留字表未必覆盖它的首段。
      // 抢到这个 label 就等于把控制台的 router 规则撞成同长度（见 DECISIONS 的域名拆分 ADR）。
      if (parsed.data.slug === consoleLabel(deps.env)) {
        return reply.code(400).send({
          error: `slug 不能是控制台域名 ${deps.env.CONSOLE_DOMAIN} 的首段`,
        })
      }

      try {
        const { image, ...rest } = parsed.data
        const row = await deps.provisioner.create({
          ...rest,
          ownerId: req.userId!,
          // exactOptionalPropertyTypes：没选版本就不带这个键，让编排层回落默认版本
          ...(image === undefined ? {} : { image }),
        })
        const states = await liveStates(req)
        return reply.code(201).send({ instance: toPublicInstance(row, deps.env, states) })
      } catch (err) {
        if (err instanceof SlugTakenError) return reply.code(409).send({ error: err.message })
        if (err instanceof QuotaExceededError) return reply.code(409).send({ error: err.message })
        // 没有默认镜像版本这类是**请求本身**的问题（D21），不是服务端故障
        if (isImageFailure(err)) return reply.code(400).send({ error: err.message })
        throw err
      }
    })

    scope.get('/api/instances/:id', async (req: AuthedRequest, reply) => {
      const row = await ownedRow(req)
      if (row === undefined) return reply.code(404).send({ error: '实例不存在' })
      return { instance: toPublicInstance(row, deps.env, await liveStates(req)) }
    })

    scope.post('/api/instances/:id/restart', async (req: AuthedRequest, reply) => {
      const row = await ownedRow(req)
      if (row === undefined) return reply.code(404).send({ error: '实例不存在' })
      const updated = await deps.provisioner.restart(row.id)
      return { instance: toPublicInstance(updated, deps.env, await liveStates(req)) }
    })

    scope.post('/api/instances/:id/stop', async (req: AuthedRequest, reply) => {
      const row = await ownedRow(req)
      if (row === undefined) return reply.code(404).send({ error: '实例不存在' })
      const updated = await deps.provisioner.stop(row.id)
      return { instance: toPublicInstance(updated, deps.env, await liveStates(req)) }
    })

    scope.post('/api/instances/:id/start', async (req: AuthedRequest, reply) => {
      const row = await ownedRow(req)
      if (row === undefined) return reply.code(404).send({ error: '实例不存在' })
      const updated = await deps.provisioner.start(row.id)
      return { instance: toPublicInstance(updated, deps.env, await liveStates(req)) }
    })

    // 默认保留数据卷；?purge=true&confirmSlug=<slug> 才连它一起删（不可逆）
    scope.delete('/api/instances/:id', async (req: AuthedRequest, reply) => {
      const row = await ownedRow(req)
      if (row === undefined) return reply.code(404).send({ error: '实例不存在' })
      const { purge, confirmSlug } = req.query as { purge?: string; confirmSlug?: string }
      try {
        await deps.provisioner.remove(row.id, {
          purgeVolume: purge === 'true',
          // exactOptionalPropertyTypes：没传就不带这个键，别显式塞 undefined
          ...(confirmSlug === undefined ? {} : { confirmSlug }),
        })
        return reply.code(204).send()
      } catch (err) {
        if (err instanceof SlugConfirmMismatchError) {
          return reply.code(400).send({ error: err.message })
        }
        throw err
      }
    })

    /**
     * 当前用量快照。容器不在（没跑 / 刚起来）就是 null——前端显示「暂无数据」。
     * 磁盘是**独立于容器**的一路：容器停了文件系统还挂着，用量照样能读。
     */
    scope.get('/api/instances/:id/stats', async (req: AuthedRequest, reply) => {
      const row = await ownedRow(req)
      if (row === undefined) return reply.code(404).send({ error: '实例不存在' })

      const disk = await readDiskOf(req, row)
      if (row.containerId === null) return { stats: null, disk }
      try {
        return { stats: (await deps.readStats(row.containerId)) ?? null, disk }
      } catch {
        // 容器刚好被删 / daemon 忙：当作「暂时取不到」，不把 500 甩给页面
        return { stats: null, disk }
      }
    })

    scope.get('/api/instances/:id/metrics', async (req: AuthedRequest, reply) => {
      const row = await ownedRow(req)
      if (row === undefined) return reply.code(404).send({ error: '实例不存在' })

      const parsed = MetricsQuerySchema.safeParse(req.query)
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })

      const metrics = await deps.listMetrics(row.id, parsed.data.limit)
      return {
        metrics: metrics.map((m) => ({
          sampledAt: m.sampledAt,
          cpuPercent: m.cpuPercent,
          memMb: m.memMb,
          diskUsedMb: m.diskUsedMb,
        })),
      }
    })

    /**
     * 版本信息：当前 / 可回滚到的上一版 / **用户能自助升到的已发布版本**（只列本地已有的，
     * 免得摆出一个选了就失败的选项）/ 升级前快照占多少宿主空间。
     */
    scope.get('/api/instances/:id/image', async (req: AuthedRequest, reply) => {
      const row = await ownedRow(req)
      if (row === undefined) return reply.code(404).send({ error: '实例不存在' })

      const releases = await deps.listImageReleases()
      const local = platformTags(
        await deps.listLocalImages().catch((): string[] => []),
        deps.env.INSTANCE_IMAGE_REPO,
      )
      const stable = releases.map((r) => r.ref).filter((ref) => local.includes(ref))
      const snapshotMb = await deps.readSnapshot(row.storageKey).catch(() => undefined)

      return {
        image: row.image,
        previousImage: row.previousImage,
        stable,
        snapshotMb: snapshotMb ?? null,
      }
    })

    /** 升级到某个稳定版。会停机几秒到几分钟（先打数据快照）——见 provisioner.setImage。 */
    scope.post('/api/instances/:id/image', async (req: AuthedRequest, reply) => {
      const row = await ownedRow(req)
      if (row === undefined) return reply.code(404).send({ error: '实例不存在' })

      const parsed = ImageBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })

      try {
        const updated = await deps.provisioner.setImage(row.id, parsed.data.image)
        return { instance: toPublicInstance(updated, deps.env, await liveStates(req)) }
      } catch (err) {
        if (isImageFailure(err)) return reply.code(400).send({ error: err.message })
        throw err
      }
    })

    scope.post('/api/instances/:id/image/rollback', async (req: AuthedRequest, reply) => {
      const row = await ownedRow(req)
      if (row === undefined) return reply.code(404).send({ error: '实例不存在' })

      try {
        const updated = await deps.provisioner.rollbackImage(row.id)
        return { instance: toPublicInstance(updated, deps.env, await liveStates(req)) }
      } catch (err) {
        if (isImageFailure(err)) return reply.code(400).send({ error: err.message })
        throw err
      }
    })

    /** 容器日志（SSE）。鉴权在 hijack 之前完成——见 log-stream.ts。 */
    scope.get('/api/instances/:id/logs', async (req: AuthedRequest, reply) => {
      const row = await ownedRow(req)
      if (row === undefined) return reply.code(404).send({ error: '实例不存在' })
      if (row.containerId === null) return reply.code(409).send({ error: '实例还没有容器' })

      const parsed = LogsQuerySchema.safeParse(req.query)
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })

      return deps.streamLogs(req, reply, row.containerId, { tail: parsed.data.tail })
    })
  })
}

function toPublicInstance(row: InstanceRow, env: Env, states: ContainerStates | undefined) {
  const { status, statusText } = resolveRuntimeStatus(row, states)
  return {
    id: row.id,
    slug: row.slug,
    status,
    statusText,
    image: row.image,
    /** 非空 = 有一份升级前的数据快照，可以回滚（见 provisioner.setImage）。 */
    previousImage: row.previousImage,
    cpus: row.cpus,
    memoryMb: row.memoryMb,
    diskMb: row.diskMb,
    lastError: row.lastError,
    stoppedAt: row.stoppedAt,
    hasContainer: row.containerId !== null,
    createdAt: row.createdAt,
    /**
     * 「打开 dsh」入口：**裸域名**。
     *
     * 桥在「无 cookie 的 `GET /`」上注入入口 token（见 docker/instance-image/Caddyfile），
     * 所以不需要任何专门的路径 —— 用户拿到哪个 URL，跳完之后浏览器里就停在哪个。
     */
    url: `${env.PUBLIC_SCHEME}://${row.slug}.${env.BASE_DOMAIN}/`,
  }
}
