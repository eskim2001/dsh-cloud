import {
  BRIDGE_PORT,
  DATA_ROOT,
  GATE_TOKEN_HEADER,
  WORKSPACE_DIR,
} from '../constants.js'
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
 * 中立到什么程度：这里不认识 smolvm 也不认识 microsandbox —— 挂载、端口、
 * 用户、配额都是通用概念，由各个 driver 翻成自己的参数。
 *
 * 关键设计（见 docs/ARCHITECTURE.md §四 / D31）：
 * - **`/data` 必须落在宿主上**：升级走「删掉重建」，VM 盘一定重造，
 *   只有宿主上的东西才活得过升级。这是我们用哪个运行时都不变的硬约束。
 * - **挂载走直通（`rw`），不走 `staged`**：`staged` 每次启动整份复制，
 *   实测 14473 个文件就超过运行时的启动超时、实例**永远起不来**。
 * - **配额 = `quota.diskMb`**：由运行时在宿主侧强制执行，且要让 guest 的 `df`
 *   报这个额度而不是宿主的真实磁盘。
 * - **运行用户 = 宿主数据目录的属主**，不是镜像的 `USER`：两者不一致时
 *   entrypoint 对 `/data` 的第一句 `mkdir` 就 EACCES。
 */
export function renderInstance(spec: InstanceSpec, ctx: RenderContext): RenderedInstance {
  const { slug, quota } = spec

  const mounts: RenderedMount[] = [
    {
      host: ctx.dataDir,
      guest: DATA_ROOT,
      mode: 'rw',
      quotaMb: quota.diskMb,
    },
  ]

  return {
    slug,
    machineName: machineName(slug),
    hostname: instanceHostname(slug, ctx.baseDomain),
    image: ctx.baseImage,
    user: ctx.dataDirOwner,
    workingDir: WORKSPACE_DIR,
    env: renderEnv(spec, ctx),
    guestPort: BRIDGE_PORT,
    hostPort: ctx.hostPort,
    dataDir: ctx.dataDir,
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
