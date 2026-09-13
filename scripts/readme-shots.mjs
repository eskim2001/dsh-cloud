#!/usr/bin/env node
/**
 * 重新生成 README 里的控制台截图：`node scripts/readme-shots.mjs`。
 *
 * 为什么要有这个脚本：README 的截图是**手抓的**，而 UI 一改它们就过期 —— 过期到一定程度就没人
 * 敢再动 README（这次的「平台管理台」截图还是拆分前的旧页面）。把视口尺寸、主题、语言和
 * 每页高度写死在代码里，重拍就是跑一条命令。
 *
 * 前置：
 *   1. 本地栈起着（`pnpm dev`）；
 *   2. 同目录的 Chrome 带 `--remote-debugging-port=9222`（脚本会在连不上时把命令打出来）。
 *
 * 只用 Node 内置能力（node 22 起自带 WebSocket / fetch），不引依赖 —— 和 `scripts/dev.mjs` 一致。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = process.env.SHOTS_DIR
  ? path.resolve(process.env.SHOTS_DIR)
  : path.join(ROOT, 'docs/screenshots')

const CDP = 'http://127.0.0.1:9222'
const ORIGIN = 'https://console.lvh.me'
const EMAIL = 'admin@lvh.me'
const PASSWORD = 'dsh-cloud-dev'

/**
 * 截图宽度：README 正文区在 GitHub 上约 830px 宽，图片按 100% 缩放过去。
 * 1200 会被缩到 0.69，14px 的字落到 10px 就发糊了；**960 缩放约 0.86**，字号基本原样，
 * 同时侧栏（约 256px）不至于把内容区挤扁。别往 1440 走 —— 那是屏幕全屏的宽度，
 * 放进 README 只会更小更看不清。
 */
const WIDTH = 960
/** 侧栏「品牌 + 两个分组 + 页脚」要这么高才不出现滚动，所以带侧栏的页一律以它为下限。 */
const SIDEBAR_MIN_HEIGHT = 580

/**
 * 每个（语言 × 页面）的抓法。**高度不写死**了：新布局每页高矮差得远，写死一个值不是裁掉内容
 * 就是留一大片白 —— 改成先按 SIDEBAR_MIN_HEIGHT 渲染、量出内容底边、再按它裁剪（见下面 shoot）。
 * 真要固定某页高度时，在条目上写 `height` 覆盖。
 *
 * **没有登录页**：一个邮箱密码表单不是这个平台的卖点，占一格折叠位不如把位置让给工作空间。
 */
const PAGES = [
  { file: 'home', route: '/home' },
  { file: 'workspaces', route: '/workspaces' },
  { file: 'workspace', route: ':workspace' },
  { file: 'admin', route: '/admin' },
  { file: 'admin-instances', route: '/admin/instances' },
  { file: 'admin-users', route: '/admin/users' },
]

const LOCALES = ['zh-CN', 'en']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageTarget() {
  const res = await fetch(`${CDP}/json`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page')
  if (page === undefined) throw new Error('CDP 里没有可用的 page target')
  return page
}

/** 极简 CDP 客户端：够用就好（顺序发命令 + 按 id 收结果）。 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 0

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    const entry = pending.get(msg.id)
    if (entry === undefined) return
    pending.delete(msg.id)
    entry(msg.result)
  })

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('连不上 CDP WebSocket')))
  })

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })

  const evaluate = async (expression) => {
    await ready
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r?.result?.value
  }

  return { ws, ready, send, evaluate }
}

const fail = (msg) => {
  console.error(`\n✖ ${msg}`)
  console.error(
    '  先起本地栈（pnpm dev），再起一个带调试端口的 Chrome：\n' +
      `  nohup '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --remote-debugging-port=9222 \\\n` +
      `    --ignore-certificate-errors --user-data-dir=/tmp/chrome-dsh-cloud --no-first-run \\\n` +
      `    --no-default-browser-check about:blank >/tmp/chrome-dsh.log 2>&1 &`,
  )
  process.exit(1)
}

const target = await pageTarget().catch(() => fail(`连不上 ${CDP}（Chrome 没起？）`))
const cdp = connect(target.webSocketDebuggerUrl)
await cdp.ready
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')

// 站在目标源上写偏好（主题 / 语言），再登录 —— 否则 localStorage 写不进去
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
})
await cdp.send('Page.navigate', { url: `${ORIGIN}/login` })
await sleep(2500)

const signedIn = await cdp.evaluate(
  `fetch('/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:${JSON.stringify(EMAIL)},password:${JSON.stringify(PASSWORD)}})}).then(r=>r.status)`,
)
if (signedIn !== 200) fail(`登录失败（${signedIn}）—— 本地栈起了吗？密码还是 ${PASSWORD} 吗？`)

const workspaces = await cdp.evaluate(
  `fetch('/api/instances').then(r=>r.json()).then(d=>d.instances.map(i=>i.id))`,
)
if (!Array.isArray(workspaces) || workspaces.length === 0) {
  fail('一个工作空间都没有：详情页截图需要至少一个，先建一个再跑')
}

for (const locale of LOCALES) {
  for (const page of PAGES) {
    // 主题 / 语言都从 localStorage 读；每轮都重设，别把上一种语言的偏好带过来
    await cdp.evaluate(
      `localStorage.setItem('dsh-cloud.theme','light');localStorage.setItem('dsh-cloud.locale',${JSON.stringify(locale)});'ok'`,
    )
    // 先按最小高度渲染：视口高度决定 vh 类布局，量内容底边之前得先把高度定下来
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: SIDEBAR_MIN_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    })
    const route = page.route === ':workspace' ? `/workspaces/${workspaces[0]}` : page.route
    await cdp.send('Page.navigate', { url: `${ORIGIN}${route}` })
    await sleep(3000)
    await cdp.evaluate('scrollTo(0,0);"top"')
    await sleep(400)

    // 高度量出来再裁：新布局各页高矮差得远，写死不是裁掉内容就是留一大片白。
    const measured = await cdp.evaluate(
      'Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))',
    )
    const height =
      page.height ??
      Math.max(SIDEBAR_MIN_HEIGHT, Number.isFinite(measured) ? measured : SIDEBAR_MIN_HEIGHT)
    if (height !== SIDEBAR_MIN_HEIGHT) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: WIDTH,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await cdp.evaluate('scrollTo(0,0);"top"')
      await sleep(700)
    }

    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: WIDTH, height, scale: 1 },
      captureBeyondViewport: false,
    })
    const out = path.join(OUT_DIR, locale, `${page.file}.png`)
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, Buffer.from(shot.data, 'base64'))
    console.log(`✓ ${path.relative(ROOT, out)}  ${WIDTH}x${height}`)
  }
}

cdp.ws.close()
console.log('\n完成。改过 UI 就重跑一遍，别让 README 里的截图比代码老。')
