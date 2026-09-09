import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { STORAGE_STATS_KEY } from '../../src/repositories/r2-stats'

interface ErrorResponse {
  error: {
    code: string
    message: string
    requestId: string
    issues?: Array<{ path: PropertyKey[] }>
  }
}

const authHeaders: Record<string, string> = {
  Authorization: 'Bearer ' + env.SNIPFLOW_API_TOKEN,
}

function uploadHeaders(overrides: Record<string, string | null> = {}): Headers {
  const headers = new Headers({
    ...authHeaders,
    'Content-Type': 'text/markdown; charset=utf-8',
    'X-Snip-Key': 'route-test',
    'X-Snip-Source': 'page',
    'X-Snip-Filename': '%E8%AF%B4%E6%98%8E.md',
  })

  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(name)
    else headers.set(name, value)
  }

  return headers
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

  await env.SNIPFLOW_R2.delete(STORAGE_STATS_KEY)
}

async function create(
  payload: BodyInit = 'hello world',
  headers: Record<string, string | null> = {}
): Promise<Response> {
  return exports.default.fetch('http://localhost/snip', {
    method: 'POST',
    headers: uploadHeaders(headers),
    body: payload,
  })
}

beforeEach(clearStorage)

describe('snip routes', () => {
  it('maps request headers to R2 HTTP metadata and custom metadata', async () => {
    const response = await create('hello world', {
      'Content-Language': 'zh-CN',
      'Cache-Control': 'private, max-age=60',
      'Expires': 'Wed, 21 Oct 2026 07:28:00 GMT',
      'X-Snip-Meta-Category': 'document',
    })
    const json = await response.json() as Record<string, unknown>
    const stored = await env.SNIPFLOW_R2.get('snips/route-test/payload')

    expect(response.status).toBe(201)
    expect(json).toMatchObject({
      key: 'route-test',
      contentType: 'text/markdown; charset=utf-8',
      filename: '说明.md',
      source: 'page',
      size: 11,
      expiresAt: null,
    })
    expect(json.createdAt).toEqual(expect.any(String))
    expect(json).not.toHaveProperty('r2Key')
    expect(stored?.httpMetadata).toMatchObject({
      contentType: 'text/markdown; charset=utf-8',
      contentLanguage: 'zh-CN',
      cacheControl: 'private, max-age=60',
      cacheExpiry: new Date('2026-10-21T07:28:00.000Z'),
    })
    expect(stored?.customMetadata).toEqual({
      category: 'document',
      filename: '说明.md',
      source: 'page',
    })
    expect(stored?.customMetadata).not.toHaveProperty('authorization')
  })

  it('accepts arbitrary binary content and returns it without conversion', async () => {
    const bytes = new Uint8Array([0, 255, 1, 128, 42])
    expect((await create(bytes, {
      'Content-Type': 'application/vnd.example.binary',
      'X-Snip-Filename': 'sample.bin',
    })).status).toBe(201)

    const response = await exports.default.fetch('http://localhost/snip', {
      headers: authHeaders,
    })
    const list = await response.json() as {
      items: Array<Record<string, unknown>>
    }
    expect(list.items[0]).toMatchObject({
      contentType: 'application/vnd.example.binary',
      filename: 'sample.bin',
      size: 5,
    })

    const read = await exports.default.fetch(
      'http://localhost/snip/route-test',
      { headers: authHeaders }
    )
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes)
    expect(read.headers.get('content-type')).toBe('application/vnd.example.binary')
    expect(read.headers.get('content-disposition'))
      .toBe("attachment; filename*=UTF-8''sample.bin")
  })

  it('returns structured issues for missing or invalid metadata headers', async () => {
    const missingSource = await create('content', {
      'X-Snip-Source': null,
    })
    const missingSourceJson = await missingSource.json() as ErrorResponse

    expect(missingSource.status).toBe(400)
    expect(missingSourceJson.error.code).toBe('INVALID_INPUT')
    expect(missingSourceJson.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['source'] }),
    ]))

    const malformedType = await create('content', {
      'Content-Type': 'invalid',
    })
    expect(malformedType.status).toBe(400)
    expect(((await malformedType.json()) as ErrorResponse).error.issues)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['contentType'] }),
      ]))
  })

  it('rejects custom metadata larger than the R2 limit', async () => {
    const response = await create('content', {
      'X-Snip-Meta-Large': 'x'.repeat(8192),
    })

    expect(response.status).toBe(400)
    expect(((await response.json()) as ErrorResponse).error.code)
      .toBe('INVALID_INPUT')
  })

  it('requires a Content-Type but accepts every valid MIME type', async () => {
    const response = await exports.default.fetch('http://localhost/snip', {
      method: 'POST',
      headers: {
        ...authHeaders,
        'X-Snip-Source': 'page',
      },
      body: new Uint8Array([1, 2, 3]),
    })

    expect(response.status).toBe(415)
    expect(((await response.json()) as ErrorResponse).error.code)
      .toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('reports conflicts and allows explicit overwrite', async () => {
    expect((await create()).status).toBe(201)

    const conflict = await create('new content')
    expect(conflict.status).toBe(409)
    expect(((await conflict.json()) as ErrorResponse).error.code).toBe('KEY_CONFLICT')

    const overwritten = await create('new content', {
      'X-Snip-Overwrite': 'true',
    })
    expect(overwritten.status).toBe(201)
    expect(await overwritten.json()).toMatchObject({ size: 11 })
  })

  it('streams an existing snip with stored HTTP metadata and a safe filename', async () => {
    await create()

    const response = await exports.default.fetch(
      'http://localhost/snip/route-test',
      { headers: authHeaders }
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello world')
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(response.headers.get('content-length')).toBe('11')
    expect(response.headers.get('content-disposition'))
      .toBe("attachment; filename*=UTF-8''%E8%AF%B4%E6%98%8E.md")
    expect(response.headers.get('etag')).toBeTruthy()
  })

  it('falls back to indexed Content-Type when R2 HTTP metadata is absent', async () => {
    await create()
    await env.SNIPFLOW_R2.put('snips/route-test/payload', 'raw')

    const response = await exports.default.fetch(
      'http://localhost/snip/route-test',
      { headers: authHeaders }
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type'))
      .toBe('text/markdown; charset=utf-8')
    expect(await response.text()).toBe('raw')
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
    const invalidDelete = await exports.default.fetch(
      'http://localhost/snip/with%20space',
      { method: 'DELETE', headers: authHeaders }
    )

    expect(invalidPath.status).toBe(400)
    expect(invalidQuery.status).toBe(400)
    expect(invalidDelete.status).toBe(400)
  })

  it('supports the complete create, read, list, delete lifecycle', async () => {
    expect((await create('hello lifecycle')).status).toBe(201)

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
    expect(listJson.items[0]).toMatchObject({
      key: 'route-test',
      contentType: 'text/markdown; charset=utf-8',
      filename: '说明.md',
      size: 15,
    })
    expect(listJson.items[0]).not.toHaveProperty('source')
    expect(listJson.items[0]).not.toHaveProperty('r2Key')
    expect(listJson.items[0]).not.toHaveProperty('content')

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
