// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearStoredDraft,
  DRAFT_STORAGE_KEY,
  isStoredDraft,
  readStoredDraft,
  readStoredDrafts,
  writeStoredDraft,
} from './draft-storage'

beforeEach(() => {
  sessionStorage.clear()
})

describe('automations/create/draft-storage ガード', () => {
  it('空文字 ID・配列・プロトタイプ継承キーを下書きとして誤認しない', () => {
    expect(isStoredDraft({ id: '', draftVersionId: 'v1' })).toBe(false)
    expect(isStoredDraft({ id: 'd1', draftVersionId: '   ' })).toBe(false)
    expect(isStoredDraft([])).toBe(false)

    sessionStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        'acc-1': { id: 'd1', draftVersionId: 'v1' },
        'acc-empty': { id: '', draftVersionId: 'v1' },
        constructor: { id: 'bad', draftVersionId: 'v1' },
      }),
    )

    expect(readStoredDrafts()).toEqual({ 'acc-1': { id: 'd1', draftVersionId: 'v1' } })
    expect(readStoredDraft('toString')).toBeNull()
    expect(readStoredDraft('constructor')).toBeNull()
    expect(readStoredDraft('__proto__')).toBeNull()
    expect(readStoredDraft('acc-empty')).toBeNull()
    expect(readStoredDraft('acc-1')).toEqual({ id: 'd1', draftVersionId: 'v1' })
  })

  it('不正なキーや空 ID の書き込みを無視し、正常な下書きの保存・削除は保つ', () => {
    writeStoredDraft('__proto__', { id: 'bad', draftVersionId: 'v1' })
    writeStoredDraft('acc-1', { id: '   ', draftVersionId: 'v1' })
    expect(readStoredDrafts()).toEqual({})

    writeStoredDraft('acc-1', { id: 'draft-1', draftVersionId: 'v2' })
    expect(readStoredDraft('acc-1')).toEqual({ id: 'draft-1', draftVersionId: 'v2' })

    clearStoredDraft('acc-1')
    expect(readStoredDraft('acc-1')).toBeNull()
  })
})
