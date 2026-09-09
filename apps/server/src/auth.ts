import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins/admin'
import { userAc } from 'better-auth/plugins/admin/access'
import type { Db } from './db/client.js'
import { trustedOrigins, type Env } from './env.js'

/**
 * 平台账号体系。**只服务控制面**（`app.example.com`）。
 *
 * cookie 必须覆盖子域，否则 forward-auth 读不到 → 数据面无法认证
 * （见 docs/ARCHITECTURE.md §七，那里的 CSRF 要求同样成立）。
 */
export function createAuth(env: Env, db: Db) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: `${env.PUBLIC_SCHEME}://${env.BASE_DOMAIN}`,
    basePath: '/api/auth',
    database: drizzleAdapter(db, { provider: 'pg' }),
    trustedOrigins: trustedOrigins(env),
    emailAndPassword: { enabled: true },
    plugins: [
      // 平台管理员（运营方）。它带来 role / banned 字段，并让 better-auth
      // 在建会话时**拒绝**被封禁的用户——封禁因此是真的封禁，不只是标记。
      admin({
        defaultRole: 'user',
        adminRoles: ['admin'],
        roles: { admin: userAc, user: userAc },
      }),
    ],
    advanced: {
      // 显式指定，别让 better-auth 按请求 Host 猜（实例子域上的请求也会打到它）
      cookiePrefix: 'dsh_cloud',
      // 必须覆盖子域，否则 forward-auth 在 <slug>.<base> 上读不到会话（§七）
      crossSubDomainCookies: { enabled: true, domain: `.${env.BASE_DOMAIN}` },
      defaultCookieAttributes: {
        httpOnly: true,
        secure: env.PUBLIC_SCHEME === 'https',
        sameSite: 'lax',
        path: '/',
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
