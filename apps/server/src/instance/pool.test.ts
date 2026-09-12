import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProjectRegistry,
  StoragePoolError,
  assertStorageKey,
  ensureStoragePool,
  inodeLimitOf,
  probe,
  reportProjects,
} from './pool.js'

/**
 * 池子模块**没有真机就跑不出结论**（`xfs_quota` 要 Linux），所以这里的做法是：
 * 把命令执行换成桩，钉住**协议与判定**——命令怎么拼、report 怎么解析、什么情况必须抛。
 *
 * 这台机器上不用 XFS，但真机上踩过的两个 bug 恰好都能在这一层抓住：
 * ① `report` 的列序（把 project ID 当用量）；② 自检只看"ID 在不在"而不看**限额的值**。
 */

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'dsh-pool-test-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** 一个按命令分发的 exec 桩，并把调用记下来。 */
function stubExec(respond: (cmd: string, args: string[]) => string | undefined) {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const exec = async (cmd: string, args: string[]): Promise<string> => {
    calls.push({ cmd, args })
    const out = respond(cmd, args)
    if (out === undefined) throw new Error(`意外的命令：${cmd} ${args.join(' ')}`)
    return out
  }
  return { exec, calls }
}

const isBlockReport = (args: string[]) => args.includes('report -p -b -h')
const isInodeReport = (args: string[]) => args.includes('report -p -i -h')

describe('inodeLimitOf', () => {
  it('按「4 KiB 一个文件塞满」取上限，并留一个下限', () => {
    expect(inodeLimitOf(1024)).toBe(1024 * 256)
    // 很小的盘也不能给出几百个 inode 的上限
    expect(inodeLimitOf(1)).toBe(1000)
  })
})

describe('assertStorageKey', () => {
  it('只认平台生成的两种形状', () => {
    expect(() => assertStorageKey('a'.repeat(32))).not.toThrow()
    expect(() => assertStorageKey(`${'0'.repeat(31)}f.prev`)).not.toThrow()
  })

  it('别的一律拒绝 —— key 会进 `xfs_quota -c` 的命令字符串', () => {
    for (const bad of ['', 'abc', 'A'.repeat(32), `${'a'.repeat(31)}`, `${'a'.repeat(33)}`,
                       '../etc', 'a'.repeat(32) + '/x', 'a'.repeat(32) + '.prev.bak']) {
      expect(() => assertStorageKey(bad)).toThrow(StoragePoolError)
    }
  })
})

describe('reportProjects：列序是命门', () => {
  it('用量取**第二列**，不是 project ID（真机上踩过：把 ID 当用量，永远读回 0）', async () => {
    const { exec } = stubExec((_cmd, args) =>
      isBlockReport(args) ? '#2   512.0m   0   0  00 [--------]\n#3   1.5g   0   0  00 [--------]\n' : '#2   1200   0   0  00 [--------]\n',
    )
    const usage = await reportProjects('/pool', exec)

    expect(usage.get(2)?.usedMb).toBe(512)
    expect(usage.get(3)?.usedMb).toBe(1536)
    expect(usage.get(2)?.usedInodes).toBe(1200)
  })

  it('块与 inode 分两次读 —— 一次带 `-b -i` 会把两段表混在一起', async () => {
    const { exec, calls } = stubExec((_cmd, args) =>
      isBlockReport(args) ? '#2   1.0m   0   0  00 [--------]\n' : '#2   7   0   0  00 [--------]\n',
    )
    await reportProjects('/pool', exec)

    expect(calls.map((c) => c.args[2])).toEqual(['report -p -b -h', 'report -p -i -h'])
  })

  it('不认识的表头 / 空表都不炸', async () => {
    const { exec } = stubExec(() => 'Project ID  Used  Soft  Hard\n------\n')
    expect((await reportProjects('/pool', exec)).size).toBe(0)
  })
})

