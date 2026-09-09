import { describe, expect, it, vi } from 'vitest'
import { buildApp, type AppDeps } from './app.js'

function dependencies(): AppDeps {
  return {
    env: {
      BASE_DOMAIN: 'app.example.com',
      PUBLIC_SCHEME: 'https',
      PLATFORM_SECRET: 'test-platform-secret',
      EXTRA_TRUSTED_ORIGINS: '',
    },
    auth: {
      handler: vi.fn(async () => new Response('{}')),
      api: {
        getSession: vi.fn(async () => ({
          user: { id: 'owner', role: 'admin' },
          session: { impersonatedBy: 'operator' },
        })),
      },
    },
    db: {},
    provisioner: {},
    orchestrator: {},
    storage: {},
  } as unknown as AppDeps
}

describe('platform account boundaries', () => {
  it.each([undefined, 'null', 'https://alice.app.example.com', 'https://evil.example']) (
    'rejects write requests from origin %s before authentication',
    async (origin) => {
      const deps = dependencies()
      const app = await buildApp(deps)
      try {
        for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
          const response = await app.inject({
            method,
            url: '/api/instances/owned/stop',
            headers: origin === undefined ? {} : { origin, 'sec-fetch-site': 'same-site' },
          })
          expect(response.statusCode).toBe(403)
        }
        expect(deps.auth.api.getSession).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    },
  )

  it.each(['https://app.example.com', 'http://localhost:5173'])(
    'allows configured console origin %s',
    async (origin) => {
      const deps = dependencies()
      deps.env.EXTRA_TRUSTED_ORIGINS = 'http://localhost:5173'
      const app = await buildApp(deps)
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers: { origin },
          payload: {},
        })
        expect(response.statusCode).toBe(200)
        expect(deps.auth.handler).toHaveBeenCalledOnce()
      } finally {
        await app.close()
      }
    },
  )

  it.each(['impersonate-user', 'set-user-password', 'update-user', 'set-role', 'list-users'])(
    'does not expose the native admin endpoint %s',
    async (endpoint) => {
      const deps = dependencies()
      const app = await buildApp(deps)
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/api/auth/admin/${endpoint}`,
          headers: { origin: 'https://app.example.com' },
          payload: {},
        })
        expect(response.statusCode).toBe(403)
        expect(deps.auth.handler).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    },
  )

  it('rejects an existing impersonation session on platform APIs', async () => {
    const app = await buildApp(dependencies())
    try {
      const response = await app.inject({ method: 'GET', url: '/api/instances' })
      expect(response.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })
})