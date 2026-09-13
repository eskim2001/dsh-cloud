import type { Auth } from './auth.js'

/**
 * 平台建号的**唯一**入口。seed 和邀请兑换都用它。
 *
 * 为什么不走 better-auth 自己的 HTTP 路由：
 *  - `sign-up/email` 在 `disableSignUp` 之后**闭死**（见 auth.ts），而 seed 恰恰要在
 *    一个还没有账号的库上建出第一个账号；
 *  - admin 插件的 `create-user` 要求调用者**已经是 admin 会话**——seed 时还没有，
 *    邀请兑换时更是连账号都没有。
 *
 * 所以直接调内部适配器：**既不受注册开关约束，也不需要会话**。
 * 这里做的三步与 better-auth 自己建号完全一致（对照 admin 插件 createUser 的实现）：
 * 建 user 行 → 哈希密码 → linkAccount(providerId: 'credential')。
 */
export interface NewAccount {
  email: string
  password: string
  name?: string
  role?: 'user' | 'admin'
}

/**
 * 邮箱已经被占了。调用方要能区分它和「数据库连不上」——前者是用户错误（409），
 * 后者是服务端故障（500），靠匹配错误文本太脆。
 */
export class AccountExistsError extends Error {
  constructor(readonly email: string) {
    super(`账号已存在：${email}`)
    this.name = 'AccountExistsError'
  }
}

/**
 * Postgres 的唯一约束冲突（`23505`）。
 *
 * 为什么需要：`findUserByEmail` 预检和 `createUser` 之间有个窗口，**并发下两边都可能过预检**。
 * 真正拦住第二个的是邮箱唯一约束——把它认出来归到「账号已存在」，别让它变成 500。
 * 错误可能被 better-auth 包过一层，所以沿着 `cause` 往下找。
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  if ((err as { code?: unknown }).code === '23505') return true
  const cause = (err as { cause?: unknown }).cause
  return cause !== err && isUniqueViolation(cause)
}

export async function createUserWithPassword(
  auth: Auth,
  { email, password, name, role = 'user' }: NewAccount,
): Promise<{ id: string; email: string }> {
  const ctx = await auth.$context
  const address = email.trim().toLowerCase()

  const existing = await ctx.internalAdapter.findUserByEmail(address)
  if (existing) throw new AccountExistsError(address)

  let user
  try {
    user = await ctx.internalAdapter.createUser(
      {
        // 显式给 id：schema 里 user.id 没有默认值，better-auth 的 signUpEmail 也是自己生成的
        id: crypto.randomUUID(),
        email: address,
        name: name?.trim() || address.split('@')[0] || address,
        role,
        // signUpEmail 建的也是未验证账号。平台没有邮件通道，这里只能是 false
        emailVerified: false,
      },
      { method: 'admin' },
    )
  } catch (err) {
    if (isUniqueViolation(err)) throw new AccountExistsError(address)
    throw err
  }
  if (!user) throw new Error(`建号失败：${address}`)

  await ctx.internalAdapter.linkAccount({
    providerId: 'credential',
    accountId: user.id,
    password: await ctx.password.hash(password),
    userId: user.id,
  })

  return { id: user.id, email: user.email }
}
