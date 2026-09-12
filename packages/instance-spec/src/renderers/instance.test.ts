import { describe, expect, it } from 'vitest'
import { BRIDGE_PORT, DATA_ROOT, GATE_TOKEN_HEADER } from '../constants.js'
import { InstanceSpecSchema } from '../schema.js'
import { renderInstance } from './instance.js'
import type { RenderContext } from './types.js'

/**
 * 渲染结果是**驱动的唯一输入**，所以这里钉住的是"机器定义里必须有什么"。
 *
 * 最要紧的一条是**资源上限**：它们曾经不在这份定义里，驱动只好回去翻 `spec.quota` ——
 * 于是漏了 `pidsLimit` 也没人发现（界面上能调、容器里不生效）。所以哪怕觉得"这只是
 * 把字段搬个地方"，也别把这条用例删掉。
 */

const spec = InstanceSpecSchema.parse({
  slug: 'alice',
  image: 'ghcr.io/example/dsh-instance:1.2.3',
  quota: { cpus: 4, memoryMb: 8192, pidsLimit: 1024, diskMb: 20_480 },
  env: { DSH_MODEL: 'deepseek-chat' },
})

const ctx: RenderContext = {
  baseImage: 'ghcr.io/example/dsh-instance:1.2.3',
  baseDomain: 'app.example.com',
  gateToken: 'gate-token-abc',
  storageKey: 'a'.repeat(32),
  hostPort: 20001,
}

describe('renderInstance', () => {
  it('**资源上限必须出现在机器定义里**（漏一个就是限额静默不生效）', () => {
    const r = renderInstance(spec, ctx)

    expect(r.cpus).toBe(4)
    expect(r.memoryMb).toBe(8192)
    expect(r.pidsLimit).toBe(1024)
  })

  it('身份：机器名与主机名都由 slug 派生，hostname 用**父域**', () => {
    const r = renderInstance(spec, ctx)

    expect(r.machineName).toBe('dsh-instance-alice')
    expect(r.hostname).toBe('alice.app.example.com')
    expect(r.slug).toBe('alice')
  })

  it('挂载只有 /data 一项、可写、容量来自 quota.diskMb', () => {
    const r = renderInstance(spec, ctx)

    expect(r.mounts).toEqual([
      { storageKey: 'a'.repeat(32), guest: DATA_ROOT, mode: 'rw', sizeMb: 20_480 },
    ])
    expect(r.guestDataDir).toBe(DATA_ROOT)
    // WORKDIR 只能是挂载点本身：空卷里还没有 workspace 那层骨架
    expect(r.workingDir).toBe(DATA_ROOT)
  })

  it('入口那套 env 由平台给，不由实例控制', () => {
    const r = renderInstance(spec, ctx)

    expect(r.env).toContain(`DSH_GATE_TOKEN=${ctx.gateToken}`)
    expect(r.env).toContain(`DSH_TRUSTED_HOSTS=${r.hostname}`)
    // 实例自己的 env 只做追加
    expect(r.env).toContain('DSH_MODEL=deepseek-chat')
    expect(r.guestPort).toBe(BRIDGE_PORT)
  })

  it('数据卷标识**不透明**：宿主路径不进渲染结果', () => {
    const r = renderInstance(spec, ctx)
    const asText = JSON.stringify(r)

    expect(asText).not.toContain('/var/lib')
    expect(asText).not.toContain('/pool')
    // 每实例的 gate header 名是常量，值才是变量
    expect(r.env).toContain(`DSH_GATE_HEADER=${'X-Platform-Token'}`)
    expect(GATE_TOKEN_HEADER).toBe('X-Platform-Token')
  })
})
