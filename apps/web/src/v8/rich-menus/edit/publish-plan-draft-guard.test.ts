import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPublishPlanDraft,
  loadPublishPlanDraft,
  savePublishPlanDraft,
  type PublishPlanInput,
} from './publish-plan-draft'

class MemoryStorage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

const SCHEDULED: PublishPlanInput = {
  mode: 'scheduled',
  startsAt: '2026-10-01T10:00',
  endsAt: '',
  restoreGroupId: '',
}

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
})

describe('rich-menus/edit/publish-plan-draft の空ID・初期値判定ガード', () => {
  it('空や空白だけのメニューIDでは下書きを共有キーへ保存・読取・削除しない', () => {
    savePublishPlanDraft('', SCHEDULED)
    savePublishPlanDraft('   ', SCHEDULED)
    expect(storage.length).toBe(0)
    expect(loadPublishPlanDraft('')).toBeNull()
    expect(loadPublishPlanDraft('   ')).toBeNull()
    clearPublishPlanDraft('')
    expect(storage.length).toBe(0)
  })

  it('プロパティ順が異なる初期値オブジェクトを保存した時も不要な下書きを残さず削除する', () => {
    savePublishPlanDraft('g-1', SCHEDULED)
    expect(loadPublishPlanDraft('g-1')).toEqual(SCHEDULED)

    const reorderedDefault: PublishPlanInput = {
      restoreGroupId: '',
      endsAt: '',
      startsAt: '',
      mode: 'now',
    }
    savePublishPlanDraft('g-1', reorderedDefault)
    expect(loadPublishPlanDraft('g-1')).toBeNull()
    expect(storage.length).toBe(0)
  })
})
