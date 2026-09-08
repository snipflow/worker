import { describe, expect, it } from 'vitest'
import {
  CreateSnipHeadersSchema,
  ListSnipsQuerySchema,
  SnipKeyParamsSchema,
} from '../../src/schemas/snip'

const validHeaders = {
  key: 'my-note',
  source: 'page',
  overwrite: 'false',
  contentType: 'application/vnd.snipflow.document+json; charset=utf-8',
}

function expectIssuePath(
  result: ReturnType<typeof CreateSnipHeadersSchema.safeParse>,
  path: PropertyKey[]
) {
  expect(result.success).toBe(false)
  if (!result.success) {
    expect(result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })])
    )
  }
}

describe('CreateSnipHeadersSchema', () => {
  it('accepts arbitrary valid MIME types and maps header values', () => {
    const result = CreateSnipHeadersSchema.safeParse({
      ...validHeaders,
      filename: '报告.data',
      ttl: '86400',
      cacheExpiry: 'Wed, 21 Oct 2026 07:28:00 GMT',
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.overwrite).toBe(false)
      expect(result.data.ttl).toBe(86400)
      expect(result.data.cacheExpiry).toEqual(new Date('2026-10-21T07:28:00.000Z'))
    }
  })

  it('rejects a malformed MIME type', () => {
    const result = CreateSnipHeadersSchema.safeParse({
      ...validHeaders,
      contentType: 'not-a-media-type',
    })

    expectIssuePath(result, ['contentType'])
  })

  it('rejects missing source and invalid control headers', () => {
    const missingSource = CreateSnipHeadersSchema.safeParse({
      ...validHeaders,
      source: null,
    })
    const invalidOverwrite = CreateSnipHeadersSchema.safeParse({
      ...validHeaders,
      overwrite: 'yes',
    })
    const invalidTtl = CreateSnipHeadersSchema.safeParse({
      ...validHeaders,
      ttl: '0',
    })

    expectIssuePath(missingSource, ['source'])
    expectIssuePath(invalidOverwrite, ['overwrite'])
    expectIssuePath(invalidTtl, ['ttl'])
  })

  it('accepts an empty key for server-side generation', () => {
    expect(CreateSnipHeadersSchema.safeParse({ ...validHeaders, key: '' }).success)
      .toBe(true)
  })

  it.each(['with/slash', 'with space', 'a'.repeat(129)])(
    'rejects invalid custom key %s',
    key => {
      const result = CreateSnipHeadersSchema.safeParse({ ...validHeaders, key })
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
