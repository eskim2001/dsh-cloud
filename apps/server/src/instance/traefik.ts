import { z } from 'zod'
import { stringify as toYaml } from 'yaml'

/** 主机名必须是安全的 ASCII hostname——它会进 Traefik 的 Host() 规则。 */
const HostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)

export const TraefikRouteSchema = z.object({
  instance: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  hostname: HostnameSchema,
  /**
   * 该实例在**宿主回环**上发布的端口。入口转发到这里。
   *
   * 实例只把桥端口发布到 `127.0.0.1:<hostPort>`（不让局域网够到），所以入口不按容器名
   * 解析——直接打回环端口；容器里的 Traefik 走 `host.docker.internal`（见 compose/local.yml）。
   */
  hostPort: z.number().int().positive().max(65535),
})

export type TraefikRoute = z.infer<typeof TraefikRouteSchema>

export interface TraefikOptions {
  /** forward-auth 端点（控制面）。 */
  forwardAuthAddress: string
  /**
   * 实例后端的上游主机名（见 `Env.INSTANCE_UPSTREAM_HOST`）。
   * 省略 = `127.0.0.1`（Traefik 跑在宿主上）；容器里的 Traefik 要传 `host.docker.internal`。
   */
  upstreamHost?: string
  authMiddlewareName?: string
  entryPoint?: string
  /**
   * 挂在 router 上的 `tls` 块。省略 = 明文（本地 `web` 那档）；
   * `{}` = 用 file provider 里的静态证书（SNI 匹配；一张都没有时落到 Traefik 默认证书）；
   * 带 `certResolver` = ACME 自动签发。
   * 挂到 `websecure` 的 router **必须显式给**，Traefik 不会因为 entryPoint 开了 TLS 就自动加。
   */
  tls?: { certResolver?: string }
}

export interface TraefikConfig {
  http: {
    middlewares: Record<string, { forwardAuth: { address: string; authResponseHeaders: string[] } }>
    /**
     * 没有实例时**整个键省略**，不要输出空 map：Traefik v3.5 的 file provider 遇到
     * 「有 middlewares、但 routers/services 是空 map」会拒收整份文件
     * （`routers cannot be a standalone element`），platform-auth 中间件跟着丢。
     * 省略和空 map 对 Traefik 是等价的。
     */
    routers?: Record<
      string,
      {
        rule: string
        service: string
        middlewares: string[]
        entryPoints: string[]
        tls?: { certResolver?: string }
      }
    >
    services?: Record<string, { loadBalancer: { servers: Array<{ url: string }> } }>
  }
}

/**
 * 生成 Traefik 的动态配置（file provider）。
 *
 * 每个实例一个 router + service，全部挂同一个 forward-auth 中间件——
 * **新增路由必须走这里**，否则会漏挂认证（见 docs/ARCHITECTURE.md §四）。
 *
 * 后端是**宿主回环上的端口**：实例只把端口发布到 `127.0.0.1`，入口直接转发到那里
 * （容器里的 Traefik 走 `host.docker.internal`）。
 *
 * **回归红线**：D3 时代「不发布宿主端口」的理由是 Docker Desktop 的 VM 网关会让发布端口
 * 对**所有**容器可见。microVM 时代实测该暴露面**不存在**（每台 VM 独立 NAT、guest IP 互指
 * 自己），但那是 microVM 的结论。**换回 Docker 后它不成立**：任何容器都能经
 * `host.docker.internal` 打到宿主的回环发布端口 —— 同宿主的实例容器之间因此可以互访。
 * 所以这条结论**依附于运行时**，换运行时必须重验，别继承（见 docs/DECISIONS.md）。
 *
 * 返回结构化对象（测试直接断言它，不经过序列化）；落盘用 `renderTraefikConfig`。
 */
export function buildTraefikConfig(routes: TraefikRoute[], opts: TraefikOptions): TraefikConfig {
  const authName = opts.authMiddlewareName ?? 'platform-auth'
  // Traefik 跑在容器里时 `127.0.0.1` 是**容器自己的**回环，打实例会 502。
  const upstreamHost = opts.upstreamHost ?? '127.0.0.1'
  const entryPoint = opts.entryPoint ?? 'websecure'

  const parsed = routes.map((r) => TraefikRouteSchema.parse(r))

  const routers = Object.fromEntries(
    parsed.map((r) => [
      `instance-${r.instance}`,
      {
        rule: `Host(\`${r.hostname}\`)`,
        service: `instance-${r.instance}`,
        middlewares: [authName],
        entryPoints: [entryPoint],
        ...(opts.tls === undefined ? {} : { tls: opts.tls }),
      },
    ]),
  )
  const services = Object.fromEntries(
    parsed.map((r) => [
      `instance-${r.instance}`,
      {
        loadBalancer: {
          servers: [{ url: `http://${upstreamHost}:${r.hostPort}` }],
        },
      },
    ]),
  )

  return {
    http: {
      middlewares: {
        [authName]: {
          forwardAuth: {
            address: opts.forwardAuthAddress,
            // 认证通过后由 forward-auth 注入，桥会校验 token
            authResponseHeaders: ['X-Platform-Instance', 'X-Platform-Token', 'Cookie'],
          },
        },
      },
      // 空 map 会被 Traefik 拒收，没实例时就不输出这两个键（见 TraefikConfig.routers）
      ...(parsed.length === 0 ? {} : { routers, services }),
    },
  }
}

/**
 * 序列化成 YAML——**必须是 YAML**：file provider 在 directory 模式下只读
 * `.yml` / `.yaml` / `.toml`，`.json` 会被静默忽略（配置里看到的是空对象，
 * 所有路由 404，且不报错）。
 */
export function renderTraefikConfig(routes: TraefikRoute[], opts: TraefikOptions): string {
  return toYaml(buildTraefikConfig(routes, opts))
}
