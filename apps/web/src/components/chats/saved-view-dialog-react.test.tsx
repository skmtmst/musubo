// @vitest-environment happy-dom
/*
 * 受信箱「保存した検索を作成」の窓（設計 `Ln4zS`・`AuSDY`）を描いて押す。
 * 画面からの保存・失敗の文言は app/chats/inbox-saved-view-error-react.test.tsx が見る。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SavedViewDialog, { type SavedViewDraft, type SavedViewSaveResult } from './saved-view-dialog'

/* 選ぶ欄は共通 Select（listbox）。ここで見たいのは選んだ後に保存へ渡る値なので、素の select にする。 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, value, onChange, options }: {
    'aria-label'?: string; value: string; onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement('select', { 'aria-label': label, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label))),
}))
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))

const INITIAL: Omit<SavedViewDraft, 'name'> = {
  status: 'all', quickFilter: 'all', channel: 'all', assignee: 'all', unreadOnly: false, favorite: false,
}

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(onSave: (draft: SavedViewDraft) => Promise<SavedViewSaveResult> = vi.fn(async () => ({ success: true as const })), emailInboxEnabled = true) {
  render(
    <SavedViewDialog
      open
      initialValue={INITIAL}
      operators={[{ id: 'op-k', name: '見本' }]}
      existingNames={['朝の未対応']}
      saving={false}
      emailInboxEnabled={emailInboxEnabled}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  )
  return { onSave }
}
const nameInput = () => screen.getByRole('textbox', { name: /検索名/ }) as HTMLInputElement
const saveButton = () => screen.getByRole('button', { name: '検索条件を保存する' }) as HTMLButtonElement
const notice = (text: string) => screen.getByText(text).closest('[data-tone]')
const choose = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe('保存した検索を作成の窓', () => {
  it('開いた直後の未入力は中立：保存は最初から押せず、理由をボタンと注意の帯で伝える', () => {
    mount()
    expect(saveButton().disabled).toBe(true)
    expect(saveButton().title).toBe('検索名を入力してください')
    expect(nameInput().getAttribute('aria-invalid')).toBe('false')
    expect(screen.getByText('（必須）')).toBeTruthy()
    expect(notice('検索名は必須です。入力すると保存できるようになります。')?.getAttribute('data-tone')).toBe('warn')
  })

  it('入力したあと空にしたときだけ赤い断りにする', () => {
    mount()
    fireEvent.change(nameInput(), { target: { value: '見本の未対応' } })
    expect(saveButton().disabled).toBe(false)
    expect(nameInput().getAttribute('aria-invalid')).toBe('false')
    fireEvent.change(nameInput(), { target: { value: '' } })
    expect(saveButton().disabled).toBe(true)
    expect(nameInput().getAttribute('aria-invalid')).toBe('true')
    expect(notice('検索名を入力してください。')?.getAttribute('data-tone')).toBe('danger')
  })

  it('名前を入れた後も、保存されるのは条件だという注意を残す', () => {
    mount()
    fireEvent.change(nameInput(), { target: { value: '見本の未対応' } })
    expect(notice('保存されるのは検索条件です。受信件数は最新の状態に自動更新されます。')?.getAttribute('data-tone')).toBe('warn')
  })

  it('窓の中で変えた条件と「よく使う」を、そのまま保存へ渡す', async () => {
    const { onSave } = mount()
    fireEvent.change(nameInput(), { target: { value: '  見本の未読メール  ' } })
    choose('保存する対応状況', 'resolved')
    choose('保存する絞り込み', 'reply')
    choose('保存する未読条件', 'unread')
    choose('保存する受信経路', 'email')
    choose('保存する担当者', 'op-k')
    fireEvent.click(screen.getByRole('checkbox', { name: /よく使うに追加/ }))
    await act(async () => { fireEvent.click(saveButton()) })
    expect(onSave).toHaveBeenCalledExactlyOnceWith({
      name: '見本の未読メール', status: 'resolved', quickFilter: 'reply', channel: 'email',
      assignee: 'op-k', unreadOnly: true, favorite: true,
    })
  })

  it('メール未接続の新規アカウントではメール経路を出さず、LINE条件だけ保存する', async () => {
    const { onSave } = mount(vi.fn(async () => ({ success: true as const })), false)
    expect(screen.queryByLabelText('保存する受信経路')).toBeNull()
    fireEvent.change(nameInput(), { target: { value: 'LINEの未対応' } })
    await act(async () => { fireEvent.click(saveButton()) })
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ channel: 'line' }))
  })

  it('保存先の成功を受け取ってからだけ「保存しました」へ進む', async () => {
    let finish!: (result: SavedViewSaveResult) => void
    mount(() => new Promise((done) => { finish = done }))
    fireEvent.change(nameInput(), { target: { value: '見本の未対応' } })
    await act(async () => { fireEvent.click(saveButton()) })
    expect(screen.queryByText('保存しました')).toBeNull()
    await act(async () => { finish({ success: true }) })
    expect(screen.getByText('保存しました')).toBeTruthy()
  })

  it('保存先が失敗を返したら、理由を窓の中に赤く出して入力を残す', async () => {
    mount(async () => ({ success: false, error: '保存できませんでした。時間を置いてもう一度お試しください。' }))
    fireEvent.change(nameInput(), { target: { value: '見本の未対応' } })
    await act(async () => { fireEvent.click(saveButton()) })
    expect(screen.queryByText('保存しました')).toBeNull()
    expect(notice('保存できませんでした。時間を置いてもう一度お試しください。')?.getAttribute('data-tone')).toBe('danger')
    expect(nameInput().value).toBe('見本の未対応')
    expect(nameInput().getAttribute('aria-invalid')).toBe('true')
  })

  it('同じ名前の検索は保存へ送らず、別の名前を促す', async () => {
    const { onSave } = mount()
    fireEvent.change(nameInput(), { target: { value: '朝の未対応' } })
    await act(async () => { fireEvent.click(saveButton()) })
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText('同じ名前の保存した検索があります。別の名前を入力してください。')).toBeTruthy()
  })
})
