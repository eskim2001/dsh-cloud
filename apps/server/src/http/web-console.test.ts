import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerWebConsole } from './web-console.js'

/**
 * 平台镜像里控制面**自己**提供管理台（本地开发走 Vite，这条路径根本不注册）。
 *
 * 盯三件事：静态资源真发得出去、深链接回落到 index.html、**接口的 404 不能被
 * 换成一张 HTML**（那会让调用方报「解析 JSON 失败」而不是「404」）。
 */
describe('管理台静态托管', () => {
  let root: string
  let app: FastifyInstance

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-web-console-'))
    await writeFile(join(root, 'index.html'), '<!doctype html><title>console</title>')
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'assets', 'app-abc123.js'), 'console.log(1)')

    app = Fastify()
    // 具体路由先注册，模拟 buildApp 里的顺序
    app.get('/healthz', async () => ({ ok: true }))
    app.get('/api/auth/session', async () => ({ user: null }))
    await registerWebConsole(app, root)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })

  it('根路径发 index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<title>console</title>')
  })

  it('带 hash 的静态资源按真实文件发', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('console.log(1)')
  })

  it('深链接回落到 index.html（BrowserRouter 刷新）', async () => {
    const res = await app.inject({ method: 'GET', url: '/instances/abc/stats' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<title>console</title>')
  })

  it('接口的 404 保持 JSON', async () => {
    for (const url of ['/api/nope', '/auth/nope', '/.well-known/acme-challenge/x']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(404)
      expect(res.json(), url).toEqual({ error: 'Not found' })
    }
  })

  it('已注册的具体路由仍然赢过通配', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ ok: true })
    expect((await app.inject({ method: 'GET', url: '/api/auth/session' })).json()).toEqual({
      user: null,
    })
  })

  it('写操作的 404 不发 HTML', async () => {
    const res = await app.inject({ method: 'POST', url: '/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Not found' })
  })

  it('目录不存在时直接报错，不静默地什么都不 serve', async () => {
    await expect(registerWebConsole(Fastify(), join(root, 'nope'))).rejects.toThrow(/WEB_DIST_DIR/)
  })
})
