import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { InstanceSpec, RenderContext, RenderedInstance } from '@dsh-cloud/instance-spec'
import type { InstanceLiveState, InstanceUsage, RuntimeDriver } from '../runtime/driver.js'
import { InstanceOrchestrator } from './orchestrator.js'

const REPO = 'ghcr.io/eskim2001/dsh-instance'
const REF = `${REPO}:0.1.2-rc.1_2`

const SPEC: InstanceSpec = {
  slug: 'alice',
  image: REF,
  quota: { cpus: 1, memoryMb: 2048, pidsLimit: 512, diskMb: 10_240 },
  env: {},
}

const CTX: RenderContext = {
  baseImage: REF,
  baseDomain: 'app.example.com',
  gateToken: 'tok',
  storageKey: 'key',
  hostPort: 20001,
}

const RENDERED: RenderedInstance = {
  slug: 'alice',
  machineName: 'dsh-instance-alice',
  hostname: 'alice.app.example.com',
  image: REF,
  user: '0',
  workingDir: '/data',
  env: [],
  guestPort: 8080,
  hostPort: 20001,
  guestDataDir: '/data',
  mounts: [],
  labels: {},
}

/**
 * 假 driver：只记录调用，不碰真运行时。
 *
 * **这一层正是测试的重点**——编排层不该认识任何具体运行时，所以它的测试也不该起
 * 真进程或 mock 某个 CLI：所有机制都被 driver 接口挡住了。
 */
function fakeDriver(over: Partial<RuntimeDriver> = {}) {
  const calls = {
    ensureImage: vi.fn<RuntimeDriver['ensureImage']>(async () => undefined),
    imageExists: vi.fn<RuntimeDriver['imageExists']>(async () => true),
    openImagePull: vi.fn<RuntimeDriver['openImagePull']>(async () => Readable.from([])),
    create: vi.fn<RuntimeDriver['create']>(async () => RENDERED),
    start: vi.fn<RuntimeDriver['start']>(async () => undefined),
    stop: vi.fn<RuntimeDriver['stop']>(async () => undefined),
    remove: vi.fn<RuntimeDriver['remove']>(async () => undefined),
    status: vi.fn<RuntimeDriver['status']>(
      async (): Promise<InstanceLiveState | undefined> => ({ state: 'running', statusText: '' }),
    ),
    listInstanceNames: vi.fn<RuntimeDriver['listInstanceNames']>(async () => []),
    probeHealthy: vi.fn<RuntimeDriver['probeHealthy']>(async () => true),
    logs: vi.fn<RuntimeDriver['logs']>(async () => 'log line'),
    exec: vi.fn<RuntimeDriver['exec']>(async () => ({ code: 0, stdout: '' })),
    stats: vi.fn<RuntimeDriver['stats']>(async (): Promise<InstanceUsage | undefined> => undefined),
    heal: vi.fn<RuntimeDriver['heal']>(async () => undefined),
    listImageTags: vi.fn<RuntimeDriver['listImageTags']>(async () => [REF]),
  }
  return {
    driver: { runtime: 'smolvm', canReportLocalImages: true, ...calls, ...over } as RuntimeDriver,
    calls,
  }
}

describe('InstanceOrchestrator（运行时中立）', () => {
  it('镜像已在宿主上时不拉', async () => {
    const { driver, calls } = fakeDriver()
    const o = new InstanceOrchestrator(driver, REPO)

    await o.ensureImage(REF)

    expect(calls.imageExists).toHaveBeenCalledWith(REF)
    expect(calls.ensureImage).not.toHaveBeenCalled()
  })

  it('缺镜像时拉，且同一 ref 并发只拉一次', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    // 断言用的 spy 必须是**真正被调用的那个**：fakeDriver 的 `over` 会覆盖默认 spy，
    // 所以这里自己建一个并传进去。
    const ensureImage = vi.fn(async () => {
      await gate
    })
    const { driver } = fakeDriver({ imageExists: async () => false, ensureImage })
    const o = new InstanceOrchestrator(driver, REPO)

    const both = Promise.all([o.ensureImage(REF), o.ensureImage(REF)])
    release()
    await both

    // 两次调用落在同一个 in-flight promise 上
    expect(ensureImage).toHaveBeenCalledTimes(1)
  })

  it('拒绝拉平台仓库之外的镜像', async () => {
    const { driver, calls } = fakeDriver({ imageExists: async () => false })
    const o = new InstanceOrchestrator(driver, REPO)

    await expect(o.ensureImage('docker.io/library/alpine:3.19')).rejects.toThrow(/非平台镜像/)
    expect(calls.ensureImage).not.toHaveBeenCalled()
  })

  it('createInstance 把渲染结果和状态一起返回', async () => {
    const { driver, calls } = fakeDriver()
    const o = new InstanceOrchestrator(driver, REPO)

    const runtime = await o.createInstance(SPEC, CTX)

    expect(calls.create).toHaveBeenCalledWith(SPEC, CTX)
    expect(runtime.machineName).toBe('dsh-instance-alice')
    expect(runtime.hostPort).toBe(20001)
    expect(runtime.status).toBe('running')
  })

  it('inspectStatus 把「不存在」归一成 unknown', async () => {
    const { driver } = fakeDriver({ status: async () => undefined })
    const o = new InstanceOrchestrator(driver, REPO)

    expect(await o.inspectStatus('dsh-instance-alice')).toBe('unknown')
  })

  it('probeHealthy 探的是服务，不是运行时状态', async () => {
    // 这条**故意**和 inspectStatus 分开：运行时会用空转容器顶替崩溃的工作负载，
    // 而状态照样报 running，所以健康判定必须走独立的探活通道。
    const probeHealthy = vi.fn(async () => false)
    const { driver } = fakeDriver({ probeHealthy })
    const o = new InstanceOrchestrator(driver, REPO)

    expect(await o.probeHealthy('dsh-instance-alice', 20001)).toBe(false)
    expect(probeHealthy).toHaveBeenCalledWith('dsh-instance-alice', 20001)
  })

  it('logs 收口成 Readable（调用方按流消费）', async () => {
    const { driver } = fakeDriver({ logs: async () => 'hello' })
    const o = new InstanceOrchestrator(driver, REPO)

    const stream = await o.logs('dsh-instance-alice', { tail: 100 })
    const chunks: string[] = []
    for await (const c of stream) chunks.push(String(c))
    expect(chunks.join('')).toBe('hello')
  })

  it('listImageTags 去重并排序', async () => {
    const { driver } = fakeDriver({
      listImageTags: async () => [`${REPO}:b`, `${REPO}:a`, `${REPO}:b`],
    })
    const o = new InstanceOrchestrator(driver, REPO)

    expect(await o.listImageTags()).toEqual([`${REPO}:a`, `${REPO}:b`])
  })

  it('listInstanceStates 按机器名索引，取不到的跳过', async () => {
    const { driver } = fakeDriver({
      listInstanceNames: async () => ['dsh-instance-alice', 'dsh-instance-ghost'],
      status: async (name) =>
        name === 'dsh-instance-alice' ? { state: 'running', statusText: 'up' } : undefined,
    })
    const o = new InstanceOrchestrator(driver, REPO)

    const states = await o.listInstanceStates()
    expect([...states.keys()]).toEqual(['dsh-instance-alice'])
  })

})
