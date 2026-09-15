import { KeyConflictError, PayloadTooLargeError } from '../../domain/errors'
import type { CreateSnipInput, SnipMeta } from '../../domain/types'
import {
  deleteSnip as deleteSnipMeta,
  getSnip,
  keyExists,
  putSnip,
} from '../../repositories/kv'
import {
  deletePayload,
  getPayload,
  putPayload,
  putPayloadConditionally,
} from '../../repositories/r2-payload'
import { updateStorageStats } from '../../repositories/r2-stats'
import { generateKey } from '../../utils/key'
import { stripReservedCustomMetadata } from '../../utils/r2-metadata'
import { nowISO, ttlToExpiresAt } from '../../utils/time'

const MAX_GENERATED_KEY_ATTEMPTS = 3

type CreateSnipBindings = Pick<
  CloudflareBindings,
  'SNIPFLOW_KV' | 'SNIPFLOW_R2'
>

export interface CreateSnipOptions {
  generateKey?: () => string
}

async function resolveKey(
  kv: KVNamespace,
  requestedKey: string,
  keyGenerator: () => string
): Promise<string> {
  if (requestedKey !== '') return requestedKey

  for (let attempt = 0; attempt < MAX_GENERATED_KEY_ATTEMPTS; attempt += 1) {
    const candidate = keyGenerator()
    if (!(await keyExists(kv, candidate))) return candidate
  }

  throw new KeyConflictError('Unable to generate a unique key')
}

async function restorePayload(
  r2: R2Bucket,
  key: string,
  previousMeta: SnipMeta | null,
  previousPayload: R2ObjectBody | null
): Promise<void> {
  if (previousMeta && previousPayload) {
    await putPayload(r2, key, previousPayload.body, {
      httpMetadata: previousPayload.httpMetadata,
      customMetadata: previousPayload.customMetadata,
      storageClass: previousPayload.storageClass,
    })
    return
  }

  await deletePayload(r2, key)
}

function remainingExpirationTtl(meta: SnipMeta): number | undefined {
  if (!meta.expiresAt) return undefined
  const seconds = Math.ceil(
    (new Date(meta.expiresAt).getTime() - Date.now()) / 1000
  )
  return Math.max(60, seconds)
}

async function restoreMetadata(
  kv: KVNamespace,
  key: string,
  previousMeta: SnipMeta | null
): Promise<void> {
  if (previousMeta) {
    await putSnip(kv, key, previousMeta, remainingExpirationTtl(previousMeta))
    return
  }

  await deleteSnipMeta(kv, key)
}

/**
 * 创建或覆盖 snip。服务仅依赖 Worker bindings 与领域输入，不依赖 Hono context。
 */
export async function createSnip(
  bindings: CreateSnipBindings,
  input: CreateSnipInput,
  options: CreateSnipOptions = {}
): Promise<SnipMeta> {
  const key = await resolveKey(
    bindings.SNIPFLOW_KV,
    input.key,
    options.generateKey ?? generateKey
  )
  const previousMeta = await getSnip(bindings.SNIPFLOW_KV, key)

  if (previousMeta && !input.overwrite) {
    throw new KeyConflictError()
  }

  const previousPayload = previousMeta
    ? await getPayload(bindings.SNIPFLOW_R2, key)
    : null
  const expirationTtl = input.expiry.mode === 'ttl' ? input.expiry.ttl : undefined
  let payloadWritten = false
  let metadataWritten = false
  let meta: SnipMeta

  try {
    const stored = await putPayloadConditionally(
      bindings.SNIPFLOW_R2,
      key,
      input.payload,
      {
        onlyIf: previousPayload
          ? { etagMatches: previousPayload.etag }
          : { etagDoesNotMatch: '*' },
        httpMetadata: input.httpMetadata,
        customMetadata: stripReservedCustomMetadata(input.customMetadata),
      }
    )
    if (!stored) throw new KeyConflictError()
    payloadWritten = true
    if (stored.size > input.maxSize) {
      throw new PayloadTooLargeError()
    }
    meta = {
      key,
      contentType:
        stored.httpMetadata?.contentType
        ?? input.httpMetadata.contentType
        ?? 'application/octet-stream',
      filename: input.filename,
      source: input.source,
      size: stored.size,
      createdAt: nowISO(),
      expiresAt: input.expiry.mode === 'ttl' ? ttlToExpiresAt(input.expiry.ttl) : null,
      r2Key: `snips/${key}/payload`,
    }
    await putSnip(bindings.SNIPFLOW_KV, key, meta, expirationTtl)
    metadataWritten = true

    const countDelta = previousMeta ? 0 : 1
    const sizeDelta = meta.size - (previousMeta?.size ?? 0)
    if (countDelta !== 0 || sizeDelta !== 0) {
      await updateStorageStats(bindings.SNIPFLOW_R2, {
        count: countDelta,
        totalSize: sizeDelta,
      })
    }
  } catch (error) {
    if (!payloadWritten) throw error

    const rollbackErrors: unknown[] = []
    try {
      await restorePayload(bindings.SNIPFLOW_R2, key, previousMeta, previousPayload)
    } catch (rollbackError: unknown) {
      rollbackErrors.push(rollbackError)
    }
    if (metadataWritten) {
      try {
        await restoreMetadata(bindings.SNIPFLOW_KV, key, previousMeta)
      } catch (rollbackError: unknown) {
        rollbackErrors.push(rollbackError)
      }
    }

    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Failed to create snip and roll back storage'
      )
    }
    throw error
  }

  return meta
}
