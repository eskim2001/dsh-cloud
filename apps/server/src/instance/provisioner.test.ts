import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceRow } from '../db/schema.js'
import type { Env } from '../env.js'
import type { DataStore } from './data-store.js'
import type { InstanceOrchestrator } from './orchestrator.js'
import {
  ImageRejectedError,
  ImageUpgradeFailedError,
  InstanceProvisioner,
  NoRollbackError,
  DiskShrinkUnsupportedError,
} from './provisioner.js'

vi.mock('../db/instance-repo.js', () => ({
  findInstanceById: vi.fn(),
  listAllInstances: vi.fn(async () => []),
  updateInstance: vi.fn(),
  countInstancesByOwner: vi.fn(),
  createInstanceRecord: vi.fn(),
  deleteInstanceRecord: vi.fn(),
  retainInstanceRecord: vi.fn(),
  QuotaExceededError: class QuotaExceededError extends Error {},
}))
vi.mock('../db/user-repo.js', () => ({ findUserQuota: vi.fn() }))
vi.mock('../db/image-release-repo.js', () => ({
  findDefaultImageRelease: vi.fn(),
  isImageRelease: vi.fn(),
}))
vi.mock('../db/image-catalog-repo.js', () => ({ isImageInCatalog: vi.fn() }))

const { findInstanceById, updateInstance, createInstanceRecord, retainInstanceRecord, deleteInstanceRecord } = await import('../db/instance-repo.js')
const { findDefaultImageRelease, isImageRelease } = await import('../db/image-release-repo.js')
const { isImageInCatalog } = await import('../db/image-catalog-repo.js')
const findById = vi.mocked(findInstanceById)
const update = vi.mocked(updateInstance)
const findDefaultRelease = vi.mocked(findDefaultImageRelease)
const isPublished = vi.mocked(isImageRelease)
const inCatalog = vi.mocked(isImageInCatalog)

const env = {
  BASE_DOMAIN: 'app.example.com',
  CONSOLE_DOMAIN: 'console.app.example.com',
  PLATFORM_SECRET: 'test-secret',
  MAX_INSTANCES_PER_USER: 3,
  INSTANCE_IMAGE_REPO: 'dsh-instance',
} as Env

/** 升级目标：已发布的那一版。 */
const NEW_IMAGE = 'dsh-instance:0.1.1_1'
const DEFAULT_REF = 'dsh-instance:0.1.0_1'

function row(over: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id: 'i-1',
    slug: 'alice',
    storageKey: 'alice',
    deletedAt: null,
    ownerId: 'u1',
    status: 'running',
    image: 'dsh-instance:0.1.0_1',
    previousImage: null,
    containerId: 'c-1',
    hostPort: null,
    cpus: 1,
    memoryMb: 2048,
    pidsLimit: 512,
    diskMb: 10_240,
    lastError: null,
    stoppedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }
}

interface Fakes {
  dataStore: DataStore
  orchestrator: InstanceOrchestrator
  syncRoutes: () => Promise<void>
  calls: {
    createData: ReturnType<typeof vi.fn>
    ensure: ReturnType<typeof vi.fn>
    usage: ReturnType<typeof vi.fn>
    snapshot: ReturnType<typeof vi.fn>
    restoreSnapshot: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    stopInstance: ReturnType<typeof vi.fn>
    removeInstance: ReturnType<typeof vi.fn>
    startInstance: ReturnType<typeof vi.fn>
    resizeStorage: ReturnType<typeof vi.fn>
    createInstance: ReturnType<typeof vi.fn>
    inspectStatus: ReturnType<typeof vi.fn>
    listImageTags: ReturnType<typeof vi.fn>
    ensureImage: ReturnType<typeof vi.fn>
    syncRoutes: ReturnType<typeof vi.fn>
  }
}

