import { spawn } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface DataStoreOptions {
  /** 宿主数据目录的根（`HOST_STORAGE_ROOT`）。 */
  root: string
  /**
   * 数据目录的属主（`uid` 或 `uid:gid`）。**工作负载以这个 uid 运行**。
   *
   * 这是**guest 侧**期望的 uid（我们镜像是 `dsh` = 1000），由运行时的挂载选项
   * （microsandbox 的 `.owner(uid,gid)`）声明式地映射上去。宿主目录本身归谁无关紧要 ——
   * 那个 chown 只是尽力而为的兜底。
   */
  owner?: string
}

/**
 * 镜像期望的空目录骨架（相对于 `/data`）。
 *
 * `home/workspace` 对应 `WORKSPACE_DIR`；运行时在建配置时要校验它存在。
 */
const SKELETON_DIRS = ['home/workspace'] as const
/** 允许出现在「新建」目录里的顶层条目。 */
const SKELETON_TOP_LEVEL = new Set(['home'])

/** 磁盘用量。 */
export interface DataUsage {
  usedMb: number
}

/** 用量 + 配额，给管理台/详情页展示用。 */
export interface DiskUsage {
  usedMb: number
  quotaMb: number
}

/**
 * 实例数据的宿主侧管理。
 *
 * **与 Docker 时代的 `HostStorage` 的根本差别**：这里不再有 loop 设备、`mkfs.ext4`、
 * 挂载点、也**不再有 `nsenter` 进宿主** —— 也没有任何「挂载」动作。
 *
 * 这个目录就是**宿主的普通目录**，由运行时用 **virtiofs 直挂**（零拷贝）进沙箱当 `/data`。
 * 配额由**挂载选项**承载（不是文件系统大小），改配额 = 重建实例 —— 所以这里只剩
 * 「目录的生命周期」，没有任何 `resize`/`shrink`。
 */
export class DataStore {
  private readonly root: string
  private readonly owner: string

  constructor(opts: DataStoreOptions) {
    this.root = opts.root
    this.owner = opts.owner ?? String(process.getuid?.() ?? 1000)
  }

  /** 数据目录在该实例上的属主（`uid` 或 `uid:gid`）。**工作负载以它运行**。 */
  get ownerId(): string {
    return this.owner
  }

  /** 该实例的数据目录（virtiofs 直挂给沙箱当 `/data`）。 */
  dir(storageKey: string): string {
    return join(this.root, storageKey)
  }

  /** 升级/回退时用来存放上一版数据的目录。**与数据目录同一个文件系统**，好让复制快。 */
  snapshotDir(storageKey: string): string {
    return `${this.dir(storageKey)}.prev`
  }

  /**
   * 首次开通：建数据目录。
   *
   * **目录已存在且非空时拒绝**——这是本模块最重要的一条，继承自 D18：
   * 静默覆盖会把「数据丢了」伪装成「一切正常」，比报错糟得多。新建只走这里。
   */
  async create(storageKey: string): Promise<void> {
    const dir = this.dir(storageKey)
    await mkdir(dir, { recursive: true })
    const entries = await readdir(dir)
    // 允许**空骨架**存在（见 `ensureSkeleton`），其余一律视为「已有数据」而拒绝。
    const unexpected = entries.filter((e) => !SKELETON_TOP_LEVEL.has(e))
    if (unexpected.length > 0) {
      throw new Error(`数据目录 ${dir} 已存在且非空，拒绝当作新建（数据保护）`)
    }
    await this.ensureSkeleton(dir)
    await this.chown(dir)
  }

  /**
   * 建出镜像期望的那层**空目录骨架**。
   *
   * 为什么必须由平台建：运行时（microsandbox）在**建配置时**就校验
   * `WORKDIR` 在 guest 里存在 —— 而新实例的 `/data` 是空的，镜像里那句
   * `RUN mkdir -p /data/home/workspace` 早在构建期就结束了、运行时被挂载覆盖掉，
   * 所以不预先建出来就会直接报
   * `invalid config: workdir does not exist in guest: /data/home/workspace`，
   * 实例**起不来**。
   *
   * 只建空目录、幂等；`ensure` 也调它，所以重启路径同样能自愈。
   */
  private async ensureSkeleton(dir: string): Promise<void> {
    for (const rel of SKELETON_DIRS) {
      await mkdir(join(dir, rel), { recursive: true })
    }
  }

