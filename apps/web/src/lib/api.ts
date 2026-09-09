export interface SessionUser {
  id: string
  email: string
  name: string
  /** 'user' | 'admin'。管理员是平台运营方。 */
  role: string
}

export interface InstanceSummary {
  id: string
  slug: string
  /** provisioning | running | restarting | paused | stopped | error | removing */
  status: string
  /** Docker 的原文描述（如 `Restarting (3) 20 seconds ago`）；取不到就是 null。 */
  statusText: string | null
  image: string
  /** 非空 = 有一份升级前的数据快照，可以回滚到这一版。 */
  previousImage: string | null
  cpus: number
  memoryMb: number
  /** 磁盘配额（MiB）。等于该实例数据文件系统的大小——写满就是写满。 */
  diskMb: number
  lastError: string | null
  /** 最后一次变成「已停止」的时刻；运行中为 null。 */
  stoppedAt: string | null
  /** 容器是否已经建出来（没建出来的实例没有日志可看）。 */
  hasContainer: boolean
  createdAt: string
  /** 「打开 dsh」入口（桥会在这条路径注入入口 token）。 */
  url: string
}

export interface InstanceUsage {
  /** 100 = 用满一个核，多核实例可以超过 100。 */
  cpuPercent: number
  memMb: number
}

/** 数据文件系统的实时占用。容器停着也能读——文件系统还挂着。 */
export interface InstanceDiskUsage {
  usedMb: number
  quotaMb: number
}

/** `/stats` 的一次快照：容器不在时 `usage` 为 null，磁盘通常仍然有值。 */
export interface InstanceSnapshot {
  usage: InstanceUsage | null
  disk: InstanceDiskUsage | null
}

export interface InstanceMetricPoint extends InstanceUsage {
  sampledAt: string
  diskUsedMb: number
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // 会话 cookie 必须带上；不能依赖默认行为
    credentials: 'same-origin',
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  })

  const text = await res.text()
  const body: unknown = text === '' ? null : safeJson(text)

  if (!res.ok) {
    throw new ApiError(errorMessage(body) ?? `请求失败（${res.status}）`, res.status)
  }
  return body as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function errorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const b = body as { message?: string; error?: string }
  return b.message ?? b.error
}

// ─── 认证（better-auth）───────────────────────────────────────────────────

export async function getSession(): Promise<SessionUser | null> {
  const res = await request<{ user?: SessionUser } | null>('/api/auth/get-session')
  return res?.user ?? null
}

export async function signIn(email: string, password: string): Promise<SessionUser> {
  const res = await request<{ user: SessionUser }>('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  return res.user
}

export async function signUp(
  email: string,
  password: string,
  name: string,
): Promise<SessionUser> {
  const res = await request<{ user: SessionUser }>('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email, password, name }),
  })
  return res.user
}

export async function signOut(): Promise<void> {
  await request('/api/auth/sign-out', { method: 'POST', body: '{}' })
}

// ─── 实例（平台 API）─────────────────────────────────────────────────────

export async function listInstances(): Promise<InstanceSummary[]> {
  const res = await request<{ instances: InstanceSummary[] }>('/api/instances')
  return res.instances
}

