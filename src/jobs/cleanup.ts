import { keyExists } from '../repositories/kv'
import { deletePayload, listPayloads } from '../repositories/r2'

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
      page.keys.map(key => keyExists(bindings.SNIPFLOW_KV, key))
    )
    const orphanedKeys = page.keys.filter((_key, index) => !existence[index])

    await Promise.all(
      orphanedKeys.map(key => deletePayload(bindings.SNIPFLOW_R2, key))
    )

    scanned += page.keys.length
    deleted += orphanedKeys.length
    cursor = page.cursor
  } while (cursor)

  return { scanned, deleted }
}
