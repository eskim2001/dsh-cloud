import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import type { InstanceRow } from '../db/schema.js'
import { syncRoutesFromInstances } from './routes-sync.js'

function row(over: Partial<InstanceRow> & { slug: string }): InstanceRow {
  return {
    id: `t-${over.slug}`,
    storageKey: over.slug,
    deletedAt: null,
    ownerId: 'u1',
    status: 'running',
    image: 'dsh-instance:0.1.0',
    previousImage: null,
    containerId: null,
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

describe('syncRoutesFromInstances', () => {
  let dir: string
  let configPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-routes-'))
    configPath = join(dir, 'nested', 'routes.yml')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const opts = {
    baseDomain: 'app.example.com',
    forwardAuthAddress: 'http://127.0.0.1:3000/auth/verify',
  }

  it('只路由 running 的实例（容器没起来给路由只会 502，漏挂认证才是洞）', async () => {
    await syncRoutesFromInstances(
      [
        row({ slug: 'alice' }),
        row({ slug: 'bob', status: 'provisioning' }),
        row({ slug: 'carol', status: 'error' }),
        row({ slug: 'dave', status: 'stopped' }),
        row({ slug: 'erin', status: 'removing' }),
      ],
      { ...opts, configPath },
    )

    const cfg = parseYaml(await readFile(configPath, 'utf8')) as {
      http: {
        routers: Record<string, unknown>
        services: Record<string, { loadBalancer: { servers: Array<{ url: string }> } }>
      }
    }
    expect(Object.keys(cfg.http.routers)).toEqual(['instance-alice'])
    // 后端是实例网络里的容器名——不发布宿主端口
    expect(cfg.http.services['instance-alice']?.loadBalancer.servers[0]?.url).toBe(
      'http://dsh-instance-alice:8080',
    )
  })

  it('目录不存在会自建（首次启动时动态目录还没建）', async () => {
    await syncRoutesFromInstances([row({ slug: 'alice' })], { ...opts, configPath })
    expect(parseYaml(await readFile(configPath, 'utf8'))).toBeDefined()
  })

  it('不留临时文件', async () => {
    await syncRoutesFromInstances([row({ slug: 'alice' })], { ...opts, configPath })
    await expect(readFile(`${configPath}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('tls 透传到每条 router（443 上的 router 不写 tls 就收不到请求）', async () => {
    await syncRoutesFromInstances([row({ slug: 'alice' })], {
      ...opts,
      configPath,
      tls: { certResolver: 'letsencrypt' },
    })

    const cfg = parseYaml(await readFile(configPath, 'utf8')) as {
      http: { routers: Record<string, { tls?: unknown }> }
    }
    expect(cfg.http.routers['instance-alice']?.tls).toEqual({ certResolver: 'letsencrypt' })
  })
})
