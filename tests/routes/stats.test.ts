import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  STORAGE_STATS_KEY,
  updateStorageStats,
} from '../../src/repositories/r2-stats'

const authHeaders = {
  Authorization: 'Bearer ' + env.SNIPFLOW_API_TOKEN,
}

beforeEach(async () => {
  await env.SNIPFLOW_R2.delete(STORAGE_STATS_KEY)
})

describe('GET /stats', () => {
  it('requires authentication', async () => {
    const response = await exports.default.fetch('http://localhost/stats')
    expect(response.status).toBe(401)
  })

  it('returns the Stats DTO', async () => {
    await updateStorageStats(env.SNIPFLOW_R2, {
      count: 2,
      totalSize: 42,
    })

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
