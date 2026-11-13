// @vitest-environment happy-dom
/*
 * 詳細条件の窓・保存した検索の窓の検索条件の扱いを、描いて押して確かめる。
 *
 * - FRIEND-01 対象は 1 か所の 4 択。リセットは「表示中」へ戻す。「すべて」で条件が無ければ conditions を送らない
 * - FRIEND-02 同じ項目の条件を複数並べても全部残す
 * - FRIEND-04/32 適用中の編集状態・並び順・件数から再開する。無変更の再適用は保存 ID を残す
 * - FRIEND-05 対応状況は「保留」を含む固定 4 状態
 * - A03-02 件数の遅い応答を採用せず、失敗は「確認できません」と再試行を出す
 * - FRIEND-20/29 保存した検索は対象と全部の条件を適用前に読め、長い名前も title で読める
 * - 保存した検索の適用は実条件を編集状態へ戻して渡す
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FriendSavedView } from '@/lib/api'

const fx = vi.hoisted(() => ({ list: vi.fn(), savedList: vi.fn() }))

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

vi.mock('@/components/shared/select', () => ({
  default: ({ options, value, onChange, 'aria-label': label, disabled }: { options: { value: string; label: string }[]; value: string; onChange: (value: string) => void; 'aria-label'?: string; disabled?: boolean }) => (
    <select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}))
vi.mock('@/lib/api/helpers/gap3', async original => ({
  ...await original<typeof import('@/lib/api/helpers/gap3')>(),
  memberRanksApi: { program: async () => ({ success: false, error: 'off' }) },
}))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      friends: { ...actual.api.friends, list: fx.list },
      friendSavedViews: { ...actual.api.friendSavedViews, list: fx.savedList },
    },
  }
})

import AdvancedSearchDialog, { type AdvancedSearchResult } from './advanced-search-dialog'
import SavedSearchDialog from './saved-search-dialog'
import { conditionsToEditorState, type FriendSearchEditorState } from './saved-search-utils'

const onApply = vi.fn()

function openDialog(props: { applied?: AdvancedSearchResult | null; initialSort?: 'recent' | 'oldest'; initialLimit?: number } = {}) {
  render(
    <AdvancedSearchDialog
      open
      accountId="account-a"
      tags={[]}
      fieldNames={[]}
      marks={[]}
      scenarios={[]}
      onClose={() => {}}
      onApply={onApply}
      applied={props.applied ?? null}
      initialSort={props.initialSort ?? 'recent'}
      initialLimit={props.initialLimit ?? 20}
      features={{ savedSearch: false, marks: false, fields: false }}
    />,
  )
  return screen.getByRole('dialog')
}

const radio = (dialog: HTMLElement, label: string) => within(dialog).getByRole<HTMLInputElement>('radio', { name: label })
function apply(dialog: HTMLElement) {
  const button = within(dialog).getAllByRole('button').find(item => /この条件で表示|人を表示/.test(item.textContent ?? ''))!
  fireEvent.click(button)
  return onApply.mock.calls.at(-1)?.[0] as AdvancedSearchResult
}
const editor = (patch: Partial<FriendSearchEditorState>): FriendSearchEditorState => ({
  blocks: [{ kind: 'name', keyword: '' }, { kind: 'tag', include: [], exclude: [] }],
  any: [],
  extraAll: [],
  visibility: 'visible',
  ...patch,
})

beforeEach(() => {
  onApply.mockReset()
  fx.list.mockReset().mockResolvedValue({ success: true, data: { items: [], total: 7 } })
  fx.savedList.mockReset()
})

afterEach(() => {
  cleanup()
  document.body.style.overflow = ''
})

describe('FRIEND-01 対象の選択は1か所の4択', () => {
  it('表示中・非表示のみ・ブロックした人・すべてを1つのグループで選び、既定は表示中', () => {
    const dialog = openDialog()
    const group = within(dialog).getByRole('group', { name: '表示する友だち' })
    expect(within(group).getAllByRole('radio').map(item => item.getAttribute('aria-label') ?? item.closest('label')?.textContent?.trim())).toEqual(['表示中', '非表示のみ', 'ブロックした人', 'すべて'])
    expect(radio(dialog, '表示中').checked).toBe(true)
  })

  it('選んだ対象を送る条件へ別々の意味で載せる', () => {
    const dialog = openDialog()
    fireEvent.click(radio(dialog, '非表示のみ'))
    expect(apply(dialog).params.conditions?.visibility).toBe('hidden_only')
    fireEvent.click(radio(dialog, 'ブロックした人'))
    const blocked = apply(dialog).params
    expect(blocked.visibility).toBe('blocked')
    expect(blocked.conditions?.all).toContainEqual({ kind: 'following', op: 'eq', value: false })
  })

  it('リセットは初期の「表示中」へ戻す', () => {
    const dialog = openDialog()
    fireEvent.click(radio(dialog, 'すべて'))
    fireEvent.click(within(dialog).getByRole('button', { name: '条件をリセット' }))
    expect(radio(dialog, '表示中').checked).toBe(true)
  })

  it('「すべて」で条件が無いときは空の conditions を送らない', () => {
    const dialog = openDialog()
    fireEvent.click(radio(dialog, 'すべて'))
    const params = apply(dialog).params
    expect(params.conditions).toBeUndefined()
    expect(params.visibility).toBeUndefined()
  })
})

describe('FRIEND-02 同じ項目の条件をすべて残す', () => {
  it('名前の条件を2つ並べると、両方を conditions.all に残す', () => {
    const dialog = openDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: '＋ 名前' }))
    const keywords = within(dialog).getAllByRole('textbox', { name: '名前のキーワード' })
    expect(keywords).toHaveLength(2)
    fireEvent.change(keywords[0], { target: { value: 'たなか' } })
    fireEvent.change(keywords[1], { target: { value: 'はなこ' } })
    const names = (apply(dialog).params.conditions?.all ?? []).filter(condition => condition.kind === 'name').map(condition => condition.value)
    expect(names).toEqual(['たなか', 'はなこ'])
  })
})

describe('FRIEND-04/32 適用した条件から再開する', () => {
  it('開くと適用中の編集状態と、一覧の並び順・件数から始まる', () => {
    const dialog = openDialog({
      applied: { params: {}, summary: [], editorState: editor({ blocks: [{ kind: 'name', keyword: 'たなか' }], visibility: 'hidden' }) },
      initialSort: 'oldest',
      initialLimit: 50,
    })
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: '名前のキーワード' }).value).toBe('たなか')
    expect(radio(dialog, '非表示のみ').checked).toBe(true)
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: '並び順' }).value).toBe('oldest')
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: '表示件数' }).value).toBe('50')
  })

  it('表示件数は選んだ値のまま params.limit へ入る', () => {
    const dialog = openDialog()
    fireEvent.change(within(dialog).getByRole('combobox', { name: '表示件数' }), { target: { value: '50' } })
    expect(apply(dialog).params.limit).toBe(50)
  })

  it('保存した検索を無変更で適用し直すと保存 ID だけを送り、変えたら条件で送る', () => {
    const state = editor({ blocks: [{ kind: 'name', keyword: 'たなか' }] })
    const dialog = openDialog({ applied: { params: { savedSearchId: 'saved-1' }, summary: [], editorState: state } })
    expect(apply(dialog).params).toEqual({ savedSearchId: 'saved-1', sort: 'recent', limit: 20 })
    fireEvent.click(radio(dialog, 'すべて'))
    const changed = apply(dialog).params
    expect(changed.savedSearchId).toBeUndefined()
    expect(changed.conditions?.all).toContainEqual({ kind: 'name', op: 'contains', value: 'たなか' })
  })
})

describe('FRIEND-05 対応状況は固定4状態', () => {
  it('対応状況の条件で「保留」を選べる', () => {
    const dialog = openDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: '＋ 対応状況' }))
    const select = within(dialog).getByRole<HTMLSelectElement>('combobox', { name: '対応状況' })
    expect([...select.options].map(option => option.textContent)).toEqual(['未対応', '対応中', '保留', '対応済み'])
    fireEvent.change(select, { target: { value: 'on_hold' } })
    expect(apply(dialog).params.chatStatus).toBe('on_hold')
  })
})

describe('A03-02 件数の古い応答と失敗', () => {
  it('件数の取得に失敗したら「確認できません」と再試行を出し、押すと取り直す', async () => {
    fx.list.mockRejectedValueOnce(new Error('down')).mockResolvedValue({ success: true, data: { items: [], total: 7 } })
    const dialog = openDialog()
    expect(await within(dialog).findByText('件数を確認できません')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '再試行' }))
    expect(await within(dialog).findByText('7人')).toBeTruthy()
    expect(within(dialog).queryByText('件数を確認できません')).toBeNull()
  })

  it('条件を変えた後に前の条件の件数が遅れて届いても採用しない', async () => {
    let finishOld!: (value: unknown) => void
    fx.list
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValue({ success: true, data: { items: [], total: 5 } })
    const dialog = openDialog()
    await waitFor(() => expect(fx.list).toHaveBeenCalledTimes(1))
    fireEvent.click(radio(dialog, 'すべて'))
    expect(await within(dialog).findByText('5人')).toBeTruthy()
    await act(async () => finishOld({ success: true, data: { items: [], total: 99 } }))
    expect(within(dialog).getByText('5人')).toBeTruthy()
    expect(within(dialog).queryByText('99人')).toBeNull()
  })
})

describe('保存した検索の窓', () => {
  const saved = (patch: Partial<FriendSavedView> = {}): FriendSavedView => ({
    id: 'saved-1',
    name: 'とても長い名前の保存した検索・秋のキャンペーンに反応した常連さん',
    conditions: {
      all: [
        { kind: 'name', op: 'contains', value: 'たなか' },
        { kind: 'name', op: 'contains', value: 'はなこ' },
        { kind: 'status_message', op: 'contains', value: '犬' },
        { kind: 'chat_status', op: 'eq', value: 'on_hold' },
        { kind: 'following', op: 'eq', value: false },
      ],
      any: [],
      visibility: 'hidden_only',
      list: { sort: 'oldest', limit: 50 },
    },
    revision: 1,
    isShared: true,
    ownerId: 'staff-1',
    lineAccountId: 'account-a',
    displayOrder: 0,
    match: { total: 3, byChannel: { line: null, mail: null }, calculatedAt: '2026-09-19T00:00:00.000Z', error: null },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...patch,
  })
  const applySaved = vi.fn()

  async function openSaved(view: FriendSavedView) {
    fx.savedList.mockResolvedValue({ success: true, data: { items: [view], total: 1 } })
    applySaved.mockReset()
    render(<SavedSearchDialog accountId="account-a" tags={[]} onClose={() => {}} onApply={applySaved} onOpenAdvanced={() => {}} />)
    await waitFor(() => expect(document.body.textContent).toContain('対象：'))
  }

  it('FRIEND-20/29: 対象と全部の条件を適用前に読め、長い名前も title で全文を読める', async () => {
    const view = saved()
    await openSaved(view)
    expect(document.body.textContent).toContain('対象：ブロックした人')
    const option = document.querySelector<HTMLElement>('[role="radio"], input[type="radio"]')
    if (option) fireEvent.click(option)
    const more = [...document.querySelectorAll('button')].find(button => /^ほか\d+件の条件を表示$/.test(button.textContent ?? ''))!
    expect(more).toBeTruthy()
    // 中身を確かめる欄の名前も、切れたときに title で全文を読める。
    expect(more.parentElement!.querySelector(`[title="${view.name}"]`)?.textContent).toBe(view.name)
    expect(document.body.textContent).not.toContain('保留')
    fireEvent.click(more)
    await waitFor(() => expect(document.body.textContent).toContain('保留'))
    expect([...document.querySelectorAll('button')].some(button => button.textContent === '条件を折りたたむ')).toBe(true)
  })

  it('適用すると保存した検索の ID と、実条件を戻した編集状態を渡す', async () => {
    const view = saved()
    await openSaved(view)
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'この条件で表示')!
    const option = document.querySelector<HTMLElement>('[role="radio"], input[type="radio"]')
    if (option) fireEvent.click(option)
    fireEvent.click(confirm)
    await waitFor(() => expect(applySaved).toHaveBeenCalledTimes(1))
    const result = applySaved.mock.calls[0][0] as AdvancedSearchResult
    expect(result.params).toEqual({ savedSearchId: 'saved-1', sort: 'oldest', limit: 50 })
    expect(result.editorState).toEqual(conditionsToEditorState(view.conditions))
    expect(result.editorState?.blocks.filter(block => block.kind === 'name')).toHaveLength(2)
  })
})
