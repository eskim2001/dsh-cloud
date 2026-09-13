import { createHash, randomBytes } from 'node:crypto'
import { AccountExistsError, createUserWithPassword } from './account.js'
import type { Auth } from './auth.js'
import type { Db } from './db/client.js'
import { findUsableInvitation, markInvitationAccepted } from './db/invitation-repo.js'

/**
 * 邀请链接的领域逻辑。**与投递无关**——平台不发邮件，链接靠 owner 自己复制转发。
 */

/** 明文 token：32 字节 URL-safe 随机串。只出现在链接里，也只出现一次。 */
export function newInviteToken(): string {
  return randomBytes(32).toString('base64url')
}

/** 库里存的哈希。拿到数据库也还原不出可用链接。 */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 邀请有效期：7 天。够 owner 慢慢发，又不至于一条链接永久有效。 */
export const INVITE_TTL_HOURS = 7 * 24

export function inviteExpiry(from = new Date()): Date {
  return new Date(from.getTime() + INVITE_TTL_HOURS * 60 * 60 * 1000)
}

/**
 * 兑换地址。挂在**控制台域名**下：兑换要先设密码、拿到会话，之后才谈得上工作空间；
 * 而且实例子域是给 dsh 页面用的，不该在那里做账号操作。
 */
export function inviteUrl(scheme: string, consoleDomain: string, token: string): string {
  return `${scheme}://${consoleDomain}/invite/${token}`
}

/** `invalid` 故意不区分「不存在 / 过期 / 已用过」——对兑换者没有区别，对探测者是信息泄露。 */
export type AcceptInvitationResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'invalid' | 'exists' }

/**
 * 兑换一条邀请：验 token → 建号 → 标记已用。建出来的一律是 `role='user'`。
 *
 * **并发下的真闸门是邮箱唯一约束**，不是 `acceptedAt` 的检查：同一个链接被同时点开时，
 * 两边都会读到「还能用」，但只有一个能把账号建出来，另一个撞唯一约束 → `exists`。
 * 所以下面 mark 那一步失败是**到不了**的（能走到说明账号刚建成功，没有第二个赢家）。
 */
export async function acceptInvitation(
  db: Db,
  auth: Auth,
  input: { token: string; password: string; name?: string | undefined },
): Promise<AcceptInvitationResult> {
  const found = await findUsableInvitation(db, hashInviteToken(input.token))
  if (found === undefined) return { ok: false, reason: 'invalid' }

  let created: { id: string; email: string }
  try {
    created = await createUserWithPassword(auth, {
      email: found.email,
      password: input.password,
      ...(input.name === undefined ? {} : { name: input.name }),
    })
  } catch (err) {
    if (err instanceof AccountExistsError) return { ok: false, reason: 'exists' }
    throw err
  }

  if (!(await markInvitationAccepted(db, found.id, created.id))) {
    // 见上面的注释：走到这里说明逻辑坏了，别静默吞掉
    throw new Error(`邀请 ${found.id} 标记失败——账号已建出，这不该发生`)
  }

  return { ok: true, email: created.email }
}
