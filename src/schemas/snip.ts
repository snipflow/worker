import { z } from 'zod'
import type { CreateSnipInput, SnipExpiry } from '../domain/types'

export const DEFAULT_MAX_SNIP_SIZE = 10 * 1024 * 1024

const utf8Encoder = new TextEncoder()
const SnipTypeSchema = z.enum(['text', 'image', 'file'])

export const SnipKeySchema = z
  .string()
  .min(1, { error: 'key 不得为空' })
  .max(128, { error: 'key 不得超过 128 个字符' })
  .regex(/^[A-Za-z0-9_-]+$/, { error: 'key 只能包含字母、数字、下划线和连字符' })

export const SnipKeyParamsSchema = z.strictObject({
  key: SnipKeySchema,
})

export const ListSnipsQuerySchema = z.strictObject({
  cursor: z.string().min(1, { error: 'cursor 不得为空' }).optional(),
})

export const ExpirySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('forever') }),
  z.strictObject({
    mode: z.literal('ttl'),
    ttl: z.number().int().positive(),
  }),
]) satisfies z.ZodType<SnipExpiry>

/**
 * 构造创建请求 Schema。
 * maxSnipSize 以 UTF-8 字节数计，与 R2 中记录的 payload 大小保持一致。
 */
export function createCreateSnipSchema(maxSnipSize: number) {
  if (!Number.isSafeInteger(maxSnipSize) || maxSnipSize <= 0) {
    throw new RangeError('maxSnipSize must be a positive safe integer')
  }

  return z.strictObject({
    key: z.union([z.literal(''), SnipKeySchema]),
    type: SnipTypeSchema,
    content: z
      .string()
      .min(1, { error: 'content 不得为空' })
      .refine(content => utf8Encoder.encode(content).byteLength <= maxSnipSize, {
        error: `content 不得超过 ${maxSnipSize} 字节`,
      }),
    source: z.string().min(1, { error: 'source 不得为空' }),
    expiry: ExpirySchema,
    overwrite: z.boolean().optional().default(false),
  }) satisfies z.ZodType<CreateSnipInput>
}

/** 默认 Schema；路由层应使用 createCreateSnipSchema 传入环境变量中的上限。 */
export const CreateSnipSchema = createCreateSnipSchema(DEFAULT_MAX_SNIP_SIZE)