export async function createInstance(input: {
  slug: string
  cpus?: number
  memoryMb?: number
  diskMb?: number
}): Promise<InstanceSummary> {
  const res = await request<{ instance: InstanceSummary }>('/api/instances', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return res.instance
}

export async function restartInstance(id: string): Promise<InstanceSummary> {
  const res = await request<{ instance: InstanceSummary }>(`/api/instances/${id}/restart`, {
    method: 'POST',
    body: '{}',
  })
  return res.instance
}

export async function stopInstance(id: string): Promise<InstanceSummary> {
  const res = await request<{ instance: InstanceSummary }>(`/api/instances/${id}/stop`, {
    method: 'POST',
    body: '{}',
  })
  return res.instance
}

export async function startInstance(id: string): Promise<InstanceSummary> {
  const res = await request<{ instance: InstanceSummary }>(`/api/instances/${id}/start`, {
    method: 'POST',
    body: '{}',
  })
  return res.instance
}

/** 默认保留数据文件系统；`purge` + 子域名确认才连它一起删。 */
export async function removeInstance(
  id: string,
  opts: { purge?: boolean; confirmSlug?: string } = {},
): Promise<void> {
  const params = new URLSearchParams()
  if (opts.purge === true) params.set('purge', 'true')
  if (opts.confirmSlug !== undefined) params.set('confirmSlug', opts.confirmSlug)
  const query = params.toString()
  await request<void>(`/api/instances/${id}${query === '' ? '' : `?${query}`}`, {
    method: 'DELETE',
  })
}

export async function getInstance(id: string): Promise<InstanceSummary> {
  const res = await request<{ instance: InstanceSummary }>(`/api/instances/${id}`)
  return res.instance
}

/** 当前用量快照。容器没跑或首帧没差值时 `usage` 是 null（页面显示「暂无数据」）。 */
export async function getInstanceStats(id: string): Promise<InstanceSnapshot> {
  const res = await request<{ stats: InstanceUsage | null; disk?: InstanceDiskUsage }>(
    `/api/instances/${id}/stats`,
  )
  return { usage: res.stats, disk: res.disk ?? null }
}

export async function getInstanceMetrics(
  id: string,
  limit = 120,
): Promise<InstanceMetricPoint[]> {
  const res = await request<{ metrics: InstanceMetricPoint[] }>(
    `/api/instances/${id}/metrics?limit=${limit}`,
  )
  return res.metrics
}

/** 用户面的版本信息：只能选平台**已发布**的版本（且宿主上已有）。 */
export interface InstanceImageInfo {
  image: string
  previousImage: string | null
  /** 可选版本 = 已发布列表 ∩ 宿主上已有。空 = 不能自助升级。 */
  stable: string[]
  /** 升级前快照的实占（MB）；null = 没有快照。 */
  snapshotMb: number | null
}

export async function getInstanceImage(id: string): Promise<InstanceImageInfo> {
  return request<InstanceImageInfo>(`/api/instances/${id}/image`)
}

/**
 * 升级 / 降级到某个已发布版本。**会停机**——先给数据打快照再换镜像，
 * 停机时间 = 停容器 + 复制已用数据 + 启动。新镜像起不来会自动回滚。
 */
export async function setInstanceImage(id: string, image: string): Promise<InstanceSummary> {
  const res = await request<{ instance: InstanceSummary }>(`/api/instances/${id}/image`, {
    method: 'POST',
    body: JSON.stringify({ image }),
  })
  return res.instance
}

/** 回滚到上一版：用升级前的快照覆盖数据，再按旧镜像重建。快照就此消费掉。 */
export async function rollbackInstanceImage(id: string): Promise<InstanceSummary> {
  const res = await request<{ instance: InstanceSummary }>(
    `/api/instances/${id}/image/rollback`,
    { method: 'POST', body: '{}' },
  )
  return res.instance
}

// ─── 会话（设备管理）──────────────────────────────────────────────────────

export interface SessionSummary {
  id: string
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
  expiresAt: string
  /** 当前这台设备。它不能撤销自己——那样会立刻把自己踢下线。 */
  current: boolean
}

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await request<{ sessions: SessionSummary[] }>('/api/sessions')
  return res.sessions
}

export async function revokeSession(id: string): Promise<void> {
  await request(`/api/sessions/${id}`, { method: 'DELETE' })
}

// ─── 平台管理面（仅管理员）────────────────────────────────────────────────

export interface AdminUser {
  id: string
  email: string
  name: string
  role: string
  banned: boolean
  banReason: string | null
  /** null = 用平台默认上限（maxInstancesPerUser）。 */
  instanceQuota: number | null
  instanceCount: number
  createdAt: string
}

export interface AdminInstance {
  id: string
  slug: string
  /** 和实例面同一套状态（见 InstanceSummary.status）。 */
  status: string
  statusText: string | null
  image: string
  /** 非空 = 有一份升级前的数据快照，可以回滚到这一版。 */
  previousImage: string | null
  cpus: number
  memoryMb: number
  pidsLimit: number
  diskMb: number
  lastError: string | null
  createdAt: string
  ownerEmail: string
}

export async function listAdminUsers(): Promise<{
  users: AdminUser[]
  maxInstancesPerUser: number
}> {
  return request('/api/admin/users')
}

export async function listAdminInstances(): Promise<AdminInstance[]> {
  const res = await request<{ instances: AdminInstance[] }>('/api/admin/instances')
  return res.instances
}

export async function banUser(id: string, reason: string): Promise<void> {
  await request(`/api/admin/users/${id}/ban`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason === '' ? undefined : reason }),
  })
}

