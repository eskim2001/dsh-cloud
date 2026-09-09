import { Readable, type Writable } from 'node:stream'
import type Docker from 'dockerode'
import {
  CONTAINER_PREFIX,
  dockerRenderer,
  type DockerRenderedInstance,
  type RenderContext,
  type InstanceSpec,
} from '@dsh-cloud/instance-spec'
import { demuxFrames, isNotFound, isNotModified } from '../docker/client.js'
import { parseStats, type ContainerUsage } from './container-stats.js'
import { imageRepo } from './image-catalog.js'
import { consumeImagePull } from './image-pull.js'

/**
 * 只要实例容器。Docker 的 `name` 过滤是子串匹配，前缀正好圈住我们的容器。
 * 不过滤的话 `docker ps -a` 要扫宿主上**全部**容器（这台开发机 63 个，~400ms），
 * 过滤后 ~35ms——而这条路径每个列表请求都走，还带 10 秒轮询。
 */
const INSTANCE_FILTER = { name: [CONTAINER_PREFIX] }

export interface InstanceRuntime extends DockerRenderedInstance {
  containerId: string
  status: string
}

/** 容器此刻的真实状态。`state` 是 Docker 的枚举，`statusText` 是它的原文描述。 */
export interface ContainerLiveState {
  /** running / restarting / paused / exited / created / dead / removing */
  state: string
  /** 人类可读，例如 `Restarting (3) 20 seconds ago`、`Up 2 hours`。 */
  statusText: string
}

/**
 * 实例编排：把 `instance-spec` 渲染出的声明，落到 Docker 上。
 *
 * 所有资源名都由 slug 派生，且 slug 已过白名单校验——这里不接受用户输入拼接。
 */
export class InstanceOrchestrator {
  /** 正在拉的镜像，按 ref 去重——两个实例同时要同一版时只拉一次。 */
  private readonly pulling = new Map<string, Promise<void>>()

  constructor(
    private readonly docker: Docker,
    /** 入口容器名（Traefik）。它要被接进每个实例网络，是那里唯一的「外人」。 */
    private readonly ingressName: string,
    /** 平台自己的镜像仓库（`INSTANCE_IMAGE_REPO`）。只有它里面的镜像允许被拉。 */
    private readonly platformImageRepo: string,
  ) {}

  /** 幂等创建独立网络（D3：每实例一个，互不可达）。 */
  async ensureNetwork(name: string): Promise<void> {
    const existing = await this.docker.listNetworks({ filters: { name: [name] } })
    if (existing.some((n) => n.Name === name)) return
    await this.docker.createNetwork({ Name: name, Driver: 'bridge', CheckDuplicate: true })
  }

  /**
   * 幂等把入口接进这些实例网络。
   *
   * 实例容器不发布宿主端口（D3），入口必须在这个网络里才能按容器名解析到它。
   * 入口容器被重建（`docker compose up`）时附着会丢，所以启动对账时要重接。
   *
   * 入口或网络不存在时**只告警不抛**：控制面可能先于 compose 起来，DB 里也可能
   * 留着「状态是 running、网络早没了」的历史行——两者都不该拖垮平台启动。
   * 此时实例不可达，Traefik 那边会 502——够响。
   */
  async attachIngress(networkNames: string[]): Promise<void> {
    if (!(await this.ingressExists())) {
      console.warn(`入口容器 ${this.ingressName} 不在，跳过网络接入（实例将不可达）`)
      return
    }
    for (const name of networkNames) {
      const net = this.docker.getNetwork(name)
      const attached = await this.isIngressAttached(net)
      if (attached === undefined) {
        console.warn(`网络 ${name} 不存在，跳过入口接入`)
        continue
      }
      if (!attached) await net.connect({ Container: this.ingressName })
    }
  }

