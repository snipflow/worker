import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const ALLOWED_ORIGIN = 'http://localhost:10010'
const DISALLOWED_ORIGIN = 'https://blocked.example.com'

function preflight(path: string, requestedHeaders = 'authorization') {
  return exports.default.fetch(`http://localhost${path}`, {
    method: 'OPTIONS',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': requestedHeaders,
    },
  })
}

describe('CORS middleware', () => {
  it('handles preflight before the method guard', async () => {
    const res = await preflight('/health/auth', 'authorization,content-type')

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    expect(res.headers.get('access-control-allow-methods')).toContain('GET')
    expect(res.headers.get('access-control-allow-methods')).toContain('OPTIONS')
    expect(res.headers.get('access-control-allow-headers')).toContain(
      'authorization',
    )
    expect(res.headers.get('access-control-max-age')).toBe('600')
  })

  it('allows the frontend to read exposed headers on actual responses', async () => {
    const res = await exports.default.fetch('http://localhost/health', {
      headers: { Origin: ALLOWED_ORIGIN },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    expect(res.headers.get('access-control-expose-headers')).toContain(
      'X-Request-Id',
    )
    expect(res.headers.get('access-control-expose-headers')).toContain(
      'X-Snip-Created-At',
    )
    expect(res.headers.get('access-control-expose-headers')).toContain(
      'X-Snip-Filename',
    )
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  it('adds CORS headers to authentication errors', async () => {
    const res = await exports.default.fetch('http://localhost/health/auth', {
      headers: { Origin: ALLOWED_ORIGIN },
    })

    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
  })

  it('does not authorize an unconfigured origin', async () => {
    const res = await exports.default.fetch('http://localhost/health', {
      method: 'OPTIONS',
      headers: {
        Origin: DISALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.has('access-control-allow-origin')).toBe(false)
  })

  it('filters headers that are not part of the API contract', async () => {
    const res = await preflight(
      '/health',
      'authorization,x-snip-meta-category,x-not-allowed',
    )
    const allowedHeaders = res.headers.get('access-control-allow-headers') ?? ''

    expect(allowedHeaders).toContain('authorization')
    expect(allowedHeaders).toContain('x-snip-meta-category')
    expect(allowedHeaders).not.toContain('x-not-allowed')
  })
})