export async function unbanUser(id: string): Promise<void> {
  await request(`/api/admin/users/${id}/unban`, { method: 'POST', body: '{}' })
}

export async function setUserQuota(id: string, quota: number | null): Promise<void> {
  await request(`/api/admin/users/${id}/quota`, {
    method: 'PATCH',
    body: JSON.stringify({ quota }),
  })
}

/** 授予 / 撤销管理员。最后一名管理员不能降级（后端 400）。 */
export async function setUserRole(id: string, role: 'user' | 'admin'): Promise<void> {
  await request(`/api/admin/users/${id}/role`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  })
}

/**
 * 改实例的 CPU / 内存 / pids / 磁盘。CPU、内存、pids 变化会**重建容器**（有几秒不可用）；
 * 磁盘**扩容不停机**，缩容要停机重建（D17 / D18）。
 */
export async function setInstanceQuota(
  id: string,
  quota: { cpus: number; memoryMb: number; pidsLimit: number; diskMb: number },
): Promise<void> {
  await request(`/api/admin/instances/${id}/quota`, {
    method: 'PATCH',
    body: JSON.stringify(quota),
  })
}

/** 管理面的版本信息：`local` 是宿主上**平台仓库**的全部 tag（含未发布的），管理员可任选。 */
export interface AdminInstanceImageInfo {
  image: string
  previousImage: string | null
  local: string[]
  snapshotMb: number | null
}

export async function getAdminInstanceImage(id: string): Promise<AdminInstanceImageInfo> {
  return request<AdminInstanceImageInfo>(`/api/admin/instances/${id}/image`)
}

/** 换镜像（升级 / 降级）。**会停机**（先打数据快照）；失败自动回滚。 */
export async function setAdminInstanceImage(id: string, image: string): Promise<void> {
  await request(`/api/admin/instances/${id}/image`, {
    method: 'PATCH',
    body: JSON.stringify({ image }),
  })
}

export async function rollbackAdminInstanceImage(id: string): Promise<void> {
  await request(`/api/admin/instances/${id}/image/rollback`, { method: 'POST', body: '{}' })
}

// ─── 镜像版本管理（仅管理员，D21 / D23）────────────────────────────────────

/** 三态：注册表上有 = 未下载；宿主上有 = 已下载；已发布 = 用户面可选。 */
export type AdminImageState = 'remote' | 'local' | 'published'

export interface AdminImage {
  ref: string
  state: AdminImageState
  /** 宿主上有没有。已发布但被 prune 掉的版本会同时是 published 且 onHost=false。 */
  onHost: boolean
  /** 新建实例用这一版。至多一个（数据库部分唯一索引兜住）。 */
  isDefault: boolean
  publishedAt: string | null
  /** 注册表给的 manifest digest；没同步过或只在宿主上就是 null。 */
  digest: string | null
}

export interface AdminImages {
  /** 新版本在前。 */
  images: AdminImage[]
  /** catalog 最近一次同步时间；从没同步过 → null。 */
  syncedAt: string | null
}

export interface AdminImagesSyncResult {
  count: number
  skipped: number
  syncedAt: string
}

export async function getAdminImages(): Promise<AdminImages> {
  return request<AdminImages>('/api/admin/images')
}

/** 拉一遍注册表的 tag 进库。慢——每个 tag 一次 HEAD，页面上要显示 pending。 */
export async function syncAdminImages(): Promise<AdminImagesSyncResult> {
  return request<AdminImagesSyncResult>('/api/admin/images/sync', {
    method: 'POST',
    body: '{}',
  })
}

/** 下载进度流的地址（SSE，`EventSource` 只支持 GET）。 */
export function adminImagePullUrl(ref: string): string {
  return `/api/admin/images/pull?ref=${encodeURIComponent(ref)}`
}

/** 发布一个宿主上已有的平台镜像。 */
export async function publishAdminImage(ref: string): Promise<void> {
  await request('/api/admin/images', { method: 'POST', body: JSON.stringify({ ref }) })
}

/** 下架。默认版本不能下架（后端 400）。 */
export async function unpublishAdminImage(ref: string): Promise<void> {
  await request('/api/admin/images', { method: 'DELETE', body: JSON.stringify({ ref }) })
}

/** 设为新建实例用的默认版本。 */
export async function setDefaultAdminImage(ref: string): Promise<void> {
  await request('/api/admin/images/default', { method: 'PATCH', body: JSON.stringify({ ref }) })
}
