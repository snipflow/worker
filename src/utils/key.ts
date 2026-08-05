import { customAlphabet } from 'nanoid'

/**
 * 生成随机 snip key
 * 使用数字和大小写字母（62个字符），5位长度
 * 理论组合数：62^5 ≈ 916 百万
 */
const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 5)

export function generateKey(): string {
  return nanoid()
}
