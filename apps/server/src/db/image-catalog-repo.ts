import { asc, eq, notInArray, sql } from 'drizzle-orm'
import type { Db } from './client.js'
import { imageCatalog, type ImageCatalogRow } from './schema.js'

/**
 * 注册表快照（D23）。**可丢弃**：每次同步整批重建，上游删掉的 tag 直接从表里消失。
 *
 * 与 `image_release` 的分工：这里只回答「GHCR 上有什么」，不表达任何发布意图——
 * 所以删除不必豁免谁，也就不可能误删掉默认版本。
 */

export async function listImageCatalog(db: Db): Promise<ImageCatalogRow[]> {
  return db.select().from(imageCatalog).orderBy(asc(imageCatalog.ref))
}

export async function isImageInCatalog(db: Db, ref: string): Promise<boolean> {
  const rows = await db
    .select({ ref: imageCatalog.ref })
    .from(imageCatalog)
    .where(eq(imageCatalog.ref, ref))
    .limit(1)
  return rows.length > 0
}

/** 写入本次同步看到的 tag。已存在就刷新 digest 与同步时间。 */
export async function upsertImageCatalog(
  db: Db,
  entries: { ref: string; digest: string }[],
): Promise<void> {
  if (entries.length === 0) return
  await db
    .insert(imageCatalog)
    .values(entries.map((e) => ({ ref: e.ref, digest: e.digest })))
    .onConflictDoUpdate({
      target: imageCatalog.ref,
      set: {
        digest: sql`excluded.digest`,
        syncedAt: sql`excluded.synced_at`,
      },
    })
}

/** 删掉本次同步没看到的行。上游没 tag 了就整表清空。 */
export async function pruneImageCatalog(db: Db, keepRefs: string[]): Promise<number> {
  const rows =
    keepRefs.length === 0
      ? await db.delete(imageCatalog).returning({ ref: imageCatalog.ref })
      : await db
          .delete(imageCatalog)
          .where(notInArray(imageCatalog.ref, keepRefs))
          .returning({ ref: imageCatalog.ref })
  return rows.length
}
