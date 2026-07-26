import type { MiddlewareHandler } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { UnauthorizedError } from '../domain/errors'

export const createAuthMiddleware = (env: CloudflareBindings): MiddlewareHandler => {
  return bearerAuth({
    verifyToken: async (token: string) => {
      return token === env.SNIPFLOW_API_TOKEN
    },
    invalidToken: {
      message: () => { throw new UnauthorizedError() }
    },
    noAuthenticationHeader: {
      message: () => { throw new UnauthorizedError() }
    }
  })
}
