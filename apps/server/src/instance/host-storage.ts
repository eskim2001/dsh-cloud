import type Docker from 'dockerode'
import { InstanceSlugSchema } from '@dsh-cloud/instance-spec'
import { demuxFrames } from '../docker/client.js'

/**
 * 实例数据的宿主存储（D18）。
 *
 * 每个实例 = 宿主上一个稀疏文件 `<root>/<slug>.img`（大小 = 磁盘配额），
 * `mkfs.ext4` 后经 loop 设备挂到 `<root>/<slug>`，容器 bind 这个目录当 `/data`。
 * **配额就是文件系统大小**——内核级硬限，不需要 quota 子系统。
 *
 * 为什么这么绕：Docker 的 `--storage-opt size=` 只限可写层（且在本机 Docker Desktop
 * 被静默忽略），池化 + XFS project quota 需要宿主装 xfsprogs，而 Docker Desktop 的
 * 宿主根是 LinuxKit，`nsenter` 进去之后容器里的工具不可见 → 开发机验不了。
 * 这条路径只依赖宿主自带的 `truncate / losetup / mkfs.ext4 / mount / chown / resize2fs`。
 *
 * 所有命令都经一个**短命特权助手容器**在宿主上执行：
 * `docker run --rm --privileged --pid=host <image> nsenter -t 1 -m -u -n -i sh -c <脚本>`。
 * 约束：脚本由本模块写死，只插入**已过白名单校验的 slug** 和整数，零用户输入拼接。
 */

/** 容器内跑 dsh 的用户（`node`，实测 uid/gid 都是 1000）。 */
const DATA_UID = 1000
const DATA_GID = 1000

export interface HostStorageConfig {
  /** 宿主目录，如 `/var/lib/dsh`。 */
  root: string
  /** 助手镜像。里面的工具用不上——`nsenter -t 1 -m` 后 PATH 解析到宿主根。 */
  helperImage: string
}

/** 宿主存储操作失败。**必须响亮**：容器绝不能带着空目录起来（否则像「数据没了」）。 */
export class HostStorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostStorageError'
  }
}

/** 已用 / 配额，单位 MB。 */
export interface DiskUsage {
  usedMb: number
  quotaMb: number
}

export class HostStorage {
  constructor(
    private readonly docker: Docker,
    private readonly config: HostStorageConfig,
  ) {}

  /** 该实例数据文件系统的挂载点（宿主路径）。容器 bind 的就是它。 */
  mountPoint(slug: string): string {
    return `${this.root}/${this.assertSlug(slug)}`
  }

  /** 数据文件（宿主路径）。 */
  imagePath(slug: string): string {
    return `${this.root}/${this.assertSlug(slug)}.img`
  }

  /**
   * 升级前快照（宿主路径）。**每实例最多一份**，下次升级覆盖。
   *
   * 放在 `.img` 旁边而不是别的目录，是为了「同一个文件系统」——回滚时 `mv` 是
   * rename，不是再复制一遍（`restoreSnapshot`）。
   */
  snapshotPath(slug: string): string {
    return `${this.root}/${this.assertSlug(slug)}.img.prev`
  }

  /**
   * **建**该实例的数据文件系统（只有 `provisioner.create` 该调）。已存在就退化成
   * `ensure`——重复调用安全。
   */
  async create(slug: string, diskMb: number): Promise<void> {
    await this.mountScript(slug, diskMb, 'create')
  }

  /**
   * 把已有存储调整到期望状态，幂等：挂载 → 容量对齐（只增）→ 交给 node 用户。
   *
   * **绝不新建**：数据文件不见了、或文件系统认不出来，一律抛错。这是本模块最重要
   * 的一条——静默建出一个空 ext4 会把「数据丢了」伪装成「一切正常」，比报错糟得多。
   * 新建只走 `create`。
   */
  async ensure(slug: string, diskMb: number): Promise<void> {
    await this.mountScript(slug, diskMb, 'ensure')
  }

