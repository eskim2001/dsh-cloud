import { machineName } from '@dsh-cloud/instance-spec'
import type { InstancePatch } from '../db/instance-repo.js'
import type { InstanceRow } from '../db/schema.js'

/**
 * 编排正在进行的状态。对账器**不碰**它们——正在跑的动作会自己写状态，
 * 插手只会打架。
 */
const TRANSIENT = new Set(['provisioning', 'removing'])

/** 运行时里实例还算「活着」的状态。 */
const LIVE_STATE = new Set(['running', 'restarting'])

export interface ReconcileDeps {
  listInstances(): Promise<InstanceRow[]>
  /** 实例当前状态；`undefined` = 机器已经不在（被 prune / 手动删）。 */
  inspectStatus(machineName: string): Promise<string | undefined>
  update(id: string, patch: InstancePatch): Promise<unknown>
  /** 现存的实例机器名（用来发现 DB 里没有的孤儿）。 */
  listInstanceNames(): Promise<string[]>
  warn(msg: string): void
}

/**
 * 把 DB 的 `status` 拉回和运行时实际一致。
 *
 * 为什么需要：实例可能被外部改（重启宿主、手动删机器、被 prune），DB 的快照会漂。
 * DB 是真相源，但它记的是**意图**；对账器负责把「意图」和「事实」对齐。
 *
 * 只同步 running ↔ stopped 这一对：
 * - `error` 不动——用户要靠 `lastError` 看到失败原因，重试是 `restart` 的事；
 * - `provisioning` / `removing` 不动——见 TRANSIENT；
 * - 孤儿机器**只告警不删**：删有竞态，可能误伤正在创建的实例。
 *
 * ⚠️ **这里同步的是运行时的自报状态，不等于服务健康**。smolvm 实测会在工作负载崩溃时
 * 换一个空转容器顶上、状态照样报 running —— 真正的死活要看 `probeHealthy`，
 * 那条路径挂在 `probe` 依赖上（见 `InstanceOrchestrator.probeHealthy`）。
 */
export async function reconcileInstances(deps: ReconcileDeps): Promise<{ changed: number }> {
  const rows = await deps.listInstances()
  const known = new Set(rows.map((r) => machineName(r.slug)))
  let changed = 0

  for (const row of rows) {
    if (TRANSIENT.has(row.status)) continue
    if (row.containerId === null) continue
    if (row.status !== 'running' && row.status !== 'stopped') continue

    let live: boolean
    try {
      const status = await deps.inspectStatus(row.containerId)
      if (status === undefined) {
        // 机器没了。清掉运行时标识——下次 start 直接走重建，不用先撞一次空引用
        await deps.update(row.id, { status: 'stopped', containerId: null })
        changed += row.status === 'running' ? 1 : 0
        continue
      }
      live = LIVE_STATE.has(status)
    } catch (err) {
      // 查不动就别改状态——宁可留着上一次的快照，也不要瞎写
      deps.warn(`对账实例 ${row.slug} 失败：${messageOf(err)}`)
      continue
    }

    if (live && row.status === 'stopped') {
      await deps.update(row.id, { status: 'running', lastError: null })
      changed += 1
    } else if (!live && row.status === 'running') {
      await deps.update(row.id, { status: 'stopped' })
      changed += 1
    }
  }

  for (const name of await deps.listInstanceNames()) {
    if (!known.has(name)) {
      deps.warn(`孤儿实例 ${name}：DB 里没有对应实例，未自动删除`)
    }
  }

  return { changed }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
