/**
 * 改平台域名：控制台落在 `console.<父域>`，实例子域挂在 `<父域>` 下面。
 *
 * **写的是 DB**（`platform_setting` 那一行），**不碰 `.env`** —— 域名只有一个家，就是那张表。
 * 装机不往环境变量里写域名（见 `install.sh` 的 `write_env`），所以这条命令同时是两件事：
 * ① 换域名；② 引导页填错、或域名被改坏之后**从 SSH 进来的唯一出路**。
 *
 * 为什么需要它：新域名是**启动期**配置 —— 会话 cookie 的 `Domain` 和 better-auth 的 baseURL
 * 都在启动时按域名定死（见 `env.ts` / `auth.ts`）。改完必须重启控制面才生效，而重启之后
 * 旧域名上的会话就失效了。所以「改域名」这件事在界面上做是危险的：写错了就把自己关在门外。
 * 这条命令是那个界面背后的兜底，也是现在唯一支持的入口。
 *
 * 用法：
 *   docker compose -f /opt/dsh-cloud/prod.yml run --rm control-plane domain example.com
 *
 * 环境变量：
 *   SELF_CONTAINER  控制面自己的容器名。给了就顺手重启它；不给就只打印要执行的命令。
 */
import { randomBytes } from 'node:crypto'
import { resolve4 } from 'node:dns/promises'
import { createDb } from '../src/db/client.js'
import { getPlatformSetting, savePlatformDomains } from '../src/db/platform-setting-repo.js'
import { createDocker } from '../src/docker/client.js'
import { CONSOLE_LABEL, loadEnv } from '../src/env.js'

function usage(message: string): never {
  console.error(
    `domain 无法执行：${message}\n\n` +
      '用法：\n' +
      '  docker compose -f /opt/dsh-cloud/prod.yml run --rm control-plane domain <父域>\n\n' +
      '父域是**父**域名（如 example.com），不是控制台自己的主机名 ——\n' +
      `控制台会落在 ${CONSOLE_LABEL}.<父域>，每个工作空间各占 <子域名>.<父域>。`,
  )
  process.exit(1)
}

/** 与引导页同一个形状（见 `http/setup-routes.ts` 的 BaseDomainSchema）。 */
const HOSTNAME = /^[a-z0-9.-]+$/u

async function main(): Promise<void> {
  const baseDomain = (process.argv[2] ?? '').trim()

  if (baseDomain === '') usage('没给父域')
  if (!HOSTNAME.test(baseDomain)) usage(`父域只能是小写字母 / 数字 / . / -，给的是：${baseDomain}`)
  if (!baseDomain.includes('.')) usage(`父域至少要两个标签（如 example.com），给的是：${baseDomain}`)

  const env = loadEnv()
  const { db, client } = createDb(env.DATABASE_URL)

  // 环境里有域名的话它**压过** DB（见 `withPlatformDomains`）—— 那这条命令写下去根本不会被读。
  // 本地开发正是这种状态（`.env.local` 里 `BASE_DOMAIN=lvh.me`）。说清楚，别让它看起来"没生效"。
  if (env.BASE_DOMAIN !== '') {
    usage(
      `这个进程的环境里有 BASE_DOMAIN=${env.BASE_DOMAIN}，它会压过数据库，改 DB 不会生效。` +
        '先清掉那个环境变量（或直接改它）。',
    )
  }

  try {
    const consoleDomain = `${CONSOLE_LABEL}.${baseDomain}`
    const current = await getPlatformSetting(db)

    if (current?.baseDomain === baseDomain) {
      console.log(`域名没变（还是 ${baseDomain}），什么都没做。`)
      return
    }

    // 粗检泛解析，**只警告不拦** —— 与引导页同一个立场：解析可能是反代、也可能还在生效，
    // 平台判不了；而且拦住的话，操作者会被卡在一个他只能从 SSH 修的状态里。
    const probe = `dsh-check-${randomBytes(4).toString('hex')}.${baseDomain}`
    const resolved = await resolve4(probe).catch(() => [])
    if (resolved.length === 0) {
      console.warn(`警告：解析不到 ${probe} —— 泛解析 *.<父域> 大概率没配好，证书签不下来。`)
    }

    await savePlatformDomains(db, { baseDomain, consoleDomain })
    console.log(`已写入平台设置：父域 ${baseDomain}`)
    if (current !== undefined) console.log(`（原来的是 ${current.baseDomain}）`)

    // 新域名是启动期配置，必须重启才生效。重启之后控制面在启动时重投影路由，
    // 新的 console.<父域> 那条才会出现。
    const self = env.SELF_CONTAINER
    if (self === '') {
      console.log('没配 SELF_CONTAINER（本地开发？），手动重启控制面让新域名生效。')
      return
    }
    try {
      await createDocker().getContainer(self).restart()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.warn(`警告：自动重启失败（${detail}）。`)
      console.warn('域名已经写好，手动让它生效：')
      console.warn('  docker compose -f /opt/dsh-cloud/prod.yml up -d control-plane')
      return
    }

    console.log(`控制面已重启，控制台现在在 https://${consoleDomain}`)
    console.log('旧域名上的会话已失效，请在新域名下重新登录。')
  } finally {
    // 不关连接池进程退不掉
    await client.end()
  }
}

await main()
