import { machineName } from '@dsh-cloud/instance-spec'
import type { InstanceLiveState } from './orchestrator.js'

/** 编排正在进行的状态：实例是死的活的都不算数，等动作自己收尾。 */
const IN_FLIGHT = new Set(['provisioning', 'removing'])

/** 机器名 → 实时状态。整张表取不到时用 `undefined`（别传空表，那等于「所有实例都没了」）。 */
export type ContainerStates = Map<string, InstanceLiveState>

export interface RuntimeStatus {
  /** 对外的实例状态。非落定态（provisioning / removing / restarting）时前端要接着轮询。 */
  status: string
  /** 运行时的原文描述，例如 `running (pid 12345)`；没有就是 null。 */
  statusText: string | null
}

/**
 * 把「DB 记的意图」和「运行时的事实」合成对外状态。
 *
 * DB 的 `status` 是意图不是事实：工作负载 crash-loop 时它仍写着 running，因为它记的是
 * 「我们想让它跑」。所以**除了编排进行中和 error**，其余一律以运行时为准。
 * `states` 为 `undefined` 表示这次取不到实时状态（运行时抖了）——退回 DB 快照，
 * 宁可显示旧值也不要谎报「全部已停止」。
 *
 * ⚠️ 但运行时的自报状态**不等于服务健康**：容器 running 也可能端口还没人听。
 * 真正的死活要看 `InstanceOrchestrator.probeHealthy`。
 *
 * 注：`row.containerId` 现在装的是**机器名**（运行时侧标识）。列名等 DB 迁移时再改，
 * 现在先保持最小改动。
 */
export function resolveRuntimeStatus(
  row: { status: string; containerId: string | null; slug: string },
  states: ContainerStates | undefined,
): RuntimeStatus {
  if (IN_FLIGHT.has(row.status) || row.status === 'error') {
    return { status: row.status, statusText: null }
  }
  if (states === undefined) return { status: row.status, statusText: null }

  // 还没有运行时侧标识、或机器已经不在（被 prune / 手动删）——都算停着
  if (row.containerId === null) return { status: 'stopped', statusText: null }
  const live = states.get(machineName(row.slug))
  if (live === undefined) return { status: 'stopped', statusText: null }

  switch (live.state) {
    case 'running':
      return { status: 'running', statusText: live.statusText }
    case 'restarting':
      return { status: 'restarting', statusText: live.statusText }
    default:
      // stopped / created / dead / unknown：都不是「跑着」
      return { status: 'stopped', statusText: live.statusText }
  }
}
