/**
 * 首次初始化：建出平台第一个管理员。
 *
 * 「还没有才做」，所以可以随便重跑，也是「被误删光」时的恢复路径：已有管理员就跳过，
 * 之后授予 / 撤销在管理台里做。
 *
 * 镜像版本**不在这里引导**（D22）：版本表为空本来就意味着创建不了实例，
 * 引导入口是管理台「镜像管理」页——发布一版并设为默认。
 *
 * 环境变量（不放进 src/env.ts：控制面运行时用不到它们）：
 *   SEED_ADMIN_EMAIL     必填——仅在还没有管理员时需要
 *   SEED_ADMIN_PASSWORD  必填，至少 8 位——同上
 *   SEED_ADMIN_NAME      可选，缺省取邮箱 @ 前那段
 *
 * 用法：pnpm --filter @dsh-cloud/server db:seed
 */
import { createAuth } from '../src/auth.js'
import { createDb, type Db } from '../src/db/client.js'
import {
  countAdmins,
  findUserByEmail,
  revokeUserSessions,
  setUserRole,
} from '../src/db/user-repo.js'
import { loadEnv, type Env } from '../src/env.js'

function usage(message: string): never {
  console.error(
    `seed 无法执行：${message}\n\n` +
      '用法（写进 apps/server/.env.local，或用环境变量传入）：\n' +
      '  SEED_ADMIN_EMAIL=admin@example.com\n' +
      '  SEED_ADMIN_PASSWORD=<至少 8 位>\n' +
      '  SEED_ADMIN_NAME=<可选，缺省取邮箱前缀>\n\n' +
      '  pnpm --filter @dsh-cloud/server db:seed',
  )
  process.exit(1)
}

async function seedAdmin(db: Db, env: Env): Promise<void> {
  const existing = await countAdmins(db)
  if (existing > 0) {
    console.log(`已有 ${existing} 个管理员，seed 跳过（权限请到管理台改）。`)
    return
  }

  const email = (process.env.SEED_ADMIN_EMAIL ?? '').trim().toLowerCase()
  const password = process.env.SEED_ADMIN_PASSWORD ?? ''
  const name = (process.env.SEED_ADMIN_NAME ?? '').trim() || email.split('@')[0] || 'admin'

  if (email === '') usage('缺 SEED_ADMIN_EMAIL')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) usage(`SEED_ADMIN_EMAIL 不像邮箱：${email}`)
  if (password.length < 8) usage('SEED_ADMIN_PASSWORD 至少 8 位（对齐 better-auth 的默认下限）')

  const found = await findUserByEmail(db, email)
  if (found !== undefined) {
    // 只提权不改密码：重置已存在账号的密码要 better-auth 内部 API，MVP 不做
    await setUserRole(db, found.id, 'admin')
    console.log(`已把 ${email} 提权为管理员（密码未改动）。`)
    return
  }

  // 不用 auth.api.createUser：admin 插件那个端点要求调用者是 admin 会话，这时还没有
  const auth = createAuth(env, db)
  await auth.api.signUpEmail({ body: { email, password, name } })
  const created = await findUserByEmail(db, email)
  if (created === undefined) throw new Error(`建号后找不到 ${email}，seed 中止`)
  await setUserRole(db, created.id, 'admin')
  // signUpEmail 顺带建了一条没人持有的会话，清掉
  await revokeUserSessions(db, created.id)
  console.log(`已创建管理员 ${email}`)
}

const env = loadEnv()
const { db, client } = createDb(env.DATABASE_URL)

try {
  await seedAdmin(db, env)
} finally {
  // 不关连接池进程退不掉
  await client.end()
}
