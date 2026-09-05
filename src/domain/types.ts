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

/**
 * 创建成功响应 DTO（不包含内部 R2 路径）
 */
export type CreateSnipResponse = Omit<SnipMeta, 'r2Key'>

/**
 * 读取成功响应 DTO
 */
export type ReadSnipResponse = CreateSnipResponse & {
  content: string
}

/**
 * 列表项 DTO
 */
export type ListSnipItem = Pick<
  SnipMeta,
  'key' | 'type' | 'size' | 'createdAt' | 'expiresAt'
>

export interface ListSnipsResponse {
  items: ListSnipItem[]
  cursor?: string
}

export interface Stats {
  count: number
  totalSize: number
  storageLimit: number
}