function build(): Fakes {
  const createData = vi.fn(async () => undefined)
  const ensure = vi.fn(async () => undefined)
  const usage = vi.fn(async () => ({ usedMb: 100 }))
  const snapshot = vi.fn(async () => undefined)
  const restoreSnapshot = vi.fn(async () => undefined)
  const destroy = vi.fn(async () => undefined)
  const snapshotUsage = vi.fn(async () => undefined)

  const stopInstance = vi.fn(async () => undefined)
  const removeInstance = vi.fn(async () => undefined)
  const startInstance = vi.fn(async () => undefined)
  const resizeStorage = vi.fn(async () => undefined)
  const inspectStatus = vi.fn(async () => 'running')
  const listImageTags = vi.fn(async () => ['dsh-instance:0.1.0_1', 'dsh-instance:0.1.1_1'])
  const ensureImage = vi.fn(async () => undefined)
  const syncRoutes = vi.fn(async () => undefined)

  // 返回的形状是**运行时中立**的 `RenderedInstance` + 状态：不再有 containerName /
  // networkName / containerPort 这些容器概念，身份是 machineName。
  const createInstance = vi.fn(async () => ({
    slug: 'alice',
    machineName: 'dsh-instance-alice',
    hostname: 'alice.app.example.com',
    image: 'dsh-instance:0.1.0_1',
    user: '502',
    workingDir: '/data/home/workspace',
    env: [],
    guestPort: 8080,
    hostPort: 20001,
    dataDir: '/var/lib/dsh/alice',
    guestDataDir: '/data',
    mounts: [],
    storageGb: 10,
    overlayGb: 10,
    labels: {},
    status: 'running',
  }))

  const dataStore = {
    create: createData,
    ensure,
    usage,
    dir: (key: string) => `/var/lib/dsh/${key}`,
    snapshot,
    restoreSnapshot,
    snapshotUsage,
    destroy,
    ownerId: '502',
  } as unknown as DataStore

  const orchestrator = {
    // 让准入逻辑照常跑「本地有没有」那一关（真运行时为 false 时才跳过）
    canReportLocalImages: true,
    createInstance,
    stopInstance,
    removeInstance,
    startInstance,
    resizeStorage,
    inspectStatus,
    listImageTags,
    ensureImage,
  } as unknown as InstanceOrchestrator

  return {
    dataStore,
    orchestrator,
    syncRoutes,
    calls: {
      createData,
      ensure,
      usage,
      snapshot,
      restoreSnapshot,
      destroy,
      stopInstance,
      removeInstance,
      startInstance,
      resizeStorage,
      createInstance,
      inspectStatus,
      listImageTags,
      ensureImage,
      syncRoutes,
    },
  }
}

function makeProvisioner(fakes: Fakes): InstanceProvisioner {
  return new InstanceProvisioner(
    {} as never,
    fakes.orchestrator,
    fakes.dataStore,
    env,
    fakes.syncRoutes,
  )
}

const quota = { cpus: 1, memoryMb: 2048, pidsLimit: 512, diskMb: 10_240 }

beforeEach(() => {
  vi.clearAllMocks()
  update.mockImplementation(async (_db, _id, patch) => ({ ...row(), ...patch }) as InstanceRow)
  // 库里有一个默认版本，且任何目标都算「已发布」——要测拒绝的用例自己覆盖
  findDefaultRelease.mockResolvedValue({
    id: 'r-1',
    ref: DEFAULT_REF,
    isDefault: true,
    publishedAt: new Date(0),
  })
  isPublished.mockResolvedValue(true)
  // 默认 catalog 里没有目标版本——要测「catalog 里有」的用例自己覆盖
  inCatalog.mockResolvedValue(false)
})

