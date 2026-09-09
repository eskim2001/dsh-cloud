import { z } from 'zod'

/**
 * 平台运行时配置。**全部来自环境变量**，启动时校验一次，缺了就起不来。
 *
 * `PLATFORM_SECRET` 和 `BETTER_AUTH_SECRET` 故意分开：前者派生实例桥的
 * gate token（D8 ③），后者签会话。密钥轮换的影响面不同，不该共用一把。
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, '缺 DATABASE_URL'),

  /** 实例子域挂在它下面，如 `app.example.com`。 */
  BASE_DOMAIN: z
    .string()
    .min(1, '缺 BASE_DOMAIN')
    .regex(/^[a-z0-9.-]+$/, 'BASE_DOMAIN 只能是小写主机名'),

  /** 派生实例 gate token。轮换后**必须重建实例容器**，否则桥 403。 */
  PLATFORM_SECRET: z.string().min(32, 'PLATFORM_SECRET 至少 32 字符'),

  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET 至少 32 字符'),

  /** 控制面监听端口（只绑回环，由 Traefik 接入）。 */
  PORT: z.coerce.number().int().positive().default(3000),

  /** 实例容器基础镜像（pin 到 digest 见 isPinnedImage）。 */
  INSTANCE_IMAGE: z.string().min(1),

  /**
   * 用户能在实例详情页**自助升级**到的版本，逗号分隔的精确 tag。
   * 平台只把「已回归过」的 tag 写进来——用户看不见其它本地镜像。
   * 空 = 用户不能自选版本（升级由管理员做）。
   */
  INSTANCE_STABLE_IMAGES: z.string().default(''),

  /** 生成对外 URL 用（本地开发是 http，线上是 https）。 */
  PUBLIC_SCHEME: z.enum(['http', 'https']).default('https'),

  /**
   * 额外受信来源，逗号分隔。better-auth 会校验请求的 Origin；
   * 生产是 `app.example.com` 本身，开发时前端跑在 :5173，需要显式放行。
   */
  EXTRA_TRUSTED_ORIGINS: z.string().default(''),

  /**
   * 入口容器名（Traefik）。控制面要把它接进每个实例网络——实例容器不发布
   * 宿主端口，入口只有在同一网络里才够得着它（D3）。
   */
  TRAEFIK_CONTAINER: z.string().default('dsh-ingress'),

  /**
   * 实例路由挂的 entryPoint。生产是 `websecure`（TLS 终结在 Traefik）；
   * 本地也是 `websecure`（证书是 mkcert 签的，见 docker/traefik/dynamic-dev/tls.yml）。
   */
  TRAEFIK_ENTRYPOINT: z.string().default('websecure'),

  /**
   * 实例 router 用的 ACME resolver 名（对应 traefik.yml 里的 certificatesResolvers）。
   * 留空 = 不挂 resolver，证书由 file provider 的静态证书按 SNI 匹配——
   * 本地 mkcert 就是这一档。
   */
  TRAEFIK_CERT_RESOLVER: z.string().default(''),

  /**
   * 平台管理员邮箱，逗号分隔。**启动时**把已存在的这些账号提权为 admin
   * （只升不降：从这里删掉不会撤权，撤权走管理台）。
   * 这是「第一个管理员从哪来」的答案——不需要手改数据库。
   */
  ADMIN_EMAILS: z.string().default(''),

  /** 每个用户默认能开几个实例；单个用户的覆盖值在 user.instance_quota。 */
  MAX_INSTANCES_PER_USER: z.coerce.number().int().positive().default(3),

  /**
   * 宿主上存放实例数据文件系统的目录（D18）。每个实例一个 `<slug>.img`
   * （大小 = 磁盘配额）挂到 `<root>/<slug>`，再 bind 进容器当 `/data`。
   * 控制面跑在宿主上，所以这是**宿主路径**。
   */
  HOST_STORAGE_ROOT: z.string().min(1).default('/var/lib/dsh'),

  /**
   * 执行宿主存储操作的助手镜像。它只用来 `nsenter` 进宿主执行
   * `losetup` / `mkfs.ext4` / `mount` 那几条命令——镜像里的工具用不上，
   * 真正跑的是宿主自己的（`nsenter -t 1 -m` 后 PATH 解析到宿主根）。
   */
  STORAGE_HELPER_IMAGE: z.string().min(1).default('alpine:3.20'),
})

export type Env = z.infer<typeof EnvSchema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    throw new Error(`环境变量不合法：\n${lines.join('\n')}`)
  }
  return parsed.data
}

/** better-auth 的受信来源：控制面自己的 origin + 额外放行项。 */
export function trustedOrigins(env: Env): string[] {
  const base = `${env.PUBLIC_SCHEME}://${env.BASE_DOMAIN}`
  const extra = env.EXTRA_TRUSTED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  return [base, ...extra]
}

/** 逗号分隔的管理员邮箱，统一小写去空（邮箱大小写不敏感）。 */
export function adminEmails(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '')
}

/** 逗号分隔的稳定版镜像 tag，去空。**不去重、不改大小写**——tag 区分大小写。 */
export function stableImages(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}
