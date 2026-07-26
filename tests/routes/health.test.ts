import { exports } from 'cloudflare:workers'
import { describe, it, expect } from 'vitest'

describe('GET /health', () => {
  it('returns 200 with { ok: true }', async () => {
    const res = await exports.default.fetch('http://localhost/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

// 方法过滤（405）在阶段二中间件层加入后测试
