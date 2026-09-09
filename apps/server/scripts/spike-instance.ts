/**
 * M1 端到端 spike：验证"实例容器"这一层能跑通。
 *
 *   1. instance-spec 渲染 + dockerode 起实例容器（**不发布任何宿主端口**）
 *   2. header 门：无门 header → 403；带门 header → 过桥（dsh 自己还要入口 token，故 401）
 *   3. 入口 token 注入：GET /__open → 桥补 token → dsh 发 cookie → 带 cookie 出页面（D14）
 *   4. 持久化：写文件 → 重建容器 → 文件还在
 *   5. 门①：从实例 A 的容器里够不到实例 B（网络名和容器 IP 两条路都试）
 *
 * 探测**从容器内部**发起：实例不发布宿主端口，宿主机上没有可 curl 的地址（D3）。
 *
 * 用法：
 *   ./docker/instance-image/build.sh
 *   pnpm --filter @dsh-cloud/server spike
 */
import type Docker from 'dockerode'
import { InstanceSpecSchema, networkName } from '@dsh-cloud/instance-spec'
import { createDocker } from '../src/docker/client.js'
import { HostStorage } from '../src/instance/host-storage.js'
import { imageRepo } from '../src/instance/image-catalog.js'
import { InstanceOrchestrator } from '../src/instance/orchestrator.js'

const SLUG = 'spike'
const SLUG_B = 'spike-b'
const IMAGE = process.env.SPIKE_IMAGE ?? 'ghcr.io/eskim2001/dsh-instance:0.1.2-rc.1_2'
const TOKEN = 'spike-gate-token'
const TOKEN_B = 'spike-b-gate-token'
const BASE_DOMAIN = 'app.example.com'
const MARKER = '/data/home/workspace/spike-marker.txt'
const BRIDGE = 'http://127.0.0.1:8080'

const spec = InstanceSpecSchema.parse({
  slug: SLUG,
  image: IMAGE,
  quota: { cpus: 1, memoryMb: 1024, pidsLimit: 256, diskMb: 1024 },
})
const specB = InstanceSpecSchema.parse({
  slug: SLUG_B,
  image: IMAGE,
  quota: { cpus: 1, memoryMb: 512, pidsLimit: 128, diskMb: 512 },
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/** 容器里跑一段 ESM——用 node 自带的 fetch，不赌镜像里有没有 curl。 */
function nodeEsm(body: string): string[] {
  return ['node', '--input-type=module', '-e', body]
}

const PING = `
try {
  const r = await fetch(${JSON.stringify(`${BRIDGE}/`)}, { redirect: 'manual' })
  console.log('up:' + r.status)
} catch {
  console.log('down')
}
`

const GATE_PROBE = `
const B = ${JSON.stringify(BRIDGE)}
const H = { 'X-Platform-Token': ${JSON.stringify(TOKEN)} }
const snap = (r) => ({ status: r.status, cookie: r.headers.get('set-cookie') })
const out = {}
try {
  out.noGate = snap(await fetch(B + '/', { redirect: 'manual' }))
  out.withGate = snap(await fetch(B + '/', { redirect: 'manual', headers: H }))
  const open = await fetch(B + '/__open', { redirect: 'manual', headers: H })
  out.open = snap(open)
  const cookie = (open.headers.get('set-cookie') ?? '').split(';')[0]
  out.authed = snap(await fetch(B + '/', { redirect: 'manual', headers: { ...H, cookie } }))
} catch (err) {
  out.error = String(err)
}
console.log(JSON.stringify(out))
`

function crossProbe(byName: string, byIp: string): string {
  return `
const out = {}
for (const t of [${JSON.stringify(byName)}, ${JSON.stringify(byIp)}]) {
  try {
    const r = await fetch(t, { signal: AbortSignal.timeout(3000) })
    out[t] = 'REACHED HTTP ' + r.status
  } catch (err) {
    out[t] = 'BLOCKED ' + (err.cause?.code ?? err.name ?? 'error')
  }
}
console.log(JSON.stringify(out))
`
}

interface Snapshot {
  status: number
  cookie: string | null
}

function lastJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw.trim().split('\n').pop() ?? '') as Record<string, unknown>
  } catch {
    return { parseError: raw.slice(0, 200) }
  }
}

function detail(v: unknown): string {
  return v === undefined ? '(缺失)' : JSON.stringify(v)
}

async function waitForBridge(
  orch: InstanceOrchestrator,
  containerId: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const out = (await orch.exec(containerId, nodeEsm(PING))).trim()
    if (out.startsWith('up:')) return out.slice(3)
    await sleep(1000)
  }
  return undefined
}

async function containerIp(docker: Docker, id: string, network: string): Promise<string> {
  const info = await docker.getContainer(id).inspect()
  return info.NetworkSettings.Networks[network]?.IPAddress ?? ''
}

