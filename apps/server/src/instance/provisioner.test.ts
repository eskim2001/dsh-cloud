import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceRow } from '../db/schema.js'
import type { Env } from '../env.js'
import type { HostStorage } from './host-storage.js'
import type { InstanceOrchestrator } from './orchestrator.js'
import {
  ImageRejectedError,
  ImageUpgradeFailedError,
  InstanceProvisioner,
  NoRollbackError,
  ShrinkBelowUsageError,
  ShrinkFailedError,
} from './provisioner.js'

vi.mock('../db/instance-repo.js', () => ({
  findInstanceById: vi.fn(),
  updateInstance: vi.fn(),
  countInstancesByOwner: vi.fn(),
  createInstanceRecord: vi.fn(),
  deleteInstanceRecord: vi.fn(),
  retainInstanceRecord: vi.fn(),
  QuotaExceededError: class QuotaExceededError extends Error {},
}))
vi.mock('../db/user-repo.js', () => ({ findUserQuota: vi.fn() }))

const { findInstanceById, updateInstance, createInstanceRecord, retainInstanceRecord, deleteInstanceRecord } = await import('../db/instance-repo.js')
const findById = vi.mocked(findInstanceById)
const update = vi.mocked(updateInstance)

const env = {
  BASE_DOMAIN: 'app.example.com',
  PLATFORM_SECRET: 'test-secret',
  INSTANCE_IMAGE: 'dsh-instance:0.1.0',
  INSTANCE_STABLE_IMAGES: 'dsh-instance:0.1.1',
  MAX_INSTANCES_PER_USER: 3,
} as Env

/** 升级目标：白名单里的那一版。 */
const NEW_IMAGE = 'dsh-instance:0.1.1'

function row(over: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id: 'i-1',
    slug: 'alice',
    storageKey: 'alice',
    deletedAt: null,
    ownerId: 'u1',
    status: 'running',
    image: 'dsh-instance:0.1.0',
    previousImage: null,
    containerId: 'c-1',
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
  storage: HostStorage
  orchestrator: InstanceOrchestrator
  syncRoutes: () => Promise<void>
  calls: {
    ensure: ReturnType<typeof vi.fn>
    usage: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    shrink: ReturnType<typeof vi.fn>
    snapshot: ReturnType<typeof vi.fn>
    restoreSnapshot: ReturnType<typeof vi.fn>
    removeContainer: ReturnType<typeof vi.fn>
    createInstance: ReturnType<typeof vi.fn>
    listImageTags: ReturnType<typeof vi.fn>
  }
}

function build(): Fakes {
  const ensure = vi.fn(async () => undefined)
  const usage = vi.fn(async () => ({ usedMb: 100, quotaMb: 10_240 }))
  const resize = vi.fn(async () => undefined)
  const shrink = vi.fn(async () => undefined)
  const snapshot = vi.fn(async () => undefined)
  const restoreSnapshot = vi.fn(async () => undefined)
  const removeContainer = vi.fn(async () => undefined)
  const listImageTags = vi.fn(async () => ['dsh-instance:0.1.0', 'dsh-instance:0.1.1'])
  const createInstance = vi.fn(async () => ({
    slug: 'alice',
    containerName: 'dsh-instance-alice',
    networkName: 'dsh-net-alice',
    dataDir: '/var/lib/dsh/alice',
    hostname: 'alice.app.example.com',
    containerPort: 8080,
    containerId: 'c-2',
    status: 'running',
  }))

  const storage = {
    ensure,
    usage,
    resize,
    shrink,
    snapshot,
    restoreSnapshot,
    create: vi.fn(),
    destroy: vi.fn(),
    assertMounted: vi.fn(),
    mountPoint: (slug: string) => `/var/lib/dsh/${slug}`,
  } as unknown as HostStorage
  const orchestrator = {
    removeContainer,
    removeInstance: vi.fn(),
    createInstance,
    listImageTags,
  } as unknown as InstanceOrchestrator

  return {
    storage,
    orchestrator,
    syncRoutes: async () => undefined,
    calls: {
      ensure,
      usage,
      resize,
      shrink,
      snapshot,
      restoreSnapshot,
      removeContainer,
      createInstance,
      listImageTags,
    },
  }
}

function makeProvisioner(fakes: Fakes): InstanceProvisioner {
  return new InstanceProvisioner(
    {} as never,
    fakes.orchestrator,
    fakes.storage,
    env,
    fakes.syncRoutes,
  )
}

const quota = { cpus: 1, memoryMb: 2048, pidsLimit: 512, diskMb: 10_240 }

beforeEach(() => {
  vi.clearAllMocks()
  update.mockImplementation(async (_db, _id, patch) => ({ ...row(), ...patch }) as InstanceRow)
})

