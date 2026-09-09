import { Readable } from 'node:stream'
import type Docker from 'dockerode'
import { describe, expect, it, vi } from 'vitest'
import { HostStorage, HostStorageError } from './host-storage.js'

/** 造一帧 Docker 多路复用输出（8 字节头 + 负载）。 */
function frame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const head = Buffer.alloc(8)
  head.writeUInt32BE(payload.length, 4)
  return Buffer.concat([head, payload])
}

interface Call {
  image: string
  script: string
  hostConfig: Record<string, unknown>
}

/**
 * 假 docker：只实现 `createContainer`，把脚本记下来，按 responder 返回退出码与输出。
 * 真容器在单测里跑不了，但「生成什么脚本、怎么判成败」是纯逻辑，值得钉住。
 */
function fakeDocker(responder: (script: string) => { status?: number; out?: string } = () => ({})) {
  const calls: Call[] = []
  const docker = {
    createContainer: async (opts: {
      Image: string
      Cmd: string[]
      HostConfig: Record<string, unknown>
    }) => {
      const script = opts.Cmd[opts.Cmd.length - 1] ?? ''
      const { status = 0, out = '' } = responder(script)
      calls.push({ image: opts.Image, script, hostConfig: opts.HostConfig })
      return {
        attach: async () => Readable.from([frame(out)]),
        start: async () => undefined,
        wait: async () => ({ StatusCode: status }),
        remove: async () => undefined,
      }
    },
  }
  return { docker: docker as unknown as Docker, calls }
}

const config = { root: '/var/lib/dsh/', helperImage: 'alpine:3.20' }

function build(responder?: (script: string) => { status?: number; out?: string }) {
  const { docker, calls } = fakeDocker(responder)
  return { storage: new HostStorage(docker, config), calls }
}

