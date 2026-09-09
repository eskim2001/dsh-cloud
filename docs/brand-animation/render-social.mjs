import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { Resvg } from '@resvg/resvg-js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const source = await readFile(join(root, 'apps/web/public/brand/dshcloud-lockup.svg'), 'utf8')
const document = new DOMParser().parseFromString(source, 'image/svg+xml')
const logo = document.getElementsByTagName('g')[0]
logo.setAttribute('transform', 'translate(285 224) scale(0.52) translate(-260 -251.5)')
const whale = new XMLSerializer().serializeToString(logo)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640">
  <defs>
    <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse">
      <path d="M64 0H0V64" fill="none" stroke="#edf1ef" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="1280" height="640" fill="#ffffff"/>
  <rect x="32" y="24" width="1216" height="592" fill="url(#grid)"/>
  <g font-family="Helvetica Neue, Arial, sans-serif" letter-spacing="0">
    <rect x="650" y="160" width="402" height="144" rx="6" fill="#e2f3ec"/>
    ${whale}
    <text x="426" y="276" font-size="138" font-weight="800"><tspan fill="#18181b">dsh</tspan><tspan fill="#087f71">cloud</tspan></text>
    <text x="640" y="405" text-anchor="middle" font-size="52" font-weight="700" fill="#18181b">Your self-hosted agent cloud.</text>
    <text x="640" y="485" text-anchor="middle" font-size="36" fill="#475852">DeepSeek Harness. Multi-tenant. Persistent.</text>
  </g>
</svg>`
const options = { font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } }
const raster = new Resvg(svg, options).render()
const pixels = raster.pixels
for (let vertical = 0; vertical < 640; vertical++) {
  for (let horizontal = 0; horizontal < 1280; horizontal++) {
    if (horizontal >= 80 && horizontal < 1200 && vertical >= 80 && vertical < 560) continue
    const offset = (vertical * 1280 + horizontal) * 4
    assert.ok(Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 220, 'Important content exceeds the 80px safe area')
  }
}
const png = raster.asPng()
assert.equal(png.readUInt32BE(16), 1280)
assert.equal(png.readUInt32BE(20), 640)
assert.ok(png.length < 1_000_000, 'GitHub preview must remain under 1 MB')
const output = join(root, 'docs/assets')
await mkdir(output, { recursive: true })
await writeFile(join(output, 'dshcloud-social-preview.svg'), svg)
await writeFile(join(output, 'dshcloud-social-preview.png'), png)
await writeFile(join(tmpdir(), 'dshcloud-social-preview-small.png'), new Resvg(svg, { ...options, fitTo: { mode: 'width', value: 640 } }).render().asPng())
console.log(`Created 1280 x 640 PNG (${Math.round(png.length / 1024)} KB) and editable SVG in ${output}`)