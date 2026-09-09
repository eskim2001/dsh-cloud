import { z } from 'zod'

/** 不能用作实例 slug 的保留字（会与平台自身或常见约定冲突）。 */
export const RESERVED_SLUGS: readonly string[] = [
  'www',
  'api',
  'app',
  'admin',
  'auth',
  'login',
  'register',
  'mail',
  'smtp',
  'static',
  'assets',
  'cdn',
  'dashboard',
  'status',
  'health',
]

/**
 * 实例标识。同时用作子域名、容器名、卷名、网络名——所以只允许 DNS label 安全字符，
 * 且必须排除 punycode 前缀（同形字风险）与保留字。
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
  .refine((s) => !RESERVED_SLUGS.includes(s), '该 slug 是保留字')

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
