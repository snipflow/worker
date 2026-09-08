const CUSTOM_METADATA_HEADER_PREFIX = 'x-snip-meta-'
export const MAX_CUSTOM_METADATA_SIZE = 8_192

const utf8Encoder = new TextEncoder()

/**
 * 浏览器请求头只接受 ASCII。前端可对 UTF-8 文件名使用 encodeURIComponent，
 * Worker 在写入 R2 customMetadata 前恢复原值。
 */
export function filenameFromHeader(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 从常见 Content-Disposition 形式中提取文件名。 */
export function filenameFromContentDisposition(
  contentDisposition: string | undefined
): string | undefined {
  if (!contentDisposition) return undefined

  const encoded = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/i.exec(contentDisposition)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim())
    } catch {
      return encoded.trim()
    }
  }

  const quoted = /(?:^|;)\s*filename="([^"]+)"/i.exec(contentDisposition)?.[1]
  if (quoted) return quoted

  return /(?:^|;)\s*filename=([^;]+)/i.exec(contentDisposition)?.[1]?.trim()
}

/**
 * 只接收显式声明为 snip metadata 的请求头，避免保存 Authorization、Cookie、
 * CF-*、Host 等认证或传输层信息。
 */
export function createCustomMetadata(
  headers: Headers,
  source: string,
  filename?: string
): Record<string, string> {
  const metadata: Record<string, string> = {}

  for (const [name, value] of headers) {
    if (name.startsWith(CUSTOM_METADATA_HEADER_PREFIX)) {
      const metadataKey = name.slice(CUSTOM_METADATA_HEADER_PREFIX.length)
      if (metadataKey) metadata[metadataKey] = value
    }
  }

  metadata.source = source
  if (filename) metadata.filename = filename
  return metadata
}

export function customMetadataSize(metadata: Record<string, string>): number {
  return Object.entries(metadata).reduce(
    (total, [key, value]) =>
      total
      + utf8Encoder.encode(key).byteLength
      + utf8Encoder.encode(value).byteLength,
    0
  )
}

export function contentDispositionForFilename(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `attachment; filename*=UTF-8''${encoded}`
}
