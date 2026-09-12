import type { RuntimeDriver } from '../runtime/driver.js'

export interface DataStoreOptions {
  /**
   * 数据卷的原语在运行时驱动上：**卷是运行时的概念** —— 宿主路径、卷名、镜像落在哪，
   * 全由它决定。这个类只留**策略**：绝不静默覆盖、快照只够用一次、快照怎么命名。
   */
  driver: RuntimeDriver
}

/** 磁盘用量。 */
export interface DataUsage {
  usedMb: number
}

/** 用量 + 容量 + **这个容量到底管不管用**，给管理台/详情页展示用。 */
export interface DiskUsage {
  usedMb: number
  quotaMb: number
  /**
   * 这份配额**真的在生效**吗。
   *
   * `false` = 只有声明值（开发机内核不支持，或是池化之前建的命名卷实例）。
   * **UI 必须如实呈现** —— 显示一个其实没生效的上限比不显示更糟。
   */
  enforced: boolean
}

/**
 * 实例数据的生命周期与策略。
 *
 * **与「宿主目录直挂」那一版 `DataStore` 的根本差别**：这里没有宿主目录、没有 loop 设备、
 * 没有 `mkfs.ext4`、也没有 `nsenter`。数据是一块 **Docker 命名卷**，`storageKey` 就是它的
 * 名字；宿主上长什么样完全不是这个类该知道的事。
 *
 * 为什么用命名卷而不是宿主目录直挂：直挂要走 Docker Desktop 的 VM 共享文件系统那一层，
 * 而它有硬链接语义问题（上游 #1559）——unlink 掉两个名字中的一个，剩下的那个会**永久只读**，
 * 而 dsh 的会话日志每次落盘正是 `tmp → link → rm(tmp)`。命名卷是 VM 里的真文件系统，
 * 没有这个问题。见驱动的类注释。
 *
 * 代价：Docker 命名卷**没有硬容量配额**，声明值只记进卷的 label，所以这里没有任何
 * `resize` / `shrink`。
 */
export class DataStore {
  private readonly driver: RuntimeDriver

  constructor(opts: DataStoreOptions) {
    this.driver = opts.driver
  }

  /** 快照卷的 key。回滚只够用一次，用过就删（与 D19 同语义）。 */
  snapshotKey(storageKey: string): string {
    return `${storageKey}.prev`
  }

  /**
   * 首次开通：建数据卷。
   *
   * **卷已存在就抛**（驱动抛 `StorageExistsError`）—— 这是本模块最重要的一条，继承自
   * D18：静默复用会把「这块卷里已经有别人的数据」伪装成「一切正常」，比报错糟得多。
   * 新建只走这里。
   */
  async create(storageKey: string, sizeMb: number): Promise<void> {
    await this.driver.createStorage(storageKey, sizeMb)
  }

  /** 幂等确保数据卷在。**绝不新建** —— 卷不见了就抛错，让上层看见。 */
  async ensure(storageKey: string): Promise<void> {
    await this.driver.ensureStorage(storageKey)
  }

  /**
   * 用量。只用于**展示**。命名卷**没有硬配额**，真正的写上限要宿主侧文件系统配额
   * （XFS project quota，见 `DockerDriver.createStorage`）来兜。**停机时也读得到** ——
   * 卷不依赖容器在跑。
   */
  async usage(storageKey: string): Promise<DataUsage | undefined> {
    const usedMb = await this.driver.storageUsageMb(storageKey)
    return usedMb === undefined ? undefined : { usedMb }
  }

  /** 这个 key 的数据**实际**有没有硬配额（`false` = 命名卷：开发机，或池化之前建的实例）。 */
  async enforced(storageKey: string): Promise<boolean> {
    return await this.driver.storageEnforced(storageKey)
  }

  /**
   * 一次读所有实例的用量（key → MiB）。列表页每行都要显示磁盘，逐行读就是 N 次调用。
   * **拿不到返回 `undefined`**（命名卷退路）—— 调用方据此显示"暂无数据"，别编一个 0。
   */
  async usageAll(): Promise<Map<string, number> | undefined> {
    return await this.driver.storageUsageAll()
  }

  /**
   * 回滚快照（`.prev`）的占用。没有快照时返回 `undefined`。
   *
   * 管理台用它显示「有一份可回滚的数据，占多少」—— 回滚只有一次机会，
   * 用户要能看见这份保险还在不在、值不值得留。
   */
  async snapshotUsage(storageKey: string): Promise<DataUsage | undefined> {
    return this.usage(this.snapshotKey(storageKey))
  }

  /**
   * 把当前数据整卷复制一份到 `.prev`（升级/回退的唯一保险）。
   *
   * 先删掉可能存在的旧快照再复制：`copyStorage` 对已存在的目标是**拒绝**的，
   * 正好逼着我们把这个决定写出来，而不是让它悄悄覆盖。
   *
   * 代价注意：从前 `.prev` 与活数据同目录，改名/硬链接就能当快照；现在两卷之间是
   * 整卷 `cp -a`（辅助容器里做），复制的是全量数据。
   */
  async snapshot(storageKey: string): Promise<void> {
    await this.driver.removeStorage(this.snapshotKey(storageKey))
    await this.driver.copyStorage(storageKey, this.snapshotKey(storageKey))
  }

  /** 用 `.prev` 覆盖当前数据。回滚路径专用。 */
  async restoreSnapshot(storageKey: string): Promise<void> {
    // `copyStorage` 要求目标不存在，所以先把活卷删掉再复制回去。
    // 调用方（`rollbackTo`）已经停过容器，此时没有东西在用这块卷。
    await this.driver.removeStorage(storageKey)
    await this.driver.copyStorage(this.snapshotKey(storageKey), storageKey)
  }

  /** 丢掉 `.prev`。回滚只够用一次，用过就清（与 D19 同语义）。 */
  async dropSnapshot(storageKey: string): Promise<void> {
    await this.driver.removeStorage(this.snapshotKey(storageKey))
  }

  /** 彻底删除数据。**不可逆**，只有 `purgeVolume` 路径会调。 */
  async destroy(storageKey: string): Promise<void> {
    await this.driver.removeStorage(storageKey)
    await this.driver.removeStorage(this.snapshotKey(storageKey))
  }
}
