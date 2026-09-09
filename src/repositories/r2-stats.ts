import { z } from 'zod'
import { InternalError } from '../domain/errors'
import type { StorageStats, StorageStatsDelta } from '../domain/types'

export const STORAGE_STATS_KEY = 'meta/stats.json'

const MAX_CAS_ATTEMPTS = 16
const StorageStatsSchema = z.strictObject({
  count: z.number().int().nonnegative(),
  totalSize: z.number().int().nonnegative(),
}) satisfies z.ZodType<StorageStats>

const StorageStatsDeltaSchema = z.strictObject({
  count: z.number().int(),
  totalSize: z.number().int(),
}) satisfies z.ZodType<StorageStatsDelta>

const EMPTY_STORAGE_STATS: StorageStats = {
  count: 0,
  totalSize: 0,
}

async function parseStorageStats(object: R2ObjectBody): Promise<StorageStats> {
  let value: unknown

  try {
    value = await object.json<unknown>()
  } catch {
    throw new InternalError('Invalid R2 storage stats JSON')
  }

  const parsed = StorageStatsSchema.safeParse(value)
  if (!parsed.success) {
    throw new InternalError('Invalid R2 storage stats value')
  }
  return parsed.data
}

function nextStorageStats(
  current: StorageStats,
  delta: StorageStatsDelta
): StorageStats {
  const next = {
    count: current.count + delta.count,
    totalSize: current.totalSize + delta.totalSize,
  }
  const parsed = StorageStatsSchema.safeParse(next)
  if (!parsed.success) {
    throw new InternalError('R2 storage stats update would produce an invalid value')
  }
  return parsed.data
}

export async function getStorageStats(r2: R2Bucket): Promise<StorageStats> {
  const object = await r2.get(STORAGE_STATS_KEY)
  return object ? await parseStorageStats(object) : { ...EMPTY_STORAGE_STATS }
}

/**
 * 通过 R2 强一致读取与 ETag 条件写入实现 CAS。
 * count 和 totalSize 保存在同一对象中，因此二者在一次更新内共同提交。
 */
export async function updateStorageStats(
  r2: R2Bucket,
  delta: StorageStatsDelta
): Promise<StorageStats> {
  const parsedDelta = StorageStatsDeltaSchema.safeParse(delta)
  if (!parsedDelta.success) {
    throw new InternalError('Invalid R2 storage stats delta')
  }

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const currentObject = await r2.get(STORAGE_STATS_KEY)
    const current = currentObject
      ? await parseStorageStats(currentObject)
      : EMPTY_STORAGE_STATS
    const next = nextStorageStats(current, parsedDelta.data)
    const stored = await r2.put(
      STORAGE_STATS_KEY,
      JSON.stringify(next),
      {
        onlyIf: currentObject
          ? { etagMatches: currentObject.etag }
          : { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json' },
      }
    )

    if (stored) return next
  }

  throw new InternalError('R2 storage stats update exceeded the CAS retry limit')
}
