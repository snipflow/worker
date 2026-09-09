import { z } from 'zod'
import { InternalError } from '../domain/errors'
import type { SnipMeta } from '../domain/types'

const SnipMetaSchema = z.strictObject({
  key: z.string().min(1),
  contentType: z.string().min(1),
  filename: z.string().min(1).nullable(),
  source: z.string().min(1),
  size: z.number().int().nonnegative(),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  r2Key: z.string().min(1),
}) satisfies z.ZodType<SnipMeta>

function parseSnipMeta(raw: string): SnipMeta {
  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new InternalError('Invalid snip metadata in KV')
  }

  const result = SnipMetaSchema.safeParse(parsed)
  if (!result.success) {
    throw new InternalError('Invalid snip metadata in KV')
  }

  return result.data
}

/**
 * KV 仓储层：封装对 Cloudflare KV 的所有操作
 */

/**
 * 获取单个 snip 的元数据
 */
export async function getSnip(kv: KVNamespace, key: string): Promise<SnipMeta | null> {
  const raw = await kv.get(`snip:${key}`)
  if (!raw) return null
  return parseSnipMeta(raw)
}

/**
 * 检查 snip key 是否已存在
 */
export async function keyExists(kv: KVNamespace, key: string): Promise<boolean> {
  const raw = await kv.get(`snip:${key}`)
  return raw !== null
}

/**
 * 写入 snip 元数据
 */
export async function putSnip(
  kv: KVNamespace,
  key: string,
  meta: SnipMeta,
  expirationTtl?: number
): Promise<void> {
  const options = expirationTtl ? { expirationTtl } : undefined
  await kv.put(`snip:${key}`, JSON.stringify(meta), options)
}

/**
 * 删除 snip 元数据
 */
export async function deleteSnip(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(`snip:${key}`)
}

/**
 * 列出所有 snip（分页）
 */
export async function listSnips(
  kv: KVNamespace,
  limit = 100,
  cursor?: string
): Promise<{ keys: string[]; cursor?: string }> {
  const result = await kv.list({ prefix: 'snip:', limit, cursor })
  // 从 KV key 中提取 snip key（去掉 'snip:' 前缀）
  const keys = result.keys.map(k => k.name.replace(/^snip:/, ''))
  return {
    keys,
    cursor: result.list_complete ? undefined : result.cursor,
  }
}
