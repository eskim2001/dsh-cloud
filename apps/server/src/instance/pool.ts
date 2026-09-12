import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** XFS 的 superblock magic（`'XFSB'`）。`statfs` 用它认"这块是不是 XFS"。 */
const XFS_SUPER_MAGIC = 0x58465342

/** 探针用的 project ID。取一个不会和真实实例撞的高位值。 */
const PROBE_PROJID = 0xfffffffe

/** 探针目录名。**别用 `.` 开头以外的东西** —— 它只活几毫秒。 */
const PROBE_DIR = '.dsh-pool-probe'

/** 池子边界检查：key 由平台生成（32 位十六进制，或它的 `.prev`），不接受别的形状。 */
const KEY_PATTERN = /^[a-f0-9]{32}(\.prev)?$/

export class StoragePoolError extends Error {}

export interface StoragePool {
  /** 池子根。`enforced === false` 时也可能有值（宿主上那个目录仍然存在）。 */
  root: string
  /**
   * 能不能**真的**强制硬配额。
   *
   * `false` 只应出现在开发机（macOS / Docker Desktop）——它的内核把配额整块裁了。
   * 这时调用方**必须**把"无硬配额"呈现给用户，别让它看着像有上限。
   */
  enforced: boolean
  /** 判定依据，进日志用。 */
  detail: string
}

export interface PoolOptions {
  /** 池子根（`HOST_STORAGE_ROOT`）。 */
  root: string
  /** 只在需要建 loopback 镜像时用；省略则取宿主该文件系统的 80%。 */
  sizeMb?: number
  /** 测试用。默认取 `process.platform`。 */
  platform?: NodeJS.Platform
  /** 测试用：把命令执行换掉。 */
  exec?: (cmd: string, args: string[]) => Promise<string>
}

/**
 * 让池子就绪。**启动时调一次，失败就抛** —— 调用方（`index.ts`）不要吞这个错：
 * 池化之后跨实例的隔离是**逻辑隔离**（全靠配额真设上了），起不来比带着"看起来有配额"跑着强。
 *
 * 判定顺序：
 * 1. 根目录所在文件系统是 **XFS** → 真设一次限额再读回来（探针）。成了就是合格池子；
 *    不成（没开 `pquota`、或缺 `CAP_SYS_ADMIN`）→ **抛错**，因为路径上已经是一块 XFS 了，
 *    再套一层 loopback 只会更难查。
 * 2. 不是 XFS → 在用一块 **loopback XFS 镜像**当池子：镜像在 `"<root>.img"`，
 *    幂等（已挂载就直接用；镜像存在但没挂 = 半成品，**抛错，绝不重新 mkfs**）。
 * 3. macOS → **不做硬配额**，返回 `enforced: false`（它的 linuxkit 内核没编配额）。
 */
export async function ensureStoragePool(opts: PoolOptions): Promise<StoragePool> {
  const platform = opts.platform ?? process.platform
  const root = opts.root
  if (!isAbsolute(root)) {
    throw new StoragePoolError(`HOST_STORAGE_ROOT 必须是绝对路径，收到 ${JSON.stringify(root)}`)
  }

  if (platform === 'darwin') {
    // 控制面是 Mac 进程，够不到 Docker 那个 Linux 虚拟机；而且那边的内核根本没编配额。
    // 不抛错 —— 开发机要能起得来，但必须让调用方知道"这里没有硬限"。
    return {
      root,
      enforced: false,
      detail: 'macOS / Docker Desktop：内核未编 XFS 配额，本机不强制磁盘配额',
    }
  }

  const fsType = await superblockMagic(root)
  if (fsType === undefined) {
    return await buildLoopbackPool({ ...opts, root, platform })
  }
  if (fsType !== XFS_SUPER_MAGIC) {
    // 路径在别的文件系统上（ext4 之类）→ 走 loopback 兜底。
    return await buildLoopbackPool({ ...opts, root, platform })
  }

  // 是一块 XFS —— 那就必须能用。探针失败就是配置 / 权限问题，直接抛，别静默降级。
  await probe(root, opts.exec)
  return { root, enforced: true, detail: 'XFS + project quota（探针已确认可设限额）' }
}