  private async mountScript(
    slug: string,
    diskMb: number,
    mode: 'create' | 'ensure',
  ): Promise<void> {
    const allowCreate = mode === 'create' ? 1 : 0
    await this.run(`
      set -eu
      ROOT=${this.q(this.root)}
      IMG=${this.q(this.imagePath(slug))}
      MNT=${this.q(this.mountPoint(slug))}
      WANT=${this.bytes(diskMb)}
      ALLOW=${allowCreate}

      mkdir -p "$ROOT"

      if [ ! -f "$IMG" ]; then
        if [ "$ALLOW" -ne 1 ]; then
          echo "数据文件不存在：$IMG——拒绝创建空文件系统（数据可能已丢失）" >&2
          exit 7
        fi
        truncate -s "$WANT" "$IMG"
      fi

      LOOP=$(losetup -j "$IMG" | cut -d: -f1 | head -n1)
      if [ -z "$LOOP" ]; then LOOP=$(losetup --find --show "$IMG"); fi

      if ! blkid "$LOOP" >/dev/null 2>&1; then
        if [ "$ALLOW" -ne 1 ]; then
          echo "文件系统无法识别：$IMG——拒绝格式化（会抹掉已有数据）" >&2
          exit 8
        fi
        mkfs.ext4 -q -m 0 -F "$LOOP"
      fi

      mkdir -p "$MNT"
      if ! mountpoint -q "$MNT"; then mount "$LOOP" "$MNT"; fi

      HAVE=$(stat -c %s "$IMG")
      if [ "$HAVE" -lt "$WANT" ]; then
        truncate -s "$WANT" "$IMG"
        losetup -c "$LOOP"
        resize2fs "$LOOP" >/dev/null
      fi

      chown ${DATA_UID}:${DATA_GID} "$MNT"
    `)
  }

  /**
   * 挂载是否真的在（不是「目录存不存在」）。
   *
   * 判定必须用 `mountpoint`：目录存在但没挂载时，往 `/data` 写会落到宿主目录里，
   * 数据**分叉**——容器照常跑，看起来一切正常。
   */
  async isMounted(slug: string): Promise<boolean> {
    const out = await this.run(`
      set -eu
      if mountpoint -q ${this.q(this.mountPoint(slug))}; then echo yes; else echo no; fi
    `)
    return out === 'yes'
  }

  /** 前置断言：没挂上就抛，绝不让容器带着空目录起来。 */
  async assertMounted(slug: string): Promise<void> {
    if (!(await this.isMounted(slug))) {
      throw new HostStorageError(
        `实例 ${slug} 的数据文件系统未挂载（${this.mountPoint(slug)}）——拒绝启动容器，否则用户会看到空数据`,
      )
    }
  }

  /** 在线扩容。只在目标更大时调用；变小走 `shrink`。 */
  async resize(slug: string, diskMb: number): Promise<void> {
    await this.run(`
      set -eu
      IMG=${this.q(this.imagePath(slug))}
      WANT=${this.bytes(diskMb)}
      [ -f "$IMG" ] || { echo "数据文件不存在：$IMG" >&2; exit 4; }

      LOOP=$(losetup -j "$IMG" | cut -d: -f1 | head -n1)
      if [ -z "$LOOP" ]; then LOOP=$(losetup --find --show "$IMG"); fi

      HAVE=$(stat -c %s "$IMG")
      if [ "$HAVE" -gt "$WANT" ]; then echo "目标容量小于当前大小，请走缩容路径" >&2; exit 5; fi

      truncate -s "$WANT" "$IMG"
      losetup -c "$LOOP"
      resize2fs "$LOOP" >/dev/null
    `)
  }

