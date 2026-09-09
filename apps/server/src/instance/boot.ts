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
 * 平台启动时的第一步：**判僵尸 → 恢复数据 → 恢复容器**（D18 / D23）。
 *
 * ① **把停在 provisioning 的行判死**（见下面注释）。
 *
 * ② **挂载所有实例的数据文件系统**。挂载是内核态，宿主 / Docker daemon 重启后
 *    全部消失。挂不上就标 error 并跳过——宁可让实例显式坏掉，也不能让它带着
 *    空目录起来（那看起来像「数据没了」，比报错糟）。
 *
 * ③ **把 DB 里状态为 running 的实例拉起来**。重启策略是 `on-failure`，它在 daemon
 *    重启时**不会**自动拉起容器（这正是我们要的：避免容器先于挂载起来），所以
 *    恢复「正在运行」这个意图是平台的责任。少了这一步，对账器会把所有实例
 *    抹成 stopped——表现为「重启后实例全停」。
 */
export async function bootInstances(deps: BootDeps): Promise<void> {
  const rows = await deps.listInstances()

  // ③ 先判僵尸：`createInstanceRecord` 先落 provisioning 行、后起容器，进程在这个窗口里
  //    挂掉就留下**谁也不管**的行——对账器跳过非 running/stopped，下面的恢复只拉 running。
  //    D23 加了自动 pull 之后窗口从秒级变成分钟级，必须显式收敛（判死，等人 restart）。
  for (const row of rows) {
    if (row.status !== 'provisioning') continue
    deps.warn(`实例 ${row.slug} 停在 provisioning：上次创建被平台重启中断`)
    await deps.markError(row.id, '平台重启中断了创建，请重试')
  }

  const mounted = new Set<string>()
  for (const row of rows) {
    if (row.status === 'provisioning') continue
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
