import { randomBytes, timingSafeEqual } from 'node:crypto'
import { resolve4 } from 'node:dns/promises'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CONSOLE_LABEL } from '../env.js'

/**
 * 引导态的 setup 端点。
 *
 * 装机没给域名时，平台**只**暴露这一条链路：`GET /api/setup/state` 告诉控制台这会儿该显示
 * setup 页；`POST /api/setup` 收域名。凭证是安装脚本生成并打印的**一次性 token** ——
 * 此刻还没有可信来源可配（域名正是在这里填的），所以这条写端点**不走 Origin 检查**
 * （见 `app.ts` 的 onRequest 钩子），那枚 token 就是它的全部防线。
 *
 * 配好之后：落库 → 调用方立刻重新投影（把 `:80` 上的明文引导口摘掉）→ 重启自己换身份。
 * 重启由调用方挂在**响应刷完之后**（SIGTERM 会截断还没发出去的 body）。
 */
export interface SetupDeps {
  /** 域名已经配好了（正常模式）：写端点一律 409，state 端点回 true。 */
  configured: boolean
  /** 引导态的一次性凭证。空串 = 没开 setup，写端点也拒（fail closed）。 */
  token: string
  /** 落库。调用方同时负责立刻重新投影，把明文引导口摘掉。 */
  saveDomains?: (domains: { baseDomain: string; consoleDomain: string }) => Promise<void>
  /** 重启自己，让新域名生效（cookie 域与 baseURL 都是启动期配置）。 */
  restart?: () => void
  /** 测试用：查子域解析。默认走系统解析器，查不到返回空表（**不抛**）。 */
  resolveSubdomain?: (hostname: string) => Promise<string[]>
}

/** 父域形状：小写 hostname，且**至少两个标签**（否则 `console.<父域>` 不成立）。 */
const BaseDomainSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9.-]+$/)
  .refine((d) => d.includes('.'), { message: '父域至少要两个标签，如 example.com' })

/**
 * 请求体。token **故意**只要求是字符串（不要求非空）：空 token 要走到"凭证不对"那条路
 * 拿 401，而不是被表单校验拦成 400 —— 前者说的是"你没权限"，后者说的是"你格式写错了"，
 * 给排障的人指的方向完全不同。
 */
const SetupBodySchema = z.object({ token: z.string(), baseDomain: BaseDomainSchema })

/** 常量时间比较（等长时）。`expected` 为空一律不匹配 —— 别让「没配 token」变成「谁都能配」。 */
function tokenMatches(expected: string, given: string): boolean {
  if (expected === '') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  // 长度不同直接拒：timingSafeEqual 要求等长，而 token 长度本来就是固定的，不算泄露
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const defaultResolve = async (hostname: string): Promise<string[]> => {
  try {
    return await resolve4(hostname)
  } catch {
    // NXDOMAIN、超时、没网 —— 都算「解析不到」，交给调用方当警告
    return []
  }
}

export function registerSetupRoutes(app: FastifyInstance, deps: SetupDeps): void {
  /**
   * 控制台启动时问一次「配好了没」。**两个模式都注册**：正常模式下它就是一句
   * `{ configured: true }`，控制台据此走正常界面，不必去猜 404 的含义。
   */
  app.get('/api/setup/state', async () => ({ configured: deps.configured }))

  app.post('/api/setup', async (request, reply) => {
    const saveDomains = deps.saveDomains
    if (deps.configured || saveDomains === undefined) {
      return reply.code(409).send({ error: 'already-configured' })
    }
    const parsed = SetupBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-domain',
        detail: parsed.error.issues[0]?.message ?? '域名不合法',
      })
    }
    if (!tokenMatches(deps.token, parsed.data.token)) {
      // 401 而不是 403：错的是凭证，不是来源
      return reply.code(401).send({ error: 'invalid-token' })
    }

    const { baseDomain } = parsed.data
    const consoleDomain = `${CONSOLE_LABEL}.${baseDomain}`

    // 粗检：随机子域解不出来 = 泛解析没配（或还没生效）。**只警告不拦** —— 与安装脚本同一个立场：
    // 解析可能是 CDN / 反代 / 生效中，平台判不了，但操作者需要知道证书可能签不下来。
    //
    // 回**结构化结果**而不是一句中文：控制台是双语的，文案归 UI 组。
    const resolve = deps.resolveSubdomain ?? defaultResolve
    const probe = `dsh-check-${randomBytes(4).toString('hex')}.${baseDomain}`
    const addresses = await resolve(probe)

    await saveDomains({ baseDomain, consoleDomain })

    const restart = deps.restart
    if (restart !== undefined) {
      // 等响应刷完再重启：SIGTERM 会把还没发出去的 body 截断，浏览器那边就成了"提交失败"。
      // **用 once**：重在一次就够，别让任何重复的 finish 触发第二次重启。
      reply.raw.once('finish', () => {
        restart()
      })
    }
    return { consoleDomain, dns: { probe, resolved: addresses.length > 0 } }
  })
}