describe('probe：自检要校验限额的**值**', () => {
  /** 探针读回的 report：`#ID Used Soft Hard Warn/Grace Flags`。 */
  const report = (hard: string) => `#4294967294   0   0   ${hard}   00 [--------]\n`

  it('Hard 等于设下去的值（1m）才算过', async () => {
    const root = await tempDir()
    const { exec, calls } = stubExec((_cmd, args) => (args.includes('report -p -b -h') ? report('1048576') : ''))

    await probe(root, exec)

    const quota = calls.filter((c) => c.cmd === 'xfs_quota').map((c) => c.args[2])
    expect(quota[0]).toContain('project -s -p')
    expect(quota[1]).toBe('limit -p bhard=1m ihard=10 4294967294')
    // 收尾：探针目录要清掉、限额要归零
    await expect(stat(join(root, '.dsh-pool-probe'))).rejects.toThrow()
    expect(quota.at(-1)).toBe('limit -p bhard=0 ihard=0 4294967294')
  })

  it('**ID 出现了但 Hard 是 0 → 必须抛**（缺 CAP_SYS_ADMIN 时 limit 是静默失败）', async () => {
    const root = await tempDir()
    const { exec } = stubExec(() => report('0'))

    await expect(probe(root, exec)).rejects.toThrow(/读不到它/)
  })

  it('report 里根本没有那一行（只有 project -s 生效）也要抛', async () => {
    const root = await tempDir()
    const { exec } = stubExec((_cmd, args) =>
      args.includes('report -p -b -h') ? '#2   0   0   0   00 [--------]\n' : '',
    )

    await expect(probe(root, exec)).rejects.toThrow(StoragePoolError)
  })

  it('命令本身失败时，错误里要带上排查方向（没开 pquota / 缺 CAP_SYS_ADMIN）', async () => {
    const root = await tempDir()
    const exec = async (): Promise<string> => {
      throw new Error('xfs_quota: cannot set limits: Operation not permitted')
    }

    await expect(probe(root, exec)).rejects.toThrow(/pquota.*CAP_SYS_ADMIN/s)
  })
})

describe('ensureStoragePool：判定分支', () => {
  it('根目录必须是绝对路径', async () => {
    await expect(ensureStoragePool({ root: 'relative/dir' })).rejects.toThrow(/绝对路径/)
  })

  it('macOS：不抛错，但明确回报「不强制」', async () => {
    const root = await tempDir()
    const pool = await ensureStoragePool({ root, platform: 'darwin' })

    expect(pool.enforced).toBe(false)
    expect(pool.detail).toContain('不强制')
  })

  it('不是 XFS 时建 loopback 池子：truncate → losetup → mkfs → mount(pquota)，然后自检', async () => {
    const root = await tempDir()
    const { exec, calls } = stubExec((cmd, args) => {
      if (cmd === 'losetup') return '/dev/loop9\n'
      if (cmd === 'xfs_quota') return args.includes('report -p -b -h') ? '#4294967294   0   0   1048576   00 [--------]\n' : ''
      if (cmd === 'findmnt') throw new Error('not a mountpoint')
      return ''
    })

    const pool = await ensureStoragePool({ root, platform: 'linux', sizeMb: 256, exec })

    expect(pool.enforced).toBe(true)
    expect(pool.detail).toContain('loopback XFS')
    const flat = calls.map((c) => `${c.cmd} ${c.args.join(' ')}`)
    // 先问"这个目录是不是已经是挂载点"，再建（幂等的前提）
    expect(flat.slice(0, 5)).toEqual([
      `findmnt -n -o FSTYPE --target ${root}`,
      `truncate -s 256M ${root}.img`,
      `losetup -f --show ${root}.img`,
      'mkfs.xfs -q -f /dev/loop9',
      `mount -o pquota /dev/loop9 ${root}`,
    ])
    expect(flat).toContain(`xfs_quota -x -c limit -p bhard=1m ihard=10 4294967294 ${root}`)
  })

  it('镜像在、但没挂上 → **拒绝重新 mkfs**（那会抹掉已有数据）', async () => {
    const root = await tempDir()
    await writeFile(`${root}.img`, 'fake image')
    dirs.push(`${root}.img`)
    const { exec, calls } = stubExec((cmd) => {
      if (cmd === 'findmnt') throw new Error('not a mountpoint')
      return ''
    })

    await expect(ensureStoragePool({ root, platform: 'linux', sizeMb: 256, exec })).rejects.toThrow(
      /拒绝重新 mkfs/,
    )
    expect(calls.some((c) => c.cmd === 'mkfs.xfs')).toBe(false)
  })
})