describe('storage ownership across lifecycle operations', () => {
  it('creates data at the reserved storage key, never the public slug', async () => {
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ storageKey: 'unique-data-key' }))
    const fakes = build()
    await makeProvisioner(fakes).create({ slug: 'alice', ownerId: 'u1', ...quota })
    expect(createInstanceRecord).toHaveBeenCalledWith({}, expect.objectContaining({ ownerId: 'u1' }), 3)
    expect(fakes.storage.create).toHaveBeenCalledWith('unique-data-key', quota.diskMb)
    expect(fakes.calls.createInstance).toHaveBeenCalledWith(expect.objectContaining({ slug: 'alice' }), expect.objectContaining({ dataDir: '/var/lib/dsh/unique-data-key' }))
  })

  it('keeps the ownership record when deleting without a purge', async () => {
    findById.mockResolvedValue(row({ storageKey: 'unique-data-key' }))
    const fakes = build()
    await makeProvisioner(fakes).remove('i-1')
    expect(retainInstanceRecord).toHaveBeenCalledWith({}, 'i-1')
    expect(deleteInstanceRecord).not.toHaveBeenCalled()
    expect(fakes.storage.destroy).not.toHaveBeenCalled()
  })

  it('purges only the selected storage key after slug confirmation', async () => {
    findById.mockResolvedValue(row({ storageKey: 'unique-data-key' }))
    const fakes = build()
    await makeProvisioner(fakes).remove('i-1', { purgeVolume: true, confirmSlug: 'alice' })
    expect(fakes.storage.destroy).toHaveBeenCalledWith('unique-data-key')
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
    expect(fakes.calls.ensure).toHaveBeenCalledWith('unique-data-key', quota.diskMb)
    expect(fakes.calls.createInstance).toHaveBeenLastCalledWith(expect.objectContaining({ slug: 'alice' }), expect.objectContaining({ dataDir: '/var/lib/dsh/unique-data-key' }))
  })
})

describe('改配额：扩容', () => {
  it('uses the immutable storage key instead of a reused slug', async () => {
    findById.mockResolvedValue(row({ storageKey: 'new-owner-data' }))
    const fakes = build()
    await makeProvisioner(fakes).setQuota('i-1', { ...quota, diskMb: 20_480 })
    expect(fakes.calls.resize).toHaveBeenCalledWith('new-owner-data', 20_480)
    expect(fakes.calls.resize).not.toHaveBeenCalledWith('alice', 20_480)
  })

  it('只扩容时**不重建容器**，在线 resize', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    await makeProvisioner(fakes).setQuota('i-1', { ...quota, diskMb: 20_480 })

    expect(fakes.calls.resize).toHaveBeenCalledWith('alice', 20_480)
    expect(fakes.calls.removeContainer).not.toHaveBeenCalled()
    expect(fakes.calls.shrink).not.toHaveBeenCalled()
    // 落库不带 containerId: null——容器没动，得留着
    expect(update).toHaveBeenCalledWith({}, 'i-1', { ...quota, diskMb: 20_480 })
  })
})

describe('改配额：缩容', () => {
  it('已用超过目标 → 直接拒绝，容器和配额都不动', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    fakes.calls.usage.mockResolvedValue({ usedMb: 5_000, quotaMb: 10_240 })

    await expect(
      makeProvisioner(fakes).setQuota('i-1', { ...quota, diskMb: 1_024 }),
    ).rejects.toThrow(ShrinkBelowUsageError)

    expect(fakes.calls.removeContainer).not.toHaveBeenCalled()
    expect(fakes.calls.shrink).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('预检前先确保挂载（停着的实例也要读得到用量）', async () => {
    findById.mockResolvedValue(row({ status: 'stopped' }))
    const fakes = build()
    fakes.calls.usage.mockResolvedValue({ usedMb: 5_000, quotaMb: 10_240 })

    await expect(
      makeProvisioner(fakes).setQuota('i-1', { ...quota, diskMb: 1_024 }),
    ).rejects.toThrow(ShrinkBelowUsageError)
    expect(fakes.calls.ensure).toHaveBeenCalledWith('alice', 10_240)
  })

  it('shrink 失败 → 配额回滚为原值、实例按原规格恢复', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    fakes.calls.shrink.mockRejectedValue(new Error('New size smaller than minimum (32041)'))

    await expect(
      makeProvisioner(fakes).setQuota('i-1', { ...quota, diskMb: 1_024 }),
    ).rejects.toThrow(ShrinkFailedError)

    // 先落新配额、再回滚旧配额
    expect(update).toHaveBeenNthCalledWith(1, {}, 'i-1', {
      ...quota,
      diskMb: 1_024,
      containerId: null,
    })
    expect(update).toHaveBeenNthCalledWith(2, {}, 'i-1', quota)
    // 恢复：容器重建（applyRuntime）
    expect(fakes.calls.createInstance).toHaveBeenCalled()
  })

  it('缩容成功 → 删容器 → 卸载缩容 → 按新规格重建', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    await makeProvisioner(fakes).setQuota('i-1', { ...quota, diskMb: 5_120 })

    expect(fakes.calls.removeContainer).toHaveBeenCalledWith('c-1')
    expect(fakes.calls.shrink).toHaveBeenCalledWith('alice', 5_120)
    expect(fakes.calls.createInstance).toHaveBeenCalled()
    expect(fakes.calls.resize).not.toHaveBeenCalled()
  })

  it('原本停着的实例缩容后**保持停止**（只删旧容器，不擅自启动）', async () => {
    findById.mockResolvedValue(row({ status: 'stopped' }))
    const fakes = build()
    await makeProvisioner(fakes).setQuota('i-1', { ...quota, diskMb: 5_120 })

    expect(fakes.calls.shrink).toHaveBeenCalled()
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
  })
})

