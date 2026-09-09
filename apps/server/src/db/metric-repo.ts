import { and, desc, eq, gte, lt } from 'drizzle-orm'
import type { Db } from './client.js'
import { instanceMetric, type InstanceMetricRow } from './schema.js'

export interface NewMetric {
  instanceId: string
  /** 100 = 用满一个核，多核可以超过 100。 */
  cpuPercent: number
  memMb: number
  /** 已用磁盘 MB（文件系统超级块口径）。 */
  diskUsedMb: number
  sampledAt?: Date
}

export async function insertMetric(db: Db, input: NewMetric): Promise<void> {
  await db.insert(instanceMetric).values({
    id: crypto.randomUUID(),
    instanceId: input.instanceId,
    cpuPercent: input.cpuPercent,
    memMb: input.memMb,
    diskUsedMb: input.diskUsedMb,
    ...(input.sampledAt === undefined ? {} : { sampledAt: input.sampledAt }),
  })
}

/**
 * 取一个实例最近 `limit` 条采样，**按时间升序返回**（画图从旧到新）。
 *
 * `instanceId` 进 WHERE，不是取全表再过滤（铁律 7）。
 */
export async function listRecentMetrics(
  db: Db,
  instanceId: string,
  limit: number,
  since?: Date,
): Promise<InstanceMetricRow[]> {
  const where =
    since === undefined
      ? eq(instanceMetric.instanceId, instanceId)
      : and(eq(instanceMetric.instanceId, instanceId), gte(instanceMetric.sampledAt, since))

  // 先按时间倒序取最近 N 条，再翻过来
  const rows = await db
    .select()
    .from(instanceMetric)
    .where(where)
    .orderBy(desc(instanceMetric.sampledAt))
    .limit(limit)
  return rows.reverse()
}

/** 清掉 `cutoff` 之前的采样，返回删了几条。保留期由调用方决定。 */
export async function deleteMetricsBefore(db: Db, cutoff: Date): Promise<number> {
  const rows = await db
    .delete(instanceMetric)
    .where(lt(instanceMetric.sampledAt, cutoff))
    .returning({ id: instanceMetric.id })
  return rows.length
}
