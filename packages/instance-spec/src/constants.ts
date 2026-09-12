/** 容器内 Caddy 监听端口；入口把它发布到宿主回环，再按 `host:hostPort` 转发进来。 */
export const BRIDGE_PORT = 8080

/** dsh 在容器内监听的端口，只绑回环。 */
export const DSH_PORT = 3080

/** 用户内容的唯一落点（卷挂载点）。 */
export const DATA_ROOT = '/data'

/** 工作目录：必须落在卷内，否则容器重建即丢。 */
export const WORKSPACE_DIR = `${DATA_ROOT}/home/workspace`

/** 入口注入的实例标识 header。 */
export const GATE_INSTANCE_HEADER = 'X-Platform-Instance'

/** 入口注入的签名 token header（每实例独立）。 */
export const GATE_TOKEN_HEADER = 'X-Platform-Token'
