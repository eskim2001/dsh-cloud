import {
  ImageRefSchema,
  InstanceSpecSchema,
  type RenderContext,
  type InstanceSpec,
} from '@dsh-cloud/instance-spec'
import type { Db } from '../db/client.js'
import {
  createInstanceRecord,
  deleteInstanceRecord,
  retainInstanceRecord,
  findInstanceById,
  updateInstance,
  type NewInstance,
} from '../db/instance-repo.js'
import { isNotFound } from '../docker/client.js'
import type { InstanceRow } from '../db/schema.js'
import { stableImages, type Env } from '../env.js'
import { gateToken } from './gate-token.js'
import type { HostStorage } from './host-storage.js'
import { imageRepo } from './image-catalog.js'
import type { InstanceOrchestrator } from './orchestrator.js'

export interface ProvisionInput {
  slug: string
  ownerId: string
  cpus: number
  memoryMb: number
  pidsLimit: number
  diskMb: number
}

export interface RemoveInput {
  /** 连数据一起删。**不可逆**——只有调用方拿到子域名确认才该传。 */
  purgeVolume?: boolean
  /** 彻底删除时要求调用方回填的子域名，用来挡误操作。 */
  confirmSlug?: string
}

/** 资源配额四元组。只由管理员改（D17）。 */
export type QuotaInput = Pick<ProvisionInput, 'cpus' | 'memoryMb' | 'pidsLimit' | 'diskMb'>

export class SlugConfirmMismatchError extends Error {
  constructor() {
    super('彻底删除需要输入正确的子域名')
    this.name = 'SlugConfirmMismatchError'
  }
}

/** 目标配额比已用还小——缩不下去，且这时还没动任何东西。 */
export class ShrinkBelowUsageError extends Error {
  constructor(usedMb: number, targetMb: number) {
    super(`该实例已用 ${usedMb} MB，不能缩到 ${targetMb} MB`)
    this.name = 'ShrinkBelowUsageError'
  }
}

/**
 * 缩容在「已删容器、已卸载」之后失败（`resize2fs` 的最小值比 `df` 报的已用更高，
 * 挂载状态下算不准）。此时配额已回滚、实例已按原规格恢复——但操作整体是失败的。
 */
export class ShrinkFailedError extends Error {
  constructor(detail: string) {
    super(`磁盘缩容失败，配额已回滚为原值：${detail}`)
    this.name = 'ShrinkFailedError'
  }
}

/** 目标镜像被拒：引用非法 / 不是平台自己的镜像仓库 / 不在可选范围 / 宿主上没有。 */
export class ImageRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageRejectedError'
  }
}

/** 没有可回滚的快照（`previous_image` 为空）。 */
export class NoRollbackError extends Error {
  constructor() {
    super('这个实例没有可回滚的版本')
    this.name = 'NoRollbackError'
  }
}

/** 换镜像后新容器起不来，数据与镜像已自动回滚到上一版。 */
export class ImageUpgradeFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageUpgradeFailedError'
  }
}

/**
 * 换镜像 / 回滚的**预期内**失败 → HTTP 400（请求本身做不到，不是服务端故障）。
 * 集中在这里，是因为实例面和管理面要给出同样的状态码，漏一处就是两套语义。
 */
export function isImageFailure(
  err: unknown,
): err is ImageRejectedError | NoRollbackError | ImageUpgradeFailedError {
  return (
    err instanceof ImageRejectedError ||
    err instanceof NoRollbackError ||
    err instanceof ImageUpgradeFailedError
  )
}

/**
 * 建实例 = 落库 → 起容器 → 更新状态 → 同步路由。
 *
 * 顺序有意如此：**先落库再起容器**，因为端口要落库才能防冲突；起容器失败
 * 就地把状态标成 `error`，管理台能看到原因，重试走 `restart`。
 */
export class InstanceProvisioner {
  constructor(
    private readonly db: Db,
    private readonly orchestrator: InstanceOrchestrator,
    private readonly storage: HostStorage,
    private readonly env: Env,
    private readonly syncRoutes: () => Promise<void>,
  ) {}

  async create(input: ProvisionInput): Promise<InstanceRow> {
    const newInstance: NewInstance = {
      id: crypto.randomUUID(),
      slug: input.slug,
      ownerId: input.ownerId,
      image: this.env.INSTANCE_IMAGE,
      cpus: input.cpus,
      memoryMb: input.memoryMb,
      pidsLimit: input.pidsLimit,
      diskMb: input.diskMb,
    }

    const row = await createInstanceRecord(this.db, newInstance, this.env.MAX_INSTANCES_PER_USER)

    try {
      // 新建：数据文件系统允许在这里第一次创建
      return await this.applyRuntime(row, { createData: true })
    } catch (err) {
      await updateInstance(this.db, row.id, { status: 'error', lastError: messageOf(err) })
      throw err
    }
  }

