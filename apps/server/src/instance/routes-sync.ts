import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { instanceHostname, machineName } from '@dsh-cloud/instance-spec'
import type { InstanceRow } from '../db/schema.js'
import type { ContainerStates } from './runtime-status.js'
import { renderTraefikConfig, type TraefikRoute } from './traefik.js'

export interface RoutesSyncOptions {
  /** Traefik file provider 监视的目录下的文件名。 */
  configPath: string
  baseDomain: string
  /** 控制面的 forward-auth 端点，如 `http://127.0.0.1:3000/auth/verify`。 */
  forwardAuthAddress: string
  /** 实例后端的上游主机名（见 `Env.INSTANCE_UPSTREAM_HOST`）。 */
  upstreamHost?: string
  entryPoint?: string
  /** 见 `TraefikOptions.tls`：省略 = 明文。 */
  tls?: { certResolver?: string }
  /**
   * 实例的实时状态（见 `orchestrator.listInstanceStates`）。
   * **省略 = 取不到**（运行时抖了）→ 退回 DB 意图。见 `routableInstances`。
   */
  containerStates?: ContainerStates
}

/**
 * 编排正在进行的状态。对账器一样不碰它们（`reconciler.ts` 的 TRANSIENT）。
 * 这段窗口里实例死活都不算数，而且 `remove` 的第一步就是「先摘路由再删实例」——
 * 早摘才对，不能等机器真没了才摘。
 */
const IN_FLIGHT = new Set(['provisioning', 'removing'])

/** 运行时在这些状态下算「在服务」。`restarting` 也算：crash-loop 会自己回来，摘了反而回不来。 */
const SERVING = new Set(['running', 'restarting'])

/**
 * 哪些实例此刻该有路由。判据是**运行时事实**，不是 DB 的 `status`。
 *
 * `status` 记的是意图，一次失败的操作就会把它写成 `error`（`provisioner` 每个动作的 catch
 * 都这么写），而实例往往还好好地跑着。照 status 判的话，这条路由一旦被摘（`remove` 第一步
 * 就摘）就再也回不来了——对账器又跳过 `error`，没人会把它加回去。症状是「实例打开了 404」，
 * 而真实原因是「上一次操作失败了」，两码事。
 *
 * **没有 `hostPort` 的行也要排除**：入口是按宿主端口转发的，没有端口就没有可转发的地址
 * （Docker 时代的存量行就是这种状态，重建后才会有）。
 *
 * `states` 省略表示这次读不到运行时：退回 DB 意图。
 * **失败即关闭**——宁可少投影一条，也不要多投影一条。
 */
export function routableInstances(
  instances: InstanceRow[],
  states: ContainerStates | undefined,
): InstanceRow[] {
  return instances.filter((row) => {
    if (IN_FLIGHT.has(row.status)) return false
    if (row.hostPort === null || row.hostPort === undefined) return false
    if (states === undefined) return row.status === 'running'
    // 机器名就是证据：有没有、在不在服务，运行时说了算
    const live = states.get(machineName(row.slug))
    return live !== undefined && SERVING.has(live.state)
  })
}

/**
 * 把此刻**在服务**的实例渲染成 Traefik 动态配置，返回被投影的 slug。
 *
 * 准入判据全部收在 `routableInstances` 里——包括「containerStates 取不到时怎么办」。
 */
export async function syncRoutesFromInstances(
  instances: InstanceRow[],
  opts: RoutesSyncOptions,
): Promise<string[]> {
  const routable = routableInstances(instances, opts.containerStates)
  const routes: TraefikRoute[] = routable.map((row) => ({
    instance: row.slug,
    hostname: instanceHostname(row.slug, opts.baseDomain),
    // 后端地址：microVM 只能把实例发布到宿主回环，所以按端口转发（见 traefik.ts 的注释）。
    hostPort: row.hostPort as number,
  }))

  const json = renderTraefikConfig(routes, {
    forwardAuthAddress: opts.forwardAuthAddress,
    ...(opts.upstreamHost === undefined ? {} : { upstreamHost: opts.upstreamHost }),
    ...(opts.entryPoint === undefined ? {} : { entryPoint: opts.entryPoint }),
    ...(opts.tls === undefined ? {} : { tls: opts.tls }),
  })

  await mkdir(dirname(opts.configPath), { recursive: true })
  // 先写临时文件再 rename：Traefik 不会读到写了一半的配置
  const tmp = `${opts.configPath}.tmp`
  await writeFile(tmp, json, 'utf8')
  await rename(tmp, opts.configPath)

  return routable.map((row) => row.slug)
}