async function main(): Promise<void> {
  console.log(`镜像: ${IMAGE}\n`)

  const docker = createDocker()
  const ingressName = process.env.TRAEFIK_CONTAINER ?? 'dsh-ingress'
  const orch = new InstanceOrchestrator(docker, ingressName, imageRepo(IMAGE))
  const storage = new HostStorage(docker, {
    root: process.env.HOST_STORAGE_ROOT ?? '/var/lib/dsh',
    helperImage: process.env.STORAGE_HELPER_IMAGE ?? 'alpine:3.20',
  })

  const ctx = {
    baseImage: IMAGE,
    baseDomain: BASE_DOMAIN,
    gateToken: TOKEN,
    dataDir: storage.mountPoint(SLUG),
  }
  const ctxB = {
    baseImage: IMAGE,
    baseDomain: BASE_DOMAIN,
    gateToken: TOKEN_B,
    dataDir: storage.mountPoint(SLUG_B),
  }

  await orch.removeInstance(spec)
  await orch.removeInstance(specB)

  let instance
  let instanceB
  try {
    // 平台侧顺序：先把数据文件系统备好，再起容器（容器挂不上就白起）。
    await storage.create(SLUG, spec.quota.diskMb)
    await storage.create(SLUG_B, specB.quota.diskMb)
    instance = await orch.createInstance(spec, ctx)
    instanceB = await orch.createInstance(specB, ctxB)
  } catch (err) {
    console.error(`\n创建容器失败：${(err as Error).message}`)
    console.error(
      `镜像 ${IMAGE} 存在吗？先跑：docker build -f docker/instance-image/Dockerfile -t ${IMAGE} docker/instance-image/`,
    )
    process.exit(1)
  }
  check('实例容器已启动', instance.status === 'running', instance.containerId.slice(0, 12))
  check('对照实例已启动', instanceB.status === 'running', instanceB.containerId.slice(0, 12))

  const inspect = await docker.getContainer(instance.containerId).inspect()
  const bindings = inspect.HostConfig.PortBindings ?? {}
  check(
    '不发布任何宿主端口（门① 的前提）',
    Object.keys(bindings).length === 0,
    JSON.stringify(bindings),
  )

  const status = await waitForBridge(orch, instance.containerId, 120_000)
  check('容器内桥已监听', status !== undefined, status === undefined ? '超时' : `HTTP ${status}`)
  if (status === undefined) {
    console.error(`\n容器没起来，看日志：docker logs dsh-instance-${SLUG}`)
    process.exit(1)
  }

  // —— 门③：header 门 ——
  const probe = lastJson(await orch.exec(instance.containerId, nodeEsm(GATE_PROBE)))
  if (probe.error !== undefined || probe.parseError !== undefined) {
    check('桥探测可执行', false, detail(probe.error ?? probe.parseError))
  } else {
    const noGate = probe.noGate as Snapshot
    const withGate = probe.withGate as Snapshot
    const open = probe.open as Snapshot
    const authed = probe.authed as Snapshot

    check('无门 header 直连 → 403', noGate.status === 403, detail(noGate))
    check(
      '带门 header → 过了桥（dsh 自己还要入口 token，故 401）',
      withGate.status === 401,
      detail(withGate),
    )
    check(
      'GET /__open → 桥补 token，dsh 发 cookie',
      open.cookie !== null && (open.status === 302 || open.status === 303),
      detail(open),
    )
    check('带 cookie → dsh 出页面', authed.status === 200, detail(authed))
  }

  // —— 门①：跨实例 ——
  const ipB = await containerIp(docker, instanceB.containerId, networkName(SLUG_B))
  const cross = lastJson(
    await orch.exec(
      instance.containerId,
      nodeEsm(crossProbe(`http://dsh-instance-${SLUG_B}:8080/`, `http://${ipB}:8080/`)),
    ),
  )
  const values = Object.values(cross).filter((v): v is string => typeof v === 'string')
  check(
    '实例 A 够不到实例 B（容器名 + IP 两条路）',
    values.length === 2 && values.every((v) => v.startsWith('BLOCKED')),
    JSON.stringify(cross),
  )

  // —— 持久化 ——
  const content = `spike-${Date.now()}`
  await orch.exec(instance.containerId, ['sh', '-c', `printf '%s' '${content}' > ${MARKER}`])

  const recreated = await orch.createInstance(spec, ctx)
  check(
    '容器已重建',
    recreated.containerId !== instance.containerId,
    recreated.containerId.slice(0, 12),
  )

  const readBack = (await orch.exec(recreated.containerId, ['cat', MARKER])).trim()
  check('重建后 /data 内容还在', readBack === content, readBack || '(空)')

  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
  console.log('容器仍在运行。手工检查（实例没有宿主端口，只能从容器里探）：')
  console.log(
    `  docker exec dsh-instance-${SLUG} node --input-type=module -e "const r=await fetch('${BRIDGE}/');console.log(r.status)"`,
  )
  console.log('  # 期望 403；带门 header 才会过桥')
  console.log('清理（入口接在这些网络里，要先摘掉才删得动网络；数据是宿主上的 loop 文件系统）：')
  console.log(
    `  docker rm -f dsh-instance-${SLUG} dsh-instance-${SLUG_B}` +
      ` && docker network disconnect -f dsh-net-${SLUG} ${ingressName}` +
      ` && docker network disconnect -f dsh-net-${SLUG_B} ${ingressName}` +
      ` && docker network rm dsh-net-${SLUG} dsh-net-${SLUG_B}`,
  )
  console.log(
    `  # 数据：umount /var/lib/dsh/${SLUG} /var/lib/dsh/${SLUG_B}` +
      ` && rm -f /var/lib/dsh/${SLUG}.img /var/lib/dsh/${SLUG_B}.img` +
      ` （宿主上执行，或用平台的特权助手容器）`,
  )

  process.exit(failed === 0 ? 0 : 1)
}

await main()
