import type { MiddlewareHandler } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { InternalError, UnauthorizedError } from '../domain/errors'

async function tokensMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])

  return crypto.subtle.timingSafeEqual(providedDigest, expectedDigest)
}

export const createAuthMiddleware = (env: CloudflareBindings): MiddlewareHandler => {
  return bearerAuth({
    verifyToken: async (token: string) => {
      try {
        const expectedToken = await env.SNIPFLOW_API_TOKEN.get()
        return tokensMatch(token, expectedToken)
      } catch {
        console.error('SNIPFLOW_API_TOKEN secret access failed')
        throw new InternalError('Authentication configuration unavailable')
      }
    },
    invalidToken: {
      message: () => { throw new UnauthorizedError() }
    },
    noAuthenticationHeader: {
      message: () => { throw new UnauthorizedError() }
    }
  })
}
