import { z } from 'zod'
import { stringify as toYaml } from 'yaml'
import { BRIDGE_PORT, containerName } from '@dsh-cloud/instance-spec'

/** 主机名必须是安全的 ASCII hostname——它会进 Traefik 的 Host() 规则。 */
const HostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)

export const TraefikRouteSchema = z.object({
  instance: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  hostname: HostnameSchema,
})

export type TraefikRoute = z.infer<typeof TraefikRouteSchema>

export interface TraefikOptions {
  /** forward-auth 端点（控制面）。 */
  forwardAuthAddress: string
  authMiddlewareName?: string
  entryPoint?: string
  /**
   * 挂在 router 上的 `tls` 块。省略 = 明文（本地 `web` 那档）；
   * `{}` = 用 file provider 里的静态证书（SNI 匹配）；带 `certResolver` = ACME 自动签发。
   * 挂到 `websecure` 的 router **必须显式给**，Traefik 不会因为 entryPoint 开了 TLS 就自动加。
   */
  tls?: { certResolver?: string }
}

export interface TraefikConfig {
  http: {
    middlewares: Record<string, { forwardAuth: { address: string; authResponseHeaders: string[] } }>
    routers: Record<
      string,
      {
        rule: string
        service: string
        middlewares: string[]
        entryPoints: string[]
        tls?: { certResolver?: string }
      }
    >
    services: Record<string, { loadBalancer: { servers: Array<{ url: string }> } }>
  }
}

/**
 * 生成 Traefik 的动态配置（file provider）。
 *
 * 每个实例一个 router + service，全部挂同一个 forward-auth 中间件——
 * **新增路由必须走这里**，否则会漏挂认证（见 docs/ARCHITECTURE.md §四）。
 *
 * 后端是**实例网络里的容器名**：入口被接进每个实例网络（D3），所以能按名字
 * 解析到容器。实例容器不发布任何宿主端口——发布出去就经 Docker Desktop 的
 * VM 网关对所有容器可见，门① 会破（见 OPEN-QUESTIONS #4）。
 *
 * 返回结构化对象（测试直接断言它，不经过序列化）；落盘用 `renderTraefikConfig`。
 */
export function buildTraefikConfig(routes: TraefikRoute[], opts: TraefikOptions): TraefikConfig {
  const authName = opts.authMiddlewareName ?? 'platform-auth'
  const entryPoint = opts.entryPoint ?? 'websecure'

  const parsed = routes.map((r) => TraefikRouteSchema.parse(r))

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
      routers: Object.fromEntries(
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
      ),
      services: Object.fromEntries(
        parsed.map((r) => [
          `instance-${r.instance}`,
          {
            loadBalancer: {
              servers: [{ url: `http://${containerName(r.instance)}:${BRIDGE_PORT}` }],
            },
          },
        ]),
      ),
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
