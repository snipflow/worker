import { describe, it, expect } from 'vitest'
import { ttlToExpiresAt, nowISO } from '../../src/utils/time'

describe('Time utilities', () => {
  describe('ttlToExpiresAt', () => {
    it('should convert TTL to ISO timestamp', () => {
      const ttl = 3600 // 1 hour
      const now = Date.now()
      const expiresAt = ttlToExpiresAt(ttl)
      const expiresAtTime = new Date(expiresAt).getTime()

      // 允许少量误差（测试执行时间）
      expect(expiresAtTime).toBeGreaterThanOrEqual(now + ttl * 1000 - 100)
      expect(expiresAtTime).toBeLessThanOrEqual(now + ttl * 1000 + 100)
    })

    it('should return valid ISO 8601 format', () => {
      const expiresAt = ttlToExpiresAt(60)
      expect(expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })
  })

  describe('nowISO', () => {
    it('should return current time in ISO format', () => {
      const now = nowISO()
      expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })

    it('should return time close to Date.now()', () => {
      const before = Date.now()
      const iso = nowISO()
      const after = Date.now()
      const isoTime = new Date(iso).getTime()

      expect(isoTime).toBeGreaterThanOrEqual(before)
      expect(isoTime).toBeLessThanOrEqual(after)
    })
  })
})