/**
 * 在 `root` 上准备一块 loopback XFS 镜像当池子。
 *
 * **只建一次**：镜像已经在、而且 `root` 就是它的挂载点 → 直接用；
 * 镜像在但没挂上 → **抛错**（半成品，可能是上次失败留下的；重新 mkfs 会把已有数据抹掉）。
 */
async function buildLoopbackPool(opts: PoolOptions & { root: string }): Promise<StoragePool> {
  const exec = execOf(opts.exec)
  const img = `${opts.root}.img`

  let mounted = false
  try {
    // 已经是挂载点了吗？（`findmnt` 在 util-linux 里，Debian/Alpine 都有）
    await exec('findmnt', ['-n', '-o', 'FSTYPE', '--target', opts.root])
    mounted = (await superblockMagic(opts.root)) === XFS_SUPER_MAGIC
  } catch {
    mounted = false
  }

  if (await exists(img)) {
    if (!mounted) {
      throw new StoragePoolError(
        `池子镜像 ${img} 存在，但 ${opts.root} 不是它的挂载点 —— 拒绝重新 mkfs（那会抹掉已有数据）。` +
          `先确认该镜像没在用：\`losetup -j ${img}\` / \`findmnt ${opts.root}\`。`,
      )
    }
    await probe(opts.root, opts.exec)
    return { root: opts.root, enforced: true, detail: `loopback XFS（${img}）+ project quota` }
  }

  const sizeMb = opts.sizeMb ?? (await defaultPoolSizeMb(opts.root))
  try {
    await mkdir(opts.root, { recursive: true })
    // 稀疏文件 —— 不做 `dd`，建 500G 的池子不该真写 500G。
    await exec('truncate', ['-s', `${sizeMb}M`, img])
    const loop = (await exec('losetup', ['-f', '--show', img])).trim()
    await exec('mkfs.xfs', ['-q', '-f', loop])
    await exec('mount', ['-o', 'pquota', loop, opts.root])
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new StoragePoolError(
      `建 loopback XFS 池子失败：${detail}\n` +
        `这一步要宿主的 CAP_SYS_ADMIN（建镜像 / losetup / mkfs / mount）。` +
        `要么让控制面以 root 或带该 capability 运行，要么自己在 ${opts.root} 上挂一块 XFS（` +
        `挂载参数带 pquota），平台会直接用它。`,
    )
  }

  await probe(opts.root, opts.exec)
  return { root: opts.root, enforced: true, detail: `新建 loopback XFS（${img}，${sizeMb} MiB）+ project quota` }
}

/**
 * 探针：**建目录 → 设 project → 设限额 → 读回来 → 清理**。
 *
 * 为什么非要真设一次：`xfs_quota report`（读）不要权限，只有 `limit`（写）要 ——
 * 所以"这块是 XFS 且开了 pquota"**不等于**"我们真的设得上限额"。缺权限时 `limit`
 * 是**静默失败**，只检查前者会得到"看起来配了限额、实际没配"（D18 点名的硬前提）。
 */