describe('ProjectRegistry', () => {
  it('从 2 开始分配，并且落盘（新实例读得到）', async () => {
    const root = await tempDir()
    const reg = new ProjectRegistry(root)

    const a = await reg.allocate('a'.repeat(32), 10_240, inodeLimitOf(10_240))
    const b = await reg.allocate('b'.repeat(32), 5120, inodeLimitOf(5120))

    expect([a.projid, b.projid]).toEqual([2, 3])
    const fresh = new ProjectRegistry(root)
    expect((await fresh.get('a'.repeat(32)))?.sizeMb).toBe(10_240)
    expect(await fresh.keys()).toEqual(new Set(['a'.repeat(32), 'b'.repeat(32)]))
  })

  it('改限额不动 projid；没有的 key 就什么都不做', async () => {
    const root = await tempDir()
    const reg = new ProjectRegistry(root)
    const key = 'c'.repeat(32)
    await reg.allocate(key, 10_240, 100)

    await reg.update(key, 20_480, 200)
    expect(await reg.get(key)).toEqual({ projid: 2, sizeMb: 20_480, inodeLimit: 200 })

    await expect(reg.update('d'.repeat(32), 1, 1)).resolves.toBeUndefined()
  })

  it('对账：盘上已不存在的条目标成墓碑（不再出现在 keys 里）', async () => {
    const root = await tempDir()
    const reg = new ProjectRegistry(root)
    const live = 'e'.repeat(32)
    const gone = 'f'.repeat(32)
    await reg.allocate(live, 1, 1)
    await reg.allocate(gone, 1, 1)

    await reg.reconcile(new Set([live]))

    expect(await reg.keys()).toEqual(new Set([live]))
    expect(await reg.get(gone)).toBeUndefined()
  })

  it('**已释放的 id 不复用**，重启后也不复用 —— 复用会把上一个租户残留的账算到新租户头上', async () => {
    const root = await tempDir()
    const reg = new ProjectRegistry(root)
    const first = '1'.repeat(32)
    const second = '2'.repeat(32)

    const a = await reg.allocate(first, 1024, 100)
    await reg.release(first)
    // 墓碑不能算"这条 key 还有存储"
    expect(await reg.get(first)).toBeUndefined()
    expect(await reg.keys()).toEqual(new Set())

    // 换一个实例（模拟重启后重新读盘）也不许把 id 发出去
    const b = await new ProjectRegistry(root).allocate(second, 1024, 100)

    expect(a.projid).toBe(2)
    expect(b.projid).not.toBe(a.projid)
  })

  it('已释放的条目不能被 update「复活」', async () => {
    const root = await tempDir()
    const reg = new ProjectRegistry(root)
    const key = '7'.repeat(32)
    await reg.allocate(key, 1024, 100)
    await reg.release(key)

    await reg.update(key, 9999, 9999)

    expect(await reg.get(key)).toBeUndefined()
    const raw = JSON.parse(await readFile(join(root, '.dsh-projects.json'), 'utf8'))
    expect(raw[key]).toEqual({ projid: 2, sizeMb: 1024, inodeLimit: 100, released: true })
  })

  it('半截 JSON 不该让注册表崩掉（原子写就是为了这个）', async () => {
    const root = await tempDir()
    await writeFile(join(root, '.dsh-projects.json'), '{"broken":')

    const reg = new ProjectRegistry(root)
    expect(await reg.keys()).toEqual(new Set())
    // 还能继续用
    expect((await reg.allocate('9'.repeat(32), 1, 1)).projid).toBe(2)
  })

  it('同一批分配出来的 id 互不重复', async () => {
    const root = await tempDir()
    const reg = new ProjectRegistry(root)
    const ids = new Set<number>()
    for (let i = 0; i < 40; i++) {
      ids.add((await reg.allocate(`${i.toString(16).padStart(32, '0')}`, 1, 1)).projid)
    }
    expect(ids.size).toBe(40)
  })
})

describe('注册表文件', () => {
  it('写的是 JSON（出问题时要能直接看）', async () => {
    const root = await tempDir()
    await new ProjectRegistry(root).allocate('a'.repeat(32), 1024, 100)
    const raw = JSON.parse(await readFile(join(root, '.dsh-projects.json'), 'utf8'))
    expect(raw['a'.repeat(32)]).toEqual({ projid: 2, sizeMb: 1024, inodeLimit: 100 })
  })
})
