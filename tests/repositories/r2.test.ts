import { env } from 'cloudflare:workers'
import { describe, it, expect, beforeEach } from 'vitest'
import * as r2Repo from '../../src/repositories/r2'

describe('R2 Repository', () => {
  let r2: R2Bucket

  beforeEach(async () => {
    r2 = env.SNIPFLOW_R2
    // 清理测试数据
    const list = await r2.list({ prefix: 'snips/' })
    await Promise.all(list.objects.map(obj => r2.delete(obj.key)))
  })

  describe('putPayload & getPayload', () => {
    it('should write and read payload', async () => {
      const content = 'Hello, World!'
      await r2Repo.putPayload(r2, 'test-key', content, 'text/plain')
      const retrieved = await r2Repo.getPayload(r2, 'test-key')
      expect(retrieved).toBe(content)
    })

    it('should return null for non-existent key', async () => {
      const result = await r2Repo.getPayload(r2, 'non-existent')
      expect(result).toBeNull()
    })

    it('should store with correct content type', async () => {
      await r2Repo.putPayload(r2, 'json-key', '{"test":true}', 'application/json')
      const obj = await r2.get('snips/json-key/payload')
      expect(obj?.httpMetadata?.contentType).toBe('application/json')
    })
  })

  describe('deletePayload', () => {
    it('should delete payload', async () => {
      await r2Repo.putPayload(r2, 'delete-me', 'content', 'text/plain')
      await r2Repo.deletePayload(r2, 'delete-me')
      const retrieved = await r2Repo.getPayload(r2, 'delete-me')
      expect(retrieved).toBeNull()
    })
  })

  describe('listPayloads', () => {
    it('should list all payload keys', async () => {
      const keys = ['key1', 'key2', 'key3']
      for (const key of keys) {
        await r2Repo.putPayload(r2, key, `content-${key}`, 'text/plain')
      }

      const result = await r2Repo.listPayloads(r2)
      expect(result.keys).toHaveLength(3)
      expect(result.keys.sort()).toEqual(['key1', 'key2', 'key3'])
    })

    it('should return empty array when no payloads exist', async () => {
      const result = await r2Repo.listPayloads(r2)
      expect(result.keys).toHaveLength(0)
    })
  })
})
