import {
  GATE_INSTANCE_HEADER,
  GATE_TOKEN_HEADER,
  InstanceSlugSchema,
} from '@dsh-cloud/instance-spec'
import { gateToken } from '../instance/gate-token.js'
import { parse, serialize } from 'cookie'

export interface InstanceLookup {
  slug: string
  ownerId: string
}

export interface ForwardAuthDeps {
  baseDomain: string
  /** 控制面自己的对外 scheme；登录页在基域上。 */
  publicScheme: 'http' | 'https'
  gateSecret: string
  findInstanceBySlug(slug: string): Promise<InstanceLookup | undefined>
  /** 从 Cookie 解析出用户；无有效会话返回 undefined。 */
  resolveUserId(cookie: string | undefined): Promise<string | undefined>
}

export interface ForwardAuthInput {
  /** 原始请求的 Host（可带端口）。 */
  host: string | undefined
  cookie: string | undefined
  /** 原始请求的完整 URL，用于登录后跳回。 */
  originalUrl: string
}

export type ForwardAuthResult =
  | { status: 200; headers: Record<string, string> }
  | { status: 302; location: string }
  | { status: 403 | 404 }

/**
 * 从 Host 里取出实例 slug。只接受**单标签**子域，避免
 * `a.b.app.example.com` 这类多级子域绕过前缀判断。
 */
export function instanceSlugFromHost(
  host: string | undefined,
  baseDomain: string,
): string | undefined {
  if (host === undefined) return undefined
  const hostname = host.split(':')[0]?.toLowerCase()
  if (hostname === undefined) return undefined

  const suffix = `.${baseDomain}`
  if (!hostname.endsWith(suffix)) return undefined

  const slug = hostname.slice(0, -suffix.length)
  if (slug.includes('.')) return undefined

  const parsed = InstanceSlugSchema.safeParse(slug)
  return parsed.success ? parsed.data : undefined
}

/**
 * forward-auth 判定（D8 ②）。
 *
 * 三道结果：未登录 → 302 回登录页；登录了但**不是该实例的 owner** → 403；
 * 通过 → 200 + 桥要的两个 header。**授权必须在这里做**——只认证不授权，
 * 任何登录用户都能开别人的实例。
 */
export async function decideForwardAuth(
  input: ForwardAuthInput,
  deps: ForwardAuthDeps,
): Promise<ForwardAuthResult> {
  const slug = instanceSlugFromHost(input.host, deps.baseDomain)
  if (slug === undefined) return { status: 404 }

  const instance = await deps.findInstanceBySlug(slug)
  if (instance === undefined) return { status: 404 }

  const userId = await deps.resolveUserId(input.cookie)
  if (userId === undefined) {
    const next = encodeURIComponent(input.originalUrl)
    return {
      status: 302,
      location: `${deps.publicScheme}://${deps.baseDomain}/login?next=${next}`,
    }
  }

  if (userId !== instance.ownerId) return { status: 403 }

  return {
    status: 200,
    headers: {
      [GATE_INSTANCE_HEADER]: instance.slug,
      [GATE_TOKEN_HEADER]: gateToken(instance.slug, deps.gateSecret),
      Cookie: Object.entries(parse(input.cookie ?? ''))
        .filter(([name]) => !/^(?:__Secure-|__Host-)?dsh_cloud(?:[._]|$)/i.test(name))
        .map(([name, value]) => serialize(name, value ?? ''))
        .join('; '),
    },
  }
}
