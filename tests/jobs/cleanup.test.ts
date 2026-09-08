/// <reference types="@cloudflare/vitest-pool-workers/types" />
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../../src/index'
import type { SnipMeta } from '../../src/domain/types'
import { cleanupOrphanedPayloads } from '../../src/jobs/cleanup'
import { putSnip } from '../../src/repositories/kv'
import { getPayload, putPayload } from '../../src/repositories/r2'

function metadata(key: string): SnipMeta {
  return {
    key,
    contentType: 'text/plain',
    filename: null,
    source: 'page',
    size: 7,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    r2Key: 'snips/' + key + '/payload',
  }
}

async function clearStorage(): Promise<void> {
  let kvCursor: string | undefined
  do {
    const page = await env.SNIPFLOW_KV.list({ prefix: 'snip:', cursor: kvCursor })
    await Promise.all(page.keys.map(key => env.SNIPFLOW_KV.delete(key.name)))
    kvCursor = page.list_complete ? undefined : page.cursor
  } while (kvCursor)

  let r2Cursor: string | undefined
  do {
    const page = await env.SNIPFLOW_R2.list({ cursor: r2Cursor })
    await Promise.all(page.objects.map(object => env.SNIPFLOW_R2.delete(object.key)))
    r2Cursor = page.truncated ? page.cursor : undefined
  } while (r2Cursor)
}

beforeEach(clearStorage)

describe('orphaned payload cleanup', () => {
  it('keeps payloads with KV metadata and deletes orphaned payloads', async () => {
    await Promise.all([
      putPayload(env.SNIPFLOW_R2, 'retained', 'content'),
      putPayload(env.SNIPFLOW_R2, 'orphaned', 'content'),
      env.SNIPFLOW_R2.put('unrelated/object', 'content'),
    ])
    await putSnip(env.SNIPFLOW_KV, 'retained', metadata('retained'))

    const result = await cleanupOrphanedPayloads(env)

    expect(result).toEqual({ scanned: 2, deleted: 1 })
    const retained = await getPayload(env.SNIPFLOW_R2, 'retained')
    expect(await retained?.text()).toBe('content')
    expect(await getPayload(env.SNIPFLOW_R2, 'orphaned')).toBeNull()
    expect(await env.SNIPFLOW_R2.get('unrelated/object')).not.toBeNull()
  })

  it('is wired to the Worker scheduled handler', async () => {
    await putPayload(env.SNIPFLOW_R2, 'scheduled-orphan', 'content')
    const controller = createScheduledController({ cron: '0 * * * *' })
    const ctx = createExecutionContext()

    await worker.scheduled(controller, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(await getPayload(env.SNIPFLOW_R2, 'scheduled-orphan')).toBeNull()
  })
})
