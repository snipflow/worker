import { KeyConflictError, PayloadTooLargeError } from '../../domain/errors'
import type { CreateSnipInput, SnipMeta } from '../../domain/types'
import {
  getSnip,
  incrementCounter,
  keyExists,
  putSnip,
} from '../../repositories/kv'
import { deletePayload, getPayload, putPayload } from '../../repositories/r2'
import { generateKey } from '../../utils/key'
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
  let meta: SnipMeta

  try {
    const stored = await putPayload(bindings.SNIPFLOW_R2, key, input.payload, {
      httpMetadata: input.httpMetadata,
      customMetadata: input.customMetadata,
    })
    if (stored.size > input.maxSize) {
      throw new PayloadTooLargeError()
    }
    meta = {
      key,
      contentType:
        stored.httpMetadata?.contentType
        ?? input.httpMetadata.contentType
        ?? 'application/octet-stream',
      filename: stored.customMetadata?.filename ?? input.customMetadata.filename ?? null,
      source: input.source,
      size: stored.size,
      createdAt: nowISO(),
      expiresAt: input.expiry.mode === 'ttl' ? ttlToExpiresAt(input.expiry.ttl) : null,
      r2Key: `snips/${key}/payload`,
    }
    await putSnip(bindings.SNIPFLOW_KV, key, meta, expirationTtl)
  } catch (error) {
    try {
      await restorePayload(bindings.SNIPFLOW_R2, key, previousMeta, previousPayload)
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Failed to create snip and roll back its R2 payload'
      )
    }
    throw error
  }

  const countDelta = previousMeta ? 0 : 1
  const sizeDelta = meta.size - (previousMeta?.size ?? 0)

  if (countDelta !== 0) {
    await incrementCounter(bindings.SNIPFLOW_KV, 'count', countDelta)
  }
  if (sizeDelta !== 0) {
    await incrementCounter(bindings.SNIPFLOW_KV, 'totalSize', sizeDelta)
  }

  return meta
}