  /** `undefined` = 网络不存在（历史残留行）。 */
  private async isIngressAttached(net: Docker.Network): Promise<boolean | undefined> {
    try {
      const info = await net.inspect()
      return Object.values(info.Containers ?? {}).some(
        (c) => c.Name.replace(/^\//, '') === this.ingressName,
      )
    } catch (err) {
      if (isNotFound(err)) return undefined
      throw err
    }
  }

  private async ingressExists(): Promise<boolean> {
    try {
      await this.docker.getContainer(this.ingressName).inspect()
      return true
    } catch (err) {
      if (!isNotFound(err)) throw err
      return false
    }
  }

  async findContainer(name: string): Promise<Docker.ContainerInfo | undefined> {
    const list = await this.docker.listContainers({ all: true, filters: { name: [name] } })
    return list.find((c) => c.Names.some((n) => n === `/${name}`))
  }

  /** 现存的实例容器名（含 DB 里没有的孤儿）。对账器用来发现漂移，不做任何删除。 */
  async listInstanceContainerNames(): Promise<string[]> {
    const list = await this.docker.listContainers({ all: true, filters: INSTANCE_FILTER })
    return list
      .flatMap((c) => c.Names)
      .map((n) => n.replace(/^\//, ''))
      .filter((n) => n.startsWith(CONTAINER_PREFIX))
  }

  /**
   * 一次 `docker ps -a` 拿到所有实例容器的实时状态，按容器名索引。
   *
   * 实例状态**在查询时**从 Docker 取，不读 DB 快照：DB 的 `status` 记的是**意图**，
   * 容器 crash-loop 时它照样写着 running（对账器把 restarting 也算活着——这是对的，
   * 容器会自己回来）。列表页问的是「现在到底在不在跑」，只有 Docker 知道。
   * 全量一次拿，避免每实例一次 inspect。
   */
  async listContainerStates(): Promise<Map<string, ContainerLiveState>> {
    const list = await this.docker.listContainers({ all: true, filters: INSTANCE_FILTER })
    const states = new Map<string, ContainerLiveState>()
    for (const c of list) {
      const state = { state: c.State, statusText: c.Status }
      for (const raw of c.Names) states.set(raw.replace(/^\//, ''), state)
    }
    return states
  }

  /**
   * 宿主上已有的镜像 tag（`repo:tag`），排序去空。
   *
   * 换镜像前用它确认「本地真的有这个镜像」——否则 Docker 会去 pull，
   * 而控制面在私有网络里未必连得上 registry，失败信息还很难看懂。
   * 不带 tag 的悬空镜像（`<none>:<none>`）不在此列。
   */
  async listImageTags(): Promise<string[]> {
    const list = await this.docker.listImages()
    return [
      ...new Set(
        list
          .flatMap((i) => i.RepoTags ?? [])
          .filter((t) => t !== '<none>:<none>'),
      ),
    ].sort()
  }

  /** 镜像在不在宿主上。**只有 404 算「没有」**——daemon 故障不是「缺镜像」，别掩盖成一次 pull。 */
  async imageExists(ref: string): Promise<boolean> {
    try {
      await this.docker.getImage(ref).inspect()
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  /**
   * 确保镜像在宿主上，缺了就从注册表拉（D23）。本地优先——已有直接返回。
   *
   * 这是**兜底**：正常路径是管理员先在控制台点「下载」。容器被 prune 掉之后
   * `restart` 才会走到这里，否则 Docker 直接 `No such image`。
   */
  async ensureImage(ref: string): Promise<void> {
    // 先看本地：已经在宿主上就没什么可拉的，仓库校验不该拦到这种（D22 之前的实例
    // `image` 还是裸 tag，照它拒会连「镜像就在本地」都重启不了）
    if (await this.imageExists(ref)) return
    this.assertPullable(ref)

    const inFlight = this.pulling.get(ref)
    if (inFlight !== undefined) return inFlight

    const task = this.pullImage(ref).finally(() => this.pulling.delete(ref))
    this.pulling.set(ref, task)
    return task
  }

  /**
   * 打开一条 `docker pull` 的进度流（SSE 用，调用方负责 destroy）。
   * 镜像已在宿主上时返回空流——调用方照常读到流结束即可，不用分两条路径。
   */
  async openImagePull(ref: string): Promise<Readable> {
    if (await this.imageExists(ref)) return Readable.from([])
    this.assertPullable(ref)
    // @types/dockerode 把 pull 的返回标成 NodeJS.ReadableStream；运行时是 stream.Readable
    const stream = await this.docker.pull(ref)
    return stream as unknown as Readable
  }

  /**
   * 只允许拉平台自己仓库里的镜像。这条路径会真的出网，而 ref 来自库里的历史值——
   * 不卡仓库，一个被改坏的 `instance.image` 就能让控制面去拉任意镜像。
   */
  private assertPullable(ref: string): void {
    if (imageRepo(ref) !== this.platformImageRepo) {
      throw new Error(`拒绝拉取非平台镜像（${this.platformImageRepo}）：${ref}`)
    }
  }

  private async pullImage(ref: string): Promise<void> {
    try {
      // @types/dockerode 把 pull 的返回标成 Web 的 ReadableStream；运行时是 stream.Readable
      const stream = (await this.docker.pull(ref)) as unknown as Readable
      await consumeImagePull(stream, () => undefined)
    } catch (err) {
      throw new Error(`拉取镜像 ${ref} 失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   *
   * **前置条件**：该实例的数据文件系统已挂载（调用方 `applyRuntime` 负责断言）。
   * 这里不兜底——兜底会掩盖「挂载没了」，那比报错更糟。
   */
  async createInstance(spec: InstanceSpec, ctx: RenderContext): Promise<InstanceRuntime> {
    const rendered = dockerRenderer.render(spec, ctx)

    await this.ensureNetwork(rendered.networkName)

    const existing = await this.findContainer(rendered.containerName)
    if (existing?.Id) await this.removeContainer(existing.Id)

    const container = await this.docker.createContainer(
      rendered.createOptions as unknown as Docker.ContainerCreateOptions,
    )
    await container.start()
    await this.attachIngress([rendered.networkName])

    const info = await container.inspect()
    return { ...rendered, containerId: container.id, status: info.State.Status }
  }

  async removeContainer(id: string): Promise<void> {
    const container = this.docker.getContainer(id)
    try {
      await container.stop({ t: 5 })
    } catch {
      // 已经停了就继续
    }
    await container.remove({ v: false, force: true })
  }

  /** 停容器。已经停了或容器不在，都当成功——调用方只关心最终状态。 */
  async stopContainer(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).stop({ t: 10 })
    } catch (err) {
      if (!isNotModified(err) && !isNotFound(err)) throw err
    }
  }

  /** 启动容器。已经在跑就当成功；容器不存在会抛 404，由调用方决定是否重建。 */
  async startContainer(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).start()
    } catch (err) {
      if (!isNotModified(err)) throw err
    }
  }

  /**
   * 移除实例的容器 + 网络。**数据不在这一层**——它是宿主上的文件系统，
   * 要不要删由 `provisioner` 决定（`purgeVolume` 时才 `storage.destroy`）。
   */
  async removeInstance(spec: InstanceSpec): Promise<void> {
    const rendered = dockerRenderer.render(spec, {
      baseImage: spec.image,
      baseDomain: 'unused.invalid',
      gateToken: 'unused',
      dataDir: 'unused.invalid',
    })

    const existing = await this.findContainer(rendered.containerName)
    if (existing?.Id) await this.removeContainer(existing.Id)

    try {
      const net = this.docker.getNetwork(rendered.networkName)
      // 入口还连着这个网络时 Docker 拒绝删网络——先摘掉（没连上就无所谓）
      await net
        .disconnect({ Container: this.ingressName, Force: true })
        .catch(() => undefined)
      await net.remove()
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }

  async inspectStatus(containerId: string): Promise<string> {
    const info = await this.docker.getContainer(containerId).inspect()
    return info.State.Status
  }

  /**
   * 取一帧用量。`stream: false` 拿的是单帧，daemon 会带上上一次采样做差值——
   * 所以同一容器**连着采**才准，这也是采样任务按固定周期跑的原因。
   */
  async stats(containerId: string): Promise<ContainerUsage | undefined> {
    const raw = await this.docker.getContainer(containerId).stats({ stream: false })
    return parseStats(raw)
  }

  /**
   * 容器日志流（`follow` 长连接，调用方负责 destroy）。
   * 容器没开 TTY，所以流是复用格式，读之前要过 `demuxStream`。
   */
  async logs(containerId: string, opts: { tail: number }): Promise<Readable> {
    // @types/dockerode 把 follow 流标成 NodeJS.ReadableStream（没有 destroy），
    // 运行时给的是 stream.Readable——调用方要 destroy 它，这里收口成 Readable
    const stream = await this.docker.getContainer(containerId).logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: opts.tail,
      timestamps: false,
    })
    return stream as unknown as Readable
  }

  /** 拆复用帧（8 字节头 + 负载）。stdout / stderr 各走一路。 */
  demuxStream(raw: Readable, out: Writable, err: Writable): void {
    this.docker.modem.demuxStream(raw, out, err)
  }

  /** 在容器内执行命令并取回输出（stdout + stderr）。 */
  async exec(containerId: string, cmd: string[]): Promise<string> {
    const container = this.docker.getContainer(containerId)
    const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true })
    const stream = await exec.start({ hijack: true, stdin: false })

    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => resolve(demuxFrames(Buffer.concat(chunks))))
      stream.on('error', reject)
    })
  }
}
