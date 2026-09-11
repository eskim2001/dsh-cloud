import type { Readable } from 'node:stream'
import type { InstanceSpec, RenderedInstance, RenderContext } from '@dsh-cloud/instance-spec'

/** 实例此刻的真实状态。`state` 是运行时归一化后的枚举，`statusText` 是它的原文。 */
export interface InstanceLiveState {
  /** running / stopped / created / restarting / dead / unknown */
  state: string
  /** 人类可读，例如 `running (pid 12345)`。 */
  statusText: string
}

/**
 * 一份用量采样。字段与 `instance/container-stats.ts` 的 `ContainerUsage` 对齐，
 * 这样 HTTP 层不用为两个运行时写两套。
 */
export interface InstanceUsage {
  /** 100 = 用满一个核；多核实例可以超过 100。 */
  cpuPercent: number
  memMb: number
}

/**
 * 建数据卷时同名卷已经存在。
 *
 * **必须当错误，不能静默复用** —— 复用会把「这块卷里已经有别人的数据」伪装成「新建成功」，
 * 正是 D18 要防的那种失败。D18 原本靠「宿主目录存在且非空就拒绝」实现，换成数据卷之后
 * 这条就是它的等价物。
 */
export class StorageExistsError extends Error {}

/** 数据卷不存在。`ensureStorage` **绝不静默新建**：那会把「数据丢了」伪装成「一切正常」。 */
export class StorageNotFoundError extends Error {}

/**
 * 运行时驱动：**唯一**接触具体运行时的接缝。
 *
 * 换运行时只换这一层的实现，`provisioner`/`boot`/`reconciler` 这些业务代码不动。
 * 之前 `ARCHITECTURE.md` 声称 renderer 就是那个接缝——不成立：容器专有的东西
 * （网络、挂载、日志多路复用、状态枚举）全都漏在编排层里，所以这里把它收干净。
 */
export interface RuntimeDriver {
  readonly runtime: string

  // ---- 镜像 ----
  /**
   * 这个运行时能不能报告「宿主上本地有哪些镜像」。
   *
   * 为 `false` 时，准入逻辑**必须跳过**「本地是否有」这一关——否则会把「运行时不给这个信息」
   * 误判成「本地没有」，导致升级永远被拒。smolvm 1.14.6 的 CLI 就是这种情况。
   */
  readonly canReportLocalImages: boolean
  ensureImage(ref: string): Promise<void>
  imageExists(ref: string): Promise<boolean>
  listImageTags(): Promise<string[]>
  openImagePull(ref: string): Promise<Readable>

  // ---- 生命周期 ----
  /** 幂等：同名已存在时先清掉再建。 */
  create(spec: InstanceSpec, ctx: RenderContext): Promise<RenderedInstance>
  start(machineName: string): Promise<void>
  /** **必须优雅**：运行时靠这一步把 `:staged` 的写入回传宿主。禁止用删除/强杀代替。 */
  stop(machineName: string): Promise<void>
  /** 幂等：不存在时不报错，并清理该机器残留（孤儿进程、端口）。 */
  remove(machineName: string): Promise<void>

  // ---- 观测 ----
  /** `undefined` = 不存在（历史残留行）。**注意：不能只信运行时的自报状态**，见 `probeHealthy`。 */
  status(machineName: string): Promise<InstanceLiveState | undefined>
  /** 现存的实例机器名（含 DB 里没有的孤儿）。对账器用来发现漂移，不做删除。 */
  listInstanceNames(): Promise<string[]>
  /**
   * 探**服务本身**，不是探运行时状态。
   *
   * 运行时可能把崩溃的工作负载换成空转容器而状态仍报 running（smolvm 实测如此），
   * 所以必须真的去连入口端口。`hostPort` 由平台分配并落库，调用方传进来。
   */
  probeHealthy(machineName: string, hostPort: number): Promise<boolean>
  logs(machineName: string, tail: number): Promise<string>
  exec(machineName: string, argv: string[]): Promise<{ code: number; stdout: string }>
  stats(machineName: string): Promise<InstanceUsage | undefined>

  // ---- 数据卷 ----
  //
  // 实例数据是一块**运行时管理的卷**，不是宿主目录。宿主路径、卷名、镜像落在哪，
  // 都由运行时决定；业务层只认那个不透明的 `storageKey`。
  /**
   * 建数据卷。**同名已存在就抛 `StorageExistsError`**，绝不静默复用（见该类注释）。
   * `sizeMb` 是硬容量：卷灌满就是 ENOSPC，不是「预算」。
   */
  createStorage(key: string, sizeMb: number): Promise<void>
  /** 确认数据卷在。不在就抛 `StorageNotFoundError`，**绝不新建**。 */
  ensureStorage(key: string): Promise<void>
  /** 删掉这一块卷。幂等。**只删这一个 key** —— 快照卷是上层的事（见 `DataStore`）。 */
  removeStorage(key: string): Promise<void>
  /** 已用容量（MiB）。**停机时也必须可读** —— 用量面板在实例没跑的时候也要有数。 */
  storageUsageMb(key: string): Promise<number | undefined>
  /**
   * 把一块卷整体复制成新卷（升级/回退的唯一保险）。
   * 目标已存在 → `StorageExistsError`；源不存在 → `StorageNotFoundError`。
   */
  copyStorage(fromKey: string, toKey: string): Promise<void>

  /** 回收孤儿进程 / 端口漂移。启动与每次对账时调。 */
  heal(): Promise<void>
}
