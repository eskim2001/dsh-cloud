import type { NewMetric } from '../db/metric-repo.js'
import type { InstanceRow } from '../db/schema.js'
import type { ContainerUsage } from './container-stats.js'

export const SAMPLE_INTERVAL_MS = 60_000
/** 采样保留 30 天——够看趋势，又不至于把库撑爆。 */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** 清理不用每分钟跑，一小时一次足够。 */
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

export interface SamplerDeps {
  /** 只采运行中的实例（其他状态没有容器可采）。 */
  listRunning(): Promise<InstanceRow[]>
  stats(containerId: string): Promise<ContainerUsage | undefined>
  /** 已用磁盘。读不到就返回 undefined——写 0 会把趋势线砸下去。 */
  disk(slug: string, quotaMb: number): Promise<{ usedMb: number } | undefined>
  insert(metric: NewMetric): Promise<void>
  deleteBefore(cutoff: Date): Promise<number>
  warn(msg: string): void
  now?(): Date
}

/**
 * 采一轮：对每个运行中的实例取一帧用量写库。
 *
 * **单实例失败只告警**——一个坏容器不该让整轮采样挂掉，更不该让进程崩。
 * `stats` 返回 `undefined`（首帧没有差值）时直接跳过这一轮，不写假数据。
 */
export async function sampleOnce(deps: SamplerDeps): Promise<void> {
  const rows = (await deps.listRunning()).filter((r) => r.containerId !== null)

  const results = await Promise.allSettled(
    rows.map(async (row) => {
      const [usage, disk] = await Promise.all([
        deps.stats(row.containerId!),
        deps.disk(row.storageKey, row.diskMb),
      ])
      if (usage === undefined) return
      await deps.insert({
        instanceId: row.id,
        cpuPercent: usage.cpuPercent,
        memMb: usage.memMb,
        diskUsedMb: disk?.usedMb ?? 0,
      })
    }),
  )

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      deps.warn(`采样实例 ${rows[i]?.slug ?? '?'} 失败：${messageOf(result.reason)}`)
    }
  })
}

/**
 * 起定时采样，返回停止函数。**定时器必须 unref**，否则进程退不掉、测试挂住。
 */
export function startMetricsSampler(deps: SamplerDeps): () => void {
  const now = deps.now ?? (() => new Date())
  let lastCleanup = 0

  const tick = async (): Promise<void> => {
    try {
      await sampleOnce(deps)
    } catch (err) {
      deps.warn(`采样轮次失败：${messageOf(err)}`)
    }

    const at = now().getTime()
    if (at - lastCleanup < CLEANUP_INTERVAL_MS) return
    lastCleanup = at
    try {
      const removed = await deps.deleteBefore(new Date(at - RETENTION_MS))
      if (removed > 0) deps.warn(`清理了 ${removed} 条过期采样`)
    } catch (err) {
      deps.warn(`清理过期采样失败：${messageOf(err)}`)
    }
  }

  const timer = setInterval(() => void tick(), SAMPLE_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}

/**
 * 错误 → 一行给人看的文本。
 *
 * ⚠️ **必须带上 `cause`**：drizzle 只在自己那层说「Failed query: ...」，而 PG 的真正原因
 * （约束名、`invalid input syntax ...`）挂在 `cause` 上。不带它，采样失败就只剩一句
 * 「Failed query」，看不出为什么 —— 实测因此让一个采样失败静默了很久。
 */
function messageOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = err.cause instanceof Error ? err.cause.message : undefined
  return cause === undefined ? err.message : `${err.message} ← ${cause}`
}
