import { keyExists } from '../repositories/kv'
import {
  deletePayloads,
  listPayloads,
} from '../repositories/r2-payload'
import { updateStorageStats } from '../repositories/r2-stats'

type CleanupBindings = Pick<
  CloudflareBindings,
  'SNIPFLOW_KV' | 'SNIPFLOW_R2'
>

export interface CleanupResult {
  scanned: number
  deleted: number
}

/**
 * 扫描全部 R2 payload，删除已经没有 KV metadata 的孤立对象。
 */
export async function cleanupOrphanedPayloads(
  bindings: CleanupBindings
): Promise<CleanupResult> {
  let cursor: string | undefined
  let scanned = 0
  let deleted = 0

  do {
    const page = await listPayloads(bindings.SNIPFLOW_R2, cursor)
    const existence = await Promise.all(
      page.items.map(item => keyExists(bindings.SNIPFLOW_KV, item.key))
    )
    const orphaned = page.items.filter((_item, index) => !existence[index])

    if (orphaned.length > 0) {
      const delta = {
        count: -orphaned.length,
        totalSize: -orphaned.reduce((total, item) => total + item.size, 0),
      }
      await updateStorageStats(bindings.SNIPFLOW_R2, delta)
      try {
        await deletePayloads(
          bindings.SNIPFLOW_R2,
          orphaned.map(item => item.key)
        )
      } catch (error) {
        try {
          await updateStorageStats(bindings.SNIPFLOW_R2, {
            count: -delta.count,
            totalSize: -delta.totalSize,
          })
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Failed to clean orphaned payloads and roll back storage stats'
          )
        }
        throw error
      }
    }

    scanned += page.items.length
    deleted += orphaned.length
    cursor = page.cursor
  } while (cursor)

  return { scanned, deleted }
}
