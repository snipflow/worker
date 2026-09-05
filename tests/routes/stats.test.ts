import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

const authHeaders = {
  Authorization: 'Bearer ' + env.SNIPFLOW_API_TOKEN,
}

beforeEach(async () => {
  await Promise.all([
    env.SNIPFLOW_KV.delete('meta:count'),
    env.SNIPFLOW_KV.delete('meta:totalSize'),
  ])
})

describe('GET /stats', () => {
  it('requires authentication', async () => {
    const response = await exports.default.fetch('http://localhost/stats')
    expect(response.status).toBe(401)
  })

  it('returns the Stats DTO', async () => {
    await Promise.all([
      env.SNIPFLOW_KV.put('meta:count', '2'),
      env.SNIPFLOW_KV.put('meta:totalSize', '42'),
    ])

    const response = await exports.default.fetch('http://localhost/stats', {
      headers: authHeaders,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      count: 2,
      totalSize: 42,
      storageLimit: Number(env.SNIPFLOW_TOTAL_STORAGE_LIMIT),
    })
  })
})
