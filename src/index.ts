import app from './app'
import { cleanupOrphanedPayloads } from './jobs/cleanup'

const worker = {
  fetch: app.fetch,
  async scheduled(
    controller: ScheduledController,
    env: CloudflareBindings,
    _ctx: ExecutionContext
  ): Promise<void> {
    try {
      const result = await cleanupOrphanedPayloads(env)
      console.log(JSON.stringify({
        message: 'orphaned payload cleanup completed',
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
        ...result,
      }))
    } catch (error) {
      console.error(JSON.stringify({
        message: 'orphaned payload cleanup failed',
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
        error: error instanceof Error ? error.message : String(error),
      }))
      throw error
    }
  },
} satisfies ExportedHandler<CloudflareBindings>

export default worker
