/**
 * Snip 时效策略
 */
export type SnipExpiry =
  | { mode: 'forever' }
  | { mode: 'ttl'; ttl: number }

export type SnipPayload =
  | ReadableStream
  | ArrayBuffer
  | ArrayBufferView
  | string
  | null
  | Blob

/**
 * 创建 Snip 的请求输入
 */
export interface CreateSnipInput {
  key: string
  source: string
  expiry: SnipExpiry
  overwrite: boolean
  maxSize: number
  payload: SnipPayload
  httpMetadata: R2HTTPMetadata
  customMetadata: Record<string, string>
}

/**
 * Snip 元数据（存储在 KV 中）
 */
export interface SnipMeta {
  key: string
  contentType: string
  filename: string | null
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
 * 列表项 DTO
 */
export type ListSnipItem = Pick<
  SnipMeta,
  'key' | 'contentType' | 'filename' | 'size' | 'createdAt' | 'expiresAt'
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
