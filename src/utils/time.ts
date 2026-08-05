/**
 * 将 TTL（秒）转换为过期时间戳（ISO 8601 格式）
 */
export function ttlToExpiresAt(ttl: number): string {
  const now = Date.now()
  const expiresAt = new Date(now + ttl * 1000)
  return expiresAt.toISOString()
}

/**
 * 获取当前时间（ISO 8601 格式）
 */
export function nowISO(): string {
  return new Date().toISOString()
}
