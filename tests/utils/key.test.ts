import { describe, it, expect } from 'vitest'
import { generateKey } from '../../src/utils/key'

describe('Key utilities', () => {
  describe('generateKey', () => {
    it('should generate a 5-character key', () => {
      const key = generateKey()
      expect(key).toHaveLength(5)
    })

    it('should only contain alphanumeric characters', () => {
      const key = generateKey()
      expect(key).toMatch(/^[0-9A-Za-z]{5}$/)
    })

    it('should generate unique keys', () => {
      const keys = new Set<string>()
      for (let i = 0; i < 100; i++) {
        keys.add(generateKey())
      }
      // 100 个 key 应该都不重复（概率极高）
      expect(keys.size).toBe(100)
    })
  })
})
