import { containerName } from '@dsh-cloud/instance-spec'
import type { ContainerLiveState } from './orchestrator.js'

/** 编排正在进行的状态：容器是死的活的都不算数，等动作自己收尾。 */
const IN_FLIGHT = new Set(['provisioning', 'removing'])

/** 容器名 → 实时状态。整张表取不到时用 `undefined`（别传空表，那等于「所有容器都没了」）。 */
export type ContainerStates = Map<string, ContainerLiveState>

export interface RuntimeStatus {
  /** 对外的实例状态。非落定态（provisioning / removing / restarting）时前端要接着轮询。 */
  status: string
  /** Docker 的原文描述，例如 `Restarting (3) 20 seconds ago`；没有就是 null。 */
  statusText: string | null
}

/**
 * 把「DB 记的意图」和「Docker 的事实」合成对外状态。
 *
 * DB 的 `status` 是意图不是事实：容器 crash-loop 时它仍写着 running，因为它记的是
 * 「我们想让它跑」。所以**除了编排进行中和 error**，其余一律以 Docker 为准。
 * `states` 为 `undefined` 表示这次取不到实时状态（Docker 抖了）——退回 DB 快照，
 * 宁可显示旧值也不要谎报「全部已停止」。
 */
export function resolveRuntimeStatus(
  row: { status: string; containerId: string | null; slug: string },
  states: ContainerStates | undefined,
): RuntimeStatus {
  if (IN_FLIGHT.has(row.status) || row.status === 'error') {
    return { status: row.status, statusText: null }
  }
  if (states === undefined) return { status: row.status, statusText: null }

  // 没有容器 id、或容器已经不在（被 prune / 手动删）——都算停着
  if (row.containerId === null) return { status: 'stopped', statusText: null }
  const live = states.get(containerName(row.slug))
  if (live === undefined) return { status: 'stopped', statusText: null }

  switch (live.state) {
    case 'running':
      return { status: 'running', statusText: live.statusText }
    case 'restarting':
      return { status: 'restarting', statusText: live.statusText }
    case 'paused':
      return { status: 'paused', statusText: live.statusText }
    default:
      // exited / created / dead / removing：都不是「跑着」
      return { status: 'stopped', statusText: live.statusText }
  }
}
