import { InternalError } from '../domain/errors'
import type { Stats } from '../domain/types'
import { getCounter } from '../repositories/kv'
import { z } from 'zod'

type StatsBindings = Pick<
  CloudflareBindings,
  'SNIPFLOW_KV' | 'SNIPFLOW_TOTAL_STORAGE_LIMIT'
>

const NonNegativeIntegerSchema = z.number().int().nonnegative()

function requireNonNegativeInteger(value: number, name: string): number {
  const result = NonNegativeIntegerSchema.safeParse(value)
  if (!result.success) {
    throw new InternalError(`Invalid ${name} configuration or counter value`)
  }
  return result.data
}

export async function getStats(bindings: StatsBindings): Promise<Stats> {
  const [count, totalSize] = await Promise.all([
    getCounter(bindings.SNIPFLOW_KV, 'count'),
    getCounter(bindings.SNIPFLOW_KV, 'totalSize'),
  ])
  const storageLimit = Number(bindings.SNIPFLOW_TOTAL_STORAGE_LIMIT)

  return {
    count: requireNonNegativeInteger(count, 'count'),
    totalSize: requireNonNegativeInteger(totalSize, 'totalSize'),
    storageLimit: requireNonNegativeInteger(storageLimit, 'storage limit'),
  }
}