describe('storage ownership across lifecycle operations', () => {
  it('creates data at the reserved storage key, never the public slug', async () => {
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ storageKey: 'unique-data-key' }))
    const fakes = build()
    await makeProvisioner(fakes).create({ slug: 'alice', ownerId: 'u1', ...quota })
    expect(createInstanceRecord).toHaveBeenCalledWith({}, expect.objectContaining({ ownerId: 'u1' }), 3)
    expect(fakes.dataStore.create).toHaveBeenCalledWith('unique-data-key')
    expect(fakes.calls.createInstance).toHaveBeenCalledWith(expect.objectContaining({ slug: 'alice' }), expect.objectContaining({ dataDir: '/var/lib/dsh/unique-data-key' }))
  })

  it('keeps the ownership record when deleting without a purge', async () => {
    findById.mockResolvedValue(row({ storageKey: 'unique-data-key' }))
    const fakes = build()
    await makeProvisioner(fakes).remove('i-1')
    expect(retainInstanceRecord).toHaveBeenCalledWith({}, 'i-1')
    expect(deleteInstanceRecord).not.toHaveBeenCalled()
    expect(fakes.dataStore.destroy).not.toHaveBeenCalled()
  })

  it('purges only the selected storage key after slug confirmation', async () => {
    findById.mockResolvedValue(row({ storageKey: 'unique-data-key' }))
    const fakes = build()
    await makeProvisioner(fakes).remove('i-1', { purgeVolume: true, confirmSlug: 'alice' })
    expect(fakes.dataStore.destroy).toHaveBeenCalledWith('unique-data-key')
    expect(deleteInstanceRecord).toHaveBeenCalledWith({}, 'i-1')
    expect(retainInstanceRecord).not.toHaveBeenCalled()
  })

  it('uses the same storage key for upgrade snapshots, rollback and rebuild', async () => {
    statefulDb(row({ storageKey: 'unique-data-key' }))
    const fakes = build()
    const provisioner = makeProvisioner(fakes)
    await provisioner.setImage('i-1', NEW_IMAGE)
    await provisioner.rollbackImage('i-1')
    expect(fakes.calls.snapshot).toHaveBeenCalledWith('unique-data-key')
    expect(fakes.calls.restoreSnapshot).toHaveBeenCalledWith('unique-data-key')
    expect(fakes.calls.ensure).toHaveBeenCalledWith('unique-data-key')
    expect(fakes.calls.createInstance).toHaveBeenLastCalledWith(expect.objectContaining({ slug: 'alice' }), expect.objectContaining({ dataDir: '/var/lib/dsh/unique-data-key' }))
  })
})

describe('存量实例的 slug 落进保留字表之后', () => {
  // 保留字是**创建期命名政策**。对库里已有的行再判一次，会让扩表把存量实例变成
  // 「打不开也删不掉」——所以这里盯住：slug 是保留字，生命周期照样走完。
  it('purge 删除照常走完，不因为 slug 是保留字而失败', async () => {
    findById.mockResolvedValue(row({ slug: 'test', storageKey: 'unique-data-key' }))
    const fakes = build()
    await makeProvisioner(fakes).remove('i-1', { purgeVolume: true, confirmSlug: 'test' })
    expect(fakes.dataStore.destroy).toHaveBeenCalledWith('unique-data-key')
    expect(deleteInstanceRecord).toHaveBeenCalledWith({}, 'i-1')
  })

  it('start 照常按规格重建容器', async () => {
    findById.mockResolvedValue(row({ slug: 'test', containerId: null, status: 'stopped' }))
    const fakes = build()
    await makeProvisioner(fakes).start('i-1')
    expect(fakes.calls.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'test' }),
      expect.anything(),
    )
  })
})

