import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const base = (process.env.SITE_BASE || (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY && !process.env.GITHUB_REPOSITORY.split('/')[1].endsWith('.github.io') ? `/${process.env.GITHUB_REPOSITORY.split('/')[1]}` : '')).replace(/\/$/, '')

test('one route template emits the two locale pages', () => {
  const zh = read('dist/index.html')
  const en = read('dist/en/index.html')
  assert.match(zh, /lang="zh-CN"/)
  assert.match(en, /lang="en"/)
  assert.ok(zh.includes(`href="${base}/en/"`))
  assert.ok(en.includes(`href="${base}/"`))
  assert.match(zh, /自己的云/)
  assert.match(en, /Your infrastructure/)
  assert.deepEqual(readdirSync(new URL('src/pages/', root)).sort(), ['404.astro', '[...locale].astro'])
})

test('both locales expose the project repository without extra configuration', () => {
  for (const file of ['dist/index.html', 'dist/en/index.html']) {
    const html = read(file)
    assert.ok(html.includes('href="https://github.com/eskim2001/dsh-cloud"'))
    assert.match(html, /class="source-link"/)
    assert.match(html, /GitHub/)
  }
})

test('display branding is dshcloud while technical identifiers stay unchanged', () => {
  for (const file of ['dist/index.html', 'dist/en/index.html']) {
    const html = read(file)
    assert.match(html, /<title>dshcloud · /)
    assert.match(html, /<h1[^>]*>dsh<span[^>]*class="wordmark-cloud"[^>]*>cloud<\/span><span aria-hidden="true"/)
    assert.ok(html.includes('https://github.com/eskim2001/dsh-cloud'))
    // 技术标识符不跟着品牌改名：scope 得还是 `@dsh-cloud/`，不能是 `@dshcloud/`
    assert.doesNotMatch(html, /@dshcloud\//)
    const prose = html.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/g, '').replace(/<[^>]+>/g, '')
    assert.doesNotMatch(prose, /dsh-cloud/)
  }
})

test('generated page assets and section anchors resolve', () => {
  for (const file of ['index.html', 'en/index.html', '404.html']) {
    const html = read(`dist/${file}`)
    assert.equal([...html.matchAll(/<h1[\s>]/g)].length, 1)
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const target = match[1]
      if (target.startsWith('#')) {
        assert.ok(html.includes(`id="${target.slice(1)}"`), `${file}: ${target}`)
      } else if (target.startsWith('/')) {
        assert.ok(target.startsWith(`${base}/`), `Missing base: ${target}`)
        const relative = decodeURI(target.slice(base.length + 1).split('#')[0])
        const local = relative.endsWith('/') || relative === '' ? `${relative}index.html` : relative
        assert.ok(existsSync(new URL(`dist/${local}`, root)), `${file}: ${target}`)
      }
    }
    assert.doesNotMatch(html, /(?:src|href)="[^"]*\/docs\//)
  }
})

test('website source does not import or link repository documentation', () => {
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) scan(path)
      else assert.doesNotMatch(readFileSync(path, 'utf8'), /(?:\.\.\/)+docs\/|["']\/docs\//)
    }
  }
  scan(fileURLToPath(new URL('src/', root)))
})

test('dictionary has matched locale command blocks', () => {
  const source = read('src/i18n.ts')
  const [zh, en] = source.split('const en: Dictionary = ')
  const codes = text => [...text.matchAll(/code: '([^']*)'/g)].map(match => match[1])
  assert.deepEqual(codes(zh), codes(en))
  assert.match(read('dist/404.html'), /404/)
})