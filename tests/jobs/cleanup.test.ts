/// <reference types="@cloudflare/vitest-pool-workers/types" />
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import type { SnipMeta } from '../../src/domain/types'
import { cleanupOrphanedPayloads } from '../../src/jobs/cleanup'
import { putSnip } from '../../src/repositories/kv'
import { getPayload, putPayload } from '../../src/repositories/r2-payload'
import {
  getStorageStats,
  updateStorageStats,
} from '../../src/repositories/r2-stats'

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
    await updateStorageStats(env.SNIPFLOW_R2, {
      count: 2,
      totalSize: 14,
    })
    await putSnip(env.SNIPFLOW_KV, 'retained', metadata('retained'))

    const result = await cleanupOrphanedPayloads(env)

    expect(result).toEqual({ scanned: 2, deleted: 1 })
    const retained = await getPayload(env.SNIPFLOW_R2, 'retained')
    expect(await retained?.text()).toBe('content')
    expect(await getPayload(env.SNIPFLOW_R2, 'orphaned')).toBeNull()
    expect(await env.SNIPFLOW_R2.get('unrelated/object')).not.toBeNull()
    await expect(getStorageStats(env.SNIPFLOW_R2)).resolves.toEqual({
      count: 1,
      totalSize: 7,
    })
  })

  it('restores stats when orphan deletion fails', async () => {
    await putPayload(env.SNIPFLOW_R2, 'failed-orphan', 'content')
    await updateStorageStats(env.SNIPFLOW_R2, {
      count: 1,
      totalSize: 7,
    })
    const deleteSpy = vi
      .spyOn(env.SNIPFLOW_R2, 'delete')
      .mockRejectedValueOnce(new Error('simulated batch delete failure'))

    try {
      await expect(cleanupOrphanedPayloads(env))
        .rejects.toThrowError('simulated batch delete failure')
    } finally {
      deleteSpy.mockRestore()
    }

    expect(await getPayload(env.SNIPFLOW_R2, 'failed-orphan')).not.toBeNull()
    await expect(getStorageStats(env.SNIPFLOW_R2)).resolves.toEqual({
      count: 1,
      totalSize: 7,
    })
  })

  it('is wired to the Worker scheduled handler', async () => {
    await putPayload(env.SNIPFLOW_R2, 'scheduled-orphan', 'content')
    await updateStorageStats(env.SNIPFLOW_R2, {
      count: 1,
      totalSize: 7,
    })
    const controller = createScheduledController({ cron: '0 * * * *' })
    const ctx = createExecutionContext()

    await worker.scheduled(controller, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(await getPayload(env.SNIPFLOW_R2, 'scheduled-orphan')).toBeNull()
    await expect(getStorageStats(env.SNIPFLOW_R2)).resolves.toEqual({
      count: 0,
      totalSize: 0,
    })
  })

  it('propagates scheduled cleanup failures after logging them', async () => {
    await putPayload(env.SNIPFLOW_R2, 'uncounted-orphan', 'content')
    const controller = createScheduledController({ cron: '0 * * * *' })
    const ctx = createExecutionContext()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await expect(worker.scheduled(controller, env, ctx))
        .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    } finally {
      errorSpy.mockRestore()
    }

    expect(await getPayload(env.SNIPFLOW_R2, 'uncounted-orphan'))
      .not.toBeNull()
  })
})
