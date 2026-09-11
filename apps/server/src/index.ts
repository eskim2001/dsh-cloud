import { buildApp } from './app.js'
import { createAuth } from './auth.js'
import { createDb } from './db/client.js'
import { listAllInstances, updateInstance } from './db/instance-repo.js'
import { deleteMetricsBefore, insertMetric } from './db/metric-repo.js'
import { loadEnv } from './env.js'
import { bootInstances } from './instance/boot.js'
import { DataStore } from './instance/data-store.js'
import { machineName } from '@dsh-cloud/instance-spec'
import { startMetricsSampler } from './instance/metrics-sampler.js'
import { InstanceOrchestrator } from './instance/orchestrator.js'
import { InstanceProvisioner } from './instance/provisioner.js'
import { reconcileInstances } from './instance/reconciler.js'
import { syncRoutesFromInstances } from './instance/routes-sync.js'
import { MicrosandboxDriver } from './runtime/microsandbox/driver.js'

const env = loadEnv()
const { db } = createDb(env.DATABASE_URL)

const auth = createAuth(env, db)

// 运行时驱动是**唯一**接触具体运行时的接口（见 runtime/driver.ts）。
const driver = new MicrosandboxDriver()
const orchestrator = new InstanceOrchestrator(driver, env.INSTANCE_IMAGE_REPO)
const dataStore = new DataStore({
  root: env.HOST_STORAGE_ROOT,
  ...(env.HOST_DATA_OWNER === undefined ? {} : { owner: env.HOST_DATA_OWNER }),
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
  // 路由判据是**运行时事实**（见 routableInstances）：读不到就省略，函数会退回 DB 意图
  const containerStates = await orchestrator.listInstanceStates().catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`读实例实时状态失败，路由这次按 DB 意图投影：${detail}`)
    return undefined
  })
  await syncRoutesFromInstances(instances, {
    configPath: routesConfigPath,
    baseDomain: env.BASE_DOMAIN,
    forwardAuthAddress,
    upstreamHost: env.INSTANCE_UPSTREAM_HOST,
    entryPoint: env.TRAEFIK_ENTRYPOINT,
    ...(instanceTls === undefined ? {} : { tls: instanceTls }),
    ...(containerStates === undefined ? {} : { containerStates }),
  })
}

const provisioner = new InstanceProvisioner(db, orchestrator, dataStore, env, syncRoutes)

/**
 * 把 DB 状态拉回和运行时一致，变了就重新投影一次路由。对账是**只读 + 状态修正**：
 * 不改机器，孤儿只告警。
 */
const reconcile = async (): Promise<void> => {
  const { changed } = await reconcileInstances({
    listInstances: () => listAllInstances(db),
    inspectStatus: (name) => orchestrator.inspectStatus(name),
    update: (id, patch) => updateInstance(db, id, patch),
    listInstanceNames: () => orchestrator.listInstanceNames(),
    warn: (msg) => console.warn(msg),
  })
  if (changed > 0) await syncRoutes()
}

/**
 * 周期性的数据落盘与清理。
 *
 * `sync` 是 `:staged` 的**持久化手段**：guest 内的写入要靠它回传宿主，所以两次之间的
 * 写入在异常掉电时会丢——周期越密，能丢的越少。优雅停机也会同步一次（见 provisioner）。
 *
 * 两者都**尽力而为**：失败只告警，不影响对账主流程。
 */
const syncAndHeal = async (): Promise<void> => {
  const running = (await listAllInstances(db)).filter(
    (r) => r.status === 'running' && r.containerId !== null,
  )
  for (const row of running) {
    await orchestrator.sync(machineName(row.slug)).catch((err: unknown) => {
      console.warn(`回传实例 ${row.slug} 的数据失败：${messageOf(err)}`)
    })
  }
  await orchestrator.heal().catch((err: unknown) => {
    console.warn(`清理孤儿失败：${messageOf(err)}`)
  })
}

const app = await buildApp({ env, db, auth, provisioner, orchestrator, dataStore, logger: true })

// 启动顺序：① 校验数据目录 → ② 拉起 DB 里 running 的实例 → ③ 对账 → ④ 投影路由。
// ② 必须在 ③ 之前：运行时不会在宿主重启后自动拉起实例，先对账会把「应该在跑」的全抹成 stopped。
await bootInstances({
  listInstances: () => listAllInstances(db),
  ensure: (storageKey) => dataStore.ensure(storageKey),
  start: (id) => provisioner.start(id).then(() => undefined),
  markError: async (id, message) => {
    await updateInstance(db, id, { status: 'error', lastError: message })
  },
  warn: (msg) => console.warn(msg),
})

await reconcile()
await syncRoutes()

// 外部改动（宿主重启、手动删机器、被 prune）只能靠定时对账收敛
const reconcileTimer = setInterval(() => {
  void syncAndHeal()
    .then(() => reconcile())
    .catch((err: unknown) => {
      console.warn(`对账失败：${messageOf(err)}`)
    })
}, 45_000)
// 不 unref 的话进程退不掉、测试也会挂住
reconcileTimer.unref()

// 用量采样：一分钟一轮，顺带清理 30 天前的点。
// ⚠️ 当前运行时**没有用量采样接口**，`stats` 恒为 undefined → 采样任务会跳过这些轮次，
// 指标表里只有磁盘用量。这是有意降级，不是坏了（见 runtime/driver.ts 的 stats）。
const stopSampler = startMetricsSampler({
  listRunning: async () => (await listAllInstances(db)).filter((r) => r.status === 'running'),
  stats: (machineNameOrId) => orchestrator.stats(machineNameOrId),
  disk: (storageKey) => dataStore.usage(storageKey),
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