describe('新建：镜像取自库里的默认版本（D21）', () => {
  it('落库的是默认版本那一行', async () => {
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ image: DEFAULT_REF }))
    const fakes = build()
    await makeProvisioner(fakes).create({ slug: 'alice', ownerId: 'u1', ...quota })
    expect(createInstanceRecord).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ image: DEFAULT_REF }),
      3,
    )
  })

  it('库里没有默认版本 → 响亮失败，不落库也不起容器', async () => {
    findDefaultRelease.mockResolvedValue(undefined)
    const fakes = build()
    await expect(
      makeProvisioner(fakes).create({ slug: 'alice', ownerId: 'u1', ...quota }),
    ).rejects.toThrow(ImageRejectedError)
    expect(createInstanceRecord).not.toHaveBeenCalled()
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
  })

  it('自选版本 → 用自选的那一版，默认版本不参与', async () => {
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ image: NEW_IMAGE }))
    const fakes = build()
    await makeProvisioner(fakes).create({
      slug: 'alice',
      ownerId: 'u1',
      ...quota,
      image: NEW_IMAGE,
    })
    expect(createInstanceRecord).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ image: NEW_IMAGE }),
      3,
    )
  })

  it('自选版本不要求宿主已有（D23：创建本来就会自动拉）', async () => {
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ image: NEW_IMAGE }))
    const fakes = build()
    fakes.calls.listImageTags.mockResolvedValue([])
    await makeProvisioner(fakes).create({
      slug: 'alice',
      ownerId: 'u1',
      ...quota,
      image: NEW_IMAGE,
    })
    expect(fakes.calls.createInstance).toHaveBeenCalled()
  })

  it('自选未发布的版本 → 拒绝，不落库', async () => {
    isPublished.mockResolvedValue(false)
    const fakes = build()
    await expect(
      makeProvisioner(fakes).create({
        slug: 'alice',
        ownerId: 'u1',
        ...quota,
        image: 'dsh-instance:9.9.9_1',
      }),
    ).rejects.toThrow(ImageRejectedError)
    expect(createInstanceRecord).not.toHaveBeenCalled()
  })

  it('自选别的仓库 → 拒绝', async () => {
    const fakes = build()
    await expect(
      makeProvisioner(fakes).create({
        slug: 'alice',
        ownerId: 'u1',
        ...quota,
        image: 'docker.io/evil/dsh-instance:0.1.1_1',
      }),
    ).rejects.toThrow(ImageRejectedError)
    expect(createInstanceRecord).not.toHaveBeenCalled()
  })
})

describe('改配额：扩容', () => {
  it('磁盘扩容 → 重建实例（配额是建实例时的参数，不能在线改）', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    await makeProvisioner(fakes).setQuota('i-1', { ...quota, diskMb: 20_480 })

    // 配额落成**挂载选项**，改它等于改运行时参数 → 必须重建。
    // 数据在宿主目录里，重建不碰它；重建后按新配额重新声明挂载。
    expect(fakes.calls.stopInstance).not.toHaveBeenCalled() // 重建走 removeInstance
    expect(fakes.calls.removeInstance).toHaveBeenCalledWith('dsh-instance-alice')
    expect(fakes.calls.createInstance).toHaveBeenCalled()
    // 落库时清掉运行时标识，等重建写回
    expect(update).toHaveBeenCalledWith({}, 'i-1', expect.objectContaining({ diskMb: 20_480, containerId: null }))
  })

  it('原本停着的实例扩容后**保持停止**（不擅自启动）', async () => {
    findById.mockResolvedValue(row({ status: 'stopped' }))
    const fakes = build()
    await makeProvisioner(fakes).setQuota('i-1', { ...quota, diskMb: 20_480 })

    expect(fakes.calls.removeInstance).toHaveBeenCalled()
    expect(fakes.calls.createInstance).not.toHaveBeenCalled() // 停着的只落库，下次 start 才重建
  })
})

describe('改配额：缩容（microVM 的盘只扩不缩）', () => {
  it('目标小于当前 → 直接拒绝，运行时和配额都不动', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()

    await expect(
      makeProvisioner(fakes).setQuota('i-1', { ...quota, diskMb: 1_024 }),
    ).rejects.toThrow(DiskShrinkUnsupportedError)

    // 关键：**动任何东西之前就拒绝** —— 不探用量、不停机、不删机器、不落库。
    // 这跟 Docker 时代不同：那时会先探已用、再卸文件系统试缩，失败才回滚。
    // microVM 直接说明「只能扩」，所以一条运行时调用都不该发生。
    expect(fakes.calls.usage).not.toHaveBeenCalled()
    expect(fakes.calls.snapshot).not.toHaveBeenCalled()
    expect(fakes.calls.stopInstance).not.toHaveBeenCalled()
    expect(fakes.calls.removeInstance).not.toHaveBeenCalled()
    expect(fakes.calls.resizeStorage).not.toHaveBeenCalled()
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('停着的实例也一样拒绝（不因为「反正没在跑」就放行）', async () => {
    findById.mockResolvedValue(row({ status: 'stopped' }))
    const fakes = build()

    await expect(
      makeProvisioner(fakes).setQuota('i-1', { ...quota, diskMb: 1_024 }),
    ).rejects.toThrow(DiskShrinkUnsupportedError)
    expect(update).not.toHaveBeenCalled()
  })
})

describe('改配额：计算资源变化', () => {
  it('CPU 变了 → 删旧机器并按新规格重建', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    await makeProvisioner(fakes).setQuota('i-1', { ...quota, cpus: 2 })

    // 机器名由 slug 现算，不再拿容器 id
    expect(fakes.calls.removeInstance).toHaveBeenCalledWith('dsh-instance-alice')
    expect(fakes.calls.createInstance).toHaveBeenCalled()
    expect(fakes.calls.resizeStorage).not.toHaveBeenCalled()
  })

  it('什么都没变 → 只落库，不碰运行时', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    await makeProvisioner(fakes).setQuota('i-1', quota)

    expect(fakes.calls.stopInstance).not.toHaveBeenCalled()
    expect(fakes.calls.removeInstance).not.toHaveBeenCalled()
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
    expect(fakes.calls.resizeStorage).not.toHaveBeenCalled()
  })
})

