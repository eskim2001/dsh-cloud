import { BRIDGE_PORT, DATA_ROOT, GATE_TOKEN_HEADER } from '../constants.js'
import type { InstanceSpec } from '../schema.js'
import type {
  InstanceRenderer,
  RenderedInstance,
  RenderedMount,
  RenderContext,
} from './types.js'

/**
 * 实例机器名的前缀。
 *
 * 运行时那边列的是**宿主上所有**实例，有前缀才能一眼认出哪些是本平台的，
 * 也给清理/对账一个判据。
 */
export const MACHINE_PREFIX = 'dsh-instance-'
export const machineName = (slug: string): string => `${MACHINE_PREFIX}${slug}`
export const instanceHostname = (slug: string, baseDomain: string): string => `${slug}.${baseDomain}`

/** 容器内环境：所有可写路径都指向 `/data`。 */
function renderEnv(spec: InstanceSpec, ctx: RenderContext): string[] {
  return [
    `DSH_HOME=${DATA_ROOT}`,
    `HOME=${DATA_ROOT}/home`,
    // agent 装的全局包也要落进卷，否则升级/重建就丢
    `NPM_CONFIG_PREFIX=${DATA_ROOT}/.npm-global`,
    `NPM_CONFIG_CACHE=${DATA_ROOT}/.npm`,
    `PNPM_HOME=${DATA_ROOT}/.pnpm`,
    `PNPM_STORE_DIR=${DATA_ROOT}/.pnpm-store`,
    `COREPACK_HOME=${DATA_ROOT}/.corepack`,
    `PATH=${DATA_ROOT}/.npm-global/bin:${DATA_ROOT}/.pnpm:/usr/local/bin:/usr/bin:/bin`,
    // Caddy 需要可写目录；**必须显式传** —— Caddyfile 里
    // `@no_gate not header {$DSH_GATE_HEADER} {$DSH_GATE_TOKEN}` 在变量为空时会
    // 展开成 `not header`（参数缺失）→ 配置加载失败 → caddy 直接退出，
    // 而 entrypoint 只 wait dsh，容器照样活着（静默坏）。
    `XDG_DATA_HOME=${DATA_ROOT}/.caddy/data`,
    `XDG_CONFIG_HOME=${DATA_ROOT}/.caddy/config`,
    `DSH_TRUSTED_HOSTS=${instanceHostname(spec.slug, ctx.baseDomain)}`,
    `DSH_GATE_HEADER=${GATE_TOKEN_HEADER}`,
    `DSH_GATE_TOKEN=${ctx.gateToken}`,
    `DSH_GATE_INSTANCE=${spec.slug}`,
    ...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
  ]
}

/**
 * 把实例规格渲染成一份**运行时中立**的机器定义。
 *
 * 中立到什么程度：这里不认识 microsandbox —— 挂载、端口、用户、容量都是通用概念，
 * 由 driver 翻成自己的参数。数据卷在驱动那边是 ext4 磁盘卷，在这里只是一个不透明的 key。
 *
 * 关键设计（见 docs/ARCHITECTURE.md §四 / D31）：
 * - **`/data` 必须活得过升级**：升级走「删掉重建」，VM 盘一定重造，只有平台侧的数据
 *   才活得过去。这份约束换运行时也不变。
 * - **不能用宿主目录直挂**：passthrough 后端有硬链接 bug（上游 #1559）——unlink 掉两个
 *   名字中的一个，剩下的那个会永久只读，而 dsh 的会话日志每次落盘都会踩到。卷是真
 *   文件系统，没有这个问题。
 * - **容量 = `quota.diskMb`**，是**硬限制**（灌满即 ENOSPC），而且**不能原地扩容**。
 * - **运行用户 = root**（`'0'`）：卷的根目录归 root，声明式属主映射对磁盘卷无效。
 * - **WORKDIR = 挂载点本身**（`/data`）：运行时会校验它在 guest 里存在，而空卷里还没有
 *   `/data/home/workspace` —— 那层骨架归镜像的 entrypoint 建，建完再 cd 进去。
 */
export function renderInstance(spec: InstanceSpec, ctx: RenderContext): RenderedInstance {
  const { slug, quota } = spec

  const mounts: RenderedMount[] = [
    {
      storageKey: ctx.storageKey,
      guest: DATA_ROOT,
      mode: 'rw',
      sizeMb: quota.diskMb,
    },
  ]

  return {
    slug,
    machineName: machineName(slug),
    hostname: instanceHostname(slug, ctx.baseDomain),
    image: ctx.baseImage,
    user: '0',
    workingDir: DATA_ROOT,
    env: renderEnv(spec, ctx),
    guestPort: BRIDGE_PORT,
    hostPort: ctx.hostPort,
    guestDataDir: DATA_ROOT,
    mounts,
    labels: {
      'dsh.cloud/instance': slug,
      'dsh.cloud/managed': 'true',
    },
  }
}

export const instanceRenderer: InstanceRenderer = {
  runtime: 'instance',
  render: renderInstance,
}
