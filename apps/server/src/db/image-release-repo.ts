import { and, asc, eq } from 'drizzle-orm'
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

/** 发布。已存在返回 `'exists'`——**不覆盖 `isDefault`**，那是 `setDefaultImageRelease` 的事。 */
export async function publishImageRelease(
  db: Db,
  ref: string,
  isDefault = false,
): Promise<'ok' | 'exists'> {
  const rows = await db
    .insert(imageRelease)
    .values({ id: crypto.randomUUID(), ref, isDefault })
    .onConflictDoNothing({ target: imageRelease.ref })
    .returning({ id: imageRelease.id })
  return rows.length > 0 ? 'ok' : 'exists'
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