/**
 * 让假 DB 记住写入——升级→失败→自动回滚这条链要读好几次行，
 * 常量 mock 会让回滚读到「还没有 previous_image」的旧行。
 */
function statefulDb(initial: InstanceRow): { current: () => InstanceRow } {
  let state = initial
  findById.mockImplementation(async () => state)
  update.mockImplementation(async (_db, _id, patch) => {
    state = { ...state, ...patch } as InstanceRow
    return state
  })
  return { current: () => state }
}

describe('换镜像：准入', () => {
  it('没发布过 → 拒绝，什么都没动', async () => {
    findById.mockResolvedValue(row())
    isPublished.mockResolvedValue(false)
    const fakes = build()

    await expect(makeProvisioner(fakes).setImage('i-1', 'dsh-instance:0.9.9')).rejects.toThrow(
      ImageRejectedError,
    )
    expect(fakes.calls.removeInstance).not.toHaveBeenCalled()
    expect(fakes.calls.snapshot).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('不是平台自己的镜像仓库 → 拒绝（挡住「换成别人的镜像」）', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()

    await expect(
      makeProvisioner(fakes).setImage('i-1', 'evil/backdoor:latest'),
    ).rejects.toThrow(/只能换成平台的实例镜像/)
    expect(fakes.calls.snapshot).not.toHaveBeenCalled()
  })

  it('tag 不是发布序列的形状 → 拒绝（公开仓库里谁都能推 :latest）', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    fakes.calls.listImageTags.mockResolvedValue(['dsh-instance:latest'])

    await expect(
      makeProvisioner(fakes).setImage('i-1', 'dsh-instance:latest'),
    ).rejects.toThrow(/不符合发布序列/)
    expect(fakes.calls.snapshot).not.toHaveBeenCalled()
  })

  it('宿主上没有、catalog 里也没有 → 拒绝', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    fakes.calls.listImageTags.mockResolvedValue(['dsh-instance:0.1.0_1'])

    await expect(
      makeProvisioner(fakes).setImage('i-1', NEW_IMAGE, { allowAny: true }),
    ).rejects.toThrow(/宿主上没有镜像/)
    expect(fakes.calls.snapshot).not.toHaveBeenCalled()
  })

  it('管理员 allowAny：catalog 里有但宿主上没有 → 放行（真正用到时自动拉）', async () => {
    const db = statefulDb(row())
    const fakes = build()
    fakes.calls.listImageTags.mockResolvedValue(['dsh-instance:0.1.0_1'])
    inCatalog.mockResolvedValue(true)

    const updated = await makeProvisioner(fakes).setImage('i-1', 'dsh-instance:0.1.2_1', {
      allowAny: true,
    })
    expect(updated.image).toBe('dsh-instance:0.1.2_1')
    expect(db.current().image).toBe('dsh-instance:0.1.2_1')
    expect(fakes.calls.snapshot).toHaveBeenCalledWith('alice')
  })

  it('用户面不吃 catalog 兜底：宿主上没有就拒（升级不该变成一次长 pull）', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    fakes.calls.listImageTags.mockResolvedValue(['dsh-instance:0.1.0_1'])
    inCatalog.mockResolvedValue(true)

    await expect(makeProvisioner(fakes).setImage('i-1', NEW_IMAGE)).rejects.toThrow(
      /宿主上没有镜像/,
    )
  })

  it('目标就是当前版本 → 幂等，不碰任何东西', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()

    const updated = await makeProvisioner(fakes).setImage('i-1', 'dsh-instance:0.1.0_1')
    expect(updated.image).toBe('dsh-instance:0.1.0_1')
    expect(fakes.calls.snapshot).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('换镜像：升级', () => {
  it('停容器 → 打快照 → 落库（新镜像 + previous_image）→ 重建', async () => {
    const db = statefulDb(row())
    const fakes = build()

    const updated = await makeProvisioner(fakes).setImage('i-1', NEW_IMAGE)

    // 先**优雅停机**（`:staged` 靠这一步把 guest 的写入回传宿主），再打快照。
    // 这里不是「删容器」——直接删会丢掉未回传的写入。
    expect(fakes.calls.stopInstance).toHaveBeenCalledWith('dsh-instance-alice')
    expect(fakes.calls.snapshot).toHaveBeenCalledWith('alice')
    expect(update).toHaveBeenCalledWith({}, 'i-1', {
      image: NEW_IMAGE,
      previousImage: 'dsh-instance:0.1.0_1',
      containerId: null,
    })
    expect(fakes.calls.createInstance).toHaveBeenCalled()
    expect(updated.image).toBe(NEW_IMAGE)
    expect(db.current().image).toBe(NEW_IMAGE)
  })

  it('快照失败 → **不落库**，按原规格把实例恢复起来', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    fakes.calls.snapshot.mockRejectedValue(new Error('宿主空间不足'))

    await expect(makeProvisioner(fakes).setImage('i-1', NEW_IMAGE)).rejects.toThrow(
      /打快照失败，实例未改动/,
    )
    // 落库这条**只认 image 那次写**——失败路径上的 restart 仍会写 status/containerId
    expect(update).not.toHaveBeenCalledWith({}, 'i-1', expect.objectContaining({ image: NEW_IMAGE }))
    // 容器已删、文件系统已卸载——但数据没动，重建就回到原样
    expect(fakes.calls.createInstance).toHaveBeenCalled()
  })

  it('新镜像起不来 → 自动回滚：数据回快照、镜像回旧版', async () => {
    const db = statefulDb(row())
    const fakes = build()
    fakes.calls.createInstance
      .mockRejectedValueOnce(new Error('crash-loop'))
      .mockResolvedValueOnce({ containerId: 'c-2', status: 'running' })

    await expect(makeProvisioner(fakes).setImage('i-1', NEW_IMAGE)).rejects.toThrow(
      ImageUpgradeFailedError,
    )

    expect(fakes.calls.restoreSnapshot).toHaveBeenCalledWith('alice')
    expect(db.current().image).toBe('dsh-instance:0.1.0_1')
    expect(db.current().previousImage).toBeNull()
    // 两次 createInstance：新镜像失败一次，回滚后旧镜像成功一次
    expect(fakes.calls.createInstance).toHaveBeenCalledTimes(2)
    expect(db.current().status).toBe('running')
  })

  it('原本停着的实例只落库，新镜像等用户自己 start', async () => {
    findById.mockResolvedValue(row({ status: 'stopped', containerId: null }))
    const fakes = build()

    const updated = await makeProvisioner(fakes).setImage('i-1', NEW_IMAGE)

    expect(updated.image).toBe(NEW_IMAGE)
    expect(fakes.calls.snapshot).toHaveBeenCalledWith('alice')
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
  })
})

