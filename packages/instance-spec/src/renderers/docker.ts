import {
  BRIDGE_PORT,
  DATA_ROOT,
  GATE_TOKEN_HEADER,
  WORKSPACE_DIR,
} from '../constants.js'
import type { InstanceSpec } from '../schema.js'
import type { RenderedInstance, RenderContext, InstanceRenderer } from './types.js'

/**
 * dockerode `createContainer` 参数的结构子集。
 * 这里自己声明而**不**依赖 dockerode 类型，让 instance-spec 保持零 runtime 依赖。
 */
export interface DockerCreateOptions {
  name: string
  Image: string
  User: string
  WorkingDir: string
  Env: string[]
  Labels: Record<string, string>
  ExposedPorts: Record<string, Record<string, never>>
  HostConfig: {
    Memory: number
    NanoCpus: number
    PidsLimit: number
    /** 可写：dsh 是编码 agent，装依赖是日常。见 docs/DECISIONS.md D12。 */
    ReadonlyRootfs: boolean
    /** PID 1 由镜像里的 tini 担任，不用 Docker 再注入一层。 */
    Init: boolean
    CapDrop: string[]
    SecurityOpt: string[]
    NetworkMode: string
    Binds: string[]
    PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>
    Tmpfs: Record<string, string>
    RestartPolicy: { Name: string; MaximumRetryCount?: number }
  }
}

export interface DockerRenderedInstance extends RenderedInstance {
  createOptions: DockerCreateOptions
}

/** 容器名前缀。Docker 的 `name` 过滤是子串匹配，查实例容器时直接拿它当过滤器。 */
export const CONTAINER_PREFIX = 'dsh-instance-'
export const containerName = (slug: string): string => `${CONTAINER_PREFIX}${slug}`
export const networkName = (slug: string): string => `dsh-net-${slug}`
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
    // Caddy 需要可写目录
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
 * 把实例规格渲染成一份 Docker 容器定义。
 *
 * 安全约束（见 docs/ARCHITECTURE.md §五）：非 root、drop 全部 capabilities、
 * no-new-privileges、pids 限制、独立网络、**不发布任何宿主端口**。
 */
export function renderDockerInstance(spec: InstanceSpec, ctx: RenderContext): DockerRenderedInstance {
  const { slug, quota } = spec
  const portKey = `${BRIDGE_PORT}/tcp`

  return {
    slug,
    containerName: containerName(slug),
    networkName: networkName(slug),
    dataDir: ctx.dataDir,
    hostname: instanceHostname(slug, ctx.baseDomain),
    containerPort: BRIDGE_PORT,
    createOptions: {
      name: containerName(slug),
      Image: ctx.baseImage,
      User: 'node',
      WorkingDir: WORKSPACE_DIR,
      Env: renderEnv(spec, ctx),
      Labels: {
        'dsh.cloud/instance': slug,
        'dsh.cloud/managed': 'true',
      },
      ExposedPorts: { [portKey]: {} },
      HostConfig: {
        Memory: quota.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(quota.cpus * 1_000_000_000),
        PidsLimit: quota.pidsLimit,
        ReadonlyRootfs: false,
        Init: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        NetworkMode: networkName(slug),
        // 宿主目录 = 该实例的数据文件系统挂载点（D18），不是 Docker named volume。
        // 挂载由 host-storage 保证在容器创建**之前**完成；这里失败就等于容器看到空目录。
        Binds: [`${ctx.dataDir}:${DATA_ROOT}`],
        // 不发布任何宿主端口（D3）。发布出去就经 Docker Desktop 的 VM 网关对**所有**
        // 容器可见（macOS/Windows 的已知行为，见 OPEN-QUESTIONS #4），门① 就没了。
        // 入口经 Docker 网络直连容器名访问，不经宿主。
        PortBindings: {},
        Tmpfs: { '/tmp': 'rw,nosuid,size=512m' },
        // 不用 unless-stopped：宿主 / daemon 重启后挂载全部消失，而它会**自动拉起**容器
        // → bind 到空目录，用户看到「数据没了」且一切看起来正常。on-failure 在 daemon
        // 重启时不拉起，崩溃时照常重试——启动顺序改由平台掌握（D18）。
        RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 5 },
      },
    },
  }
}

export const dockerRenderer: InstanceRenderer<DockerRenderedInstance> = {
  runtime: 'docker',
  render: renderDockerInstance,
}
