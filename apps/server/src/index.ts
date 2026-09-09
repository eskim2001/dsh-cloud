import { buildApp } from './app.js'
import { createAuth } from './auth.js'
import { createDb } from './db/client.js'
import { listAllInstances, updateInstance } from './db/instance-repo.js'
import { deleteMetricsBefore, insertMetric } from './db/metric-repo.js'
import { createDocker, isNotFound } from './docker/client.js'
import { loadEnv } from './env.js'
import { bootInstances } from './instance/boot.js'
import { HostStorage } from './instance/host-storage.js'
import { startMetricsSampler } from './instance/metrics-sampler.js'
import { InstanceOrchestrator } from './instance/orchestrator.js'
import { InstanceProvisioner } from './instance/provisioner.js'
import { reconcileInstances } from './instance/reconciler.js'
import { syncRoutesFromInstances } from './instance/routes-sync.js'
import { networkName } from '@dsh-cloud/instance-spec'

const env = loadEnv()
const { db } = createDb(env.DATABASE_URL)

const auth = createAuth(env, db)
const docker = createDocker()
const orchestrator = new InstanceOrchestrator(
  docker,
  env.TRAEFIK_CONTAINER,
  env.INSTANCE_IMAGE_REPO,
)
const storage = new HostStorage(docker, {
  root: env.HOST_STORAGE_ROOT,
  helperImage: env.STORAGE_HELPER_IMAGE,
})

const routesConfigPath = process.env.TRAEFIK_ROUTES_PATH ?? '/etc/traefik/dynamic/routes.yml'
const forwardAuthAddress =
  process.env.FORWARD_AUTH_ADDRESS ?? `http://127.0.0.1:${env.PORT}/auth/verify`

// 明文档（本地 `web` entryPoint）不挂 tls；https 档必须挂，否则 Traefik 在 443 上
// 收不到这个 router（entryPoint 开了 TLS 不代表 router 自动有）。
const instanceTls: { certResolver?: string } | undefined =
  env.PUBLIC_SCHEME === 'https'
    ? env.TRAEFIK_CERT_RESOLVER === ''
      ? {}
      : { certResolver: env.TRAEFIK_CERT_RESOLVER }
    : undefined

const syncRoutes = async (): Promise<void> => {
  const instances = await listAllInstances(db)
  await syncRoutesFromInstances(instances, {
    configPath: routesConfigPath,
    baseDomain: env.BASE_DOMAIN,
    forwardAuthAddress,
    entryPoint: env.TRAEFIK_ENTRYPOINT,
    ...(instanceTls === undefined ? {} : { tls: instanceTls }),
  })
  // 入口被重建后附着会丢——每次对账都把它接回运行中的实例网络
  await orchestrator.attachIngress(
    instances.filter((t) => t.status === 'running').map((t) => networkName(t.slug)),
  )
}

const provisioner = new InstanceProvisioner(db, orchestrator, storage, env, syncRoutes)

/**
 * 把 DB 状态拉回和 Docker 一致，变了就重新投影一次路由。
 * 对账是**只读 + 状态修正**：不改容器，孤儿容器只告警。
 */
const reconcile = async (): Promise<void> => {
  const { changed } = await reconcileInstances({
    listInstances: () => listAllInstances(db),
    inspectStatus: async (id) => {
      try {
        return await orchestrator.inspectStatus(id)
      } catch (err) {
        if (isNotFound(err)) return undefined
        throw err
      }
    },
    update: (id, patch) => updateInstance(db, id, patch),
    listContainerNames: () => orchestrator.listInstanceContainerNames(),
    warn: (msg) => console.warn(msg),
  })
  if (changed > 0) await syncRoutes()
}

const app = await buildApp({ env, db, auth, provisioner, orchestrator, storage, logger: true })

// 启动顺序（D18）：① 恢复数据文件系统 → ② 拉起 DB 里 running 的实例 → ③ 对账。
// ② 必须在 ③ 之前：on-failure 策略不会在 daemon 重启后自动拉起容器，
// 先对账会把「应该在跑」的实例全抹成 stopped。
await bootInstances({
  listInstances: () => listAllInstances(db),
  ensure: (slug, diskMb) => storage.ensure(slug, diskMb),
  start: (id) => provisioner.start(id).then(() => undefined),
  markError: async (id, message) => {
    await updateInstance(db, id, { status: 'error', lastError: message })
  },
  warn: (msg) => console.warn(msg),
})

// 再对账（DB 记的是意图，Docker 才是事实），最后无条件投影一次路由
await reconcile()
await syncRoutes()

// 外部改动（docker stop / prune / 宿主重启）只能靠定时对账收敛
const reconcileTimer = setInterval(() => {
  void reconcile().catch((err: unknown) => {
    console.warn(`对账失败：${err instanceof Error ? err.message : String(err)}`)
  })
}, 45_000)
// 不 unref 的话进程退不掉、测试也会挂住
reconcileTimer.unref()

// 用量采样：一分钟一轮，顺带清理 30 天前的点
const stopSampler = startMetricsSampler({
  listRunning: async () => (await listAllInstances(db)).filter((r) => r.status === 'running'),
  stats: (containerId) => orchestrator.stats(containerId),
  disk: (slug, quotaMb) => storage.usage(slug, quotaMb),
  insert: (metric) => insertMetric(db, metric),
  deleteBefore: (cutoff) => deleteMetricsBefore(db, cutoff),
  warn: (msg) => console.warn(msg),
})

await app.listen({ host: '127.0.0.1', port: env.PORT })

const shutdown = async (signal: string): Promise<void> => {
  app.log.info(`收到 ${signal}，退出中`)
  clearInterval(reconcileTimer)
  stopSampler()
  await app.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
