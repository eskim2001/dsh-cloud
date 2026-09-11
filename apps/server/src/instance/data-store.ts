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

/** 用量 + 容量，给管理台/详情页展示用。 */
export interface DiskUsage {
  usedMb: number
  quotaMb: number
}

/**
 * 实例数据的生命周期与策略。
 *
 * **与 Docker 时代的 `HostStorage`、以及「宿主目录直挂」那一版 `DataStore` 的根本差别**：
 * 这里没有宿主目录、没有 loop 设备、没有 `mkfs.ext4`、也没有 `nsenter`。数据是一块
 * **运行时管理的卷**（microsandbox 下是 ext4 磁盘卷），`storageKey` 就是它的名字；
 * 宿主上长什么样完全不是这个类该知道的事。
 *
 * 为什么换成卷：宿主目录直挂走的是 virtiofs passthrough，而那个后端有个硬链接 bug
 * （上游 #1559）—— unlink 掉两个名字中的一个，剩下的那个会**永久只读**，而 dsh 的会话
 * 日志每次落盘正是 `tmp → link → rm(tmp)`。见驱动的类注释。
 *
 * 代价：容量是**硬限制**，而且**不能原地扩容**，所以这里没有任何 `resize` / `shrink`。
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
   * 用量。只用于**展示**；真正的写上限由卷的容量兜底（灌满 guest 拿 ENOSPC，
   * 永远沾不满宿主的盘）。**停机时也读得到** —— 运行时自己的记账，不需要进 guest。
   */
  async usage(storageKey: string): Promise<DataUsage | undefined> {
    const usedMb = await this.driver.storageUsageMb(storageKey)
    return usedMb === undefined ? undefined : { usedMb }
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
   * 代价注意：从前 `.prev` 与活数据同目录，`cp` 只复制改动的文件；现在是一整块镜像，
   * 复制的是整卷（底层用写时复制，支持的文件系统上不真拷数据）。
   */
  async snapshot(storageKey: string): Promise<void> {
    await this.driver.removeStorage(this.snapshotKey(storageKey))
    await this.driver.copyStorage(storageKey, this.snapshotKey(storageKey))
  }

  /** 用 `.prev` 覆盖当前数据。回滚路径专用。 */
  async restoreSnapshot(storageKey: string): Promise<void> {
    // `copyStorage` 要求目标不存在，所以先把活卷删掉再复制回去。
    // 调用方（`rollbackTo`）已经停过沙箱，此时没有东西在用这块卷。
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
