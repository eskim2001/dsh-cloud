import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { instanceHostname } from '@dsh-cloud/instance-spec'
import type { InstanceRow } from '../db/schema.js'
import { renderTraefikConfig, type TraefikRoute } from './traefik.js'

export interface RoutesSyncOptions {
  /** Traefik file provider 监视的目录下的文件名。 */
  configPath: string
  baseDomain: string
  /** 控制面的 forward-auth 端点，如 `http://127.0.0.1:3000/auth/verify`。 */
  forwardAuthAddress: string
  entryPoint?: string
  /** 见 `TraefikOptions.tls`：省略 = 明文。 */
  tls?: { certResolver?: string }
}

/**
 * 把当前**运行中**的实例渲染成 Traefik 动态配置。
 *
 * 只路由 `running`：容器没起来时给 Traefik 一条路由只会变成 502，
 * 而漏挂认证是安全洞——所以这里**失败即关闭**（少一条路由，不是多一条裸路由）。
 */
export async function syncRoutesFromInstances(
  instances: InstanceRow[],
  opts: RoutesSyncOptions,
): Promise<void> {
  const routes: TraefikRoute[] = instances
    .filter((t) => t.status === 'running')
    .map((t) => ({
      instance: t.slug,
      hostname: instanceHostname(t.slug, opts.baseDomain),
    }))

  const json = renderTraefikConfig(routes, {
    forwardAuthAddress: opts.forwardAuthAddress,
    ...(opts.entryPoint === undefined ? {} : { entryPoint: opts.entryPoint }),
    ...(opts.tls === undefined ? {} : { tls: opts.tls }),
  })

  await mkdir(dirname(opts.configPath), { recursive: true })
  // 先写临时文件再 rename：Traefik 不会读到写了一半的 JSON
  const tmp = `${opts.configPath}.tmp`
  await writeFile(tmp, json, 'utf8')
  await rename(tmp, opts.configPath)
}
