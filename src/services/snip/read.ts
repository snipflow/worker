import { NotFoundError } from '../../domain/errors'
import type { SnipMeta } from '../../domain/types'
import { getSnip } from '../../repositories/kv'
import { getPayload } from '../../repositories/r2'

type ReadSnipBindings = Pick<
  CloudflareBindings,
  'SNIPFLOW_KV' | 'SNIPFLOW_R2'
>

export interface ReadSnipResult {
  meta: SnipMeta
  content: string
}

export async function readSnip(
  bindings: ReadSnipBindings,
  key: string
): Promise<ReadSnipResult> {
  const meta = await getSnip(bindings.SNIPFLOW_KV, key)
  if (!meta) throw new NotFoundError('Snip not found')

  const content = await getPayload(bindings.SNIPFLOW_R2, key)
  if (content === null) throw new NotFoundError('Snip payload not found')

  return { meta, content }
}
