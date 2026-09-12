import type { MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'

const ALLOWED_METHODS = ['GET', 'POST', 'DELETE', 'OPTIONS']
const ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Content-Language',
  'Content-Disposition',
  'Content-Encoding',
  'Cache-Control',
  'Expires',
  'X-Snip-Key',
  'X-Snip-Source',
  'X-Snip-Filename',
  'X-Snip-TTL',
  'X-Snip-Overwrite',
]
const EXPOSED_HEADERS = [
  'Content-Length',
  'Content-Disposition',
  'ETag',
  'X-Request-Id',
]

function parseOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}

function isAllowedHeader(header: string): boolean {
  const normalized = header.toLowerCase()
  return ALLOWED_HEADERS.some((allowed) => allowed.toLowerCase() === normalized) ||
    normalized.startsWith('x-snip-meta-')
}

function requestedAllowedHeaders(requested: string | undefined): string[] {
  if (!requested) {
    return ALLOWED_HEADERS
  }

  const allowedHeaders = requested
    .split(',')
    .map((header) => header.trim())
    .filter((header) => header && isAllowedHeader(header))

  return allowedHeaders.length > 0
    ? allowedHeaders
    : ['X-Snipflow-Cors-Rejected']
}

export function createCorsMiddleware(
  env: Pick<CloudflareBindings, 'SNIPFLOW_CORS_ORIGINS'>,
): MiddlewareHandler {
  const origins = parseOrigins(env.SNIPFLOW_CORS_ORIGINS)

  return async (c, next) => {
    const handler = cors({
      origin: origins,
      allowMethods: ALLOWED_METHODS,
      allowHeaders: requestedAllowedHeaders(
        c.req.header('Access-Control-Request-Headers'),
      ),
      exposeHeaders: EXPOSED_HEADERS,
      maxAge: 600,
    })

    return handler(c, next)
  }
}
