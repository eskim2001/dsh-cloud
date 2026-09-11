import type { InstanceSpec } from '../schema.js'

/** 渲染上下文：除实例规格外的所有输入都由平台提供，实例无法控制。 */
export interface RenderContext {
  /** 基础镜像（平台固定）。 */
  baseImage: string
  /** **父域**（不是控制台域名）：实例主机名是 `<slug>.<baseDomain>`，如 `app.example.com`。 */
  baseDomain: string
  /** 入口注入的 token（每实例独立随机值）。 */
  gateToken: string
  /**
   * 宿主上该实例的数据目录（`:staged` 的源）。
   *
   * **不再是 loop 挂载点**：microVM 下没有宿主侧 loop/ext4，这就是一个普通目录。
   * 它的属主决定工作负载以什么 uid 运行 —— 见 `dataDirOwner`。
   */
  dataDir: string
  /**
   * 数据目录的属主（`uid` 或 `uid:gid`），工作负载以它运行。
   *
   * **为什么必须显式传**：`:staged` 会把宿主的属主带进 guest，而镜像声明的 `USER`
   * 是固定的 uid 1000。两者对不上时，entrypoint 对 `/data` 的第一句 `mkdir` 就 EACCES，
   * 容器直接退出（实测：smolvm 会静默降级成一个空转容器，状态仍显示 running）。
   */
  dataDirOwner: string
  /** 宿主上发布的回环端口（平台分配，唯一）。入口转发到这里。 */
  hostPort: number
}

/** 一个挂载：宿主路径 → guest 路径。 */
export interface RenderedMount {
  host: string
  guest: string
  /**
   * `rw` = 直通（virtiofs / bind）；`ro` = 只读；`staged` = 复制进 VM、停机回传。
   *
   * ⚠️ `staged` **每次启动整份复制**，文件数一多就超过运行时的启动超时 ——
   * 实测 14473 个文件必现起不来。除非确认目录很小，别用它。
   */
  mode: 'staged' | 'ro' | 'rw'
  /**
   * 这个挂载的**写入配额**（MB）。由运行时在宿主侧强制执行，超了 guest 收 ENOSPC。
   *
   * 运行时应当让 guest 的 `df` 报这个额度而不是宿主的真实磁盘 ——
   * 否则就是把宿主的磁盘规模暴露给租户。
   */
  quotaMb: number
}

/** runtime 中立的最小结果：编排层只认这些。 */
export interface RenderedInstance {
  slug: string
  /** 运行时侧标识（smolvm 的 machine name）。 */
  machineName: string
  hostname: string
  image: string
  /**
   * 工作负载的运行用户。**等于 `ctx.dataDirOwner`**，不是镜像的 `USER`。
   * 理由见 `RenderContext.dataDirOwner` 的注释。
   */
  user: string
  workingDir: string
  /** `KEY=VALUE`，与 Docker `Env` 同形，便于两边对照。 */
  env: string[]
  /** 容器内桥端口（Caddy 监听）。 */
  guestPort: number
  /** 宿主回环端口，入口转发目标。 */
  hostPort: number
  /** 宿主数据目录（`:staged` 的源）。 */
  dataDir: string
  /** 容器内数据根（`/data`）。 */
  guestDataDir: string
  mounts: RenderedMount[]
  labels: Record<string, string>
}

/**
 * 纯渲染：把实例规格 + 平台上下文变成一份运行时定义。**零 I/O。**
 *
 * 命令式的那一半（真的去 create/start/stop）在 `apps/server/src/runtime/driver.ts`。
 */
export interface InstanceRenderer {
  readonly runtime: string
  render(spec: InstanceSpec, ctx: RenderContext): RenderedInstance
}
