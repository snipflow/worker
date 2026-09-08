import { describe, expect, it } from 'vitest'
import {
  contentDispositionForFilename,
  createCustomMetadata,
  customMetadataSize,
  filenameFromContentDisposition,
  filenameFromHeader,
} from '../../src/utils/r2-metadata'

describe('R2 metadata utilities', () => {
  it('decodes browser-safe UTF-8 filename headers', () => {
    expect(filenameFromHeader('%E8%AF%B4%E6%98%8E.md')).toBe('说明.md')
    expect(filenameFromHeader('plain.txt')).toBe('plain.txt')
  })

  it('extracts standard and RFC 5987 content-disposition filenames', () => {
    expect(filenameFromContentDisposition(
      'attachment; filename="report.pdf"'
    )).toBe('report.pdf')
    expect(filenameFromContentDisposition(
      "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf"
    )).toBe('报告.pdf')
  })

  it('stores only explicit custom metadata and canonical fields', () => {
    const headers = new Headers({
      Authorization: 'Bearer secret',
      Cookie: 'session=secret',
      'CF-Ray': 'transport-only',
      'X-Snip-Meta-Category': 'report',
      'X-Snip-Meta-Source': 'cannot-override',
      'X-Snip-Meta-Filename': 'cannot-override.txt',
    })

    expect(createCustomMetadata(headers, 'page', 'report.pdf')).toEqual({
      category: 'report',
      source: 'page',
      filename: 'report.pdf',
    })
  })

  it('counts UTF-8 bytes for the R2 metadata limit', () => {
    expect(customMetadataSize({ filename: '报告.pdf' })).toBe(
      new TextEncoder().encode('filename报告.pdf').byteLength
    )
  })

  it('generates an ASCII RFC 5987 download header', () => {
    expect(contentDispositionForFilename('报告 (1).pdf')).toBe(
      "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%281%29.pdf"
    )
  })
})