describe('路径', () => {
  it('挂载点 / 数据文件按 slug 拼，root 末尾斜杠会被去掉', () => {
    const { storage } = build()
    expect(storage.mountPoint('alice')).toBe('/var/lib/dsh/alice')
    expect(storage.imagePath('alice')).toBe('/var/lib/dsh/alice.img')
  })

  it('非法 slug 在**碰 docker 之前**就抛（路径由它拼出来）', async () => {
    const { storage, calls } = build()
    for (const bad of ['../etc', 'a/b', '', 'Alice', 'a b']) {
      await expect(storage.create(bad, 1024)).rejects.toThrow(HostStorageError)
      await expect(storage.ensure(bad, 1024)).rejects.toThrow(HostStorageError)
      expect(() => storage.mountPoint(bad)).toThrow(HostStorageError)
    }
    expect(calls).toHaveLength(0)
  })

  it('配额必须是正整数 MB', async () => {
    const { storage, calls } = build()
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(storage.create('alice', bad)).rejects.toThrow(HostStorageError)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('create vs ensure', () => {
  it('create 允许建文件与格式化（ALLOW=1）', async () => {
    const { storage, calls } = build()
    await storage.create('alice', 1024)

    const script = calls[0]?.script ?? ''
    expect(script).toContain('ALLOW=1')
    expect(script).toContain('mkfs.ext4')
    expect(script).toContain(`'/var/lib/dsh/alice.img'`)
    expect(script).toContain(`'/var/lib/dsh/alice'`)
  })

  it('ensure **绝不**允许新建或格式化（ALLOW=0）', async () => {
    const { storage, calls } = build()
    await storage.ensure('alice', 1024)
    expect(calls[0]?.script).toContain('ALLOW=0')
  })

  it('两种模式都先判 mountpoint 再决定挂不挂（重复调用安全）', async () => {
    const { storage, calls } = build()
    await storage.create('alice', 1024)
    await storage.ensure('alice', 1024)
    for (const call of calls) {
      expect(call.script).toContain('mountpoint -q')
    }
  })

  it('目标是配额字节数', async () => {
    const { storage, calls } = build()
    await storage.create('alice', 1024)
    expect(calls[0]?.script).toContain('WANT=1073741824')
  })
})

describe('特权助手容器', () => {
  it('nsenter 进宿主命名空间，且只这一处特权', async () => {
    const { storage, calls } = build()
    await storage.ensure('alice', 1024)

    expect(calls[0]?.image).toBe('alpine:3.20')
    expect(calls[0]?.hostConfig).toMatchObject({
      Privileged: true,
      PidMode: 'host',
      NetworkMode: 'none',
    })
  })

  it('非零退出 → 抛错，带上退出码和输出（存储操作没有「尽力而为」）', async () => {
    const { storage } = build(() => ({ status: 7, out: '数据文件不存在' }))
    await expect(storage.ensure('alice', 1024)).rejects.toThrow(/exit 7.*数据文件不存在/s)
  })

  it('助手容器跑完就删，失败也删', async () => {
    const remove = vi.fn(async () => undefined)
    const docker = {
      createContainer: async () => ({
        attach: async () => Readable.from([frame('')]),
        start: async () => undefined,
        wait: async () => ({ StatusCode: 1 }),
        remove,
      }),
    } as unknown as Docker

    const storage = new HostStorage(docker, config)
    await expect(storage.ensure('alice', 1024)).rejects.toThrow(HostStorageError)
    expect(remove).toHaveBeenCalledWith({ force: true })
  })
})

describe('挂载判定', () => {
  it('isMounted 认 mountpoint 的输出，不认目录存在', async () => {
    const { storage } = build(() => ({ out: 'yes\n' }))
    await expect(storage.isMounted('alice')).resolves.toBe(true)

    const { storage: no } = build(() => ({ out: 'no\n' }))
    await expect(no.isMounted('alice')).resolves.toBe(false)
  })

  it('assertMounted：没挂上就抛（绝不让容器带着空目录起来）', async () => {
    const { storage } = build(() => ({ out: 'no\n' }))
    await expect(storage.assertMounted('alice')).rejects.toThrow(/未挂载/)
  })

  it('assertMounted：挂着就静默通过', async () => {
    const { storage } = build(() => ({ out: 'yes\n' }))
    await expect(storage.assertMounted('alice')).resolves.toBeUndefined()
  })
})

describe('用量', () => {
  it('读 df 的已用列，换算成 MB', async () => {
    const { storage, calls } = build(() => ({ out: '1234567\n' }))
    await expect(storage.usage('alice', 10_240)).resolves.toEqual({
      usedMb: 1206,
      quotaMb: 10_240,
    })
    expect(calls[0]?.script).toContain('df -Pk')
  })

  it('没挂载 → undefined（不是 0：0 会被当成「真的没用量」）', async () => {
    const { storage } = build(() => ({ out: 'unmounted\n' }))
    await expect(storage.usage('alice', 10_240)).resolves.toBeUndefined()
  })

  it('输出解析不了 → 抛，不编一个数字出来', async () => {
    const { storage } = build(() => ({ out: 'bogus\n' }))
    await expect(storage.usage('alice', 10_240)).rejects.toThrow(/无法解析磁盘用量/)
  })
})

describe('扩容 / 缩容 / 销毁', () => {
  it('扩容：改文件大小 → 通知 loop → resize2fs，不重建文件系统', async () => {
    const { storage, calls } = build()
    await storage.resize('alice', 2048)

    const script = calls[0]?.script ?? ''
    expect(script).toContain('resize2fs')
    expect(script).toContain('losetup -c')
    expect(script).not.toContain('mkfs')
  })

  it('缩容：先自己卸载（调用方只负责停容器），再 e2fsck + resize2fs + 截断 + 摘 loop', async () => {
    const { storage, calls } = build()
    await storage.shrink('alice', 512)

    const script = calls[0]?.script ?? ''
    expect(script).toContain('umount')
    expect(script).toContain('不能缩容')
    expect(script).toContain('e2fsck')
    expect(script).toContain('MB=512')
    expect(script).toContain('losetup -d')
  })

  it('销毁：卸载 → 摘 loop → 删文件（不可逆）', async () => {
    const { storage, calls } = build()
    await storage.destroy('alice')

    const script = calls[0]?.script ?? ''
    expect(script).toContain('umount')
    expect(script).toContain('losetup -d')
    expect(script).toContain('rm -f')
  })
})
