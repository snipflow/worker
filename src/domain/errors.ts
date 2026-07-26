import type { Context } from 'hono'

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number
  ) {
    super(message)
    this.name = this.constructor.name
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 'UNAUTHORIZED', 401)
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 'NOT_FOUND', 404)
  }
}

export class InvalidInputError extends AppError {
  constructor(message: string) {
    super(message, 'INVALID_INPUT', 400)
  }
}

export class MethodNotAllowedError extends AppError {
  constructor(message = 'Method not allowed') {
    super(message, 'METHOD_NOT_ALLOWED', 405)
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Payload too large') {
    super(message, 'PAYLOAD_TOO_LARGE', 413)
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'Unsupported media type') {
    super(message, 'UNSUPPORTED_MEDIA_TYPE', 415)
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal server error') {
    super(message, 'INTERNAL_ERROR', 500)
  }
}

export function handleError(err: Error, c: Context) {
  const requestId = c.get('requestId')
  const disguise = c.env.SNIPFLOW_DISGUISE === 'true'

  if (err instanceof AppError) {
    if (disguise) {
      console.error(`[error] requestId=${requestId} code=${err.code} status=${err.status} message=${err.message}`)
      return c.html('<html><body><h1>Hello World</h1></body></html>', 200)
    }
    const { code, message, status } = err
    return c.json({ error: { code, message, requestId } }, status as 400 | 401 | 404 | 405 | 413 | 415 | 500)
  }

  console.error(`[error] requestId=${requestId} unexpected error:`, err)
  if (disguise) {
    return c.html('<html><body><h1>Hello World</h1></body></html>', 200)
  }
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId } }, 500)
}

