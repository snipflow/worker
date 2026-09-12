import { adminSecretsStore } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

export const TEST_API_TOKEN = 'test-token-for-development'

export async function ensureTestApiToken(): Promise<void> {
  const admin = adminSecretsStore(env.SNIPFLOW_API_TOKEN)
  const existing = (await admin.list())[0]

  if (existing?.metadata?.uuid) {
    await admin.update(TEST_API_TOKEN, existing.metadata.uuid)
    return
  }

  await admin.create(TEST_API_TOKEN)
}
