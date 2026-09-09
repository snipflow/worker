import { NotFoundError } from '../../domain/errors'
import { deleteSnip as deleteSnipMeta, getSnip, putSnip } from '../../repositories/kv'
import { deletePayload } from '../../repositories/r2-payload'
import { updateStorageStats } from '../../repositories/r2-stats'

type DeleteSnipBindings = Pick<
  CloudflareBindings,
  'SNIPFLOW_KV' | 'SNIPFLOW_R2'
>

function remainingExpirationTtl(expiresAt: string | null): number | undefined {
  if (!expiresAt) return undefined
  const seconds = Math.ceil(
    (new Date(expiresAt).getTime() - Date.now()) / 1000
  )
  return Math.max(60, seconds)
}

export async function deleteSnip(
  bindings: DeleteSnipBindings,
  key: string
): Promise<void> {
  const meta = await getSnip(bindings.SNIPFLOW_KV, key)
  if (!meta) throw new NotFoundError('Snip not found')

  await updateStorageStats(bindings.SNIPFLOW_R2, {
    count: -1,
    totalSize: -meta.size,
  })

  let metadataDeleted = false
  try {
    await deleteSnipMeta(bindings.SNIPFLOW_KV, key)
    metadataDeleted = true
    await deletePayload(bindings.SNIPFLOW_R2, key)
  } catch (error) {
    const rollbackErrors: unknown[] = []
    if (metadataDeleted) {
      try {
        await putSnip(
          bindings.SNIPFLOW_KV,
          key,
          meta,
          remainingExpirationTtl(meta.expiresAt)
        )
      } catch (rollbackError: unknown) {
        rollbackErrors.push(rollbackError)
      }
    }
    try {
      await updateStorageStats(bindings.SNIPFLOW_R2, {
        count: 1,
        totalSize: meta.size,
      })
    } catch (rollbackError: unknown) {
      rollbackErrors.push(rollbackError)
    }

    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Failed to delete snip and roll back storage'
      )
    }
    throw error
  }
}
