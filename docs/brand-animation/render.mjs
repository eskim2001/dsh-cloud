import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { Resvg } from '@resvg/resvg-js'

if (typeof globalThis.gc !== 'function') {
  const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url)], { stdio: 'inherit' })
  process.exit(child.status ?? 1)
}

const root = fileURLToPath(new URL('../../', import.meta.url))
const brand = join(root, 'apps/web/public/brand')
const output = join(root, 'docs/assets')
const width = 1328
const height = 480
const fps = 20
const duration = 8
const poses = [
  [0, 0, 0, 0],
  [1.0, 0, 0, 0],
  [2.1, 12, 228, -16],
  [2.7, 0, 240, -6],
  [3.85, -12, -110, 19],
  [4.7, -3, -50, 8],
  [5.8, 0, 0, 0],
  [8, 0, 0, 0],
]
const smooth = value => value * value * (3 - 2 * value)
const serializer = new XMLSerializer()
const serialize = node => serializer.serializeToString(node)

function pose(time) {
  const next = poses.findIndex(frame => frame[0] > time)
  if (next < 0) return poses.at(-1).slice(1)
  const previous = poses[next - 1]
  const following = poses[next]
  const mix = smooth((time - previous[0]) / (following[0] - previous[0]))
  return previous.slice(1).map((value, index) => value + (following[index + 1] - value) * mix)
}

function scene(source, time, dark) {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml')
  const logo = document.getElementsByTagName('g')[0]
  const paths = logo.getElementsByTagName('path')
  assert.equal(paths.length, 2, 'Expected separate original whale and cloud paths')
  const whale = serialize(paths[0])
  const cloud = serialize(paths[1])
  const text = serialize(document.getElementsByTagName('text')[0])
  const [horizontal, vertical, rotation] = pose(time)
  const activity = time > 1 && time < 6
    ? Math.sin(Math.PI * (time - 1) / 5) ** 2 : 0
  const wave = Math.sin((time - 1) * Math.PI * 1.3) * activity
  const ink = dark ? '#fafafa' : '#18181b'
  const mist = dark ? '#74747e' : '#b8b8c1'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 830 300">
    <defs><clipPath id="surface"><path d="M-100 -200H650V349C470 342 415 356 355 363C262 398 177 382 120 337C65 322 10 340-100 355Z"/></clipPath></defs>
    <g transform="${logo.getAttribute('transform')}">
      <g fill="${mist}" transform="translate(${-36 + wave * 13} ${-14 - activity * 16}) translate(260 380) scale(${1.19 * activity} ${0.88 * activity}) translate(-260 -380)">${cloud}</g>
      <g clip-path="url(#surface)" fill="${ink}">
        <g transform="translate(${horizontal} ${vertical}) rotate(${rotation} 260 251.5)">${whale}</g>
      </g>
      <g fill="${ink}" transform="translate(260 380) scale(${1 + activity * 0.075} ${1 + wave * 0.045}) translate(-260 -380)">${cloud}</g>
      <g fill="${mist}" transform="translate(${wave * -16} 20) translate(260 380) scale(${0.92 * activity} ${0.42 * activity}) translate(-260 -380)">${cloud}</g>
    </g>
    ${text}
  </svg>`
}

function render(svg) {
  return new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
  }).render()
}

function execute(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`)
  return result.stdout
}

await mkdir(output, { recursive: true })
const temporary = await mkdtemp(join(tmpdir(), 'dsh-brand-animation-'))
try {
  for (const dark of [false, true]) {
    const suffix = dark ? '-dark' : ''
    const source = await readFile(join(brand, `dshcloud-lockup${suffix}.svg`), 'utf8')
    const frames = join(temporary, dark ? 'dark' : 'light')
    await mkdir(frames)
    const first = Buffer.from(render(scene(source, 0, dark)).pixels)
    assert.deepEqual(first, Buffer.from(render(scene(source, duration, dark)).pixels), 'Loop endpoints must match')
    let movingFrames = 0
    for (let frame = 0; frame < duration * fps; frame++) {
      const raster = render(scene(source, frame / fps, dark))
      const pixels = Buffer.from(raster.pixels)
      if (!pixels.equals(first)) movingFrames++
      for (let row = 0; row < height; row++) {
        const start = (row * width + 460) * 4
        const end = (row + 1) * width * 4
        assert.ok(pixels.subarray(start, end).equals(first.subarray(start, end)), 'Wordmark moved')
      }
      await writeFile(join(frames, `${String(frame).padStart(3, '0')}.png`), raster.asPng())
      if (frame % 8 === 0) globalThis.gc()
    }
    assert.ok(movingFrames > fps * 4, 'Whale must move during the cycle')
    const animation = join(output, `dshcloud-swim${suffix}.png`)
    execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps), '-i', join(frames, '%03d.png'),
      '-pix_fmt', 'rgba', '-plays', '0', '-f', 'apng', animation])
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', animation,
      '-vf', 'select=eq(n\\,0)+eq(n\\,77)+eq(n\\,159)', '-fps_mode', 'passthrough',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 })
    assert.equal(decoded.status, 0, decoded.stderr?.toString())
    const frameSize = width * height * 4
    assert.equal(decoded.stdout.length, frameSize * 3)
    for (const [index, frame] of [0, 77, 159].entries()) {
      const actual = decoded.stdout.subarray(index * frameSize, (index + 1) * frameSize)
      const reference = spawnSync('ffmpeg', ['-v', 'error', '-i', join(frames, `${String(frame).padStart(3, '0')}.png`),
        '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: frameSize + 1024 })
      assert.equal(reference.status, 0, reference.stderr?.toString())
      assert.ok(actual.equals(reference.stdout), 'Encoded animation must preserve antialiased pixels exactly')
    }
    const alphaLevels = new Set()
    let edgePixels = 0
    for (let offset = 3; offset < frameSize; offset += 4) {
      const alpha = decoded.stdout[offset]
      alphaLevels.add(alpha)
      if (alpha > 0 && alpha < 255) edgePixels++
    }
    assert.ok(alphaLevels.size >= 16 && edgePixels > 1000, 'Antialiased transparency must survive encoding')
    assert.ok(decoded.stdout.subarray(0, frameSize).equals(decoded.stdout.subarray(frameSize * 2)), 'Decoded loop endpoints must match')
    const cells = [0, 1.7, 2.5, 3.2, 3.85, 4.7, 5.8, 8]
      .map((time, index) => `<g transform="translate(${(index % 2) * 830} ${Math.floor(index / 2) * 330})">${scene(source, time, dark).replace(`width="${width}" height="${height}"`, 'width="664" height="240"')}<text x="28" y="290" fill="${dark ? '#a1a1aa' : '#71717a'}" font-family="Arial" font-size="18">${time.toFixed(2)}s</text></g>`).join('')
    const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="1660" height="1320"><rect width="1660" height="1320" fill="${dark ? '#0d1117' : '#ffffff'}"/>${cells}</svg>`
    await writeFile(join(temporary, `contact-sheet${suffix}.png`), render(sheet).asPng())
    await rm(frames, { recursive: true, force: true })
    console.log(`${suffix || 'light'}: ${duration * fps} frames, ${movingFrames} moving; seamless loop, stationary wordmark and lossless antialiasing verified (${alphaLevels.size} alpha levels)`)
  }
  console.log(`Contact sheets: ${temporary}`)
} catch (error) {
  await rm(temporary, { recursive: true, force: true })
  throw error
}