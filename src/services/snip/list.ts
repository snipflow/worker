import type { SnipMeta } from '../../domain/types'
import { getSnip, listSnips as listSnipKeys } from '../../repositories/kv'

type ListSnipsBindings = Pick<CloudflareBindings, 'SNIPFLOW_KV'>

export interface ListSnipsResult {
  items: SnipMeta[]
  cursor?: string
}

export async function listSnips(
  bindings: ListSnipsBindings,
  cursor?: string
): Promise<ListSnipsResult> {
  const page = await listSnipKeys(bindings.SNIPFLOW_KV, 100, cursor)
  const metadata = await Promise.all(
    page.keys.map(key => getSnip(bindings.SNIPFLOW_KV, key))
  )
  const items = metadata.filter((meta): meta is SnipMeta => meta !== null)

  return page.cursor ? { items, cursor: page.cursor } : { items }
}