export async function probe(root: string, exec?: (cmd: string, args: string[]) => Promise<string>): Promise<void> {
  const ex = execOf(exec)
  const dir = join(root, PROBE_DIR)
  try {
    await mkdir(dir, { recursive: true })
    await ex('xfs_quota', ['-x', '-c', `project -s -p ${dir} ${PROBE_PROJID}`, root])
    await ex('xfs_quota', ['-x', '-c', `limit -p bhard=1m ihard=10 ${PROBE_PROJID}`, root])
    const report = await ex('xfs_quota', ['-x', '-c', 'report -p -b -h', root])
    // ⚠️ 必须校验**限额的值**，不能只看 ID 出没出现：`project -s` 本身就会让那个 ID 出现在
    // report 里（哪怕 `limit` 静默失败了），那样自检等于没检。
    // 列序 `#ID Used Soft Hard …` → Hard 是第 3 列。
    const row = new RegExp(`^#${PROBE_PROJID}\\s+(.*)$`, 'm').exec(report)
    const hard = row === null ? 0 : parseSize((row[1] ?? '').trim().split(/\s+/)[2] ?? '')
    if (hard !== 1024 * 1024) {
      throw new StoragePoolError(
        `在 ${root} 上设了限额但 \`xfs_quota report\` 读不到它（Hard=${hard}）—— 配额没生效（多半是缺 CAP_SYS_ADMIN）。`,
      )
    }
  } catch (err) {
    if (err instanceof StoragePoolError) throw err
    const detail = err instanceof Error ? err.message : String(err)
    throw new StoragePoolError(
      `${root} 上的配额自检失败：${detail}\n` +
        `常见原因：① 这块 XFS 没以 \`pquota\` 挂载（用 \`findmnt -o OPTIONS\` 看）；` +
        `② 控制面缺 CAP_SYS_ADMIN（\`xfs_quota limit\` 要它，而 report 不要）。`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    await ex('xfs_quota', ['-x', '-c', `limit -p bhard=0 ihard=0 ${PROBE_PROJID}`, root]).catch(() => '')
  }
}

// ---------------- 配额原语（驱动用）----------------

/** 把一个目录纳进某个 project 并设限额。**先 `project -s`**（它顺带设继承标志），子文件才会计入。 */
export async function setProjectQuota(
  root: string,
  dir: string,
  projid: number,
  sizeMb: number,
  inodeLimit: number,
  exec?: (cmd: string, args: string[]) => Promise<string>,
): Promise<void> {
  const ex = execOf(exec)
  await ex('xfs_quota', ['-x', '-c', `project -s -p ${dir} ${projid}`, root])
  await ex('xfs_quota', ['-x', '-c', `limit -p bhard=${sizeMb}m ihard=${inodeLimit} ${projid}`, root])
}

/** 只改限额，不动目录（改配额的扩容 / 缩容走这里）。 */
export async function updateProjectQuota(
  root: string,
  projid: number,
  sizeMb: number,
  inodeLimit: number,
  exec?: (cmd: string, args: string[]) => Promise<string>,
): Promise<void> {
  const ex = execOf(exec)
  await ex('xfs_quota', ['-x', '-c', `limit -p bhard=${sizeMb}m ihard=${inodeLimit} ${projid}`, root])
}

/** 清掉一个 project 的账（删实例 / 删快照时）。幂等。 */
export async function clearProject(root: string, projid: number, dir?: string): Promise<void> {
  const ex = execOf()
  if (dir !== undefined) {
    await ex('xfs_quota', ['-x', '-c', `project -C -p ${dir}`, root]).catch(() => '')
  }
  await ex('xfs_quota', ['-x', '-c', `limit -p bhard=0 ihard=0 ${projid}`, root]).catch(() => '')
}

export interface ProjectUsage {
  usedMb: number
  usedInodes: number
}

/**
 * 读所有 project 的用量。`xfs_quota report` 不要权限，所以停机时也读得到。
 *
 * 分**两次**调用（块一次、inode 一次）：一次同时带 `-b -i` 会输出两段表，
 * 表头之外没有可靠的分段标记，按行解析会把 inode 段的数字当成块段的。
 *
 * ⚠️ 列序是 `#ID  Used  Soft  Hard  Warn/Grace  Flags` —— **第二列才是用量**，
 * 第一列是 project ID（踩过：把 ID 当用量，永远读回 0）。
 */
export async function reportProjects(
  root: string,
  exec?: (cmd: string, args: string[]) => Promise<string>,
): Promise<Map<number, ProjectUsage>> {
  const ex = execOf(exec)
  const usage = new Map<number, ProjectUsage>()
  const rows = (out: string): Array<[number, number]> => {
    const found: Array<[number, number]> = []
    for (const line of out.split('\n')) {
      const m = /^#(\d+)\s+(.*)$/.exec(line)
      if (m === null) continue
      const used = (m[2] ?? '').trim().split(/\s+/)[0]
      found.push([Number(m[1]), parseSize(used)])
    }
    return found
  }

  for (const [projid, bytes] of rows(await ex('xfs_quota', ['-x', '-c', 'report -p -b -h', root]))) {
    usage.set(projid, { usedMb: Math.round(bytes / 1024 / 1024), usedInodes: 0 })
  }
  for (const [projid, count] of rows(await ex('xfs_quota', ['-x', '-c', 'report -p -i -h', root]))) {
    const rec = usage.get(projid)
    if (rec !== undefined) rec.usedInodes = Math.round(count)
  }
  return usage
}

/** `report -h` 的尺寸 → bytes。`1.2m` / `512k` / `0`。 */
function parseSize(s: string | undefined): number {
  if (s === undefined) return 0
  const m = /^([\d.]+)([kmg]?)$/i.exec(s.trim())
  if (m === null) return 0
  const n = Number(m[1])
  const unit = (m[2] ?? '').toLowerCase()
  return unit === 'k' ? n * 1024 : unit === 'm' ? n * 1024 * 1024 : unit === 'g' ? n * 1024 ** 3 : n
}

// ---------------- 内部工具 ----------------

export function assertStorageKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    // key 会进 `xfs_quota -c` 的命令字符串，形状必须钉死（它是平台生成的，不该有别的东西）。
    throw new StoragePoolError(`storageKey 形状不合法：${JSON.stringify(key)}`)
  }
}

