import { Hono } from 'hono'
import { InvalidInputError } from '../domain/errors'
import type {
  CreateSnipResponse,
  ListSnipItem,
  ListSnipsResponse,
  SnipMeta,
} from '../domain/types'
import {
  CreateSnipHeadersSchema,
  ListSnipsQuerySchema,
  SnipKeyParamsSchema,
} from '../schemas/snip'
import { createSnip } from '../services/snip/create'
import { deleteSnip } from '../services/snip/delete'
import { listSnips } from '../services/snip/list'
import { readSnip } from '../services/snip/read'
import { maxSnipSize } from '../middleware/guard'
import {
  MAX_CUSTOM_METADATA_SIZE,
  contentDispositionForFilename,
  createCustomMetadata,
  customMetadataSize,
  filenameFromContentDisposition,
  filenameFromHeader,
} from '../utils/r2-metadata'

const snipRoutes = new Hono<{ Bindings: CloudflareBindings }>()

function invalidInput(issues: readonly unknown[]): InvalidInputError {
  return new InvalidInputError(issues)
}

function toCreateResponse(meta: SnipMeta): CreateSnipResponse {
  return {
    key: meta.key,
    contentType: meta.contentType,
    filename: meta.filename,
    source: meta.source,
    size: meta.size,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
  } satisfies CreateSnipResponse
}

function toListItem(meta: SnipMeta): ListSnipItem {
  return {
    key: meta.key,
    contentType: meta.contentType,
    filename: meta.filename,
    size: meta.size,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
  } satisfies ListSnipItem
}

snipRoutes.post('/', async c => {
  const headers = c.req.raw.headers
  const contentDisposition = headers.get('content-disposition') ?? undefined
  const parsed = CreateSnipHeadersSchema.safeParse({
    key: headers.get('x-snip-key') ?? '',
    source: headers.get('x-snip-source'),
    filename:
      filenameFromHeader(headers.get('x-snip-filename') ?? undefined)
      ?? filenameFromContentDisposition(contentDisposition),
    ttl: headers.get('x-snip-ttl') ?? undefined,
    overwrite: headers.get('x-snip-overwrite') ?? 'false',
    contentType: headers.get('content-type'),
    contentLanguage: headers.get('content-language') ?? undefined,
    contentDisposition,
    contentEncoding: headers.get('content-encoding') ?? undefined,
    cacheControl: headers.get('cache-control') ?? undefined,
    cacheExpiry: headers.get('expires') ?? undefined,
  })
  if (!parsed.success) {
    throw invalidInput(parsed.error.issues)
  }

  const httpMetadata: R2HTTPMetadata = {
    contentType: parsed.data.contentType,
    ...(parsed.data.contentLanguage
      ? { contentLanguage: parsed.data.contentLanguage }
      : {}),
    ...(parsed.data.contentDisposition
      ? { contentDisposition: parsed.data.contentDisposition }
      : {}),
    ...(parsed.data.contentEncoding
      ? { contentEncoding: parsed.data.contentEncoding }
      : {}),
    ...(parsed.data.cacheControl ? { cacheControl: parsed.data.cacheControl } : {}),
    ...(parsed.data.cacheExpiry ? { cacheExpiry: parsed.data.cacheExpiry } : {}),
  }
  const customMetadata = createCustomMetadata(
    headers,
    parsed.data.source,
    parsed.data.filename
  )
  if (customMetadataSize(customMetadata) > MAX_CUSTOM_METADATA_SIZE) {
    throw invalidInput([{
      code: 'too_big',
      path: ['headers'],
      message: `R2 custom metadata 不得超过 ${MAX_CUSTOM_METADATA_SIZE} 字节`,
    }])
  }

  const maximumSize = maxSnipSize(c.env)
  const meta = await createSnip(c.env, {
    key: parsed.data.key,
    source: parsed.data.source,
    expiry: parsed.data.ttl
      ? { mode: 'ttl', ttl: parsed.data.ttl }
      : { mode: 'forever' },
    overwrite: parsed.data.overwrite,
    maxSize: maximumSize,
    payload: c.req.raw.body,
    httpMetadata,
    customMetadata,
  })
  return c.json(toCreateResponse(meta), 201)
})

snipRoutes.get('/', async c => {
  const parsed = ListSnipsQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    throw invalidInput(parsed.error.issues)
  }

  const result = await listSnips(c.env, parsed.data.cursor)
  const response = {
    items: result.items.map(toListItem),
    ...(result.cursor ? { cursor: result.cursor } : {}),
  } satisfies ListSnipsResponse

  return c.json(response)
})

snipRoutes.get('/:key', async c => {
  const parsed = SnipKeyParamsSchema.safeParse(c.req.param())
  if (!parsed.success) {
    throw invalidInput(parsed.error.issues)
  }

  const result = await readSnip(c.env, parsed.data.key)
  const headers = new Headers()
  result.payload.writeHttpMetadata(headers)
  headers.set('ETag', result.payload.httpEtag)
  headers.set('Content-Length', String(result.payload.size))
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', result.meta.contentType)
  }

  const filename =
    result.payload.customMetadata?.filename
    ?? result.meta.filename
  if (filename && !headers.has('Content-Disposition')) {
    headers.set('Content-Disposition', contentDispositionForFilename(filename))
  }

  return new Response(result.payload.body, { headers })
})

snipRoutes.delete('/:key', async c => {
  const parsed = SnipKeyParamsSchema.safeParse(c.req.param())
  if (!parsed.success) {
    throw invalidInput(parsed.error.issues)
  }

  await deleteSnip(c.env, parsed.data.key)
  return c.body(null, 204)
})

export default snipRoutes
