import type { Db } from '../db/client.js'
import { pruneImageCatalog, upsertImageCatalog } from '../db/image-catalog-repo.js'
import { imageTag, isReleaseTag } from './image-catalog.js'
import type { RegistryClient } from './registry.js'

/** 到注册表那一跳失败了。路由据此回 502，而不是把出网故障当成平台 500。 */
export class RegistryError extends Error {}

export interface SyncImagesResult {
  /** 本次写进 catalog 的版本数。 */
  count: number
  /** 注册表上有、但形状不是发布 tag 而被忽略的数量。 */
  skipped: number
  syncedAt: Date
}

/**
 * 把注册表上的 tag 同步进 `image_catalog`（D23）。**整批重建**：本次没看到的行删掉。
 *
 * 形状不对的 tag 只是跳过（`skipped` 计数会报出来，不静默）——仓库是公开的，
 * 任何 collaborator 都能往里推 `:latest`；它们不该出现在控制台里。
 */
export async function syncImageCatalog(
  db: Db,
  client: RegistryClient,
  repo: string,
): Promise<SyncImagesResult> {
  let tags: string[]
  try {
    tags = await client.listTags()
  } catch (err) {
    throw new RegistryError(messageOf(err))
  }

  const refs = tags.map((tag) => `${repo}:${tag}`).filter(isReleaseTag)

  const entries: { ref: string; digest: string }[] = []
  let skipped = tags.length - refs.length
  for (const ref of refs) {
    const tag = imageTag(ref)
    if (tag === undefined) continue
    try {
      entries.push({ ref, digest: await client.tagDigest(tag) })
    } catch {
      // 单个 tag 读不到 digest（manifest 坏 / 权限只给了 list）不该让整次同步白跑
      skipped += 1
    }
  }
  // 但**一个都没读到**就是另一回事了：多半是凭据或网络坏了。别把它报成「同步成功，0 个版本」。
  if (refs.length > 0 && entries.length === 0) {
    throw new RegistryError(`读不到任何 tag 的 digest（${refs.length} 个都失败）`)
  }

  await upsertImageCatalog(db, entries)
  await pruneImageCatalog(
    db,
    entries.map((e) => e.ref),
  )
  return { count: entries.length, skipped, syncedAt: new Date() }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