  /**
   * 缩容。**调用方必须先停掉容器**（否则卸载不下来），卸载由本方法自己做——
   * 分两步的话总有人忘了第二步，而忘掉的后果是「缩容永远失败」。
   *
   * 缩不到已用之下时 `resize2fs` 会直接拒绝，这正是我们要的响亮失败。
   * 缩完保持未挂载，下次 `ensure` 重新挂。
   */
  async shrink(slug: string, diskMb: number): Promise<void> {
    await this.run(`
      set -eu
      IMG=${this.q(this.imagePath(slug))}
      MNT=${this.q(this.mountPoint(slug))}
      MB=${this.int(diskMb)}

      if mountpoint -q "$MNT"; then
        umount "$MNT" || { echo "文件系统仍在使用中（容器没停干净？），不能缩容：$MNT" >&2; exit 6; }
      fi

      LOOP=$(losetup -j "$IMG" | cut -d: -f1 | head -n1)
      if [ -z "$LOOP" ]; then LOOP=$(losetup --find --show "$IMG"); fi

      e2fsck -f -p "$LOOP" >/dev/null 2>&1 || true
      resize2fs "$LOOP" "\${MB}M" >/dev/null

      truncate -s "\${MB}M" "$IMG"
      losetup -d "$LOOP"
    `)
  }

  /**
   * 打升级前快照：**调用方必须先停掉容器**（否则复制出来的不是一致状态），
   * 卸载由本方法自己做——和 `shrink` 同一个约定，分两步总有人忘第二步。
   *
   * `cp --sparse=always` 把连续零块还原成洞，所以快照实占 ≈ 已用字节，
   * 不是配额大小（宿主是 GNU coreutils，实测 9.1）。复制失败（多半是宿主空间不足）
   * 会把半截文件删掉再抛——**绝不能留一个看起来能用的假快照**。
   *
   * 复制完保持未挂载，下次 `ensure` 重新挂。
   */
  async snapshot(slug: string): Promise<void> {
    await this.run(`
      set -eu
      IMG=${this.q(this.imagePath(slug))}
      SNAP=${this.q(this.snapshotPath(slug))}
      MNT=${this.q(this.mountPoint(slug))}

      [ -f "$IMG" ] || { echo "数据文件不存在：$IMG" >&2; exit 4; }

      if mountpoint -q "$MNT"; then
        umount "$MNT" || { echo "文件系统仍在使用中（容器没停干净？），不能打快照：$MNT" >&2; exit 6; }
      fi

      rm -f "$SNAP"
      if ! cp --sparse=always "$IMG" "$SNAP"; then
        rm -f "$SNAP"
        echo "复制数据文件失败（宿主空间不足？）：$IMG" >&2
        exit 9
      fi
    `)
  }

  /**
   * 用快照覆盖当前数据文件。**调用方必须先停掉容器**；卸载由本方法自己做。
   *
   * `mv` 在同一个目录里是 rename，不复制内容——快照就此被消费掉（回滚只有一步）。
   * 恢复后文件系统保持未挂载，`ensure` 会按当前配额把它（至少）对齐回去。
   */
  async restoreSnapshot(slug: string): Promise<void> {
    await this.run(`
      set -eu
      IMG=${this.q(this.imagePath(slug))}
      SNAP=${this.q(this.snapshotPath(slug))}
      MNT=${this.q(this.mountPoint(slug))}

      [ -f "$SNAP" ] || { echo "没有可回滚的快照：$SNAP" >&2; exit 10; }

      if mountpoint -q "$MNT"; then
        umount "$MNT" || { echo "文件系统仍在使用中（容器没停干净？），不能回滚：$MNT" >&2; exit 6; }
      fi

      LOOP=$(losetup -j "$IMG" | cut -d: -f1 | head -n1)
      if [ -n "$LOOP" ]; then losetup -d "$LOOP"; fi

      mv -f "$SNAP" "$IMG"
    `)
  }

  /** 删掉快照（升级确认无误 / 回滚已消费 / 实例被删）。幂等。 */
  async dropSnapshot(slug: string): Promise<void> {
    await this.run(`set -eu; rm -f ${this.q(this.snapshotPath(slug))}`)
  }

  /** 快照实占（MB，`du` 口径 = 分配块数，不是表观大小）。没有快照返回 undefined。 */
  async snapshotUsage(slug: string): Promise<number | undefined> {
    const out = await this.run(`
      set -eu
      SNAP=${this.q(this.snapshotPath(slug))}
      if [ ! -f "$SNAP" ]; then echo none; exit 0; fi
      du -sk "$SNAP" | cut -f1
    `)
    if (out === 'none' || out === '') return undefined
    const kb = Number(out)
    if (!Number.isFinite(kb)) throw new HostStorageError(`无法解析快照占用：${out}`)
    return Math.round(kb / 1024)
  }

