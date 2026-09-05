import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

interface ErrorResponse {
  error: {
    code: string
    message: string
    requestId: string
    issues?: Array<{ path: PropertyKey[] }>
  }
}

const authHeaders = {
  Authorization: 'Bearer ' + env.SNIPFLOW_API_TOKEN,
}
const jsonHeaders = {
  ...authHeaders,
  'content-type': 'application/json',
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    key: 'route-test',
    type: 'text',
    content: 'hello world',
    source: 'page',
    expiry: { mode: 'forever' },
    overwrite: false,
    ...overrides,
  }
}

async function clearStorage(): Promise<void> {
  let kvCursor: string | undefined
  do {
    const page = await env.SNIPFLOW_KV.list({ prefix: 'snip:', cursor: kvCursor })
    await Promise.all(page.keys.map(key => env.SNIPFLOW_KV.delete(key.name)))
    kvCursor = page.list_complete ? undefined : page.cursor
  } while (kvCursor)

  let r2Cursor: string | undefined
  do {
    const page = await env.SNIPFLOW_R2.list({ prefix: 'snips/', cursor: r2Cursor })
    await Promise.all(page.objects.map(object => env.SNIPFLOW_R2.delete(object.key)))
    r2Cursor = page.truncated ? page.cursor : undefined
  } while (r2Cursor)

  await Promise.all([
    env.SNIPFLOW_KV.delete('meta:count'),
    env.SNIPFLOW_KV.delete('meta:totalSize'),
  ])
}

async function create(overrides: Record<string, unknown> = {}): Promise<Response> {
  return exports.default.fetch('http://localhost/snip', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(createBody(overrides)),
  })
}

beforeEach(clearStorage)

describe('snip routes', () => {
  it('creates a snip and exposes only its public metadata', async () => {
    const response = await create()
    const json = await response.json() as Record<string, unknown>

    expect(response.status).toBe(201)
    expect(json).toMatchObject({
      key: 'route-test',
      type: 'text',
      source: 'page',
      size: 11,
      expiresAt: null,
    })
    expect(json.createdAt).toEqual(expect.any(String))
    expect(json).not.toHaveProperty('r2Key')
    expect(await env.SNIPFLOW_R2.get('snips/route-test/payload')).not.toBeNull()
  })

  it('returns structured Zod issues for invalid input', async () => {
    const response = await exports.default.fetch('http://localhost/snip', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ key: 'missing-fields' }),
    })
    const json = await response.json() as ErrorResponse

    expect(response.status).toBe(400)
    expect(json.error.code).toBe('INVALID_INPUT')
    expect(json.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['content'] }),
    ]))
  })

  it('returns INVALID_INPUT for malformed JSON', async () => {
    const response = await exports.default.fetch('http://localhost/snip', {
      method: 'POST',
      headers: jsonHeaders,
      body: '{',
    })
    const json = await response.json() as ErrorResponse

    expect(response.status).toBe(400)
    expect(json.error.code).toBe('INVALID_INPUT')
    expect(json.error.issues).toHaveLength(1)
  })

  it('reports conflicts and allows explicit overwrite', async () => {
    expect((await create()).status).toBe(201)

    const conflict = await create({ content: 'new content' })
    expect(conflict.status).toBe(409)
    expect(((await conflict.json()) as ErrorResponse).error.code).toBe('KEY_CONFLICT')

    const overwritten = await create({ content: 'new content', overwrite: true })
    expect(overwritten.status).toBe(201)
    expect(await overwritten.json()).toMatchObject({ size: 11 })
  })

  it('reads an existing snip without leaking r2Key', async () => {
    await create()

    const response = await exports.default.fetch(
      'http://localhost/snip/route-test',
      { headers: authHeaders }
    )
    const json = await response.json() as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(json).toMatchObject({ key: 'route-test', content: 'hello world' })
    expect(json).not.toHaveProperty('r2Key')
  })

  it('returns NOT_FOUND for an unknown snip', async () => {
    const response = await exports.default.fetch('http://localhost/snip/missing', {
      headers: authHeaders,
    })

    expect(response.status).toBe(404)
    expect(((await response.json()) as ErrorResponse).error.code).toBe('NOT_FOUND')
  })

  it('validates path and query inputs', async () => {
    const invalidPath = await exports.default.fetch(
      'http://localhost/snip/with%20space',
      { headers: authHeaders }
    )
    const invalidQuery = await exports.default.fetch(
      'http://localhost/snip?limit=10',
      { headers: authHeaders }
    )

    expect(invalidPath.status).toBe(400)
    expect(invalidQuery.status).toBe(400)
  })

  it('supports the complete create, read, list, delete lifecycle', async () => {
    expect((await create()).status).toBe(201)

    const read = await exports.default.fetch('http://localhost/snip/route-test', {
      headers: authHeaders,
    })
    expect(read.status).toBe(200)

    const listed = await exports.default.fetch('http://localhost/snip', {
      headers: authHeaders,
    })
    const listJson = await listed.json() as {
      items: Array<Record<string, unknown>>
      cursor?: string
    }
    expect(listed.status).toBe(200)
    expect(listJson.items).toHaveLength(1)
    expect(listJson.items[0]).toMatchObject({ key: 'route-test', size: 11 })
    expect(listJson.items[0]).not.toHaveProperty('content')
    expect(listJson.items[0]).not.toHaveProperty('source')
    expect(listJson.items[0]).not.toHaveProperty('r2Key')

    const deleted = await exports.default.fetch(
      'http://localhost/snip/route-test',
      { method: 'DELETE', headers: authHeaders }
    )
    expect(deleted.status).toBe(204)
    expect(await deleted.text()).toBe('')

    const emptyList = await exports.default.fetch('http://localhost/snip', {
      headers: authHeaders,
    })
    expect(await emptyList.json()).toEqual({ items: [] })
  })
})
