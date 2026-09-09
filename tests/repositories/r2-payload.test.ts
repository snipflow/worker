import { env } from 'cloudflare:workers'
import { describe, it, expect, beforeEach } from 'vitest'
import * as r2Repo from '../../src/repositories/r2-payload'

describe('R2 Payload Repository', () => {
  let r2: R2Bucket

  beforeEach(async () => {
    r2 = env.SNIPFLOW_R2
    // 清理测试数据
    const list = await r2.list({ prefix: 'snips/' })
    await Promise.all(list.objects.map(obj => r2.delete(obj.key)))
  })

  describe('putPayload & getPayload', () => {
    it('streams arbitrary bytes without converting them to text', async () => {
      const content = new Uint8Array([0, 255, 1, 128, 42])
      await r2Repo.putPayload(r2, 'test-key', content, {
        httpMetadata: { contentType: 'application/x-custom-binary' },
      })
      const retrieved = await r2Repo.getPayload(r2, 'test-key')

      expect(new Uint8Array(await retrieved!.arrayBuffer())).toEqual(content)
    })

    it('should return null for non-existent key', async () => {
      const result = await r2Repo.getPayload(r2, 'non-existent')
      expect(result).toBeNull()
    })

    it('stores complete HTTP and custom metadata', async () => {
      const expires = new Date('2026-10-21T07:28:00.000Z')
      await r2Repo.putPayload(r2, 'json-key', '{"test":true}', {
        httpMetadata: {
          contentType: 'application/json',
          contentLanguage: 'zh-CN',
          contentDisposition: 'inline',
          contentEncoding: 'gzip',
          cacheControl: 'private, max-age=60',
          cacheExpiry: expires,
        },
        customMetadata: {
          filename: 'data.json',
          source: 'page',
          category: 'report',
        },
      })
      const obj = await r2.get('snips/json-key/payload')

      expect(obj?.httpMetadata?.contentType).toBe('application/json')
      expect(obj?.httpMetadata?.contentLanguage).toBe('zh-CN')
      expect(obj?.httpMetadata?.contentDisposition).toBe('inline')
      expect(obj?.httpMetadata?.contentEncoding).toBe('gzip')
      expect(obj?.httpMetadata?.cacheControl).toBe('private, max-age=60')
      expect(obj?.httpMetadata?.cacheExpiry).toEqual(expires)
      expect(obj?.customMetadata).toEqual({
        filename: 'data.json',
        source: 'page',
        category: 'report',
      })
    })
  })

  describe('deletePayload', () => {
    it('should delete payload', async () => {
      await r2Repo.putPayload(r2, 'delete-me', 'content')
      await r2Repo.deletePayload(r2, 'delete-me')
      const retrieved = await r2Repo.getPayload(r2, 'delete-me')
      expect(retrieved).toBeNull()
    })
  })

  describe('listPayloads', () => {
    it('should list all payload keys', async () => {
      const keys = ['key1', 'key2', 'key3']
      for (const key of keys) {
        await r2Repo.putPayload(r2, key, `content-${key}`)
      }

      const result = await r2Repo.listPayloads(r2)
      expect(result.items).toHaveLength(3)
      expect(result.items).toEqual(expect.arrayContaining([
        { key: 'key1', size: 12 },
        { key: 'key2', size: 12 },
        { key: 'key3', size: 12 },
      ]))
    })

    it('should return empty array when no payloads exist', async () => {
      const result = await r2Repo.listPayloads(r2)
      expect(result.items).toHaveLength(0)
    })

    it('deletes multiple payloads in one operation', async () => {
      await Promise.all([
        r2Repo.putPayload(r2, 'first', 'first'),
        r2Repo.putPayload(r2, 'second', 'second'),
      ])

      await r2Repo.deletePayloads(r2, ['first', 'second'])
      await expect(r2Repo.deletePayloads(r2, [])).resolves.toBeUndefined()

      expect((await r2Repo.listPayloads(r2)).items).toEqual([])
    })
  })
})
