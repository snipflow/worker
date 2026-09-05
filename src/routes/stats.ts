import { Hono } from 'hono'
import type { Stats } from '../domain/types'
import { getStats } from '../services/stats'

const statsRoutes = new Hono<{ Bindings: CloudflareBindings }>()

statsRoutes.get('/', async c => {
  const stats = await getStats(c.env)
  const response = {
    count: stats.count,
    totalSize: stats.totalSize,
    storageLimit: stats.storageLimit,
  } satisfies Stats

  return c.json(response)
})

export default statsRoutes
