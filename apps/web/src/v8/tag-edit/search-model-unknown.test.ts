import { describe, expect, it } from 'vitest'
import type { SavedSearch } from '@line-crm/shared'
import { headUsageText } from './search-model'

describe('保存した検索の使用先', () => {
  it.each(['constructor', 'toString', '__proto__', 'future'])('未知の種類 %s を安全に表示する', kind => {
    expect(headUsageText([{ kind, name: '確認用', mode: 'live' }] as SavedSearch['usedIn'])).toBe('種類を確認できません「確認用」で使っている')
  })
  it('既知の種類を表示する', () => {
    expect(headUsageText([{ kind: 'broadcast', name: 'お知らせ', mode: 'live' }] as SavedSearch['usedIn'])).toBe('一斉配信「お知らせ」で使っている')
  })
})
