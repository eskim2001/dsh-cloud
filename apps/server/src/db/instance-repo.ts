import { and, asc, count, eq, isNull, ne } from 'drizzle-orm'
import type { Db } from './client.js'
import { instance, user, type InstanceRow } from './schema.js'

const PG_UNIQUE_VIOLATION = '23505'

export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`slug 已被占用：${slug}`)
    this.name = 'SlugTakenError'
  }
}

export class QuotaExceededError extends Error {
  constructor(readonly limit: number) {
    super(`已达实例数上限（${limit} 个）`)
    this.name = 'QuotaExceededError'
  }
}

export interface NewInstance {
  id: string
  slug: string
  ownerId: string
  image: string
  cpus: number
  memoryMb: number
  pidsLimit: number
  diskMb: number
}

/** forward-auth 每个请求都要查——按 slug 唯一索引命中。 */
export async function findInstanceBySlug(db: Db, slug: string): Promise<InstanceRow | undefined> {
  const rows = await db.select().from(instance).where(and(eq(instance.slug, slug), isNull(instance.deletedAt))).limit(1)
  return rows[0]
}

export async function findInstanceById(db: Db, id: string): Promise<InstanceRow | undefined> {
  const rows = await db.select().from(instance).where(and(eq(instance.id, id), isNull(instance.deletedAt))).limit(1)
  return rows[0]
}

/** 只列自己的实例——`ownerId` 是 WHERE 的一部分，不是事后过滤（铁律 7）。 */
export async function listInstancesByOwner(db: Db, ownerId: string): Promise<InstanceRow[]> {
  return db.select().from(instance).where(and(eq(instance.ownerId, ownerId), isNull(instance.deletedAt))).orderBy(asc(instance.createdAt))
}

export async function listAllInstances(db: Db): Promise<InstanceRow[]> {
  return db.select().from(instance).where(isNull(instance.deletedAt)).orderBy(asc(instance.createdAt))
}

/** 配额判定用。`ownerId` 同样进 WHERE（铁律 7）。 */
export async function countInstancesByOwner(db: Db, ownerId: string): Promise<number> {
  const rows = await db.select({ n: count() }).from(instance).where(and(eq(instance.ownerId, ownerId), isNull(instance.deletedAt)))
  return rows[0]?.n ?? 0
}

/**
 * 建实例记录。slug 冲突由唯一索引兜底，转成可读错误。
 *
 * 软删的行**仍然占着 slug**：同一 owner 可以重建同名（卷还在、浏览器状态本来就是他的），
 * 换个人不行——域名一旦回收给另一个租户，上一个租户留在这个域名下的浏览器状态
 * （cookie / localStorage / service worker）就被继承过去了。要彻底释放走 purge。
 */
export async function createInstanceRecord(db: Db, input: NewInstance, defaultLimit: number): Promise<InstanceRow> {
  try {
    return await db.transaction(async (transaction) => {
      const [owner] = await transaction.select({ quota: user.instanceQuota })
        .from(user).where(eq(user.id, input.ownerId)).for('update')
      if (owner === undefined) throw new Error('Instance owner does not exist')
      const limit = owner.quota ?? defaultLimit
      const [usage] = await transaction.select({ used: count() }).from(instance)
        .where(and(eq(instance.ownerId, input.ownerId), isNull(instance.deletedAt)))
      if ((usage?.used ?? 0) >= limit) throw new QuotaExceededError(limit)
      const [conflict] = await transaction.select({ ownerId: instance.ownerId }).from(instance)
        .where(and(eq(instance.slug, input.slug), ne(instance.ownerId, input.ownerId))).limit(1)
      if (conflict !== undefined) throw new SlugTakenError(input.slug)
      const [created] = await transaction.insert(instance)
        .values({ ...input, status: 'provisioning' }).returning()
      return created!
    })
  } catch (err) {
    if (constraintName(err) === 'instance_slug_unique') throw new SlugTakenError(input.slug)
    throw err
  }
}

export interface InstancePatch {
  status?: string
  containerId?: string | null
  image?: string
  /** 非空 = 有一份升级前的数据快照可回滚（见 provisioner.setImage）。 */
  previousImage?: string | null
  lastError?: string | null
  /** 资源配额。改了不会自己生效——CPU/内存要重建容器，磁盘走 host-storage（见 setQuota）。 */
  cpus?: number
  memoryMb?: number
  pidsLimit?: number
  diskMb?: number
}

export async function updateInstance(
  db: Db,
  id: string,
  patch: InstancePatch,
): Promise<InstanceRow | undefined> {
  const rows = await db
    .update(instance)
    .set({ ...patch, ...stoppedAtPatch(patch), updatedAt: new Date() })
    .where(and(eq(instance.id, id), isNull(instance.deletedAt)))
    .returning()
  return rows[0]
}

/**
 * `stoppedAt` 是派生字段——由 status 推出来，调用方不用自己记。
 * 集中在这里是为了让 stop / start / 对账三条路径自动一致。
 */
function stoppedAtPatch(patch: InstancePatch): { stoppedAt?: Date | null } {
  if (patch.status === 'stopped') return { stoppedAt: new Date() }
  if (patch.status === 'running') return { stoppedAt: null }
  return {}
}

/** 删记录。**容器/卷的清理是调用方的事**——DB 只管自己这一份。 */
export async function deleteInstanceRecord(db: Db, id: string): Promise<boolean> {
  const rows = await db.delete(instance).where(eq(instance.id, id)).returning({ id: instance.id })
  return rows.length > 0
}

export async function retainInstanceRecord(db: Db, id: string): Promise<void> {
  await db.update(instance).set({
    deletedAt: new Date(),
    updatedAt: new Date(),
    status: 'retained',
    containerId: null,
  }).where(and(eq(instance.id, id), isNull(instance.deletedAt)))
}

function constraintName(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as { code?: string; constraint_name?: string; constraint?: string }
  if (e.code !== PG_UNIQUE_VIOLATION) {
    return err instanceof Error && err.cause !== err ? constraintName(err.cause) : undefined
  }
  return e.constraint_name ?? e.constraint
}