describe('换镜像：回滚', () => {
  it('没有可回滚的版本 → NoRollbackError，什么都不动', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()

    await expect(makeProvisioner(fakes).rollbackImage('i-1')).rejects.toThrow(NoRollbackError)
    expect(fakes.calls.restoreSnapshot).not.toHaveBeenCalled()
  })

  it('恢复快照 → 落库回旧镜像（清空 previous_image）→ 重建', async () => {
    const db = statefulDb(
      row({ image: NEW_IMAGE, previousImage: 'dsh-instance:0.1.0_1' }),
    )
    const fakes = build()

    const updated = await makeProvisioner(fakes).rollbackImage('i-1')

    expect(fakes.calls.restoreSnapshot).toHaveBeenCalledWith('alice')
    expect(update).toHaveBeenCalledWith({}, 'i-1', {
      image: 'dsh-instance:0.1.0_1',
      previousImage: null,
      containerId: null,
    })
    expect(fakes.calls.createInstance).toHaveBeenCalled()
    expect(updated.image).toBe('dsh-instance:0.1.0_1')
    expect(db.current().previousImage).toBeNull()
  })
})

describe('重建前的镜像兜底（D23）', () => {
  it('restart / create 都先确保镜像在宿主上（被 prune 掉也能自愈）', async () => {
    statefulDb(row())
    const fakes = build()

    await makeProvisioner(fakes).restart('i-1')
    expect(fakes.calls.ensureImage).toHaveBeenCalledWith('dsh-instance:0.1.0_1')

    fakes.calls.ensureImage.mockClear()
    vi.mocked(createInstanceRecord).mockResolvedValue(row())
    await makeProvisioner(fakes).create({ slug: 'alice', ownerId: 'u1', ...quota })
    expect(fakes.calls.ensureImage).toHaveBeenCalledWith(DEFAULT_REF)
  })

  it('拉不到镜像 → 标 error，不建容器（别把「镜像没了」报成「规格错了」）', async () => {
    const db = statefulDb(row())
    const fakes = build()
    fakes.calls.ensureImage.mockRejectedValue(
      new Error('拉取镜像 dsh-instance:0.1.0_1 失败：manifest unknown'),
    )

    await expect(makeProvisioner(fakes).restart('i-1')).rejects.toThrow(/拉取镜像/)
    expect(db.current().status).toBe('error')
    expect(db.current().lastError).toContain('manifest unknown')
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
  })
})