describe('改配额：计算资源变化', () => {
  it('CPU 变了 → 删旧容器并按新规格重建', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    await makeProvisioner(fakes).setQuota('i-1', { ...quota, cpus: 2 })

    expect(fakes.calls.removeContainer).toHaveBeenCalledWith('c-1')
    expect(fakes.calls.createInstance).toHaveBeenCalled()
    expect(fakes.calls.shrink).not.toHaveBeenCalled()
    expect(fakes.calls.resize).not.toHaveBeenCalled()
  })

  it('什么都没变 → 只落库，不碰 Docker', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    await makeProvisioner(fakes).setQuota('i-1', quota)

    expect(fakes.calls.removeContainer).not.toHaveBeenCalled()
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
    expect(fakes.calls.resize).not.toHaveBeenCalled()
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
  it('不在稳定版白名单 → 拒绝，什么都没动', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()

    await expect(makeProvisioner(fakes).setImage('i-1', 'dsh-instance:0.9.9')).rejects.toThrow(
      ImageRejectedError,
    )
    expect(fakes.calls.removeContainer).not.toHaveBeenCalled()
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

  it('宿主上没有这个 tag → 拒绝（不去 registry 拉，失败信息看不懂）', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    fakes.calls.listImageTags.mockResolvedValue(['dsh-instance:0.1.0'])

    await expect(makeProvisioner(fakes).setImage('i-1', NEW_IMAGE)).rejects.toThrow(
      /宿主上没有镜像/,
    )
    expect(fakes.calls.snapshot).not.toHaveBeenCalled()
  })

  it('管理员 allowAny 绕过白名单，但仍必须本地已有', async () => {
    const db = statefulDb(row())
    const fakes = build()
    fakes.calls.listImageTags.mockResolvedValue(['dsh-instance:0.1.0', 'dsh-instance:0.1.2'])

    const updated = await makeProvisioner(fakes).setImage('i-1', 'dsh-instance:0.1.2', {
      allowAny: true,
    })
    expect(updated.image).toBe('dsh-instance:0.1.2')
    expect(db.current().image).toBe('dsh-instance:0.1.2')
    expect(fakes.calls.snapshot).toHaveBeenCalledWith('alice')
  })

  it('目标就是当前版本 → 幂等，不碰任何东西', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()

    const updated = await makeProvisioner(fakes).setImage('i-1', 'dsh-instance:0.1.0')
    expect(updated.image).toBe('dsh-instance:0.1.0')
    expect(fakes.calls.snapshot).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('换镜像：升级', () => {
  it('停容器 → 打快照 → 落库（新镜像 + previous_image）→ 重建', async () => {
    const db = statefulDb(row())
    const fakes = build()

    const updated = await makeProvisioner(fakes).setImage('i-1', NEW_IMAGE)

    expect(fakes.calls.removeContainer).toHaveBeenCalledWith('c-1')
    expect(fakes.calls.snapshot).toHaveBeenCalledWith('alice')
    expect(update).toHaveBeenCalledWith({}, 'i-1', {
      image: NEW_IMAGE,
      previousImage: 'dsh-instance:0.1.0',
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
    expect(db.current().image).toBe('dsh-instance:0.1.0')
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
      row({ image: NEW_IMAGE, previousImage: 'dsh-instance:0.1.0' }),
    )
    const fakes = build()

    const updated = await makeProvisioner(fakes).rollbackImage('i-1')

    expect(fakes.calls.restoreSnapshot).toHaveBeenCalledWith('alice')
    expect(update).toHaveBeenCalledWith({}, 'i-1', {
      image: 'dsh-instance:0.1.0',
      previousImage: null,
      containerId: null,
    })
    expect(fakes.calls.createInstance).toHaveBeenCalled()
    expect(updated.image).toBe('dsh-instance:0.1.0')
    expect(db.current().previousImage).toBeNull()
  })
})
