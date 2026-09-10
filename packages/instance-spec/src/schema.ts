import { z } from 'zod'

/**
 * 不能用作实例 slug 的保留字。
 *
 * **这不是洁癖，是边界**：控制台（`console.<base>`）和所有实例（`<slug>.<base>`）
 * 共享同一个注册域，谁抢到某个 label 就决定了谁的 router 规则更长 / 更像平台。
 * 分组只是为了让后来者知道该往哪一档加词。
 *
 * **只在「分配新名字」时生效**（创建输入）。它是命名政策，不是记录的属性——
 * 对库里已有的行再判一次，等于让扩表追溯性地把存量实例变成不可访问、不可删除的对象。
 */
export const RESERVED_SLUGS: readonly string[] = [
  // 平台 / 控制台自用
  'console',
  'platform',
  'portal',
  'panel',
  'dashboard',
  'manage',
  'control',
  'root',
  'system',
  'internal',
  // 认证与账号
  'auth',
  'login',
  'logout',
  'signin',
  'signup',
  'register',
  'sso',
  'oauth',
  'account',
  'accounts',
  'password',
  'verify',
  'admin',
  'api',
  'gateway',
  // 基础设施
  'www',
  'web',
  'static',
  'assets',
  'cdn',
  'media',
  'files',
  'dns',
  'ns1',
  'ns2',
  'mail',
  'smtp',
  'imap',
  'ftp',
  'git',
  'gitlab',
  'registry',
  'docker',
  'proxy',
  'node',
  // 环境
  'dev',
  'test',
  'staging',
  'stage',
  'prod',
  'demo',
  'sandbox',
  'local',
  'lvh',
  'beta',
  'alpha',
  'preview',
  'uat',
  // 监控与运维
  'status',
  'health',
  'metrics',
  'monitor',
  'grafana',
  'prometheus',
  'kibana',
  'logs',
  'alert',
  'alerts',
  'uptime',
  // 常见服务词（用户第一反应会去点的那种）
  'app',
  'blog',
  'docs',
  'help',
  'support',
  'shop',
  'store',
  'pay',
  'payment',
  'billing',
  'email',
]

/** 保留字判定。**只给创建路径用**——见 `RESERVED_SLUGS` 的注释。 */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.includes(slug)
}

/**
 * 实例标识的形状。同时用作子域名、容器名、卷名、网络名——所以只允许 DNS label 安全字符，
 * 且必须排除 punycode 前缀（同形字风险）。
 *
 * **不含保留字判定**：那一步在创建输入上（`CreateBodySchema`）。对库里已有的记录
 * 只做形状校验，否则存量实例会因为保留字表扩容而无法启停 / 删除。
 */
export const InstanceSlugSchema = z
  .string()
  .min(3, 'slug 至少 3 个字符')
  .max(32, 'slug 最多 32 个字符')
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'slug 只能用小写字母 / 数字 / 连字符，且首尾不能是连字符',
  )
  .refine((s) => !s.startsWith('xn--'), '禁止 punycode 前缀（同形字风险）')

/**
 * 配额。磁盘（`diskMb`）不是 Docker 参数——它决定数据文件系统的大小，
 * 由 `apps/server/src/instance/host-storage.ts` 落地（D18）。
 */
export const QuotaSchema = z.object({
  cpus: z.number().positive().max(64),
  memoryMb: z.number().int().positive().max(262_144),
  pidsLimit: z.number().int().positive().max(4_096).default(512),
  diskMb: z.number().int().positive().max(1_048_576).default(10_240),
})

/** 镜像引用：禁止空格与 shell 元字符，防止注入 Docker 参数。 */
export const ImageRefSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/, '镜像引用含非法字符')

/** 环境变量名：POSIX 风格。 */
export const EnvKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '环境变量名非法')

export const InstanceSpecSchema = z.object({
  slug: InstanceSlugSchema,
  /** 基础镜像由平台给定，实例不可选。 */
  image: ImageRefSchema,
  quota: QuotaSchema,
  env: z.record(EnvKeySchema, z.string()).default({}),
})

export type InstanceSlug = z.infer<typeof InstanceSlugSchema>
export type Quota = z.infer<typeof QuotaSchema>
export type InstanceSpec = z.infer<typeof InstanceSpecSchema>

/** 镜像是否 digest pin（`repo@sha256:...`）。生产环境要求为真。 */
export function isPinnedImage(image: string): boolean {
  return /@sha256:[0-9a-f]{64}$/.test(image)
}
