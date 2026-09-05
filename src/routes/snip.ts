import { Hono } from 'hono'
import { InvalidInputError } from '../domain/errors'
import type {
  CreateSnipResponse,
  ListSnipItem,
  ListSnipsResponse,
  ReadSnipResponse,
  SnipMeta,
} from '../domain/types'
import {
  ListSnipsQuerySchema,
  SnipKeyParamsSchema,
  createCreateSnipSchema,
} from '../schemas/snip'
import { createSnip } from '../services/snip/create'
import { deleteSnip } from '../services/snip/delete'
import { listSnips } from '../services/snip/list'
import { readSnip } from '../services/snip/read'

const snipRoutes = new Hono<{ Bindings: CloudflareBindings }>()

function invalidInput(issues: readonly unknown[]): InvalidInputError {
  return new InvalidInputError(issues)
}

function toCreateResponse(meta: SnipMeta): CreateSnipResponse {
  return {
    key: meta.key,
    type: meta.type,
    source: meta.source,
    size: meta.size,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
  } satisfies CreateSnipResponse
}

function toListItem(meta: SnipMeta): ListSnipItem {
  return {
    key: meta.key,
    type: meta.type,
    size: meta.size,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
  } satisfies ListSnipItem
}

snipRoutes.post('/', async c => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw invalidInput([
      { code: 'invalid_json', path: [], message: '请求体必须是合法 JSON' },
    ])
  }

  const schema = createCreateSnipSchema(Number(c.env.SNIPFLOW_MAX_SNIP_SIZE))
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw invalidInput(parsed.error.issues)
  }

  const meta = await createSnip(c.env, parsed.data)
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
  const response = {
    ...toCreateResponse(result.meta),
    content: result.content,
  } satisfies ReadSnipResponse

  return c.json(response)
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
