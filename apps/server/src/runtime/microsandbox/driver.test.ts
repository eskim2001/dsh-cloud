import type { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 驱动层唯一的测试。**mock 掉 `microsandbox` 整个模块** —— 这里要验的是我们自己的
 * 编排（短路、去重、流内报错、收尾清理），不是 SDK 能不能拉镜像；真拉一次要开微 VM
 * 加几百 MB 流量，跑不进单测。
 *
 * 用 `vi.hoisted`：`vi.mock` 的工厂会被提升到 import 之前，普通 `const` 那时还在
 * TDZ 里，拿不到。
 */
const mocks = vi.hoisted(() => ({
  imageGet: vi.fn(),
  sandboxRemove: vi.fn(async () => undefined),
  createWithPullProgress: vi.fn(),
}))

vi.mock('microsandbox', () => {
  class SandboxBuilder {
    image(): this {
      return this
    }
    cpus(): this {
      return this
    }
    memory(): this {
      return this
    }
    detached(): this {
      return this
    }
    workdir(): this {
      return this
    }
    pullPolicy(): this {
      return this
    }
    createWithPullProgress(): unknown {
      return mocks.createWithPullProgress()
    }
  }
  return {
    Image: { get: mocks.imageGet },
    Sandbox: { remove: mocks.sandboxRemove },
    SandboxBuilder,
  }
})

const { MicrosandboxDriver } = await import('./driver.js')

const REF = 'ghcr.io/eskim2001/dsh-instance:0.1.0_1'

/** 把流读完收成字符串。**不吞错误** —— 有 error 事件就当作测试失败。 */
function collect(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    stream.on('data', (chunk) => (out += String(chunk)))
    stream.on('end', () => resolve(out))
    stream.on('error', reject)
  })
}

/** 假的 `PullProgressCreate`：一个可异步迭代的事件序列 + `awaitSandbox`。 */
function fakePull(events: unknown[]) {
  return {
    awaitSandbox: vi.fn(async () => undefined),
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sandboxRemove.mockResolvedValue(undefined)
})

describe('MicrosandboxDriver.openImagePull（预热）', () => {
  it('本机已有：不开 VM，只回一行说明', async () => {
    mocks.imageGet.mockResolvedValueOnce({ reference: REF })
    const driver = new MicrosandboxDriver()

    const text = await collect(await driver.openImagePull(REF))

    expect(text).toContain('已在本机缓存')
    expect(mocks.createWithPullProgress).not.toHaveBeenCalled()
    expect(mocks.sandboxRemove).not.toHaveBeenCalled()
  })

  it('本机没有：开一次性沙箱、把事件拍成人话、结束即拆', async () => {
    mocks.imageGet.mockRejectedValueOnce(new Error('not found'))
    mocks.createWithPullProgress.mockResolvedValueOnce(
      fakePull([
        { kind: 'resolving', reference: REF },
        { kind: 'resolved', layerCount: 3, totalDownloadBytes: 5 * 1024 * 1024 },
        { kind: 'layerDownloadProgress', layerIndex: 0, downloadedBytes: 1024, totalBytes: 1024 },
        { kind: 'stitchComplete' },
        { kind: 'complete', reference: REF, layerCount: 3 },
      ]),
    )
    const driver = new MicrosandboxDriver()

    const text = await collect(await driver.openImagePull(REF))

    expect(text).toContain('解析')
    expect(text).toContain('共 3 层')
    expect(text).toContain('合并文件系统')
    expect(text).toContain('预热完成')
    // 一次性沙箱必须拆掉，名字走 dsh-prewarm- 前缀（否则会被当成实例）
    expect(mocks.sandboxRemove).toHaveBeenCalledTimes(1)
    expect(mocks.sandboxRemove.mock.calls[0]?.[0]).toMatch(/^dsh-prewarm-/)
  })

  it('拉取失败：**以流内一行报出，不抛**，且沙箱照样拆', async () => {
    mocks.imageGet.mockRejectedValueOnce(new Error('not found'))
    mocks.createWithPullProgress.mockRejectedValueOnce(
      new Error('no entry found in image index manifest'),
    )
    const driver = new MicrosandboxDriver()

    // 关键：`collect` 在流上挂了 error → reject。这里不 reject 就说明失败走的是数据行。
    const text = await collect(await driver.openImagePull(REF))

    expect(text).toContain('预热失败')
    expect(text).toContain('image index manifest')
    expect(mocks.sandboxRemove).toHaveBeenCalledTimes(1)
  })

  it('同一版本并发：第二次不开第二台', async () => {
    mocks.imageGet.mockRejectedValue(new Error('not found'))
    // 永不 resolve —— 模拟「第一条还在拉」。生成器是惰性的，这里它根本没开始跑。
    mocks.createWithPullProgress.mockImplementation(() => new Promise(() => {}))
    const driver = new MicrosandboxDriver()

    const first = await driver.openImagePull(REF)
    const second = await driver.openImagePull(REF)

    expect(await collect(second)).toContain('正在预热中')
    expect(mocks.createWithPullProgress).not.toHaveBeenCalled()
    first.destroy()
  })

  it('逐字节的进度刷屏会被压掉：同一 MiB 只出一行', async () => {
    mocks.imageGet.mockRejectedValueOnce(new Error('not found'))
    const sameMiB = { kind: 'layerDownloadProgress', layerIndex: 0, totalBytes: 4 * 1024 * 1024 }
    mocks.createWithPullProgress.mockResolvedValueOnce(
      fakePull([
        { ...sameMiB, downloadedBytes: 1024 },
        { ...sameMiB, downloadedBytes: 2048 },
        { ...sameMiB, downloadedBytes: 3 * 1024 * 1024 },
      ]),
    )
    const driver = new MicrosandboxDriver()

    const text = await collect(await driver.openImagePull(REF))

    const lines = text.split('\n').filter((l) => l.includes('下载'))
    expect(lines).toHaveLength(2) // 0 MiB 一行、3 MiB 一行；中间那两条被去重掉
  })
})
