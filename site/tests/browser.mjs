import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const origin = process.env.TEST_URL || 'http://127.0.0.1:4321'
const prefix = (process.env.SITE_BASE || '').replace(/\/$/, '')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
await mkdir('test-results', { recursive: true })
try {
  for (const locale of ['zh', 'en']) {
    for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844], ['narrow', 320, 740]]) {
      await page.setViewportSize({ width, height })
      await page.goto(`${origin}${prefix}/${locale === 'en' ? 'en/' : ''}`)
      await page.evaluate(() => document.fonts.ready)
      await page.locator('.hero-actions').evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished))
      })
      assert.equal(await page.locator('html').getAttribute('lang'), locale === 'zh' ? 'zh-CN' : 'en')
      assert.equal(await page.locator('.hero-wordmark').evaluate(element => getComputedStyle(element).color), 'rgb(24, 24, 27)')
      assert.equal(await page.locator('.wordmark-cloud').evaluate(element => getComputedStyle(element).color), 'rgb(113, 113, 122)')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${locale}/${name}: horizontal overflow`)
      assert.equal(await page.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), true)
      await page.screenshot({ path: `test-results/${locale}-${name}.png`, fullPage: true })
      if (name === 'desktop') {
        await page.screenshot({ path: `test-results/${locale}-hero.png` })
        for (const section of ['isolation', 'start']) {
          await page.locator(`#${section}`).scrollIntoViewIfNeeded()
          await page.screenshot({ path: `test-results/${locale}-${section}.png` })
        }
      }
      const question = page.locator('.faq details').first()
      await question.locator('summary').click()
      assert.equal(await question.getAttribute('open'), '')
      assert.equal(await question.locator('p').isVisible(), true)
      await page.locator('[data-copy]').first().click()
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'pnpm install\ncp .env.example apps/server/.env.local')
      if (name !== 'desktop') {
        await page.locator('.mobile-menu summary').click()
        await page.locator('.mobile-menu nav a').first().click()
        assert.equal(await page.locator('.mobile-menu').getAttribute('open'), null)
      }
      await page.locator('.language').click()
      assert.equal(await page.locator('html').getAttribute('lang'), locale === 'zh' ? 'en' : 'zh-CN')
      console.log(`PASS ${locale}/${name}: layout, images, FAQ, clipboard, navigation, locale switch`)
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${origin}${prefix}/`)
  assert.equal(await page.locator('.hero-whale').evaluate(element => getComputedStyle(element).animationName), 'none')
  assert.deepEqual(errors, [])
  console.log('PASS reduced motion and no browser errors')
} finally {
  await browser.close()
}