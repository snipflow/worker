import { z } from 'zod'

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

const MediaTypeSchema = z
  .string()
  .min(1, { error: 'Content-Type 不得为空' })
  .refine(
    value => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;.*)?$/.test(value),
    { error: 'Content-Type 必须是合法的 MIME 类型' }
  )

const PositiveIntegerHeaderSchema = z
  .string()
  .regex(/^\d+$/, { error: 'X-Snip-TTL 必须是正整数秒数' })
  .transform(Number)
  .pipe(z.number().int().positive())

const HttpDateSchema = z
  .string()
  .refine(value => Number.isFinite(Date.parse(value)), {
    error: 'Expires 必须是合法的 HTTP 日期',
  })
  .transform(value => new Date(value))

/**
 * POST /snip 的控制参数和 R2 HTTP metadata 均来自请求头。
 * 缺少 X-Snip-Key 时由服务端生成 key，缺少 X-Snip-TTL 时永久保存。
 */
export const CreateSnipHeadersSchema = z.strictObject({
  key: z.union([z.literal(''), SnipKeySchema]),
  source: z.string().min(1, { error: 'X-Snip-Source 不得为空' }).max(256),
  filename: z
    .string()
    .min(1, { error: 'X-Snip-Filename 不得为空' })
    .max(1024)
    .optional(),
  ttl: PositiveIntegerHeaderSchema.optional(),
  overwrite: z
    .enum(['true', 'false'], { error: 'X-Snip-Overwrite 必须是 true 或 false' })
    .transform(value => value === 'true'),
  contentType: MediaTypeSchema,
  contentLanguage: z.string().min(1).optional(),
  contentDisposition: z.string().min(1).optional(),
  contentEncoding: z.string().min(1).optional(),
  cacheControl: z.string().min(1).optional(),
  cacheExpiry: HttpDateSchema.optional(),
})

export type ParsedCreateSnipHeaders = z.infer<typeof CreateSnipHeadersSchema>
