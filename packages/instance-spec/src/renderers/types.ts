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
   * 该实例的数据卷标识。**不透明** —— 宿主路径、卷名、镜像落在哪，全由运行时决定；
   * 平台只负责「在这个 key 下建卷、用它挂载、删它」。
   *
   * 从前这里是一份**宿主目录**。改用命名卷是因为宿主目录直挂要走 Docker Desktop 的
   * VM 共享文件系统，而那个后端有硬链接语义问题（上游 #1559）：unlink 掉两个名字中的一个，
   * 剩下的那个名字会永久只读 —— dsh 的会话日志每次落盘都会踩到。见驱动的类注释。
   */
  storageKey: string
  /** 宿主上发布的回环端口（平台分配，唯一）。入口转发到这里。 */
  hostPort: number
}

/** 一个挂载：数据卷 → guest 路径。 */
export interface RenderedMount {
  /** 挂哪块卷（见 `RenderContext.storageKey`）。 */
  storageKey: string
  guest: string
  /** `rw` = 可写；`ro` = 只读。 */
  mode: 'ro' | 'rw'
  /**
   * 这块卷**声明的容量**（MiB）。Docker 命名卷**没有硬配额** —— 它只记进卷的 label，
   * 用于展示和按同容量重建；真正的上限要宿主侧文件系统配额（见 `DockerDriver.createStorage`）。
   * 容量在创建时定死，**不能原地扩容**（改了要么迁移要么拒绝）。
   */
  sizeMb: number
}

/** runtime 中立的最小结果：编排层只认这些。 */
export interface RenderedInstance {
  slug: string
  /** 运行时侧标识（实例机器名）。 */
  machineName: string
  hostname: string
  image: string
  /**
   * 工作负载的运行用户。**固定 `'0'`（root）** —— 数据卷的根目录归 root，而
   * `.owner()` 这类声明式属主映射对命名卷无效，所以工作负载只能是 root。
   *
   * 这不是「懒得降权」：guest 里能写的只有 `/data`，而它归 root。安全边界是容器本身
   * （内核命名空间），不是 guest 内的 uid。
   */
  user: string
  /**
   * 运行时的 **WORKDIR**。只能是挂载点本身（`/data`）—— 空卷里还没有
   * `/data/home/workspace` 那层骨架，而 `/data` 作为挂载点在容器起来时一定存在。
   *
   * dsh 真正的工作目录由镜像的 entrypoint 建出来再 `cd` 进去，保证它的 cwd 仍是
   * `/data/home/workspace`（会话目录名的前缀编码的就是 cwd，变了会让已有会话看着像丢了）。
   */
  workingDir: string
  /** `KEY=VALUE`，与 Docker `Env` 同形，便于两边对照。 */
  env: string[]
  /** 容器内桥端口（Caddy 监听）。 */
  guestPort: number
  /**
   * 资源上限（CPU 核数 / 内存 MiB / 进程数）。**驱动必须落到运行时上。**
   *
   * 为什么放在这里而不是让驱动自己回去翻 `spec.quota`：`create()` 的返回值的全部意义就是
   * 「这台机器该长什么样」，驱动照着它建就行。资源曾经**不在**这份定义里 —— 于是
   * `pidsLimit` 在 schema 里有、界面上能调，驱动却没往下带，护栏是空的；将来写 K8s /
   * microVM 驱动的人同样会以为"接口里没提资源，那大概不用管"。
   */
  cpus: number
  memoryMb: number
  pidsLimit: number
  /** 宿主回环端口，入口转发目标。 */
  hostPort: number
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
