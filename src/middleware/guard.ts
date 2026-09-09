import type { MiddlewareHandler } from 'hono'
import {
  InternalError,
  MethodNotAllowedError,
  PayloadTooLargeError,
} from '../domain/errors'

const ALLOWED_METHODS = ['GET', 'POST', 'DELETE']

export const methodGuard: MiddlewareHandler = async (c, next) => {
  if (!ALLOWED_METHODS.includes(c.req.method)) {
    throw new MethodNotAllowedError()
  }
  await next()
}

export function maxSnipSize(
  bindings: {
    SNIPFLOW_MAX_SNIP_SIZE: string
  }
): number {
  const configured = Number(bindings.SNIPFLOW_MAX_SNIP_SIZE)
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new InternalError('Invalid SNIPFLOW_MAX_SNIP_SIZE configuration')
  }
  return configured
}

/**
 * Content-Length 可用时提前拒绝；最终以 R2 返回的实际对象大小为准。
 */
export const bodyLimitGuard: MiddlewareHandler<{
  Bindings: CloudflareBindings
}> = async (c, next) => {
  if (c.req.method === 'POST') {
    const contentLength = c.req.header('content-length')
    if (contentLength) {
      const parsed = Number(contentLength)
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new PayloadTooLargeError('Invalid Content-Length')
      }
      if (parsed > maxSnipSize(c.env)) {
        throw new PayloadTooLargeError()
      }
    }
  }
  await next()
}
