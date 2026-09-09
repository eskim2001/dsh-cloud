import { describe, expect, it } from 'vitest'
import { InstanceSpecSchema, InstanceSlugSchema, isPinnedImage } from '../schema.js'
import { renderDockerInstance } from './docker.js'
import { DATA_ROOT, WORKSPACE_DIR } from '../constants.js'

const ctx = {
  baseImage: 'ghcr.io/example/dsh-instance:0.1.0',
  baseDomain: 'app.example.com',
  gateToken: 'token-alice',
  dataDir: '/var/lib/dsh/alice',
}

const spec = InstanceSpecSchema.parse({
  slug: 'alice',
  image: 'ghcr.io/example/dsh-instance:0.1.0',
  quota: { cpus: 1, memoryMb: 2048 },
})

describe('InstanceSlugSchema', () => {
  it('接受合法 slug', () => {
    expect(InstanceSlugSchema.parse('alice')).toBe('alice')
    expect(InstanceSlugSchema.parse('team-a1')).toBe('team-a1')
  })

  it('拒绝大写 / 首尾连字符 / 太短', () => {
    for (const bad of ['Alice', '-alice', 'alice-', 'ab', 'a'.repeat(33), 'al ice']) {
      expect(InstanceSlugSchema.safeParse(bad).success, bad).toBe(false)
    }
  })

  it('拒绝 punycode 前缀与保留字', () => {
    expect(InstanceSlugSchema.safeParse('xn--abc').success).toBe(false)
    expect(InstanceSlugSchema.safeParse('admin').success).toBe(false)
    expect(InstanceSlugSchema.safeParse('api').success).toBe(false)
  })
})

describe('ImageRefSchema', () => {
  it('拒绝注入类字符', () => {
    for (const bad of ['img; rm -rf /', 'img --privileged', 'img\nfoo', '']) {
      expect(InstanceSpecSchema.safeParse({ ...spec, image: bad }).success, bad).toBe(false)
    }
  })

  it('isPinnedImage 只认 digest', () => {
    expect(isPinnedImage(`repo@sha256:${'a'.repeat(64)}`)).toBe(true)
    expect(isPinnedImage('repo:tag')).toBe(false)
  })
})

describe('renderDockerInstance', () => {
  const rendered = renderDockerInstance(spec, ctx)
  const hc = rendered.createOptions.HostConfig

  it('命名稳定且带实例前缀', () => {
    expect(rendered.containerName).toBe('dsh-instance-alice')
    expect(rendered.networkName).toBe('dsh-net-alice')
    expect(rendered.dataDir).toBe('/var/lib/dsh/alice')
    expect(rendered.hostname).toBe('alice.app.example.com')
  })

  it('用户内容全部落在 /data', () => {
    expect(rendered.createOptions.WorkingDir).toBe(WORKSPACE_DIR)
    expect(rendered.createOptions.WorkingDir.startsWith(DATA_ROOT + '/')).toBe(true)
    // 宿主目录（该实例自己的文件系统挂载点）→ 容器 /data，不是 Docker named volume
    expect(hc.Binds).toEqual([`/var/lib/dsh/alice:${DATA_ROOT}`])
    expect(rendered.createOptions.Env).toContain(`DSH_HOME=${DATA_ROOT}`)
    expect(rendered.createOptions.Env).toContain(`HOME=${DATA_ROOT}/home`)
  })

  it('重启策略是 on-failure:5（不用 unless-stopped，避免挂载未就绪时被拉起）', () => {
    expect(hc.RestartPolicy).toEqual({ Name: 'on-failure', MaximumRetryCount: 5 })
  })

  it('加固项齐全', () => {
    expect(rendered.createOptions.User).toBe('node')
    // rootfs 可写：dsh 是编码 agent，要能装依赖（D12）
    expect(hc.ReadonlyRootfs).toBe(false)
    expect(hc.Init).toBe(false) // PID 1 由镜像里的 tini 担任
    expect(hc.CapDrop).toEqual(['ALL'])
    expect(hc.SecurityOpt).toContain('no-new-privileges:true')
    expect(hc.PidsLimit).toBe(512)
    expect(hc.Tmpfs['/tmp']).toContain('rw')
  })

  it('agent 装的全局包落进卷（升级不丢）', () => {
    const env = rendered.createOptions.Env
    expect(env).toContain(`NPM_CONFIG_PREFIX=${DATA_ROOT}/.npm-global`)
    expect(env).toContain(`PNPM_HOME=${DATA_ROOT}/.pnpm`)
    expect(env).toContain(`PNPM_STORE_DIR=${DATA_ROOT}/.pnpm-store`)
    expect(env.find((e) => e.startsWith('PATH='))).toContain(`${DATA_ROOT}/.npm-global/bin`)
  })

  it('不发布任何宿主端口，且挂独立网络', () => {
    // 发布出去就经 Docker Desktop 的 VM 网关对**所有**容器可见 → 门① 破
    expect(hc.PortBindings).toEqual({})
    expect(rendered.containerPort).toBe(8080)
    expect(hc.NetworkMode).toBe('dsh-net-alice')
  })

  it('配额换算正确', () => {
    expect(hc.Memory).toBe(2048 * 1024 * 1024)
    expect(hc.NanoCpus).toBe(1_000_000_000)
    // 磁盘不进 Docker 参数——它决定数据文件系统大小（host-storage），这里只验默认值
    expect(spec.quota.diskMb).toBe(10_240)
  })

  it('注入 header 门所需的环境变量', () => {
    const env = rendered.createOptions.Env
    expect(env).toContain('DSH_GATE_HEADER=X-Platform-Token')
    expect(env).toContain('DSH_GATE_TOKEN=token-alice')
    expect(env).toContain('DSH_GATE_INSTANCE=alice')
    expect(env).toContain('DSH_TRUSTED_HOSTS=alice.app.example.com')
  })
})
