import { containerName } from '@dsh-cloud/instance-spec'
import type { InstancePatch } from '../db/instance-repo.js'
import type { InstanceRow } from '../db/schema.js'

/**
 * 编排正在进行的状态。对账器**不碰**它们——正在跑的动作会自己写状态，
 * 插手只会打架。
 */
const TRANSIENT = new Set(['provisioning', 'removing'])

/** Docker 里容器还活着（或马上会活）的状态。 */
const LIVE_CONTAINER = new Set(['running', 'restarting', 'paused'])

export interface ReconcileDeps {
  listInstances(): Promise<InstanceRow[]>
  /** 容器当前状态；`undefined` = 容器已经不在（被 prune / 手动删）。 */
  inspectStatus(containerId: string): Promise<string | undefined>
  update(id: string, patch: InstancePatch): Promise<unknown>
  /** 现存的实例容器名（用来发现 DB 里没有的孤儿）。 */
  listContainerNames(): Promise<string[]>
  warn(msg: string): void
}

/**
 * 把 DB 的 `status` 拉回和 Docker 实际一致。
 *
 * 为什么需要：容器可能被外部改（`docker stop`、宿主重启后 `unless-stopped`
 * 自动拉起、被 prune），DB 的快照会漂。DB 是真相源，但它记的是**意图**；
 * 对账器负责把「意图」和「事实」对齐。
 *
 * 只同步 running ↔ stopped 这一对：
 * - `error` 不动——用户要靠 `lastError` 看到失败原因，重试是 `restart` 的事；
 * - `provisioning` / `removing` 不动——见 TRANSIENT；
 * - 孤儿容器**只告警不删**：删有竞态，可能误伤正在创建的实例。
 */
export async function reconcileInstances(deps: ReconcileDeps): Promise<{ changed: number }> {
  const rows = await deps.listInstances()
  const known = new Set(rows.map((r) => containerName(r.slug)))
  let changed = 0

  for (const row of rows) {
    if (TRANSIENT.has(row.status)) continue
    if (row.containerId === null) continue
    if (row.status !== 'running' && row.status !== 'stopped') continue

    let live: boolean
    try {
      const status = await deps.inspectStatus(row.containerId)
      if (status === undefined) {
        // 容器没了。清掉 containerId——下次 start 直接走重建，不用先撞一次 404
        await deps.update(row.id, { status: 'stopped', containerId: null })
        changed += row.status === 'running' ? 1 : 0
        continue
      }
      live = LIVE_CONTAINER.has(status)
    } catch (err) {
      // 查不动就别改状态——宁可留着上一次的快照，也不要瞎写
      deps.warn(`对账实例 ${row.slug} 失败：${messageOf(err)}`)
      continue
    }

    if (live && row.status === 'stopped') {
      // 宿主重启后 unless-stopped 会把容器拉起来，DB 还记着「已停止」
      await deps.update(row.id, { status: 'running', lastError: null })
      changed += 1
    } else if (!live && row.status === 'running') {
      await deps.update(row.id, { status: 'stopped' })
      changed += 1
    }
  }

  for (const name of await deps.listContainerNames()) {
    if (!known.has(name)) {
      deps.warn(`孤儿容器 ${name}：DB 里没有对应实例，未自动删除`)
    }
  }

  return { changed }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