describe('失败收尾：标 error 之后必须重新投影一次路由', () => {
  // 投影判据是**容器事实**（routableInstanceSlugs）。但投影这件事只在成功路径和
  // remove 的第一步里发生——失败路径不补这一下，路由就停在「上一次投影」的样子。
  // remove 尤其致命：它第一步就把路由摘了，后面任何一步失败都会留下
  // 「容器还好好地跑着、路由却没了」——页面表现为实例打不开，没人会修。
  it('remove 中途失败 → 标 error，并把已经摘掉的路由重新投影一次', async () => {
    const db = statefulDb(row())
    const fakes = build()
    vi.mocked(fakes.orchestrator.removeInstance).mockRejectedValue(new Error('daemon 超时'))

    await expect(makeProvisioner(fakes).remove('i-1')).rejects.toThrow('daemon 超时')

    expect(db.current().status).toBe('error')
    expect(db.current().lastError).toBe('daemon 超时')
    // ① 置 removing 后摘一次，② failWith 里补一次
    expect(fakes.calls.syncRoutes).toHaveBeenCalledTimes(2)
  })

  it('其他动作失败也补投影（create / restart 的重建路径同理）', async () => {
    const db = statefulDb(row())
    const fakes = build()
    fakes.calls.ensureImage.mockRejectedValue(new Error('拉取镜像失败'))

    await expect(makeProvisioner(fakes).restart('i-1')).rejects.toThrow('拉取镜像失败')

    expect(db.current().status).toBe('error')
    expect(fakes.calls.syncRoutes).toHaveBeenCalledTimes(1)
  })

  it('投影本身失败不能盖掉原始错误（标 error 已经落库了）', async () => {
    const db = statefulDb(row())
    const fakes = build()
    fakes.calls.ensureImage.mockRejectedValue(new Error('拉取镜像失败'))
    fakes.calls.syncRoutes.mockRejectedValue(new Error('Traefik 目录只读'))

    await expect(makeProvisioner(fakes).restart('i-1')).rejects.toThrow('拉取镜像失败')
    expect(db.current().status).toBe('error')
  })
})
