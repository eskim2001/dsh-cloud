import { and, asc, eq, sql } from 'drizzle-orm'
import type { Db } from './client.js'
import { imageRelease, type ImageReleaseRow } from './schema.js'

/**
 * 平台镜像版本（D21）。表很小，语义重：
 * - `isDefault` 那一版是**新建实例**用的镜像；
 * - 表里全部行 = 用户面能自助升级到的候选（再与宿主上真实存在的 tag 取交集）。
 *
 * 「至多一个默认」由 `image_release_default_unique` 部分唯一索引兜住，不靠应用层自觉。
 */

export async function listImageReleases(db: Db): Promise<ImageReleaseRow[]> {
  return db.select().from(imageRelease).orderBy(asc(imageRelease.publishedAt))
}

export async function findDefaultImageRelease(db: Db): Promise<ImageReleaseRow | undefined> {
  const rows = await db
    .select()
    .from(imageRelease)
    .where(eq(imageRelease.isDefault, true))
    .limit(1)
  return rows[0]
}

export async function isImageRelease(db: Db, ref: string): Promise<boolean> {
  const rows = await db
    .select({ id: imageRelease.id })
    .from(imageRelease)
    .where(eq(imageRelease.ref, ref))
    .limit(1)
  return rows.length > 0
}

/**
 * 发布路径的咨询锁 key。任意常数，平台内不与其他用途冲突即可。
 *
 * 为什么需要锁：「至多一个默认」由 `image_release_default_unique` 部分唯一索引兜底，
 * 而 `publishImageRelease` 的 `onConflictDoNothing` 仲裁者只有 `ref` 唯一约束 ——
 * **挡不住**索引冲突。两个管理员同时上架第一版时两边都会读到「没有默认」，第二个插入
 * 直接 23505 → 500。锁住整段「读有没有默认 + 插入」，事务结束自动释放。
 */
const PUBLISH_LOCK_KEY = 0x696d6772

/**
 * 发布。已存在返回 `'exists'`。
 *
 * `defaultIfFirst` 为真且**当前没有任何默认版本**时，把这一版定成默认。判据故意用
 * 「没有默认」而不是「表为空」：`image_release` 非空但一行默认都没有，正是「用户创建
 * 不了实例」的死状态（老版本只要求发布不要求设默认，能留下这种库），这样顺带自愈。
 *
 * 「还有没有默认版本」的读留在事务里 —— 放到调用方读了再传就是 TOCTOU。
 */
export async function publishImageRelease(
  db: Db,
  ref: string,
  defaultIfFirst = false,
): Promise<'ok' | 'exists'> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PUBLISH_LOCK_KEY})`)

    const existing = await tx
      .select({ id: imageRelease.id })
      .from(imageRelease)
      .where(eq(imageRelease.isDefault, true))
      .limit(1)
    const isDefault = defaultIfFirst && existing.length === 0

    const rows = await tx
      .insert(imageRelease)
      .values({ id: crypto.randomUUID(), ref, isDefault })
      .onConflictDoNothing({ target: imageRelease.ref })
      .returning({ id: imageRelease.id })
    return rows.length > 0 ? 'ok' : 'exists'
  })
}

/** 下架。默认版本不能下架——否则新建实例就没有镜像了。 */
export async function unpublishImageRelease(
  db: Db,
  ref: string,
): Promise<'ok' | 'missing' | 'default'> {
  const rows = await db
    .delete(imageRelease)
    .where(and(eq(imageRelease.ref, ref), eq(imageRelease.isDefault, false)))
    .returning({ id: imageRelease.id })
  if (rows.length > 0) return 'ok'
  // 没删掉：要么没有这一版，要么它是默认版本（被 WHERE 挡掉了）
  return (await isImageRelease(db, ref)) ? 'default' : 'missing'
}

/**
 * 换默认版本。**必须先清后设**：部分唯一索引不允许同时存在两行 `is_default = true`。
 * 目标不在表里返回 false。
 */
export async function setDefaultImageRelease(db: Db, ref: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const target = await tx
      .select({ id: imageRelease.id })
      .from(imageRelease)
      .where(eq(imageRelease.ref, ref))
      .limit(1)
    if (target.length === 0) return false

    await tx.update(imageRelease).set({ isDefault: false }).where(eq(imageRelease.isDefault, true))
    await tx.update(imageRelease).set({ isDefault: true }).where(eq(imageRelease.ref, ref))
    return true
  })
}
