import { exports, env } from 'cloudflare:workers'
import { describe, it, expect } from 'vitest'

interface ErrorResponse {
  error: {
    code: string
    message: string
    requestId: string
  }
}

describe('Middleware Layer', () => {
  describe('Health endpoints', () => {
    it('GET /health returns 200 without auth', async () => {
      const res = await exports.default.fetch('http://localhost/health')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    })

    it('GET /health/auth returns 401 without token', async () => {
      const res = await exports.default.fetch('http://localhost/health/auth')
      expect(res.status).toBe(401)
      const json = await res.json() as ErrorResponse
      expect(json.error.code).toBe('UNAUTHORIZED')
    })

    it('GET /health/auth returns 401 with invalid token', async () => {
      const res = await exports.default.fetch('http://localhost/health/auth', {
        headers: { 'Authorization': 'Bearer wrong-token' }
      })
      expect(res.status).toBe(401)
      const json = await res.json() as ErrorResponse
      expect(json.error.code).toBe('UNAUTHORIZED')
    })

    it('GET /health/auth returns 200 with correct token', async () => {
      const res = await exports.default.fetch('http://localhost/health/auth', {
        headers: { 'Authorization': `Bearer ${env.SNIPFLOW_API_TOKEN}` }
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, authed: true })
    })
  })

  describe('Request ID middleware', () => {
    it('includes X-Request-Id header in response', async () => {
      const res = await exports.default.fetch('http://localhost/health')
      expect(res.headers.has('x-request-id')).toBe(true)
      expect(res.headers.get('x-request-id')).toBeTruthy()
    })

    it('includes requestId in error response', async () => {
      const res = await exports.default.fetch('http://localhost/health/auth')
      const json = await res.json() as ErrorResponse
      expect(json.error.requestId).toBeTruthy()
    })
  })

  describe('Method guard', () => {
    it('allows GET', async () => {
      const res = await exports.default.fetch('http://localhost/health')
      expect(res.status).toBe(200)
    })

    it('allows POST with proper headers', async () => {
      const res = await exports.default.fetch('http://localhost/snip', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Authorization': `Bearer ${env.SNIPFLOW_API_TOKEN}`
        },
        body: '{}'
      })
      expect(res.status).not.toBe(405)
    })

    it('allows DELETE with proper headers', async () => {
      const res = await exports.default.fetch('http://localhost/snip/test', {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${env.SNIPFLOW_API_TOKEN}` }
      })
      expect(res.status).not.toBe(405)
    })

    it('rejects PUT with 405', async () => {
      const res = await exports.default.fetch('http://localhost/health', {
        method: 'PUT'
      })
      expect(res.status).toBe(405)
      const json = await res.json() as ErrorResponse
      expect(json.error.code).toBe('METHOD_NOT_ALLOWED')
    })

    it('rejects PATCH with 405', async () => {
      const res = await exports.default.fetch('http://localhost/health', {
        method: 'PATCH'
      })
      expect(res.status).toBe(405)
    })
  })

  describe('Content-Type guard', () => {
    it('rejects POST /snip without content-type', async () => {
      const res = await exports.default.fetch('http://localhost/snip', {
        method: 'POST',
        body: new Uint8Array([1, 2, 3]),
        headers: { 'Authorization': `Bearer ${env.SNIPFLOW_API_TOKEN}` }
      })
      expect(res.status).toBe(415)
      const json = await res.json() as ErrorResponse
      expect(json.error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
    })

    it('accepts POST /snip with any MIME content type', async () => {
      const res = await exports.default.fetch('http://localhost/snip', {
        method: 'POST',
        body: 'plain text',
        headers: {
          'content-type': 'text/plain',
          'x-snip-source': 'page',
          'Authorization': `Bearer ${env.SNIPFLOW_API_TOKEN}`
        }
      })
      expect(res.status).toBe(201)
    })

    it('does not force JSON payloads into a special storage type', async () => {
      const res = await exports.default.fetch('http://localhost/snip', {
        method: 'POST',
        body: JSON.stringify({ test: 'data' }),
        headers: {
          'content-type': 'application/json',
          'x-snip-source': 'page',
          'Authorization': `Bearer ${env.SNIPFLOW_API_TOKEN}`
        }
      })
      expect(res.status).not.toBe(415)
    })

    it('does not check content-type for GET', async () => {
      const res = await exports.default.fetch('http://localhost/health')
      expect(res.status).toBe(200)
    })
  })

  describe('/snip routes require auth', () => {
    it('POST /snip requires auth', async () => {
      const res = await exports.default.fetch('http://localhost/snip', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' }
      })
      expect(res.status).toBe(401)
    })

    it('GET /snip requires auth', async () => {
      const res = await exports.default.fetch('http://localhost/snip')
      expect(res.status).toBe(401)
    })

    it('DELETE /snip/:key requires auth', async () => {
      const res = await exports.default.fetch('http://localhost/snip/test-key', {
        method: 'DELETE'
      })
      expect(res.status).toBe(401)
    })
  })
})
