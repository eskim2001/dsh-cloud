import { eq } from 'drizzle-orm'
import type { Db } from './client.js'
import { platformSetting, type PlatformSettingRow } from './schema.js'

/**
 * 单行表的固定主键（见 `schema.ts` 的 `platformSetting`）。
 */
const SINGLETON = 'singleton'

/** 读平台设置。**没有行** = 从没配过域名（引导态）—— 返回 undefined，不替你造一行默认值。 */
export async function getPlatformSetting(db: Db): Promise<PlatformSettingRow | undefined> {
  const rows = await db
    .select()
    .from(platformSetting)
    .where(eq(platformSetting.id, SINGLETON))
    .limit(1)
  return rows[0]
}

/**
 * 写域名（有行则更新）。
 *
 * `configuredAt` **只在第一次落下来时写**：改域名不该刷新它 —— 它回答的是「这台机器
 * 什么时候配好的」，不是「上次改域名是什么时候」。所以 `onConflictDoUpdate` 里刻意不带它。
 */
export async function savePlatformDomains(
  db: Db,
  domains: { baseDomain: string; consoleDomain: string },
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(platformSetting)
    .values({ id: SINGLETON, ...domains, configuredAt: now })
    .onConflictDoUpdate({
      target: platformSetting.id,
      set: { baseDomain: domains.baseDomain, consoleDomain: domains.consoleDomain },
    })
}
