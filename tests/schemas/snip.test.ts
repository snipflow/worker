import { describe, expect, it } from 'vitest'
import {
  CreateSnipSchema,
  ExpirySchema,
  ListSnipsQuerySchema,
  SnipKeyParamsSchema,
  createCreateSnipSchema,
} from '../../src/schemas/snip'

const validRequest = {
  key: 'my-note',
  type: 'text' as const,
  content: 'hello world',
  source: 'page',
  expiry: { mode: 'ttl' as const, ttl: 86400 },
}

function expectIssuePath(result: ReturnType<typeof CreateSnipSchema.safeParse>, path: PropertyKey[]) {
  expect(result.success).toBe(false)
  if (!result.success) {
    expect(result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })])
    )
  }
}

describe('ExpirySchema', () => {
  it('accepts forever expiry', () => {
    expect(ExpirySchema.safeParse({ mode: 'forever' }).success).toBe(true)
  })

  it('rejects ttl expiry without ttl at expiry.ttl', () => {
    const result = CreateSnipSchema.safeParse({
      ...validRequest,
      expiry: { mode: 'ttl' },
    })

    expectIssuePath(result, ['expiry', 'ttl'])
  })

  it('rejects fields that do not belong to forever expiry', () => {
    expect(ExpirySchema.safeParse({ mode: 'forever', ttl: 60 }).success).toBe(false)
  })
})

describe('CreateSnipSchema', () => {
  it('accepts a valid request and defaults overwrite to false', () => {
    const result = CreateSnipSchema.safeParse(validRequest)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.overwrite).toBe(false)
    }
  })

  it('rejects an unsupported type at type', () => {
    const result = CreateSnipSchema.safeParse({
      ...validRequest,
      type: 'link',
    })

    expectIssuePath(result, ['type'])
  })

  it('rejects empty content at content', () => {
    const result = CreateSnipSchema.safeParse({
      ...validRequest,
      content: '',
    })

    expectIssuePath(result, ['content'])
  })

  it('limits content by UTF-8 bytes', () => {
    const schema = createCreateSnipSchema(5)

    expect(schema.safeParse({ ...validRequest, content: 'hello' }).success).toBe(true)

    const result = schema.safeParse({ ...validRequest, content: '你好' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['content'] })])
      )
    }
  })

  it('rejects an invalid maximum size when the schema is constructed', () => {
    expect(() => createCreateSnipSchema(0)).toThrow(RangeError)
    expect(() => createCreateSnipSchema(Number.NaN)).toThrow(RangeError)
  })

  it('accepts an empty key for server-side generation', () => {
    expect(CreateSnipSchema.safeParse({ ...validRequest, key: '' }).success).toBe(true)
  })

  it.each(['with/slash', 'with space', 'a'.repeat(129)])(
    'rejects invalid custom key %s',
    key => {
      const result = CreateSnipSchema.safeParse({ ...validRequest, key })
      expectIssuePath(result, ['key'])
    }
  )
})

describe('Route input schemas', () => {
  it('accepts a valid path key', () => {
    expect(SnipKeyParamsSchema.safeParse({ key: 'my-note_1' }).success).toBe(true)
  })

  it.each(['', 'with/slash', 'with space'])('rejects invalid path key %s', key => {
    const result = SnipKeyParamsSchema.safeParse({ key })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['key'])
    }
  })

  it('accepts an omitted or non-empty cursor', () => {
    expect(ListSnipsQuerySchema.safeParse({}).success).toBe(true)
    expect(ListSnipsQuerySchema.safeParse({ cursor: 'opaque-cursor' }).success).toBe(true)
  })

  it('rejects an empty cursor and unknown query fields', () => {
    expect(ListSnipsQuerySchema.safeParse({ cursor: '' }).success).toBe(false)
    expect(ListSnipsQuerySchema.safeParse({ limit: '10' }).success).toBe(false)
  })
})
