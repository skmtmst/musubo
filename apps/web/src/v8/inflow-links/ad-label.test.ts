import { describe, expect, it } from 'vitest'
import type { AdPlatform } from '@/lib/api'
import { adPlatformLabel } from './ad-shared'

const platform = (name: string, displayName: string | null): AdPlatform => ({ id: 'p', name, displayName, config: {}, isActive: true, lineAccountId: 'a', createdAt: '', updatedAt: '' })

describe('広告媒体名', () => {
  it('既知の媒体と未指定を表示する', () => {
    expect(adPlatformLabel(platform('google', '別名'))).toBe('Google広告')
    expect(adPlatformLabel(undefined)).toBe('—')
  })
  it.each(['constructor', 'toString', '__proto__', 'future'])('未知の媒体 %s には登録された表示名を使う', name => {
    expect(adPlatformLabel(platform(name, '新しい媒体'))).toBe('新しい媒体')
    expect(adPlatformLabel(platform(name, null))).toBe(name)
  })
})
