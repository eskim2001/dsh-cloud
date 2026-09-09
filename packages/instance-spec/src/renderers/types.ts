import type { InstanceSpec } from '../schema.js'

/** 渲染上下文：除实例规格外的所有输入都由平台提供，实例无法控制。 */
export interface RenderContext {
  /** 基础镜像（平台固定）。 */
  baseImage: string
  /** 子域后缀，如 `app.example.com`。 */
  baseDomain: string
  /** 入口注入的 token（每实例独立随机值）。 */
  gateToken: string
  /**
   * 宿主上该实例的数据目录（已挂载好、已 chown），bind 到容器内的 `/data`。
   * 由平台按 `HOST_STORAGE_ROOT` + slug 生成，见 `host-storage.ts`（D18）。
   */
  dataDir: string
}

/** runtime 中立的最小结果：编排层只认这些。 */
export interface RenderedInstance {
  slug: string
  containerName: string
  networkName: string
  /** 宿主数据目录（容器 `/data` 的来源）。 */
  dataDir: string
  hostname: string
  containerPort: number
}

/**
 * runtime renderer。换 K8s / microVM 时新增一个实现，业务代码不动。
 * 见 docs/DECISIONS.md D2。
 */
export interface InstanceRenderer<T> {
  readonly runtime: string
  render(spec: InstanceSpec, ctx: RenderContext): T
}
