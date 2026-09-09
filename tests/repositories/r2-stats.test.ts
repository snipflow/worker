import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { InternalError } from '../../src/domain/errors'
import {
  STORAGE_STATS_KEY,
  getStorageStats,
  updateStorageStats,
} from '../../src/repositories/r2-stats'

describe('R2 storage stats repository', () => {
  beforeEach(async () => {
    await env.SNIPFLOW_R2.delete(STORAGE_STATS_KEY)
  })

  it('returns zero values when the stats object does not exist', async () => {
    await expect(getStorageStats(env.SNIPFLOW_R2)).resolves.toEqual({
      count: 0,
      totalSize: 0,
    })
  })

  it('creates and updates both counters in one R2 object', async () => {
    await expect(updateStorageStats(env.SNIPFLOW_R2, {
      count: 1,
      totalSize: 6,
    })).resolves.toEqual({
      count: 1,
      totalSize: 6,
    })

    await expect(updateStorageStats(env.SNIPFLOW_R2, {
      count: 0,
      totalSize: 4,
    })).resolves.toEqual({
      count: 1,
      totalSize: 10,
    })

    const object = await env.SNIPFLOW_R2.get(STORAGE_STATS_KEY)
    expect(object?.httpMetadata?.contentType).toBe('application/json')
    expect(await object?.json()).toEqual({
      count: 1,
      totalSize: 10,
    })
  })

  it('retries conditional-write conflicts without losing concurrent increments', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_value, index) =>
        updateStorageStats(env.SNIPFLOW_R2, {
          count: 1,
          totalSize: index + 1,
        })
      )
    )

    await expect(getStorageStats(env.SNIPFLOW_R2)).resolves.toEqual({
      count: 8,
      totalSize: 36,
    })
  })

  it('rejects decrements that would make either counter negative', async () => {
    await updateStorageStats(env.SNIPFLOW_R2, {
      count: 1,
      totalSize: 5,
    })

    await expect(updateStorageStats(env.SNIPFLOW_R2, {
      count: -2,
      totalSize: -6,
    })).rejects.toBeInstanceOf(InternalError)
    await expect(getStorageStats(env.SNIPFLOW_R2)).resolves.toEqual({
      count: 1,
      totalSize: 5,
    })
  })

  it('rejects invalid deltas and corrupted persisted values', async () => {
    await expect(updateStorageStats(env.SNIPFLOW_R2, {
      count: 0.5,
      totalSize: 1,
    })).rejects.toBeInstanceOf(InternalError)

    await env.SNIPFLOW_R2.put(
      STORAGE_STATS_KEY,
      JSON.stringify({ count: 'invalid', totalSize: 1 })
    )

    await expect(getStorageStats(env.SNIPFLOW_R2))
      .rejects.toBeInstanceOf(InternalError)
    await expect(updateStorageStats(env.SNIPFLOW_R2, {
      count: 1,
      totalSize: 1,
    })).rejects.toBeInstanceOf(InternalError)
  })

  it('rejects malformed stats JSON', async () => {
    await env.SNIPFLOW_R2.put(STORAGE_STATS_KEY, '{')

    await expect(getStorageStats(env.SNIPFLOW_R2))
      .rejects.toBeInstanceOf(InternalError)
  })
})
