import type { MiddlewareHandler } from 'hono'
import { UnsupportedMediaTypeError } from '../domain/errors'

export const contentTypeGuard: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'POST' || c.req.method === 'PUT') {
    const contentType = c.req.header('content-type')
    if (!contentType || !contentType.includes('application/json')) {
      throw new UnsupportedMediaTypeError()
    }
  }
  await next()
}
