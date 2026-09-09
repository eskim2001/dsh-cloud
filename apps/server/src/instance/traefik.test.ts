import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { GATE_INSTANCE_HEADER, GATE_TOKEN_HEADER } from '@dsh-cloud/instance-spec'
import { buildTraefikConfig, renderTraefikConfig, type TraefikOptions } from './traefik.js'

const ROUTES = [
  { instance: 'alice', hostname: 'alice.app.example.com' },
  { instance: 'bob', hostname: 'bob.app.example.com' },
]

function render(over: Partial<TraefikOptions> = {}) {
  return buildTraefikConfig(ROUTES, {
    forwardAuthAddress: 'http://127.0.0.1:3000/auth/verify',
    ...over,
  })
}

describe('renderTraefikConfig', () => {
  it('每条路由都挂了 forward-auth（漏挂就是洞，且不会报错）', () => {
    const cfg = render()
    const routers = Object.values(cfg.http.routers!)
    expect(routers).toHaveLength(2)
    for (const r of routers) expect(r.middlewares).toContain('platform-auth')
  })

  it('回注桥需要的两个 header', () => {
    const cfg = render()
    expect(cfg.http.middlewares['platform-auth']?.forwardAuth.authResponseHeaders).toEqual([
      GATE_INSTANCE_HEADER,
      GATE_TOKEN_HEADER,
      'Cookie',
    ])
  })

  it('后端是实例网络里的容器名（D3：不发布宿主端口，入口进网络直连）', () => {
    const cfg = render()
    expect(cfg.http.services!['instance-alice']?.loadBalancer.servers[0]?.url).toBe(
      'http://dsh-instance-alice:8080',
    )
  })

  it('Host 规则用完整主机名', () => {
    const cfg = render()
    expect(cfg.http.routers!['instance-alice']?.rule).toBe('Host(`alice.app.example.com`)')
  })

  it('默认挂 websecure（线上 TLS 在 Traefik 终结）', () => {
    const cfg = render()
    expect(cfg.http.routers!['instance-alice']?.entryPoints).toEqual(['websecure'])
  })

  it('entryPoint 可覆盖', () => {
    const cfg = render({ entryPoint: 'web' })
    expect(cfg.http.routers!['instance-alice']?.entryPoints).toEqual(['web'])
  })

  it('默认不挂 tls（明文档不该有 tls 块）', () => {
    const cfg = render()
    expect(cfg.http.routers!['instance-alice']?.tls).toBeUndefined()
  })

  it('tls: {} = 用 file provider 的静态证书（本地自签）', () => {
    const cfg = render({ tls: {} })
    expect(cfg.http.routers!['instance-alice']?.tls).toEqual({})
  })

  it('tls 带 certResolver = ACME 自动签发（线上）', () => {
    const cfg = render({ tls: { certResolver: 'letsencrypt' } })
    expect(cfg.http.routers!['instance-alice']?.tls).toEqual({ certResolver: 'letsencrypt' })
  })

  it('落盘是 YAML 且能原样读回（file provider 只认 yml/yaml/toml，json 会被静默忽略）', () => {
    const text = renderTraefikConfig(ROUTES, {
      forwardAuthAddress: 'http://127.0.0.1:3000/auth/verify',
    })
    expect(text).not.toMatch(/^\s*\{/)
    expect(parseYaml(text)).toEqual(
      render() as unknown as Record<string, unknown>,
    )
  })

  it('没有实例时不输出空的 routers/services（Traefik v3.5 会整份文件拒收，中间件跟着丢）', () => {
    const cfg = buildTraefikConfig([], { forwardAuthAddress: 'http://127.0.0.1:3000/auth/verify' })
    expect(cfg.http.routers).toBeUndefined()
    expect(cfg.http.services).toBeUndefined()
    expect(cfg.http.middlewares['platform-auth']).toBeDefined()
  })
})
