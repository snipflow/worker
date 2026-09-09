import { env } from 'cloudflare:workers'
import { describe, it, expect, beforeEach } from 'vitest'
import * as kvRepo from '../../src/repositories/kv'
import { InternalError } from '../../src/domain/errors'
import type { SnipMeta } from '../../src/domain/types'

describe('KV Repository', () => {
  let kv: KVNamespace

  beforeEach(async () => {
    kv = env.SNIPFLOW_KV
    // 清理测试数据
    const list = await kv.list({ prefix: 'snip:' })
    await Promise.all(list.keys.map(k => kv.delete(k.name)))
  })

  describe('getSnip & putSnip', () => {
    it('should write and read snip metadata', async () => {
      const meta: SnipMeta = {
        key: 'test-key',
        contentType: 'text/plain',
        filename: null,
        source: 'page',
        size: 100,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        r2Key: 'snips/test-key/payload',
      }

      await kvRepo.putSnip(kv, 'test-key', meta)
      const retrieved = await kvRepo.getSnip(kv, 'test-key')

      expect(retrieved).toEqual(meta)
    })

    it('should return null for non-existent key', async () => {
      const result = await kvRepo.getSnip(kv, 'non-existent')
      expect(result).toBeNull()
    })

    it('should reject invalid JSON metadata', async () => {
      await kv.put('snip:invalid-json', '{')
      await expect(kvRepo.getSnip(kv, 'invalid-json')).rejects.toBeInstanceOf(InternalError)
    })

    it('should reject metadata with an invalid shape', async () => {
      await kv.put('snip:invalid-shape', JSON.stringify({ key: 'invalid-shape' }))
      await expect(kvRepo.getSnip(kv, 'invalid-shape')).rejects.toBeInstanceOf(InternalError)
    })

    it('should support TTL expiration', async () => {
      const meta: SnipMeta = {
        key: 'ttl-key',
        contentType: 'application/pdf',
        filename: 'report.pdf',
        source: 'page',
        size: 50,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        r2Key: 'snips/ttl-key/payload',
      }

      await kvRepo.putSnip(kv, 'ttl-key', meta, 60)
      const retrieved = await kvRepo.getSnip(kv, 'ttl-key')
      expect(retrieved).toEqual(meta)
    })
  })

  describe('keyExists', () => {
    it('should return true for existing key', async () => {
      const meta: SnipMeta = {
        key: 'exists',
        contentType: 'text/plain',
        filename: null,
        source: 'page',
        size: 10,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        r2Key: 'snips/exists/payload',
      }

      await kvRepo.putSnip(kv, 'exists', meta)
      const exists = await kvRepo.keyExists(kv, 'exists')
      expect(exists).toBe(true)
    })

    it('should return false for non-existent key', async () => {
      const exists = await kvRepo.keyExists(kv, 'non-existent')
      expect(exists).toBe(false)
    })
  })

  describe('deleteSnip', () => {
    it('should delete snip metadata', async () => {
      const meta: SnipMeta = {
        key: 'delete-me',
        contentType: 'text/plain',
        filename: null,
        source: 'page',
        size: 20,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        r2Key: 'snips/delete-me/payload',
      }

      await kvRepo.putSnip(kv, 'delete-me', meta)
      await kvRepo.deleteSnip(kv, 'delete-me')
      const retrieved = await kvRepo.getSnip(kv, 'delete-me')

      expect(retrieved).toBeNull()
    })
  })

  describe('listSnips', () => {
    it('should list all snip keys', async () => {
      const keys = ['key1', 'key2', 'key3']
      for (const key of keys) {
        const meta: SnipMeta = {
          key,
          contentType: 'text/plain',
          filename: null,
          source: 'page',
          size: 10,
          createdAt: new Date().toISOString(),
          expiresAt: null,
          r2Key: `snips/${key}/payload`,
        }
        await kvRepo.putSnip(kv, key, meta)
      }

      const result = await kvRepo.listSnips(kv)
      expect(result.keys).toHaveLength(3)
      expect(result.keys.sort()).toEqual(['key1', 'key2', 'key3'])
    })

    it('should return empty array when no snips exist', async () => {
      const result = await kvRepo.listSnips(kv)
      expect(result.keys).toHaveLength(0)
    })
  })
})
