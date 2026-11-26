import { describe, expect, it } from 'vitest'
import { mediaUsageKindText, UNKNOWN_USAGE_KIND } from './media-usage-display'
import { inputTypeLabel } from '@/v8/form-edit/model'
import { permissionLabel } from '@/v8/settings/staff/permission-labels'

describe('知らない使用先とフォームの種類', () => {
  it.each(['constructor', 'toString', '__proto__', 'future'])('%s を安全に表示する', value => {
    expect(mediaUsageKindText(value)).toBe(UNKNOWN_USAGE_KIND)
    expect(inputTypeLabel({ type: value } as Parameters<typeof inputTypeLabel>[0])).toBe('種類を確認できません')
    expect(permissionLabel(value)).toBe('')
  })
})
