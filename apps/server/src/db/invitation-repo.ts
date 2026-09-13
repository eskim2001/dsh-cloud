import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import type { Db } from './client.js'
import { invitation } from './schema.js'

/**
 * 邀请链接的存取。**平台不发邮件**，所以这里只有链接本身，没有投递状态——
 * owner 生成后自己复制、自己发给熟人。
 *
 * 库里只存 token 的**哈希**：拿到数据库也还原不出可用链接。
 */

export interface InvitationRow {
  id: string
  email: string
  createdAt: Date
  expiresAt: Date
  acceptedAt: Date | null
}

export async function createInvitation(
  db: Db,
  input: { tokenHash: string; email: string; createdBy: string; expiresAt: Date },
): Promise<void> {
  await db.insert(invitation).values({ id: crypto.randomUUID(), ...input })
}

/** 这个邮箱有没有还没被接受的邀请——避免同一个人攒一堆链接。 */
export async function findPendingInvitationByEmail(
  db: Db,
  email: string,
): Promise<{ id: string } | undefined> {
  const rows = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(and(eq(invitation.email, email), isNull(invitation.acceptedAt)))
    .limit(1)
  return rows[0]
}

/**
 * 兑换时用。只认「哈希对得上 + 还没用过 + 还没过期」这一种。
 * 过期和已用过在这里就分不出来了——对兑换者来说也没必要分。
 */
export async function findUsableInvitation(
  db: Db,
  tokenHash: string,
): Promise<{ id: string; email: string } | undefined> {
  const rows = await db
    .select({ id: invitation.id, email: invitation.email })
    .from(invitation)
    .where(
      and(
        eq(invitation.tokenHash, tokenHash),
        isNull(invitation.acceptedAt),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .limit(1)
  return rows[0]
}

/**
 * 标记已兑换。返回 false = 这条已经被别人抢先兑换了（两次点击的竞态）。
 * 条件里带 `acceptedAt IS NULL`，所以是**原子**的：并发时只有一个人拿到 true。
 */
export async function markInvitationAccepted(
  db: Db,
  id: string,
  acceptedBy: string,
): Promise<boolean> {
  const rows = await db
    .update(invitation)
    .set({ acceptedAt: new Date(), acceptedBy })
    .where(and(eq(invitation.id, id), isNull(invitation.acceptedAt)))
    .returning({ id: invitation.id })
  return rows.length > 0
}

/** 管理台列表，最近的在前。 */
export async function listInvitations(db: Db): Promise<InvitationRow[]> {
  return db
    .select({
      id: invitation.id,
      email: invitation.email,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
    })
    .from(invitation)
    .orderBy(desc(invitation.createdAt))
    .limit(100)
}

/** 撤销。只能撤销**还没被接受**的——已接受的那条是历史记录，不该被抹掉。 */
export async function deleteInvitation(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(invitation)
    .where(and(eq(invitation.id, id), isNull(invitation.acceptedAt)))
    .returning({ id: invitation.id })
  return rows.length > 0
}
