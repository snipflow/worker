import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { MethodNotAllowedError, PayloadTooLargeError } from '../domain/errors'

const ALLOWED_METHODS = ['GET', 'POST', 'DELETE']
const CLOUDFLARE_WORKERS_MAX_BODY_SIZE = 100 * 1024 * 1024 // 100 MB (Free plan limit)

export const methodGuard: MiddlewareHandler = async (c, next) => {
  if (!ALLOWED_METHODS.includes(c.req.method)) {
    throw new MethodNotAllowedError()
  }
  await next()
}

export const bodyLimitGuard = bodyLimit({
  maxSize: CLOUDFLARE_WORKERS_MAX_BODY_SIZE,
  onError: (_c: Context) => {
    throw new PayloadTooLargeError()
  }
})
