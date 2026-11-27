// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommonVarDetail } from '@/lib/api'
import { renderValueFields } from './edit-value-fields'

function baseContext(overrides: Partial<Parameters<typeof renderValueFields>[0]> = {}): Parameters<typeof renderValueFields>[0] {
  return {
    canWrite: false,
    expiryBehavior: 'stop',
    fallbackFieldError: '',
    fallbackValue: '',
    folderId: 'f-1',
    folders: [],
    foldersError: false,
    item: {
      id: 'cv-1',
      name: '営業時間',
      varKey: 'shop_hours',
      type: 'text',
      value: '10:00-20:00',
    } as unknown as CommonVarDetail,
    loadFolders: vi.fn().mockResolvedValue(undefined),
    memo: '',
    name: '営業時間',
    nameFieldError: '',
    periodFieldError: '',
    selectedAccountId: 'acc-1',
    setExpiryBehavior: vi.fn(),
    setFallbackValue: vi.fn(),
    setFolderId: vi.fn(),
    setFolders: vi.fn(),
    setMemo: vi.fn(),
    setName: vi.fn(),
    setNameFieldError: vi.fn(),
    setPeriodFieldError: vi.fn(),
    setSaved: vi.fn(),
    setValidFrom: vi.fn(),
    setValidUntil: vi.fn(),
    validFrom: '',
    validUntil: '',
    ...overrides,
  }
}

describe('common-vars-edit/edit-value-fields ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('閲覧のみでフォルダ取得に失敗したときは「未分類」と誤表示せず「確認できません」と出す', () => {
    render(<>{renderValueFields(baseContext({ canWrite: false, folderId: 'f-1', folders: [], foldersError: true }))}</>)
    expect(screen.getByDisplayValue('フォルダ：確認できません')).toBeTruthy()
    expect(screen.queryByDisplayValue('フォルダ：未分類')).toBeNull()
  })

  it('閲覧のみで未知の expiryBehavior を受け取っても「配信を止める」に決めつけず「確認できません」と出す', () => {
    render(<>{renderValueFields(baseContext({ canWrite: false, expiryBehavior: 'unknown_mode' as unknown as 'stop' }))}</>)
    expect(screen.getByDisplayValue('期間外の動き：確認できません')).toBeTruthy()
    expect(screen.queryByDisplayValue('期間外の動き：配信を止める')).toBeNull()
  })

  it('代わりの値にエラーがあるときは aria-invalid と aria-describedby がエラー文へ結び付く', () => {
    render(
      <>
        {renderValueFields(
          baseContext({
            canWrite: true,
            expiryBehavior: 'fallback',
            fallbackFieldError: '代わりの値を入力してください',
          }),
        )}
      </>,
    )
    const input = screen.getByLabelText('代わりの値')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe('cv-fallback-error')
    expect(document.getElementById('cv-fallback-error')?.textContent).toBe('代わりの値を入力してください')
  })
})