  /** 用同一份规格重建容器（换镜像 / 修复崩溃）。**卷不动**，所以内容保留。 */
  async restart(id: string): Promise<InstanceRow> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)

    try {
      return await this.applyRuntime(row)
    } catch (err) {
      await updateInstance(this.db, row.id, { status: 'error', lastError: messageOf(err) })
      throw err
    }
  }

  /**
   * 停实例。可逆——容器和卷都留着，`start` 能原样起来。
   * 停下来的实例不进 Traefik 投影，所以同步一次路由把它摘掉。
   */
  async stop(id: string): Promise<InstanceRow> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)

    try {
      if (row.containerId !== null) await this.orchestrator.stopContainer(row.containerId)
      const updated = await updateInstance(this.db, row.id, { status: 'stopped', lastError: null })
      await this.syncRoutes()
      return updated ?? row
    } catch (err) {
      await updateInstance(this.db, row.id, { status: 'error', lastError: messageOf(err) })
      throw err
    }
  }

  /**
   * 启动实例。容器已经不在（被 prune / 手动删）就回落重建——数据不动，内容保留。
   *
   * **起容器前必须先确认数据文件系统挂上了**：宿主重启后挂载全没了，而容器还在、
   * 状态是 exited——直接 `start` 会让它 bind 到空目录，用户看到「数据没了」（D18）。
   */
  async start(id: string): Promise<InstanceRow> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)
    if (row.containerId === null) return this.applyRuntime(row)

    try {
      try {
        await this.storage.ensure(row.storageKey, row.diskMb)
        await this.storage.assertMounted(row.storageKey)
        await this.orchestrator.startContainer(row.containerId)
      } catch (err) {
        if (!isNotFound(err)) throw err
        return await this.applyRuntime(row)
      }
      const updated = await updateInstance(this.db, row.id, { status: 'running', lastError: null })
      await this.syncRoutes()
      return updated ?? row
    } catch (err) {
      await updateInstance(this.db, row.id, { status: 'error', lastError: messageOf(err) })
      throw err
    }
  }

  /**
   * 删实例。默认**保留数据文件系统**——删实例不等于删数据，用同一个子域名重建还能拿回来。
   * 只有 `purgeVolume` + 子域名确认都给了才连它删，那一步不可逆。
   *
   * 顺序有意如此：先摘路由再删容器，否则容器删到一半时流量还会打进来。
   */
  async remove(id: string, opts: RemoveInput = {}): Promise<void> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)
    if (opts.purgeVolume === true && opts.confirmSlug !== row.slug) {
      throw new SlugConfirmMismatchError()
    }

    try {
      // ① 摘路由：置 removing 后投影一次，Traefik 立刻不再往里送流量
      await updateInstance(this.db, row.id, { status: 'removing' })
      await this.syncRoutes()

      // ② 删容器 + 网络（数据文件系统不动——它不属于 Docker）
      await this.orchestrator.removeInstance(this.specOf(row))

      // ③ 彻底删除：容器已停，这时才敢卸载 + 删文件（不可逆）
      if (opts.purgeVolume === true) await this.storage.destroy(row.storageKey)

      // ④ 删记录，再投影一次让路由条目彻底消失
      if (opts.purgeVolume === true) await deleteInstanceRecord(this.db, row.id)
      else await retainInstanceRecord(this.db, row.id)
      await this.syncRoutes()
    } catch (err) {
      // 删失败就把状态写回去，别让实例永远卡在 removing——行还在，可以重试
      await updateInstance(this.db, row.id, { status: 'error', lastError: messageOf(err) })
      throw err
    }
  }

  /**
   * 改资源配额（D17：创建后只有管理员能改）。
   *
   * **CPU / 内存 / pids** 是 Docker 参数，只在建容器时生效 → 改了必须重建容器
   * （中断几秒，数据不动）。**磁盘**不一样：它就是数据文件系统的大小，
   * 扩容可以**在线**做（不动容器），只有缩容要先停容器、卸载文件系统。
   *
   * 原本在跑的实例重建后照旧运行；原本停着的**保持停止**——只把旧容器删掉
   * （否则 `start` 会复用旧容器、带着旧配额起来），等用户自己 `start`。
   */
  async setQuota(id: string, quota: QuotaInput): Promise<InstanceRow> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)

    const computeChanged =
      row.cpus !== quota.cpus ||
      row.memoryMb !== quota.memoryMb ||
      row.pidsLimit !== quota.pidsLimit
    const diskShrank = quota.diskMb < row.diskMb
    const rebuild = computeChanged || diskShrank
    const wasRunning = row.status === 'running'

    // 缩容预检，放在**动任何东西之前**：明显缩不下去就直接拒绝，容器和配额都不动。
    // 这一关只能挡「已用 > 目标」；挂载状态下 resize2fs -P 会把最小可能大小报小
    // （脏页没落盘，实测写入 100MB 后仍报 26MB），所以真正的兜底是下面的回滚。
    if (diskShrank) {
      await this.storage.ensure(row.storageKey, row.diskMb)
      const usage = await this.storage.usage(row.storageKey, row.diskMb)
      if (usage === undefined) {
        throw new Error(`读不到 ${row.slug} 的磁盘用量，拒绝缩容`)
      }
      if (usage.usedMb > quota.diskMb) {
        throw new ShrinkBelowUsageError(usage.usedMb, quota.diskMb)
      }
    }

    // 先落库：即使下面 Docker 操作失败，配额意图也已记下，重试走 restart 即可
    const updated = await updateInstance(this.db, row.id, {
      ...quota,
      ...(rebuild ? { containerId: null } : {}),
    })
    if (updated === undefined) throw new Error(`实例不存在：${id}`)

    // 扩容在线完成，容器不用动
    if (quota.diskMb > row.diskMb) await this.storage.resize(row.storageKey, quota.diskMb)

    if (rebuild) {
      if (row.containerId !== null) await this.orchestrator.removeContainer(row.containerId)
      if (diskShrank) {
        try {
          // 卸载由 shrink 自己做——容器刚删掉，这时才卸得下来
          await this.storage.shrink(row.storageKey, quota.diskMb)
        } catch (err) {
          // 回滚：resize2fs 拒绝时文件系统本身没动，只是已卸载。把配额写回原值、
          // 按原规格把实例恢复起来——别留下「容器没了、配额却记着小值」的半截状态。
          await updateInstance(this.db, row.id, {
            cpus: row.cpus,
            memoryMb: row.memoryMb,
            pidsLimit: row.pidsLimit,
            diskMb: row.diskMb,
          })
          if (wasRunning) await this.restart(id)
          throw new ShrinkFailedError(messageOf(err))
        }
      }
      return wasRunning ? this.restart(id) : updated
    }

    return updated
  }

  /**
   * 换镜像（升级 / 降级）。**升级前给 `/data` 打一份快照**，所以失败可回滚。
   *
   * 顺序：校验 → 停容器 → 快照 → 落库 → 重建。每一步都有明确退路：
   * - 校验不通过：什么都没碰。
   * - 快照失败（多半是宿主空间不够）：文件系统只是被卸载了，按原规格把实例恢复起来。
   * - 新镜像起不来：**自动回滚**——数据回快照、镜像回旧版，然后抛错说明原因。
   *
   * 停机时间 = 停容器 + 复制已用数据 + 启动。数据越多越久（100MB 秒级，
   * 10GB 一两分钟）——快照的价钱，UI 上要写清楚。
   *
   * `allowAny` 只给管理员用：用户只能在 `INSTANCE_STABLE_IMAGES` 里选。
   */
  async setImage(
    id: string,
    image: string,
    opts: { allowAny?: boolean } = {},
  ): Promise<InstanceRow> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)
    if (image === row.image) return row

    await this.assertImageAllowed(image, opts.allowAny === true)

    const wasRunning = row.status === 'running'

    // ① 停容器：快照要的是一致状态，容器还在写就没法复制
    if (row.containerId !== null) await this.orchestrator.removeContainer(row.containerId)

    // ② 快照。失败时容器已删、文件系统已卸载，但**数据一个字节没动**——
    //    按原规格重建就回到了原样。
    try {
      await this.storage.snapshot(row.storageKey)
    } catch (err) {
      if (wasRunning) await this.restart(id)
      throw new ImageRejectedError(`升级前打快照失败，实例未改动：${messageOf(err)}`)
    }

    // ③ 落库：新镜像 + 记下旧镜像（非空 = 有一份快照可回滚）
    const updated = await updateInstance(this.db, row.id, {
      image,
      previousImage: row.image,
      containerId: null,
    })
    if (updated === undefined) throw new Error(`实例不存在：${id}`)

    // 停着的实例只落库——新镜像在用户下次 start 时生效
    if (!wasRunning) return updated

    try {
      return await this.restart(id)
    } catch (err) {
      try {
        // 用**升级前**的 wasRunning 决定要不要拉起来：此刻 DB 里的状态已被
        // 失败的 restart 写成 error，照它判断就会把实例留在「没容器」的状态
        await this.rollbackTo(id, row.image, wasRunning)
      } catch (rollbackErr) {
        // 回滚也失败：容器没了、库里记着新镜像——必须响亮地标 error
        await updateInstance(this.db, row.id, {
          status: 'error',
          lastError: messageOf(rollbackErr),
        })
        throw new ImageUpgradeFailedError(
          `新镜像 ${image} 起不来，回滚也失败了（${messageOf(rollbackErr)}）：${messageOf(err)}`,
        )
      }
      throw new ImageUpgradeFailedError(
        `新镜像 ${image} 起不来，已回滚到 ${row.image}：${messageOf(err)}`,
      )
    }
  }

  /**
   * 回滚到上一版：用升级前的快照覆盖数据，再按 `previous_image` 重建。
   *
   * 快照被 `mv` 消费掉（回滚只有一步），`previous_image` 随之清空——想再升回去
   * 就走一次正常升级（会重新打快照）。
   */
  async rollbackImage(id: string): Promise<InstanceRow> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)
    if (row.previousImage === null) throw new NoRollbackError()

    return this.rollbackTo(id, row.previousImage, row.status === 'running')
  }

  /**
   * 回滚的落地动作：恢复快照 → 落库回旧镜像 → （原本在跑的）重建。
   *
   * `rebuild` 由调用方给：自动回滚那条路上，DB 里的状态已经是失败后的 `error`，
   * 只能拿升级前的意图来判断。
   */
  private async rollbackTo(
    id: string,
    previousImage: string,
    rebuild: boolean,
  ): Promise<InstanceRow> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)
    if (row.containerId !== null) await this.orchestrator.removeContainer(row.containerId)

    await this.storage.restoreSnapshot(row.storageKey)

    const updated = await updateInstance(this.db, row.id, {
      image: previousImage,
      previousImage: null,
      containerId: null,
    })
    if (updated === undefined) throw new Error(`实例不存在：${id}`)

    return rebuild ? this.restart(id) : updated
  }

  /**
   * 目标镜像准入。四道：引用合法 → 是我们自己的仓库 → 用户可选范围 → 宿主上真的有。
   *
   * 「本地存在」这一关必须过：否则 Docker 会去 registry 拉，而控制面在私有网络里
   * 未必连得上，失败信息还很难看懂（用户会以为是平台坏了）。
   */
  private async assertImageAllowed(image: string, allowAny: boolean): Promise<void> {
    if (!ImageRefSchema.safeParse(image).success) {
      throw new ImageRejectedError(`镜像引用不合法：${image}`)
    }

    const platform = imageRepo(this.env.INSTANCE_IMAGE)
    if (imageRepo(image) !== platform) {
      throw new ImageRejectedError(`只能换成平台的实例镜像（${platform}），收到 ${image}`)
    }

    if (!allowAny && !stableImages(this.env.INSTANCE_STABLE_IMAGES).includes(image)) {
      throw new ImageRejectedError(`${image} 不在平台提供的版本列表里`)
    }

    const local = await this.orchestrator.listImageTags()
    if (!local.includes(image)) {
      throw new ImageRejectedError(`宿主上没有镜像 ${image}`)
    }
  }

  private specOf(row: InstanceRow): InstanceSpec {
    return InstanceSpecSchema.parse({
      slug: row.slug,
      image: row.image,
      quota: {
        cpus: row.cpus,
        memoryMb: row.memoryMb,
        pidsLimit: row.pidsLimit,
        diskMb: row.diskMb,
      },
      env: {},
    })
  }

  private async applyRuntime(
    row: InstanceRow,
    opts: { createData?: boolean } = {},
  ): Promise<InstanceRow> {
    const spec = this.specOf(row)

    // ★ 唯一的收口点：**先有数据，再有容器**。
    // 存储没就位就直接抛，实例标 error——绝不能建出一个 bind 到空目录的容器：
    // 那样容器照常跑、UI 照常绿，用户看到的是「数据没了」（D18）。
    // 只有建实例这条路允许「建」文件系统；其余一律只挂载，缺文件就报错。
    if (opts.createData === true) await this.storage.create(row.storageKey, row.diskMb)
    else await this.storage.ensure(row.storageKey, row.diskMb)
    await this.storage.assertMounted(row.storageKey)

    const ctx: RenderContext = {
      // 用实例自己记录的 tag，不是平台环境变量：升级是**按实例**的
      // （管理台显示的就是实际在跑的版本，可灰度、可回滚）。
      // INSTANCE_IMAGE 只决定新建实例时记什么。
      baseImage: row.image,
      baseDomain: this.env.BASE_DOMAIN,
      gateToken: gateToken(row.slug, this.env.PLATFORM_SECRET),
      dataDir: this.storage.mountPoint(row.storageKey),
    }

    const runtime = await this.orchestrator.createInstance(spec, ctx)

    const updated = await updateInstance(this.db, row.id, {
      status: 'running',
      containerId: runtime.containerId,
      lastError: null,
    })
    await this.syncRoutes()
    return updated ?? row
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
