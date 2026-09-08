/**
 * R2 仓储层：封装对 Cloudflare R2 的所有操作
 */

import type { SnipPayload } from '../domain/types'

export interface PutPayloadOptions {
  httpMetadata?: R2HTTPMetadata
  customMetadata?: Record<string, string>
  storageClass?: string
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

/**
 * 列出所有 R2 payload（用于定期清理任务）
 */
export async function listPayloads(
  r2: R2Bucket,
  cursor?: string
): Promise<{ keys: string[]; cursor?: string }> {
  const result = await r2.list({ prefix: 'snips/', cursor })
  // 从 R2 key 中提取 snip key（格式：snips/{key}/payload）
  const keys = result.objects.map(obj => {
    const parts = obj.key.split('/')
    return parts[1] // snips/{key}/payload -> key
  })
  return {
    keys,
    cursor: result.truncated ? result.cursor : undefined,
  }
}
