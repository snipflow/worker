/**
 * R2 payload 仓储层：封装正文对象及其 metadata 操作
 */

import type { SnipPayload } from '../domain/types'

export interface PutPayloadOptions {
  httpMetadata?: R2HTTPMetadata
  customMetadata?: Record<string, string>
  storageClass?: string
}

type ConditionalPutPayloadOptions = PutPayloadOptions & {
  onlyIf: R2Conditional | Headers
}

/**
 * 写入 payload 到 R2
 */
export async function putPayload(
  r2: R2Bucket,
  key: string,
  payload: SnipPayload,
  options: PutPayloadOptions = {}
): Promise<R2Object> {
  return await r2.put(`snips/${key}/payload`, payload, options)
}

/**
 * 仅在 ETag 条件成立时写入；条件冲突时返回 null。
 */
export async function putPayloadConditionally(
  r2: R2Bucket,
  key: string,
  payload: SnipPayload,
  options: ConditionalPutPayloadOptions
): Promise<R2Object | null> {
  return await r2.put(`snips/${key}/payload`, payload, options)
}

/**
 * 读取 R2 payload
 */
export async function getPayload(r2: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return await r2.get(`snips/${key}/payload`)
}

/**
 * 删除 R2 payload
 */
export async function deletePayload(r2: R2Bucket, key: string): Promise<void> {
  await r2.delete(`snips/${key}/payload`)
}

export async function deletePayloads(
  r2: R2Bucket,
  keys: string[]
): Promise<void> {
  if (keys.length === 0) return
  await r2.delete(keys.map(key => `snips/${key}/payload`))
}

export interface ListedPayload {
  key: string
  size: number
}

/**
 * 列出所有 R2 payload（用于定期清理任务）
 */
export async function listPayloads(
  r2: R2Bucket,
  cursor?: string
): Promise<{ items: ListedPayload[]; cursor?: string }> {
  const result = await r2.list({ prefix: 'snips/', cursor })
  const items = result.objects.map(obj => {
    const parts = obj.key.split('/')
    return {
      key: parts[1],
      size: obj.size,
    }
  })
  return {
    items,
    cursor: result.truncated ? result.cursor : undefined,
  }
}
