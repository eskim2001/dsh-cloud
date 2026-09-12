/**
 * 实例状态的**唯一**判定处。
 *
 * 抽出来的原因：`IN_FLIGHT_STATUSES`、`IDLE_POLL_MS`、以及那个「在途就快轮询」的回调，
 * 原先在 `InstancesPage`、`InstanceDetailPage`、`AdminPage` 里**各写了一遍** —— 三份副本
 * 意味着"改一处漏两处"，而轮询节奏和"能不能打开"这种判断错一次就是用户可见的 bug。
 *
 * 状态本身由服务端**查询时从 Docker 现算**（见 docs/DECISIONS.md D16），不是 DB 快照 ——
 * 所以这里只做"拿到状态之后怎么用"的判定，不猜状态。
 */

/** 编排**在途**的状态：它们自己会变（转成 running / stopped / error），所以按快节奏轮询。 */
export const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set(['provisioning', 'removing'])

/** 在途时的轮询间隔（ms）。 */
export const IN_FLIGHT_POLL_MS = 3_000

/**
 * 落定之后的轮询间隔（ms）——状态仍可能被别人改（对账器、手动 docker 操作）。
 *
 * ⚠️ **别因为"看起来已经落定"就停掉轮询**：状态是查询时从 Docker 现算的，落定态也会漂 ——
 * 容器可能 crash-loop（running → restarting）、被外部停掉、或随宿主重启拉起。一旦停轮询，
 * 这三种情况就会永远停在旧值（实践里出过一次：crash-loop 时列表还写着「运行中」）。
 */
export const IDLE_POLL_MS = 10_000

/** 这个状态还在变吗（用它决定轮询节奏）。 */
export function isTransitioning(status: string): boolean {
  return IN_FLIGHT_STATUSES.has(status)
}

/**
 * 现在能打开这个实例吗。
 *
 * 只有 `running` 算 —— 别的状态下域名那一条要么没服务、要么正在拆，点过去只会吃 502。
 */
export function canOpen(status: string): boolean {
  return status === 'running'
}

/** 磁盘用到这个比例就算"该看一眼了"。展示层（进度条变色）也用它。 */
export const DISK_ATTENTION_RATIO = 0.9

/** 舰队/列表页要判断的一行最少需要这些字段。 */
export interface AttentionInput {
  status: string
  diskUsedMb?: number | undefined
  diskMb: number
  /** **没有硬配额时磁盘永远不算"需要注意"** —— 没有上限就无从"接近上限"。 */
  diskEnforced: boolean
}

/**
 * 这一行"需要注意"吗。
 *
 * 两个来源：① 状态不对（error / restarting）；② 磁盘快满了（≥90%）。
 *
 * ⚠️ ② 只在 `diskEnforced` 为真时才判：开发机（内核不支持配额）或实例没有池子时，
 * `diskMb` 只是个声明值，拿它算比例会造出"快满了"的假警报。
 */
export function needsAttention(row: AttentionInput): boolean {
  if (row.status === 'error' || row.status === 'restarting') return true
  if (!row.diskEnforced) return false
  const used = row.diskUsedMb
  if (used === undefined || row.diskMb <= 0) return false
  return used / row.diskMb >= DISK_ATTENTION_RATIO
}

/** react-query 的 `refetchInterval`：单个实例。还没拿到数据就不轮询。 */
export function instanceRefetchInterval(instance: { status: string } | undefined): number | false {
  if (instance === undefined) return false
  return isTransitioning(instance.status) ? IN_FLIGHT_POLL_MS : IDLE_POLL_MS
}

/** react-query 的 `refetchInterval`：列表。**任意一个**在途就按快节奏轮询。 */
export function listRefetchInterval(list: Array<{ status: string }> | undefined): number | false {
  if (list === undefined) return false
  return list.some((i) => isTransitioning(i.status)) ? IN_FLIGHT_POLL_MS : IDLE_POLL_MS
}