  /**
   * 幂等确保数据目录存在且可写。**绝不新建**——目录不见了就抛错，让上层看见。
   */
  async ensure(storageKey: string): Promise<void> {
    const dir = this.dir(storageKey)
    let s: Awaited<ReturnType<typeof stat>>
    try {
      s = await stat(dir)
    } catch {
      throw new Error(`数据目录 ${dir} 不存在（拒绝静默新建：那会把「数据丢了」伪装成正常）`)
    }
    if (!s.isDirectory()) throw new Error(`数据路径 ${dir} 不是目录`)
    // 骨架是空目录、幂等，补出来不影响「绝不新建」的语义（数据文件仍然绝不动）。
    await this.ensureSkeleton(dir)
  }

  /**
   * 宿主目录的用量。
   *
   * 只用于**展示和缩容预检**；真正的写上限由运行时的 `--storage` 兜底（guest 拿 ENOSPC，
   * 永远沾不满宿主的盘）。
   */
  async usage(storageKey: string): Promise<DataUsage | undefined> {
    return this.usageOf(this.dir(storageKey))
  }

  private async usageOf(dir: string): Promise<DataUsage | undefined> {
    try {
      const out = await this.exec(['du', '-sm', dir])
      const mb = Number(out.trim().split(/\s+/)[0])
      return Number.isFinite(mb) ? { usedMb: mb } : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 回滚快照（`.prev`）的占用。没有快照时返回 `undefined`。
   *
   * 管理台用它显示「有一份可回滚的数据，占多少」——回滚只有一次机会，
   * 用户要能看见这份保险还在不在、值不值得留。
   */
  async snapshotUsage(storageKey: string): Promise<DataUsage | undefined> {
    const dir = this.snapshotDir(storageKey)
    try {
      const s = await stat(dir)
      if (!s.isDirectory()) return undefined
    } catch {
      return undefined
    }
    return this.usageOf(dir)
  }

  /** 把当前数据复制一份到 `.prev`（升级/回退的唯一保险）。 */
  async snapshot(storageKey: string): Promise<void> {
    const src = this.dir(storageKey)
    const dst = this.snapshotDir(storageKey)
    await rm(dst, { recursive: true, force: true })
    await this.exec(['cp', '-a', src, dst])
  }

  /** 用 `.prev` 覆盖当前数据。回滚路径专用。 */
  async restoreSnapshot(storageKey: string): Promise<void> {
    const src = this.snapshotDir(storageKey)
    const dst = this.dir(storageKey)
    await this.exec(['cp', '-a', src, dst])
  }

  /** 丢掉 `.prev`。回滚只够用一次，用过就清（与 D19 同语义）。 */
  async dropSnapshot(storageKey: string): Promise<void> {
    await rm(this.snapshotDir(storageKey), { recursive: true, force: true })
  }

  /** 彻底删除数据。**不可逆**，只有 `purgeVolume` 路径会调。 */
  async destroy(storageKey: string): Promise<void> {
    await rm(this.dir(storageKey), { recursive: true, force: true })
    await rm(this.snapshotDir(storageKey), { recursive: true, force: true })
  }

  /**
   * 把目录交给运行用户。**尽力而为** —— 失败只告警，不阻断创建。
   *
   * 为什么可以不较真：现在的运行时（microsandbox）用挂载选项 `.owner(uid,gid)`
   * **声明式**地把宿主文件映射成 guest 侧的那个 uid，宿主目录本身归谁无关紧要。
   * 而 macOS 上非 root 进程 chown 到别的 uid 本来就会 EPERM，硬失败只会把
   * 「能跑」变成「起不来」。
   */
  private async chown(dir: string): Promise<void> {
    try {
      await this.exec(['chown', '-R', this.owner, dir])
    } catch {
      // 属主由运行时的挂载选项兜底，这里失败不影响实例可用。
    }
  }

  private exec(argv: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (b: Buffer) => (stdout += b.toString()))
      child.stderr.on('data', (b: Buffer) => (stderr += b.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve(stdout)
        else reject(new Error(`${argv.join(' ')} 失败（exit ${code}）：${stderr.trim()}`))
      })
    })
  }
}
