import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins/admin'
import { userAc } from 'better-auth/plugins/admin/access'
import type { Db } from './db/client.js'
import { trustedOrigins, type Env } from './env.js'

/**
 * 平台账号体系。**只服务控制面**（`CONSOLE_DOMAIN`）。
 *
 * cookie 必须覆盖父域，否则 forward-auth 在实例子域上读不到 → 数据面无法认证
 * （见 docs/ARCHITECTURE.md §七，那里的 CSRF 要求同样成立）。
 *
 * `opts.bootstrap`：**还没配域名**时（引导态）用它。此时不能用 `CONSOLE_DOMAIN` 拼 baseURL
 * —— 空域名会拼出 `"https://"`，better-auth 建上下文时 `new URL()` **直接抛**，进程起不来。
 * 引导态也不该有跨子域 cookie（还没有父域），所以关掉。这个实例在引导态**不接任何认证请求**
 * （`buildApp` 只注册 setup 端点）。
 */
export function createAuth(env: Env, db: Db, opts: { bootstrap?: boolean } = {}) {
  const bootstrap = opts.bootstrap === true
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: bootstrap ? `http://127.0.0.1:${env.PORT}` : `${env.PUBLIC_SCHEME}://${env.CONSOLE_DOMAIN}`,
    basePath: '/api/auth',
    database: drizzleAdapter(db, { provider: 'pg' }),
    trustedOrigins: trustedOrigins(env),
    // 公开注册**关闭**。装平台的人 = 用平台的人，「谁能进来」是 owner 自己的事：
    // 开着注册等于让陌生人到你服务器上开号、建容器、吃 CPU 和磁盘。
    // 账号只有两条路产生——seed 的第一个 owner，和 owner 发的邀请链接；
    // 两条都走 createUserWithPassword（src/account.ts），绕过这个开关。
    emailAndPassword: { enabled: true, disableSignUp: true },
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
      // 必须覆盖**父域**（控制台 + 所有实例子域），否则 forward-auth 在
      // `<slug>.<BASE_DOMAIN>` 上读不到会话（§七）。引导态还没有父域，关掉。
      crossSubDomainCookies: bootstrap ? { enabled: false } : { enabled: true, domain: `.${env.BASE_DOMAIN}` },
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
