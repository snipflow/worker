import { InternalError } from '../domain/errors'
import type { Stats } from '../domain/types'
import { getStorageStats } from '../repositories/r2-stats'
import { z } from 'zod'

interface StatsBindings {
  SNIPFLOW_R2: R2Bucket
  SNIPFLOW_TOTAL_STORAGE_LIMIT: string
}

const NonNegativeIntegerSchema = z.number().int().nonnegative()

function requireNonNegativeInteger(value: number, name: string): number {
  const result = NonNegativeIntegerSchema.safeParse(value)
  if (!result.success) {
    throw new InternalError(`Invalid ${name} configuration or counter value`)
  }
  return result.data
}

export async function getStats(bindings: StatsBindings): Promise<Stats> {
  const storageStats = await getStorageStats(bindings.SNIPFLOW_R2)
  const storageLimit = Number(bindings.SNIPFLOW_TOTAL_STORAGE_LIMIT)

  return {
    count: storageStats.count,
    totalSize: storageStats.totalSize,
    storageLimit: requireNonNegativeInteger(storageLimit, 'storage limit'),
  }
}
