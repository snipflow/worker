import { Hono } from 'hono'
import { requestIdMiddleware } from './middleware/request-id'
import { methodGuard, bodyLimitGuard } from './middleware/guard'
import { createCorsMiddleware } from './middleware/cors'
import { contentTypeGuard } from './middleware/content-type'
import { createAuthMiddleware } from './middleware/auth'
import { handleError } from './domain/errors'
import snipRoutes from './routes/snip'
import statsRoutes from './routes/stats'

const app = new Hono<{ Bindings: CloudflareBindings }>()

app.onError(handleError)

app.use('*', (c, next) => createCorsMiddleware(c.env)(c, next))
app.use('*', requestIdMiddleware)
app.use('*', bodyLimitGuard)
app.use('*', methodGuard)

app.get('/health', (c) => {
  return c.json({ ok: true })
})

app.get('/health/auth', (c, next) => createAuthMiddleware(c.env)(c, next), (c) => {
  return c.json({ ok: true, authed: true })
})

app.use('/snip/*', (c, next) => createAuthMiddleware(c.env)(c, next))
app.use('/stats', (c, next) => createAuthMiddleware(c.env)(c, next))
app.use('/snip', contentTypeGuard)

app.route('/snip', snipRoutes)
app.route('/stats', statsRoutes)

export default app