  /** 彻底删除数据（不可逆）：卸载 → 摘 loop → 删文件 → 删空目录。快照一起删。 */
  async destroy(slug: string): Promise<void> {
    await this.run(`
      set -eu
      IMG=${this.q(this.imagePath(slug))}
      SNAP=${this.q(this.snapshotPath(slug))}
      MNT=${this.q(this.mountPoint(slug))}

      if mountpoint -q "$MNT"; then umount "$MNT"; fi

      LOOP=$(losetup -j "$IMG" | cut -d: -f1 | head -n1)
      if [ -n "$LOOP" ]; then losetup -d "$LOOP"; fi

      rm -f "$IMG" "$SNAP"
      rmdir "$MNT" 2>/dev/null || true
    `)
  }

  /** 已用磁盘（MB）。读文件系统超级块，不是 `du` 估算。未挂载返回 undefined。 */
  async usage(slug: string, quotaMb: number): Promise<DiskUsage | undefined> {
    const out = await this.run(`
      set -eu
      MNT=${this.q(this.mountPoint(slug))}
      if ! mountpoint -q "$MNT"; then echo unmounted; exit 0; fi
      df -Pk "$MNT" | awk 'NR==2{print $3}'
    `)
    if (out === 'unmounted' || out === '') return undefined
    const usedKb = Number(out)
    if (!Number.isFinite(usedKb)) {
      throw new HostStorageError(`无法解析磁盘用量：${out}`)
    }
    return { usedMb: Math.round(usedKb / 1024), quotaMb }
  }

  /**
   * 在宿主上跑一段脚本，返回 stdout（stderr 混在里面，便于报错时看到原因）。
   * 非零退出即抛——**存储操作没有「尽力而为」这一档**。
   */
  private async run(script: string): Promise<string> {
    const container = await this.docker.createContainer({
      Image: this.config.helperImage,
      Cmd: ['nsenter', '-t', '1', '-m', '-u', '-n', '-i', 'sh', '-c', script],
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        // 唯一需要特权的组件，且只在控制面进程内可达（见 ARCHITECTURE §五）
        Privileged: true,
        PidMode: 'host',
        // 进了宿主网络命名空间，容器自己不需要网络
        NetworkMode: 'none',
      },
    })

    try {
      const stream = await container.attach({ stream: true, stdout: true, stderr: true })
      const chunks: Buffer[] = []
      const drained = new Promise<void>((resolve, reject) => {
        stream.on('data', (c: Buffer) => chunks.push(c))
        stream.on('end', resolve)
        stream.on('error', reject)
      })

      await container.start()
      const { StatusCode } = await container.wait()
      await drained

      const output = demuxFrames(Buffer.concat(chunks)).trim()
      if (StatusCode !== 0) {
        throw new HostStorageError(
          `宿主存储操作失败（exit ${String(StatusCode)}）：${output === '' ? '(无输出)' : output}`,
        )
      }
      return output
    } finally {
      await container.remove({ force: true }).catch(() => undefined)
    }
  }

  /** 单引号包裹，内部单引号按 shell 惯例转义。 */
  private q(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`
  }

  private bytes(diskMb: number): string {
    return String(this.int(diskMb) * 1024 * 1024)
  }

  private int(value: number): number {
    if (!Number.isInteger(value) || value <= 0) {
      throw new HostStorageError(`磁盘配额必须是正整数 MB，收到 ${String(value)}`)
    }
    return value
  }

  /** slug 早已过 `InstanceSlugSchema`，这里再断一次——路径由它拼出来。 */
  private assertSlug(slug: string): string {
    const parsed = InstanceSlugSchema.safeParse(slug)
    if (!parsed.success) throw new HostStorageError(`非法实例标识：${slug}`)
    return parsed.data
  }

  private get root(): string {
    return this.config.root.replace(/\/+$/, '')
  }
}
