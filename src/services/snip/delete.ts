import { NotFoundError } from '../../domain/errors'
import { deleteSnip as deleteSnipMeta, getSnip, incrementCounter } from '../../repositories/kv'
import { deletePayload } from '../../repositories/r2'

type DeleteSnipBindings = Pick<
  CloudflareBindings,
  'SNIPFLOW_KV' | 'SNIPFLOW_R2'
>

export async function deleteSnip(
  bindings: DeleteSnipBindings,
  key: string
): Promise<void> {
  const meta = await getSnip(bindings.SNIPFLOW_KV, key)
  if (!meta) throw new NotFoundError('Snip not found')

  await deleteSnipMeta(bindings.SNIPFLOW_KV, key)
  await deletePayload(bindings.SNIPFLOW_R2, key)
  await incrementCounter(bindings.SNIPFLOW_KV, 'count', -1)
  await incrementCounter(bindings.SNIPFLOW_KV, 'totalSize', -meta.size)
}
