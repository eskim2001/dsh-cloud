import { z } from 'zod'

/**
 * 平台运行时配置。**全部来自环境变量**，启动时校验一次，缺了就起不来。
 *
 * `PLATFORM_SECRET` 和 `BETTER_AUTH_SECRET` 故意分开：前者派生实例桥的
 * gate token（D8 ③），后者签会话。密钥轮换的影响面不同，不该共用一把。
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, '缺 DATABASE_URL'),

  /**
   * **父域**：实例子域挂在它下面（`<slug>.<BASE_DOMAIN>`），会话 cookie 也种在它上面
   * （`Domain=.<BASE_DOMAIN>`），所以它必须同时覆盖控制台和实例。本地 `lvh.me`。
   */
  BASE_DOMAIN: z
    .string()
    .min(1, '缺 BASE_DOMAIN')
    .regex(/^[a-z0-9.-]+$/, 'BASE_DOMAIN 只能是小写主机名'),

  /**
   * 控制台自己的主机名，必须是 `BASE_DOMAIN` 的**子域**（`console.lvh.me`）。
   * 父域本身不当主机名用——`<父域>` 这一层留给实例命名空间（`<slug>.<父域>`）。
   * 它决定 better-auth 的 baseURL、受信 Origin 和未登录时的跳转目标。
   */
  CONSOLE_DOMAIN: z
    .string()
    .min(1, '缺 CONSOLE_DOMAIN')
    .regex(/^[a-z0-9.-]+$/, 'CONSOLE_DOMAIN 只能是小写主机名'),

  /** 派生实例 gate token。轮换后**必须重建实例容器**，否则桥 403。 */
  PLATFORM_SECRET: z.string().min(32, 'PLATFORM_SECRET 至少 32 字符'),

  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET 至少 32 字符'),

  /** 控制面监听端口（只绑回环，由 Traefik 接入）。 */
  PORT: z.coerce.number().int().positive().default(3000),

  /** 生成对外 URL 用（本地开发是 http，线上是 https）。 */
  PUBLIC_SCHEME: z.enum(['http', 'https']).default('https'),

  /**
   * 额外受信来源，逗号分隔。better-auth 会校验请求的 Origin；
   * 生产就是 `CONSOLE_DOMAIN` 本身，开发时前端跑在 :5173，需要显式放行。
   */
  EXTRA_TRUSTED_ORIGINS: z.string().default(''),

  /**
   * 入口容器名（Traefik）。控制面要把它接进每个实例网络——实例容器不发布
   * 宿主端口，入口只有在同一网络里才够得着它（D3）。
   */
  TRAEFIK_CONTAINER: z.string().default('dsh-ingress'),

  /**
   * 实例路由挂的 entryPoint。生产是 `websecure`（TLS 终结在 Traefik）；
   * 本地也是 `websecure`（没配静态证书，回落到 Traefik 的默认自签证书）。
   */
  TRAEFIK_ENTRYPOINT: z.string().default('websecure'),

  /**
   * 实例 router 用的 ACME resolver 名（对应 traefik.yml 里的 certificatesResolvers）。
   * 留空 = 不挂 resolver，证书走 file provider 的静态证书按 SNI 匹配。
   * 本地没有静态证书，落到 Traefik 的默认自签证书；生产是把 Cloudflare Origin Certificate
   * 之类的证书放进 file provider（TLS 在边缘终结时也是这一档）。
   */
  TRAEFIK_CERT_RESOLVER: z.string().default(''),

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

  /**
   * 平台自己的实例镜像仓库（D22）。发布准入和「宿主上可发布」都按它过滤——
   * 不再从默认版本推断（那样表一空就没法发布第一版）。本地 build.sh 打的是同一个全名。
   */
  INSTANCE_IMAGE_REPO: z.string().min(1).default('ghcr.io/eskim2001/dsh-instance'),

  /**
   * 同步 GHCR tag 用的凭据（D23）。包是**公开**的，不设也能匿名读；
   * 换成私有包时两个都要设，只设一个会被忽略（免得出现半截 Basic 头）。
   */
  INSTANCE_IMAGE_REGISTRY_USER: z.string().default(''),
  INSTANCE_IMAGE_REGISTRY_TOKEN: z.string().default(''),
}).superRefine((env, ctx) => {
  // 控制台是父域的专属子域（console.<父域>）；父域本身不当主机名用。
  // 用 label 边界判定（`endsWith('.lvh.me')`），别让 `evil-lvh.me` 混过去。
  if (!env.CONSOLE_DOMAIN.endsWith(`.${env.BASE_DOMAIN}`)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CONSOLE_DOMAIN'],
      message: `CONSOLE_DOMAIN 必须是 BASE_DOMAIN（${env.BASE_DOMAIN}）的子域，如 console.${env.BASE_DOMAIN}`,
    })
  }
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

/** better-auth 的受信来源：**控制台**自己的 origin + 额外放行项。实例子域不在其中。 */
export function trustedOrigins(env: Env): string[] {
  const base = `${env.PUBLIC_SCHEME}://${env.CONSOLE_DOMAIN}`
  const extra = env.EXTRA_TRUSTED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  return [base, ...extra]
}

/** 控制台主机名的首段（`console.lvh.me` → `console`）。实例不能占用它，见 instance-routes 的创建校验。 */
export function consoleLabel(env: Env): string {
  return env.CONSOLE_DOMAIN.split('.')[0]!
}
