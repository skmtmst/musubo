import { describe, expect, it } from 'vitest'
import { safePhotoSrc } from './src'

describe('nen-posts/src のURL安全検査ガード', () => {
  it('バックスラッシュ相対URL・制御文字混入・ホスト欠落の https URL を拒否する', () => {
    expect(safePhotoSrc('/\\evil.example.com/x.jpg')).toBeNull()
    expect(safePhotoSrc('https://')).toBeNull()
    expect(safePhotoSrc('https://[invalid')).toBeNull()
    expect(safePhotoSrc('https://example.com/photo.jpg\nX-Injected: 1')).toBeNull()
    expect(safePhotoSrc('/api/nen-members/photos/1\r\n')).toBeNull()
  })

  it('正規の https・相対パス・localhost・data:image はそのまま通す', () => {
    expect(safePhotoSrc('https://example.com/photos/1.jpg')).toBe('https://example.com/photos/1.jpg')
    expect(safePhotoSrc('/api/nen-members/photos/1/image')).toBe('/api/nen-members/photos/1/image')
    expect(safePhotoSrc('http://localhost:8788/1.jpg')).toBe('http://localhost:8788/1.jpg')
    expect(safePhotoSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
  })
})