async function superblockMagic(path: string): Promise<number | undefined> {
  try {
    const s = await statfs(path)
    return Number(s.type)
  } catch {
    return undefined
  }
}

/** 池子大小默认值：宿主该文件系统的 80%（留 20% 给镜像以外的文件）。 */
async function defaultPoolSizeMb(root: string): Promise<number> {
  const probePath = (await exists(root)) ? root : dirname(root)
  const s = await statfs(probePath)
  const totalMb = (Number(s.blocks) * Number(s.bsize)) / 1024 / 1024
  return Math.max(1024, Math.floor(totalMb * 0.8))
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function execOf(fn?: (cmd: string, args: string[]) => Promise<string>): (cmd: string, args: string[]) => Promise<string> {
  if (fn !== undefined) return fn
  return async (cmd, args) => {
    const { stdout } = await run(cmd, args, { maxBuffer: 8 * 1024 * 1024 })
    return stdout
  }
}

// ---------------- project ID 注册表 ----------------

/** 注册表里一条记录：一个 key 占的 project ID 和它的限额。 */
export interface ProjectRecord {
  projid: number
  sizeMb: number
  inodeLimit: number
  /**
   * 墓碑：这条 key 的数据已经删了，但 **id 永久占位**。
   *
   * 为什么不直接删掉记录：`xfs_quota` 的账是**按 project ID** 记的，不是按目录 ——
   * 只要还有任何文件带着这个 projid，用量就还算在它头上。一旦把 id 发给下一个租户，
   * 上一个租户的残留就会静默算进新租户的账（可能一上来就"已用超限"）。今天的调用方
   * 都是先删目录再 release，所以暂时打不到；但那是**调用方的自觉**，不该是注册表的契约。
   */
  released?: boolean
}

/**
 * `storageKey → project` 的注册表，落在池子根部的一个点文件里。
 *
 * 为什么不做哈希派生：32 位哈希在用了几万个实例后**必然碰撞**，而碰撞 = 两个租户的账
 * **静默合并**（正是 D18 要防的那种数据保护事故）。
 *
 * 为什么存在池子根而不是库里：`createStorage(key, sizeMb)` 拿不到实例行，DataStore 又只做策略 ——
 * 分配这件事留在驱动这一层最自然。**已释放的 id 不再复用**（见 `released`，复用会把旧账算到新租户头上）。
 *
 * 限额也记在这里：`copyStorage` 要把源的限额原样搬到目标上，而目录形态下没有"卷 label"
 * 这种侧信道可读（对比：命名卷那版是从 label 读的）。
 */
export class ProjectRegistry {
  private readonly path: string
  private cache: Map<string, ProjectRecord> | undefined

  constructor(poolRoot: string) {
    this.path = join(poolRoot, '.dsh-projects.json')
  }

  async get(key: string): Promise<ProjectRecord | undefined> {
    const record = (await this.load()).get(key)
    // 墓碑不算"这条 key 有存储" —— 调用方拿它判断要不要设限额 / 对外报用量
    return record === undefined || record.released === true ? undefined : record
  }

  async keys(): Promise<Set<string>> {
    const map = await this.load()
    return new Set([...map].filter(([, r]) => r.released !== true).map(([key]) => key))
  }

  /** 分配一个**从没用过**的 id、连同限额一起落盘。 */
  async allocate(key: string, sizeMb: number, inodeLimit: number): Promise<ProjectRecord> {
    const map = await this.load()
    // 墓碑也要算进来：它们的 id 不许再发出去
    const taken = new Set([...map.values()].map((r) => r.projid))
    // 从低位往上找第一个空闲的；`1` 留给可能的系统用途。
    let projid = 2
    while (taken.has(projid)) projid++
    const record: ProjectRecord = { projid, sizeMb, inodeLimit }
    map.set(key, record)
    await this.save(map)
    return record
  }

  /** 改限额（扩容 / 缩容）。没有这条 key、或它已是墓碑，就什么都不做。 */
  async update(key: string, sizeMb: number, inodeLimit: number): Promise<void> {
    const map = await this.load()
    const record = map.get(key)
    if (record === undefined || record.released === true) return
    map.set(key, { ...record, sizeMb, inodeLimit })
    await this.save(map)
  }

  /** 释放：**留墓碑**，id 不再复用（见 `ProjectRecord.released`）。 */
  async release(key: string): Promise<void> {
    const map = await this.load()
    const record = map.get(key)
    if (record === undefined || record.released === true) return
    map.set(key, { ...record, released: true })
    await this.save(map)
  }

  /**
   * 与实际的目录对账：注册表里有、盘上已经没有的条目标记成墓碑（id 仍然占位，不回收）。
   *
   * 不回收是有意的：回收一个 id 就等于把它发给下一个租户，而盘上可能还有带着这个 projid 的
   * 文件（对账的判据是"目录还在不在"，不是"账还记不记得"）。代价是注册表会随删实例单调增长 ——
   * 一条墓碑约 60 字节，相对于它挡掉的那类数据事故可以忽略。
   */
  async reconcile(liveKeys: Set<string>): Promise<void> {
    const map = await this.load()
    let changed = false
    for (const [key, record] of [...map]) {
      if (!liveKeys.has(key) && record.released !== true) {
        map.set(key, { ...record, released: true })
        changed = true
      }
    }
    if (changed) await this.save(map)
  }

  private async load(): Promise<Map<string, ProjectRecord>> {
    if (this.cache !== undefined) return this.cache
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, ProjectRecord>
      this.cache = new Map(Object.entries(raw))
    } catch {
      this.cache = new Map()
    }
    return this.cache
  }

  /** 原子写：先写临时文件再 rename，别让半截 JSON 留在盘上。 */
  private async save(map: Map<string, ProjectRecord>): Promise<void> {
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, JSON.stringify(Object.fromEntries(map)), 'utf8')
    await rename(tmp, this.path)
  }
}

/**
 * 一个配额对应的 **inode 上限**。
 *
 * 必须和字节上限一起设：只限字节的话，一个实例能用几百万个零字节文件把宿主 inode 耗尽，
 * 整台机器的文件系统都会瘫痪（D18 / OPEN-QUESTIONS #7 都点名过）。
 * 取「按 4 KiB 一个文件算满」——即假设最极端的情况，全是小文件。
 */
export function inodeLimitOf(sizeMb: number): number {
  return Math.max(1000, sizeMb * 256)
}
