/**
 * Snip 时效策略
 */
export type SnipExpiry =
  | { mode: 'forever' }
  | { mode: 'ttl'; ttl: number }

/**
 * 创建 Snip 的请求输入
 */
export interface CreateSnipInput {
  key: string
  type: 'text' | 'image' | 'file'
  content: string
  source: string
  expiry: SnipExpiry
  overwrite?: boolean // 可选，为 true 时强制覆盖已存在的 key
}

/**
 * Snip 元数据（存储在 KV 中）
 */
export interface SnipMeta {
  key: string
  type: 'text' | 'image' | 'file'
  source: string
  size: number
  createdAt: string
  expiresAt: string | null
  r2Key: string
}
