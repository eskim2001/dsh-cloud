import { Readable } from 'node:stream'
import type { InstanceSpec, RenderContext, RenderedInstance } from '@dsh-cloud/instance-spec'
import type { InstanceLiveState, InstanceUsage, RuntimeDriver } from '../runtime/driver.js'
import { imageRepo } from './image-catalog.js'

/** 实例的运行时视图：渲染结果 + 此刻的状态。 */
export interface InstanceRuntime extends RenderedInstance {
  status: string
}

export type { InstanceLiveState }

/**
 * 实例编排：把中立的实例定义交给 `RuntimeDriver`，并守住**平台策略**。
 *
 * 这一层**不认识任何具体运行时**。策略（只允许拉平台自己仓库的镜像、同一 ref 的拉取去重）
 * 留在这里；机制（create/start/stop/日志/状态）全在 driver 里。
 *
 * 与 Docker 时代的差别：不再有独立网络、不再有入口接入、不再有容器 id ——
 * 实例的身份就是 `machineName`，入口靠 `hostPort` 转发。
 */
export class InstanceOrchestrator {
  /** 正在拉的镜像，按 ref 去重——两个实例同时要同一版时只拉一次。 */
  private readonly pulling = new Map<string, Promise<void>>()

  constructor(
    private readonly driver: RuntimeDriver,
    /** 平台自己的镜像仓库（`INSTANCE_IMAGE_REPO`）。只有它里面的镜像允许被拉。 */
    private readonly platformImageRepo: string,
  ) {}

  get runtime(): string {
    return this.driver.runtime
  }

  /** 现存的实例机器名（含 DB 里没有的孤儿）。对账器用来发现漂移，不做删除。 */
  listInstanceNames(): Promise<string[]> {
    return this.driver.listInstanceNames()
  }

  /** 一次拿全所有实例的实时状态，按机器名索引。 */
  async listInstanceStates(): Promise<Map<string, InstanceLiveState>> {
    const names = await this.driver.listInstanceNames()
    const states = new Map<string, InstanceLiveState>()
    await Promise.all(
      names.map(async (name) => {
        const s = await this.driver.status(name)
        if (s) states.set(name, s)
      }),
    )
    return states
  }

  /** 宿主上已有的镜像 tag（`repo:tag`），排序去空。 */
  async listImageTags(): Promise<string[]> {
    return [...new Set(await this.driver.listImageTags())].sort()
  }

  /** 运行时能不能报告本地有哪些镜像。为 false 时准入逻辑要跳过「本地有吗」那一关。 */
  get canReportLocalImages(): boolean {
    return this.driver.canReportLocalImages
  }

  imageExists(ref: string): Promise<boolean> {
    return this.driver.imageExists(ref)
  }

  /**
   * 确保镜像在宿主上，缺了就从注册表拉（D23）。本地优先——已有直接返回。
   *
   * **兜底**：microsandbox 下 `create` 会按 `if-missing` 自己拉，驱动的 `ensureImage`
   * 是空操作；留着这一层是为了别的运行时实现可能真的需要。
   */
  async ensureImage(ref: string): Promise<void> {
    if (await this.imageExists(ref)) return
    this.assertPullable(ref)

    const inFlight = this.pulling.get(ref)
    if (inFlight !== undefined) return inFlight

    const task = this.driver
      .ensureImage(ref)
      .catch((err: unknown) => {
        throw new Error(`拉取镜像 ${ref} 失败：${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => this.pulling.delete(ref))
    this.pulling.set(ref, task)
    return task
  }

  /**
   * 打开一条镜像预热的进度流（SSE 用，调用方负责 destroy）。
   *
   * 「已经在宿主上」的短路**归驱动管** —— 它会回一行「已在本机缓存，无需预热」。
   * 编排层这里再判一次只会返回一条**空流**，调用方看到的就是「什么都没有，只有 end」。
   *
   * `assertPullable` 仍在这里：它会真的出网，而 ref 来自库里的历史值。
   */
  async openImagePull(ref: string): Promise<Readable> {
    this.assertPullable(ref)
    return this.driver.openImagePull(ref)
  }

  /**
   * 只允许拉平台自己仓库里的镜像。这条路径会真的出网，而 ref 来自库里的历史值——
   * 不卡仓库，一个被改坏的 `instance.image` 就能让控制面去拉任意镜像。
   */
  private assertPullable(ref: string): void {
    if (imageRepo(ref) !== this.platformImageRepo) {
      throw new Error(`拒绝拉取非平台镜像（${this.platformImageRepo}）：${ref}`)
    }
  }

  /** 创建并启动实例。`spec`/`ctx` 里的 `hostPort` 由调用方分配并落库。 */
  async createInstance(spec: InstanceSpec, ctx: RenderContext): Promise<InstanceRuntime> {
    const rendered = await this.driver.create(spec, ctx)
    const state = await this.driver.status(rendered.machineName)
    return { ...rendered, status: state?.state ?? 'unknown' }
  }

  /** 停实例。已经停了或不存在，都当成功——调用方只关心最终状态。 */
  stopInstance(machineName: string): Promise<void> {
    return this.driver.stop(machineName)
  }

  /** 启动实例。已经在跑就当成功。 */
  startInstance(machineName: string): Promise<void> {
    return this.driver.start(machineName)
  }

  /**
   * 移除实例的运行时侧资源。**数据不在这一层**——它是宿主上的目录，
   * 要不要删由 `provisioner` 决定。
   */
  removeInstance(machineName: string): Promise<void> {
    return this.driver.remove(machineName)
  }

  async inspectStatus(machineName: string): Promise<string> {
    const state = await this.driver.status(machineName)
    return state?.state ?? 'unknown'
  }

  /**
   * 探服务本身。**不能用 `inspectStatus` 代替**：运行时会用空转容器顶替崩溃的工作负载，
   * 状态照样报 running（smolvm 实测），只有真连端口才分得清死活。
   */
  probeHealthy(machineName: string, hostPort: number): Promise<boolean> {
    return this.driver.probeHealthy(machineName, hostPort)
  }

  stats(machineName: string): Promise<InstanceUsage | undefined> {
    return this.driver.stats(machineName)
  }

  /** 工作负载日志（快照，非 follow）。 */
  async logs(machineName: string, opts: { tail: number }): Promise<Readable> {
    const text = await this.driver.logs(machineName, opts.tail)
    return Readable.from([text])
  }

  /** 在实例内执行命令并取回 stdout。 */
  async exec(machineName: string, cmd: string[]): Promise<string> {
    const r = await this.driver.exec(machineName, cmd)
    return r.stdout
  }

  /** 回收孤儿进程 / 端口漂移。 */
  heal(): Promise<void> {
    return this.driver.heal()
  }
}
