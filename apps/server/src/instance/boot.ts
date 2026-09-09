import type { InstanceRow } from '../db/schema.js'

export interface BootDeps {
  listInstances(): Promise<InstanceRow[]>
  /** 挂载该实例的数据文件系统。**不允许新建**——数据文件没了就该报错。 */
  ensure(slug: string, diskMb: number): Promise<void>
  /** 拉起实例（容器在就 start，不在就重建）。 */
  start(id: string): Promise<void>
  markError(id: string, message: string): Promise<void>
  warn(msg: string): void
}

/**
 * 平台启动时的第一步：**恢复数据，再恢复容器**（D18）。
 *
 * 两件事按顺序做，顺序不能换：
 *
 * ① **挂载所有实例的数据文件系统**。挂载是内核态，宿主 / Docker daemon 重启后
 *    全部消失。挂不上就标 error 并跳过——宁可让实例显式坏掉，也不能让它带着
 *    空目录起来（那看起来像「数据没了」，比报错糟）。
 *
 * ② **把 DB 里状态为 running 的实例拉起来**。重启策略是 `on-failure`，它在 daemon
 *    重启时**不会**自动拉起容器（这正是我们要的：避免容器先于挂载起来），所以
 *    恢复「正在运行」这个意图是平台的责任。少了这一步，对账器会把所有实例
 *    抹成 stopped——表现为「重启后实例全停」。
 */
export async function bootInstances(deps: BootDeps): Promise<void> {
  const rows = await deps.listInstances()

  const mounted = new Set<string>()
  for (const row of rows) {
    try {
      await deps.ensure(row.storageKey, row.diskMb)
      mounted.add(row.id)
    } catch (err) {
      const message = messageOf(err)
      deps.warn(`实例 ${row.slug} 的数据文件系统挂载失败：${message}`)
      await deps.markError(row.id, `数据文件系统挂载失败：${message}`)
    }
  }

  for (const row of rows) {
    if (row.status !== 'running' || !mounted.has(row.id)) continue
    try {
      await deps.start(row.id)
    } catch (err) {
      const message = messageOf(err)
      deps.warn(`实例 ${row.slug} 启动失败：${message}`)
      await deps.markError(row.id, message)
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
