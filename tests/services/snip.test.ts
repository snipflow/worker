import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { KeyConflictError, NotFoundError } from '../../src/domain/errors'
import type { CreateSnipInput } from '../../src/domain/types'
import { getSnip, setCounter } from '../../src/repositories/kv'
import { deletePayload, getPayload, putPayload } from '../../src/repositories/r2'
import { createSnip } from '../../src/services/snip/create'
import { deleteSnip } from '../../src/services/snip/delete'
import { listSnips } from '../../src/services/snip/list'
import { readSnip } from '../../src/services/snip/read'
import { getStats } from '../../src/services/stats'

const textEncoder = new TextEncoder()
const storageLimit = Number(env.SNIPFLOW_TOTAL_STORAGE_LIMIT)

function bindings() {
  return {
    SNIPFLOW_KV: env.SNIPFLOW_KV,
    SNIPFLOW_R2: env.SNIPFLOW_R2,
  } satisfies Pick<CloudflareBindings, 'SNIPFLOW_KV' | 'SNIPFLOW_R2'>
}

function createInput(overrides: Partial<CreateSnipInput> = {}): CreateSnipInput {
  return {
    key: 'test-key',
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

  await env.SNIPFLOW_KV.delete('meta:count')
  await env.SNIPFLOW_KV.delete('meta:totalSize')
}

beforeEach(clearStorage)

describe('createSnip', () => {
  it('generates a non-empty key when the requested key is empty', async () => {
    const meta = await createSnip(bindings(), createInput({ key: '' }))

    expect(meta.key).toMatch(/^[0-9A-Za-z]{5}$/)
    expect(await getSnip(env.SNIPFLOW_KV, meta.key)).toEqual(meta)
    expect(await getPayload(env.SNIPFLOW_R2, meta.key)).toBe('hello world')
  })

  it('keeps a caller-provided key', async () => {
    const meta = await createSnip(bindings(), createInput({ key: 'abc' }))

    expect(meta.key).toBe('abc')
  })

  it('tries at most three generated keys before reporting a conflict', async () => {
    const candidates = ['taken1', 'taken2', 'taken3']
    await Promise.all(
      candidates.map(key => env.SNIPFLOW_KV.put(`snip:${key}`, 'occupied'))
    )
    let calls = 0

    await expect(
      createSnip(bindings(), createInput({ key: '' }), {
        generateKey: () => candidates[calls++] ?? 'unexpected',
      })
    ).rejects.toBeInstanceOf(KeyConflictError)
    expect(calls).toBe(3)
  })

  it('rejects an existing custom key unless overwrite is enabled', async () => {
    await createSnip(bindings(), createInput({ key: 'abc', content: 'old' }))

    await expect(
      createSnip(bindings(), createInput({ key: 'abc', content: 'new' }))
    ).rejects.toBeInstanceOf(KeyConflictError)
    expect(await getPayload(env.SNIPFLOW_R2, 'abc')).toBe('old')
  })

  it('overwrites content and adjusts size without incrementing count', async () => {
    await createSnip(bindings(), createInput({ key: 'abc', content: 'old' }))
    const meta = await createSnip(
      bindings(),
      createInput({ key: 'abc', content: '你好', overwrite: true })
    )

    expect(await getPayload(env.SNIPFLOW_R2, 'abc')).toBe('你好')
    expect(meta.size).toBe(textEncoder.encode('你好').byteLength)
    await expect(getStats(env)).resolves.toEqual({
      count: 1,
      totalSize: 6,
      storageLimit,
    })
  })

  it('stores TTL metadata and configures KV expiration', async () => {
    const before = Math.floor(Date.now() / 1000)
    const meta = await createSnip(
      bindings(),
      createInput({ key: 'ttl-key', expiry: { mode: 'ttl', ttl: 3600 } })
    )
    const page = await env.SNIPFLOW_KV.list({ prefix: 'snip:ttl-key' })

    expect(meta.expiresAt).not.toBeNull()
    expect(new Date(meta.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now())
    expect(page.keys[0]?.expiration).toBeGreaterThanOrEqual(before + 3600)
  })

  it('increments count and totalSize using UTF-8 bytes', async () => {
    await createSnip(bindings(), createInput({ content: '你好' }))

    await expect(getStats(env)).resolves.toEqual({
      count: 1,
      totalSize: 6,
      storageLimit,
    })
  })
})

describe('readSnip', () => {
  it('returns metadata and payload content', async () => {
    const created = await createSnip(bindings(), createInput())

    await expect(readSnip(bindings(), created.key)).resolves.toEqual({
      meta: created,
      content: 'hello world',
    })
  })

  it('throws NotFoundError when metadata or payload is missing', async () => {
    await expect(readSnip(bindings(), 'missing')).rejects.toBeInstanceOf(NotFoundError)

    await createSnip(bindings(), createInput({ key: 'missing-payload' }))
    await deletePayload(env.SNIPFLOW_R2, 'missing-payload')
    await expect(readSnip(bindings(), 'missing-payload')).rejects.toBeInstanceOf(
      NotFoundError
    )
  })
})

describe('listSnips', () => {
  it('returns paged metadata without loading payloads', async () => {
    const first = await createSnip(bindings(), createInput({ key: 'first' }))
    const second = await createSnip(bindings(), createInput({ key: 'second' }))

    const result = await listSnips(bindings())

    expect(result.cursor).toBeUndefined()
    expect(result.items).toEqual(expect.arrayContaining([first, second]))
  })
})

describe('deleteSnip', () => {
  it('deletes KV before R2 and decrements counters', async () => {
    await createSnip(bindings(), createInput({ key: 'delete-me', content: '你好' }))

    await deleteSnip(bindings(), 'delete-me')

    expect(await getSnip(env.SNIPFLOW_KV, 'delete-me')).toBeNull()
    expect(await getPayload(env.SNIPFLOW_R2, 'delete-me')).toBeNull()
    await expect(getStats(env)).resolves.toEqual({
      count: 0,
      totalSize: 0,
      storageLimit,
    })
  })

  it('throws NotFoundError for an unknown key', async () => {
    await expect(deleteSnip(bindings(), 'missing')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('getStats', () => {
  it('reads both counters and the configured storage limit', async () => {
    await setCounter(env.SNIPFLOW_KV, 'count', 4)
    await setCounter(env.SNIPFLOW_KV, 'totalSize', 1234)

    await expect(getStats(env)).resolves.toEqual({
      count: 4,
      totalSize: 1234,
      storageLimit,
    })
  })

  it('does not confuse an R2 object without metadata for a listed snip', async () => {
    await putPayload(env.SNIPFLOW_R2, 'orphan', 'content', 'text/plain')

    await expect(listSnips(bindings())).resolves.toEqual({ items: [] })
  })

  it('rejects invalid counter values at the DTO boundary', async () => {
    await env.SNIPFLOW_KV.put('meta:count', 'not-a-number')

    await expect(getStats(env)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })
})
