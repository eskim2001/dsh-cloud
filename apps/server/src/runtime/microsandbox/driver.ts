import { randomUUID } from 'node:crypto'
import { constants, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import {
  Image,
  Sandbox,
  SandboxBuilder,
  Volume,
  VolumeAlreadyExistsError,
  VolumeNotFoundError,
  type ExecHandle,
  type SandboxHandle,
} from 'microsandbox'
import type { InstanceSpec, RenderContext, RenderedInstance } from '@dsh-cloud/instance-spec'
import { MACHINE_PREFIX, renderInstance } from '@dsh-cloud/instance-spec'
import {
  StorageExistsError,
  StorageNotFoundError,
  type InstanceLiveState,
  type InstanceUsage,
  type RuntimeDriver,
} from '../driver.js'

export interface MicrosandboxDriverOptions {
  /** pull 策略：`if-missing`（默认，有缓存就不重拉）/ `always` / `never`（断网跑）。 */
  pullPolicy?: 'always' | 'if-missing' | 'never'
}

/**
 * microsandbox 运行时驱动。**走官方 TypeScript SDK，不 shell out 到 `msb`。**
 *
 * 为什么用 SDK 而不是 CLI：msb **没有 `--json`** —— 实测 `list` / `metrics` /
 * `image ls` 都是人读的表格，CLI 集成只能解析表格列，版本一改就碎。
 * SDK 是 napi-rs 原生绑定 + 完整类型，配额/属主/挂载都是结构化参数，
 * 且自带 `ping()` / `metrics()` / `logs()` 这些我们本来要自己凑的能力。
 *
 * 存储模型：`/data` 是一块 **ext4 数据卷**（真块设备），不是宿主目录。
 *
 * **不能用宿主目录直挂。** passthrough（virtiofs）后端有个 bug（上游 #1559）：一个文件
 * 有两个硬链接名字时，**unlink 掉其中一个**会让剩下的那个名字**永久只读** ——
 * `write` → EBADF、`ftruncate` → EINVAL、读正常、重启沙箱才恢复。而 dsh 的会话日志
 * 首次落盘正是 `open(tmp,'wx') → link(tmp, final) → rm(tmp)`，于是每建一个会话就中招一次。
 * 同一段代码在 ext4 卷上完全正常（实测：同样的链接数轨迹 1→2→1，唯一变量是后端）。
 *
 * 代价写在 `createStorage` / `copyStorage` 上：硬容量、**不能原地扩容**、卷底限 128 MiB。
 *
 * 另外两条 SDK 的脾气：
 * - 负载在 guest 里跑 **root** —— `.owner()` 对磁盘卷无效，ext4 根目录归 root，
 *   而我们的写入全在 `/data` 上，所以没有降权的余地（产品决策，见 D31）。
 * - **`create` / `startDetached` 都只开机，不跑镜像的 ENTRYPOINT** —— 必须再补一次
 *   `execDefaultStream()` 才会把工作负载拉起来（实测：不补的话 guest 里一个监听都没有）。
 */
/** 预热用的一次性沙箱名前缀。**必须**和 `MACHINE_PREFIX` 不同，否则对账器会把它当成实例。 */
const PREWARM_PREFIX = 'dsh-prewarm-'

/**
 * 数据卷里那个镜像文件的名字。**这是 microsandbox 的私有布局**
 * （`<MSB_HOME>/volumes/<name>/disk.raw`）—— 公开 API 不给卷的路径，复制卷只能按名字找。
 * 上游哪天改了，这里会先炸 `copyStorage`（而不是悄悄复制了一份空镜像）。
 */
const DISK_IMAGE = 'disk.raw'

export class MicrosandboxDriver implements RuntimeDriver {
  readonly runtime = 'microsandbox'
  readonly canReportLocalImages = true

  /**
   * 正在预热的版本 → 它的一次性沙箱名（还没建出来时是 `null`）。两个用途：
   * 同一版本重复调用时去重；`heal()` 靠它避开本进程正在跑的那几台。
   */
  private readonly prewarming = new Map<string, string | null>()

  /**
   * 工作负载的 exec 句柄，按机器名存着。
   *
   * **必须持有引用**：`execDefaultStream()` 返回的句柄就是那条后台命令的会话，丢掉引用
   * 之后它会被回收，**连接一拆命令就跟着死**。症状极具迷惑性 —— 沙箱状态 running、
   * 端口却没人监听、`/data` 空的、guest 里连 tini 都没有，而且**时好时坏**（取决于 GC
   * 时机）。实测：同一段代码，保留句柄 `dsh web` 正常起来，丢掉就一个进程都没有。
   */
  private readonly workloads = new Map<string, ExecHandle>()

  constructor(private readonly opts: MicrosandboxDriverOptions = {}) {}

  // ---------------- 镜像 ----------------

  /**
   * **无操作** —— SDK 没有独立的 pull；拉取由沙箱的 pull 策略在 create 时发生。
   * 保留这个方法是为了让「先确认镜像再有实例」这个顺序在编排层仍然成立。
   */
  async ensureImage(_ref: string): Promise<void> {
    // 故意留空：`create` 的 pullPolicy 负责拉。
  }

  async imageExists(ref: string): Promise<boolean> {
    try {
      await Image.get(ref)
      return true
    } catch {
      return false
    }
  }

  async listImageTags(): Promise<string[]> {
    const images = await Image.list()
    return images.map(imageRef).filter((r) => r.includes(':'))
  }

  /**
   * 预热：把镜像提前拉到本机缓存，免得用户第一次创建这个版本时要等下载。
   *
   * SDK **没有独立的 pull**（`Image` 只有 get / list / inspect / load / save / remove / prune），
   * 唯一能把镜像落进缓存的入口是**建沙箱时的拉取** —— 所以这里起一台一次性沙箱
   * （`createWithPullProgress()`），拉完立刻拆掉。
   *
   * 几个刻意的选择：
   * - **不调 `execDefaultStream()`**：那一步才会跑镜像的 ENTRYPOINT。预热只要镜像，不要工作负载。
   * - **workdir 显式给 `/`**：镜像自带的 WORKDIR 是 `/data/home/workspace`，那要靠实例挂载
   *   才存在；预热沙箱没有任何挂载，用镜像默认值会直接报
   *   `invalid config: workdir does not exist in guest`。
   * - 名字用 `dsh-prewarm-` 前缀：`listInstanceNames` 只认 `dsh-instance-`，残留不会被当成实例。
   * - `if-missing`：已经缓存的不该再走一遍网络。
   *
   * 失败**以流内的一行错误呈现，不往外抛**：调用方（`instance/pull-stream.ts`）只把
   * `openImagePull` 这个调用本身抛出的错转成错误事件 —— 流已经返回之后再抛就没人接了。
   */
  async openImagePull(ref: string): Promise<Readable> {
    // 同一版本重复点：**不共享进度流**（流是单消费者的，共享会互相吃掉事件），直接跳过。
    if (this.prewarming.has(ref)) {
      return Readable.from([`${ref} 正在预热中，这次跳过\n`])
    }
    this.prewarming.set(ref, null)
    return Readable.from(this.prewarm(ref))
  }

  private async *prewarm(ref: string): AsyncGenerator<string> {
    let name: string | null = null
    try {
      // 已经缓存就别开 VM 了。查不到（运行时抖了）当作没缓存，继续走真拉取。
      if (await this.imageExists(ref).catch(() => false)) {
        yield `${ref} 已在本机缓存，无需预热\n`
        return
      }

      name = `${PREWARM_PREFIX}${randomUUID().slice(0, 8)}`
      this.prewarming.set(ref, name)

      const pull = await new SandboxBuilder(name)
        .image(ref)
        .cpus(1)
        .memory(512)
        .detached(true)
        .workdir('/')
        .pullPolicy('if-missing')
        .createWithPullProgress()

      // 逐字节的进度事件刷得极快，按「整 MiB 变过才出一行」压缩（见 pullLine）。
      let last = ''
      for await (const event of pull) {
        const line = pullLine(event)
        if (line === undefined || line === last) continue
        last = line
        yield `${line}\n`
      }
      await pull.awaitSandbox()
      yield `预热完成：${ref}\n`
    } catch (err) {
      yield `预热失败：${err instanceof Error ? err.message : String(err)}\n`
    } finally {
      this.prewarming.delete(ref)
      // 一次性沙箱，成败都要拆。remove 本身幂等，再兜一层免得覆盖上面的错误。
      // 客户端中途断开时生成器会被 `return()`，这里同样会跑到。
      if (name !== null) await Sandbox.remove(name).catch(() => undefined)
    }
  }

  // ---------------- 存储（实例数据卷）----------------

  /**
   * 建数据卷。同名卷已存在 → `StorageExistsError`。
   *
   * 这条就是 D18「绝不静默覆盖」的落点：`Volume.builder().create()` 在有同名卷时抛
   * `VolumeAlreadyExistsError`，正好是我们想要的语义。
   *
   * **建卷只走这里，挂载一律 `'existing'`** —— 挂载时顺手建卷（`mode: 'create'`）会把
   * 这条保护抵消掉：同名卷被静默复用，而调用方以为刚建了一块新的。
   *
   * `sizeMb` 有下限：64 MiB 会报 `image size is too small for ext4 formatting`，
   * 所以上层 schema 的 `diskMb` 下限是 128。
   */
  async createStorage(key: string, sizeMb: number): Promise<void> {
    try {
      await Volume.builder(key).disk().size(sizeMb).create()
    } catch (err) {
      if (err instanceof VolumeAlreadyExistsError) {
        throw new StorageExistsError(`数据卷 ${key} 已存在，拒绝当作新建（数据保护）`)
      }
      throw err
    }
  }

  /** 数据卷在不在。不在 → `StorageNotFoundError`，**绝不新建**。 */
  async ensureStorage(key: string): Promise<void> {
    try {
      await Volume.get(key)
    } catch (err) {
      if (err instanceof VolumeNotFoundError) {
        throw new StorageNotFoundError(
          `数据卷 ${key} 不存在（拒绝静默新建：那会把「数据丢了」伪装成正常）`,
        )
      }
      throw err
    }
  }

  /** 删掉这一块卷。幂等。**只删这一个 key** —— 快照卷由 `DataStore` 按 .prev 命名去删。 */
  async removeStorage(key: string): Promise<void> {
    await Volume.remove(key).catch(() => undefined)
  }

  /**
   * 已用容量（MiB）。`usedBytes` 是运行时自己的记账，**停机时也读得到**，
   * 不需要进 guest 跑 `du`。卷不在 → `undefined`。
   */
  async storageUsageMb(key: string): Promise<number | undefined> {
    try {
      const vol = await Volume.get(key)
      return Math.round(vol.usedBytes / 1024 / 1024)
    } catch {
      return undefined
    }
  }

  /**
   * 整卷复制成另一块卷（升级/回退的唯一保险）。
   *
   * 做法：按源卷的容量建一块新卷（已存在就抛），再把源卷的 `disk.raw` 整块复制过去。
   *
   * ⚠️ **这耦合了 microsandbox 的私有布局** `<MSB_HOME>/volumes/<name>/disk.raw`：
   * 公开 API 没有「卷克隆」，`Volume.get()` 给的 handle 也不带路径（只有
   * `builder.create()` 的返回值有 `.path`）。所以这里**不硬编码 MSB_HOME**，
   * 而是先建出目标卷、从它的 `path` 反推 `volumes/` 父目录，再去拼源镜像的路径。
   *
   * **前提：源沙箱已经停了** —— 调用方（`provisioner.setImage`）保证这一点。
   * 实测停掉之后 `disk.raw` 是完整的、没有 `.part` 残留。
   *
   * 复制用 `COPYFILE_FICLONE`：支持写时复制的文件系统（APFS / btrfs / xfs）上不真拷数据，
   * 没有就自动退回普通复制。
   */
  async copyStorage(fromKey: string, toKey: string): Promise<void> {
    const src = await Volume.get(fromKey).catch(() => undefined)
    if (src === undefined) {
      throw new StorageNotFoundError(`数据卷 ${fromKey} 不存在，无法复制`)
    }
    if (src.capacityBytes === null) {
      throw new Error(`数据卷 ${fromKey} 没有容量信息，无法复制`)
    }

    let dst: Awaited<ReturnType<ReturnType<typeof Volume.builder>['create']>>
    try {
      dst = await Volume.builder(toKey).disk().size(Math.ceil(src.capacityBytes / 1024 / 1024)).create()
    } catch (err) {
      if (err instanceof VolumeAlreadyExistsError) {
        throw new StorageExistsError(`快照卷 ${toKey} 已存在，拒绝覆盖`)
      }
      throw err
    }

    const volumesDir = dirname(dst.path)
    await copyFile(
      join(volumesDir, fromKey, DISK_IMAGE),
      join(volumesDir, toKey, DISK_IMAGE),
      constants.COPYFILE_FICLONE,
    )
  }

  // ---------------- 生命周期 ----------------

  async create(spec: InstanceSpec, ctx: RenderContext): Promise<RenderedInstance> {
    const r = renderInstance(spec, ctx)

    const builder = new SandboxBuilder(r.machineName)
      .image(r.image)
      .cpus(spec.quota.cpus)
      .memory(spec.quota.memoryMb)
      // **不开 detached 就不会跑镜像的命令** —— 那 dsh 永远不会启动。
      .detached(true)
      // 挂载点自身（`/data`）。**不能给 `/data/home/workspace`**：运行时会校验 WORKDIR
      // 在 guest 里存在，而空 ext4 里还没有那层骨架 —— 那句 `mkdir` 现在归镜像的
      // entrypoint 做（它建完骨架再 cd 进去，保证 dsh 的 cwd 不变）。
      .workdir(r.workingDir)
      // 负载跑 root：ext4 数据卷的根目录归 root，而 `.owner()` 对磁盘卷无效
      // （`mount owner is only valid for directory named volumes`）。见类注释。
      .user(r.user)
      .replace() // 幂等：同名残留直接替换

    for (const kv of r.env) {
      const eq = kv.indexOf('=')
      if (eq > 0) builder.env(kv.slice(0, eq), kv.slice(eq + 1))
    }
    for (const [k, v] of Object.entries(r.labels)) builder.label(k, v)

    // 宿主端口只发布到回环；guest 侧是桥（caddy）的端口。
    builder.port(r.hostPort, r.guestPort)

    for (const m of r.mounts) {
      // **`'existing'`：挂载绝不建卷。** 建卷是 `createStorage` 的事，那里有 D18 的
      // 「同名就拒」保护；这里若用 `'create'` 会静默把同名卷复用掉，正好抵消那条保护。
      builder.volume(m.guest, (v) => v.namedWith(m.storageKey, 'existing', 'disk'))
    }

    if (this.opts.pullPolicy !== undefined) builder.pullPolicy(this.opts.pullPolicy)

    // ⚠️ 终止方法是 **`create()`**，不是 `build()` —— `build()` 只产出配置对象、
    // 不开机（实测：它返回一个 `{name, image, resources, ...}` 的 config）。
    const sb = await builder.create()

    // ⚠️ **`create()` 只建沙箱、不跑镜像的 ENTRYPOINT。** 实测：建完之后 guest 里
    // 一个监听都没有；必须再 `execDefaultStream()` 才会把 caddy+dsh 拉起来
    //（它是流式句柄，命令在后台继续跑 —— 正是我们这种常驻服务要的语义）。
    //
    // ⚠️⚠️ 句柄**必须存起来**（见 `workloads` 的注释）：丢掉引用 = 命令被杀。
    this.workloads.set(r.machineName, await sb.execDefaultStream())
    return r
  }

  /**
   * 拉起一个停掉的实例。
   *
   * ⚠️ 必须用 **`startDetached`**：普通 `start` 只把机器开机，**不会重跑镜像的
   * ENTRYPOINT**（SDK 把这两件事分开）。我们要的是「实例带着 dsh 跑起来」。
   */
  async start(machineName: string): Promise<void> {
    const sb = await Sandbox.startDetached(machineName)
    // **同理**：`startDetached` 只把机器开机，workload 不会自己回来（实测：
    // stop → startDetached 之后 guest 里没有监听；补一次 `execDefaultStream` 才有）。
    // 新的句柄覆盖旧的，旧的连接已经被 stop 断掉了。
    this.workloads.set(machineName, await sb.execDefaultStream())
  }

  /** 停实例。已经停了或不存在都当成功。 */
  async stop(machineName: string): Promise<void> {
    // 先放手：句柄存着的话连接会一直挂着
    this.workloads.delete(machineName)
    const h = await this.handle(machineName)
    if (h === undefined) return
    await h.stop()
  }

  /** 幂等删除。不存在也算成功。 */
  async remove(machineName: string): Promise<void> {
    this.workloads.delete(machineName)
    try {
      await Sandbox.remove(machineName)
    } catch {
      // 不存在 —— 幂等语义下算成功。
    }
  }

  private async handle(machineName: string): Promise<SandboxHandle | undefined> {
    try {
      return await Sandbox.get(machineName)
    } catch {
      return undefined
    }
  }

  // ---------------- 观测 ----------------

  async status(machineName: string): Promise<InstanceLiveState | undefined> {
    const h = await this.handle(machineName)
    if (h === undefined) return undefined
    // `status` 是同步 getter（`get status(): string`），不是 Promise。
    const raw = h.status
    return { state: normalizeState(raw), statusText: raw }
  }

  async listInstanceNames(): Promise<string[]> {
    // `SandboxPage = { sandboxes: SandboxHandle[]; nextCursor?: string }`；
    // 且 handle 的 `name` 是**异步 getter**（`get name(): Promise<string>`）。
    const page = await Sandbox.list()
    const names: string[] = []
    for (const s of page.sandboxes) {
      const n = await s.name
      if (n.startsWith(MACHINE_PREFIX)) names.push(n)
    }
    return names
  }

  /**
   * 探服务本身。SDK 自带 `ping()`（走 agent 通道）—— 比在宿主上探端口更准：
   * 它验的是「沙箱活着且 agent 应答」，不只是「有个进程占着端口」。
   */
  async probeHealthy(machineName: string, _hostPort: number): Promise<boolean> {
    const h = await this.handle(machineName)
    if (h === undefined) return false
    try {
      // `SandboxPingResult` 只有 `{ name, latencyMs }` —— **没有 ok/reachable**。
      // 语义是「resolve 就通，throw 就不通」。
      await h.ping()
      return true
    } catch {
      return false
    }
  }

  async logs(machineName: string, tail: number): Promise<string> {
    const h = await this.handle(machineName)
    if (h === undefined) return ''
    // `LogEntry.data` 是 Buffer（正文），不是 message/line。
    const entries = await h.logs({ tail })
    return entries.map((e) => e.data.toString()).join('')
  }

  async exec(machineName: string, argv: string[]): Promise<{ code: number; stdout: string }> {
    const h = await this.handle(machineName)
    if (h === undefined) throw new Error(`实例不存在：${machineName}`)
    const [cmd, ...args] = argv
    if (cmd === undefined) throw new Error('exec 至少需要一个参数')
    // exec 在 `Sandbox` 上（不在 handle 上），handle 得先 connect。
    const sandbox = await h.connect()
    const out = await sandbox.exec(cmd, args)
    // `ExecOutput`：`code` 是 getter，`stdout()`/`stderr()` 是方法。
    return { code: out.code, stdout: out.stdout() + out.stderr() }
  }

  /** SDK 的 `metrics()` 直接给出结构化用量（smolvm 那边根本没有采样接口）。 */
  async stats(machineName: string): Promise<InstanceUsage | undefined> {
    const h = await this.handle(machineName)
    if (h === undefined) return undefined
    try {
      // `SandboxMetrics`：`cpuPercent` + `memoryBytes` 都是必需字段。
      const m = await h.metrics()
      return { cpuPercent: m.cpuPercent, memMb: m.memoryBytes / 1024 / 1024 }
    } catch {
      return undefined
    }
  }

  /**
   * 回收孤儿。预热的沙箱是「建了就该拆」的一次性资源：进程被打断（重启 / 崩溃 / 强杀）
   * 会留下 `dsh-prewarm-*`，而 `listInstanceNames` 只认 `dsh-instance-` 前缀，
   * 对账器看不见它们 —— 不在这里收就一直占着磁盘。
   *
   * **跳过本进程正在跑的那几台**（名字存在 `prewarming` 里），别把自己的活儿拆了。
   */
  async heal(): Promise<void> {
    const active = new Set(this.prewarming.values())
    const page = await Sandbox.list().catch(() => undefined)
    if (page === undefined) return
    for (const s of page.sandboxes) {
      const name = await s.name
      if (!name.startsWith(PREWARM_PREFIX) || active.has(name)) continue
      await Sandbox.remove(name).catch(() => undefined)
    }
  }
}

/** 从 SDK 的镜像对象里取引用串。 */
function imageRef(i: { reference?: string; ref?: string }): string {
  return i.reference ?? i.ref ?? ''
}


function normalizeState(raw: string | undefined): string {
  switch ((raw ?? '').toLowerCase()) {
    case 'running':
      return 'running'
    case 'stopped':
    case 'exited':
      return 'stopped'
    case 'created':
    case 'starting':
      return 'created'
    default:
      return 'unknown'
  }
}

/**
 * SDK 的进度事件（原生层叫 `NapiPullProgressEvent`）是扁平的可选字段结构，
 * 没有从包根导出，所以这里按用到的字段自己声明一份形状。
 */
interface PullProgressEvent {
  kind: string
  reference?: string
  layerCount?: number
  totalDownloadBytes?: number
  layerIndex?: number
  downloadedBytes?: number
  totalBytes?: number
}

/**
 * 把一个进度事件拍成给人看的一行。返回 `undefined` = 这一档不显示。
 *
 * `layerDownloadProgress` 是按 chunk 发的，所以字节数**取整到 MiB** —— 调用方再去重，
 * 于是每 MiB 才出一行。不这么做进度框会被瞬间刷屏（对话框虽然会裁到 500 行，
 * 但刷屏本身既没用又费带宽）。
 */
function pullLine(event: PullProgressEvent): string | undefined {
  const layer = event.layerIndex === undefined ? '' : `第 ${event.layerIndex + 1} 层 `
  switch (event.kind) {
    case 'resolving':
      return `解析 ${event.reference ?? ''} …`
    case 'resolved':
      return event.totalDownloadBytes === null || event.totalDownloadBytes === undefined
        ? `共 ${event.layerCount ?? 0} 层`
        : `共 ${event.layerCount ?? 0} 层，${mib(event.totalDownloadBytes)} 待下载`
    case 'layerDownloadProgress':
      return `下载 ${layer}${mib(event.downloadedBytes ?? 0)} / ${mib(event.totalBytes ?? 0)}`
    case 'layerDownloadComplete':
      return `${layer}下载完成`
    case 'layerMaterializeComplete':
      return `${layer}写入缓存`
    case 'stitchComplete':
      return '合并文件系统'
    case 'complete':
      return `镜像就绪（${event.layerCount ?? 0} 层）`
    default:
      return undefined
  }
}

function mib(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MiB`
}
