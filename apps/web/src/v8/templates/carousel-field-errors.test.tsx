// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ prepare: vi.fn(), put: vi.fn(), complete: vi.fn(), detail: vi.fn(), create: vi.fn(), update: vi.fn(), get: vi.fn(), publish: vi.fn() }))
const staffRole = vi.hoisted(() => ({ value: 'owner' as 'owner' | 'viewer' }))
const account = vi.hoisted(() => ({ id: 'a-1' }))
vi.mock('@/lib/api', () => ({ ApiError: class extends Error {}, api: {
  media: { prepareUploads: calls.prepare, completeUpload: calls.complete, detail: calls.detail },
  templates: { create: calls.create, update: calls.update, get: calls.get, publish: calls.publish }, folders: { list: async () => ({ success: true, data: [] }) },
} }))
vi.mock('../contents/media-direct-upload', async (original) => ({
  ...await original<Record<string, unknown>>(), extractMediaMetadata: async () => ({ width: 1040, height: 1040 }), putMediaFile: calls.put,
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: account.id, selectedAccount: { name: '店' }, accounts: [] }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => staffRole.value }))
vi.mock('@/components/auto-replies/inline-action-list', () => ({ useActionOptions: () => ({ tags: [], fields: [], marks: [], scenarios: [], vars: [] }) }))


import Carousel from './carousel'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'

/*
 * カルーセルの保存で落ちた欄（・オーナーの写真の指摘：「すべてのカードに本文を入力してください」の帯だけだった）。
 * 欄が赤くなり真下に理由、別のカードならそのカードを開いて移り、カードの札に赤い丸が付く。
 */
beforeEach(() => { account.id = 'a-1'; staffRole.value = 'owner'; calls.create.mockResolvedValue({ success: true, data: { id: 'template-1' } }) })
afterEach(() => { cleanup(); forgetStaffIdentity(); vi.resetAllMocks() })

const fillFirst = () => {
  fireEvent.change(screen.getByPlaceholderText('例：夏の定番5点'), { target: { value: '夏の定番' } })
  fireEvent.change(screen.getByLabelText('タイトル（40文字まで）'), { target: { value: '1枚目' } })
  fireEvent.change(screen.getByLabelText(/本文（/), { target: { value: '1枚目の本文' } })
}

describe('カルーセルの欄ごとの誤り', () => {
  it('使われているカルーセルの公開確認に対象を表示する', async () => {
    verifiedStaffRole('owner')
    calls.get.mockResolvedValue({ success: true, data: { accountId: 'a-1', publishedVersion: 0, draftRevision: 1, usedBy: { scenarios: [{ id: 's-1' }] } } })
    render(<Carousel />)
    fillFirst()
    fireEvent.click(screen.getByRole('button', { name: '保存して公開' }))
    const dialog = await screen.findByRole('dialog', { name: 'この内容を公開しますか？' })
    expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
    expect(within(dialog).getByText('環境')).toBeTruthy()
  })
  it('アカウントを切り替えて戻しても古い公開確認では公開しない', async () => {
    verifiedStaffRole('owner')
    calls.get.mockResolvedValue({ success: true, data: { accountId: 'a-1', publishedVersion: 0, draftRevision: 1, usedBy: { scenarios: [{ id: 's-1' }] } } })
    const view = render(<Carousel />)
    fillFirst()
    fireEvent.click(screen.getByRole('button', { name: '保存して公開' }))
    const dialog = await screen.findByRole('dialog', { name: 'この内容を公開しますか？' })
    const button = within(dialog).getByRole('button', { name: '公開する' })
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const oldClick = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    account.id = 'a-2'; view.rerender(<Carousel />)
    account.id = 'a-1'; view.rerender(<Carousel />)
    await act(async () => { await oldClick({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
    expect(calls.publish).not.toHaveBeenCalled()
  })
  it('確認後に最新の下書きが変わっても窓を開いた時の版を公開APIへ渡す', async () => {
    verifiedStaffRole('owner')
    calls.get.mockResolvedValueOnce({ success:true, data:{ accountId:'a-1', publishedVersion:2, draftRevision:3, usedBy:{ scenarios:[{ id:'s-1' }] } } })
      .mockResolvedValue({ success:true, data:{ accountId:'a-1', publishedVersion:4, draftRevision:5, usedBy:{ scenarios:[{ id:'s-1' }] } } })
    calls.publish.mockResolvedValue({ success:true, data:{} })
    render(<Carousel />); fillFirst(); fireEvent.click(screen.getByRole('button',{name:'保存して公開'}))
    const dialog=await screen.findByRole('dialog',{name:'この内容を公開しますか？'})
    fireEvent.click(within(dialog).getByRole('button',{name:'公開する'}))
    await waitFor(()=>expect(calls.publish).toHaveBeenCalledWith('template-1',{expectedVersion:2,expectedDraftRevision:3}))
  })
  it('公開確認を閉じたあとの古い確定口では公開しない', async () => {
    verifiedStaffRole('owner')
    calls.get.mockResolvedValue({ success:true, data:{ accountId:'a-1', publishedVersion:2, draftRevision:3, usedBy:{ scenarios:[{ id:'s-1' }] } } })
    calls.publish.mockResolvedValue({ success:true, data:{} })
    render(<Carousel />); fillFirst(); fireEvent.click(screen.getByRole('button',{name:'保存して公開'}))
    const dialog=await screen.findByRole('dialog',{name:'この内容を公開しますか？'})
    const button=within(dialog).getByRole('button',{name:'公開する'})
    const key=Object.keys(button).find(k=>k.startsWith('__reactProps$'))!
    const oldClick=(button as unknown as Record<string,{onClick:(event:unknown)=>void}>)[key].onClick
    fireEvent.click(within(dialog).getByRole('button',{name:'キャンセル'}))
    await act(async()=>{await oldClick({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button})})
    expect(calls.publish).not.toHaveBeenCalled()
  })
  it.each(['shop', 'hq'] as const)('閲覧のみでは順番の絵を灰色と理由で出し、変更を送らない: %s', scope => {
    const onSave = vi.fn()
    verifiedStaffRole('viewer')
    if (scope === 'shop') staffRole.value = 'viewer'
    render(<Carousel host={scope === 'hq' ? {
      description: '', folders: [], folder: '', onFolderChange: vi.fn(), busy: false,
      onSave, onCancel: vi.fn(), readOnly: true,
    } : undefined} />)
    expect(screen.getByText('一覧で中身を確認できます。')).toBeTruthy()
    const chip = screen.getByRole('button', { name: /^1 カード 1$/ })
    expect(chip.getAttribute('aria-disabled')).toBe('true')
    expect(chip.getAttribute('draggable')).toBe('false')
    expect((chip as HTMLButtonElement).disabled).toBe(false)
    expect(document.getElementById(chip.getAttribute('aria-describedby')!)?.textContent).toBe(PERMISSION_LOCK_REASON.viewer)
    expect(screen.queryByRole('button', { name: /を外す|ボタンを足す|下書きを保存|保存して公開|保存して配る/ })).toBeNull()
    fireEvent.click(chip)
    fireEvent.keyDown(chip, { key: 'ArrowRight', altKey: true })
    expect(calls.create).not.toHaveBeenCalled()
    expect(calls.update).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })
  it('役割が未確認なら順番の札を押せなくし、権限の理由は作らない', () => {
    verifiedStaffRole(null)
    staffRole.value = 'viewer'
    render(<Carousel />)
    const chip = screen.getByRole('button', { name: /^1 カード 1$/ }) as HTMLButtonElement
    expect(chip.disabled).toBe(true)
    expect(chip.hasAttribute('aria-describedby')).toBe(false)
    expect(chip.hasAttribute('data-permission-locked')).toBe(false)
    expect(chip.getAttribute('draggable')).toBe('false')
    expect(screen.queryByRole('button', { name: /を外す|ボタンを足す|下書きを保存|保存して公開|保存して配る/ })).toBeNull()
  })
  it('順番の札に小さな代わりの絵と題を出し、Alt矢印で入れ替えても中身を保つ', async () => {
    render(<Carousel />)
    fillFirst()
    fireEvent.click(screen.getByRole('button', { name: 'カードを足す' }))
    fireEvent.change(screen.getByLabelText('タイトル（40文字まで）'), { target: { value: '2枚目' } })
    const second = screen.getByRole('button', { name: '2 2枚目' })
    expect(within(second).getByRole('img', { name: '画像なし' })).toBeTruthy()
    expect(second.getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(second, { key: 'ArrowLeft', altKey: true })
    expect(screen.getByRole('button', { name: '1 2枚目' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '2 1枚目' }))
    expect((screen.getByLabelText('タイトル（40文字まで）') as HTMLInputElement).value).toBe('1枚目')
    expect(calls.create).not.toHaveBeenCalled()
    expect(calls.update).not.toHaveBeenCalled()
  })
  it('ボタンごとに文字と動きの題を付け、最後の一つを隠し、削除後も残りの値を保つ', async () => {
    render(<Carousel />)
    expect(screen.queryByRole('button', { name: 'カード1のボタン1を外す' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'ボタンを足す' }))
    expect(screen.getAllByText('ボタンの文字', { exact: true }).length).toBe(2)
    const labels = screen.getAllByText('押したら', { exact: true })
    expect(labels.length).toBe(2)
    for (const label of labels) expect(label.closest('[data-tap-action-columns="3"]')?.children.length).toBe(3)
    fireEvent.change(screen.getByLabelText('カード1のボタン2の文字'), { target: { value: '残すボタン' } })
    const add = screen.getByRole('button', { name: 'ボタンを足す' }) as HTMLButtonElement
    fireEvent.click(add)
    expect(add.disabled).toBe(true)
    expect(add.title).toBe('ボタンは3つまでです。')
    fireEvent.click(screen.getByRole('button', { name: 'カード1のボタン3を外す' }))
    expect(add.disabled).toBe(false)
    expect(add.title).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'カード1のボタン1を外す' }))
    expect((screen.getByLabelText('カード1のボタン1の文字') as HTMLInputElement).value).toBe('残すボタン')
    expect(screen.queryByRole('button', { name: 'カード1のボタン1を外す' })).toBeNull()
    expect(calls.create).not.toHaveBeenCalled()
  })
  it('2枚目の本文が空なら送らず、2枚目を開いて本文の欄を赤くし、真下に理由を出してそこへ移る。札に赤い丸', async () => {
    render(<Carousel />)
    fillFirst()
    fireEvent.click(screen.getByRole('button', { name: 'カードを足す' }))
    fireEvent.click(screen.getByRole('button', { name: /^1 / }))
    fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'カード 2 の中身' })).toBeTruthy())
    const body = document.getElementById('cr-text') as HTMLInputElement
    expect(body.value).toBe('')
    expect(body.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById('cr-text-error')?.textContent).toBe('本文を入力してください')
    expect(screen.queryByText('すべてのカードに本文を入力してください')).toBeNull()
    expect(screen.getByRole('img', { name: 'カード2に直す欄が1か所' })).toBeTruthy()
    expect(screen.queryByRole('img', { name: /カード1に直す欄/ })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(body))
    expect(calls.create).not.toHaveBeenCalled()
    /* 直すと赤と丸が消え、保存できる。 */
    fireEvent.change(body, { target: { value: '2枚目の本文' } })
    expect(body.getAttribute('aria-invalid')).toBeNull()
    expect(screen.queryByRole('img', { name: /直す欄/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
    await waitFor(() => expect(calls.create).toHaveBeenCalled())
  })

  it('名前が空・ボタンの送る文が空なら、それぞれの欄に理由を出し、1つ目（名前）へ移る', async () => {
    render(<Carousel />)
    fireEvent.change(screen.getByLabelText(/本文（/), { target: { value: '本文' } })
    fireEvent.change(screen.getByLabelText('カード1のボタン1の文字'), { target: { value: '聞く' } })
    fireEvent.click(screen.getByRole('button', { name: 'カード1のボタン1の動き' }))
    fireEvent.click(within(screen.getByRole('listbox')).getByText('テキストを送る'))
    fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
    const name = screen.getByPlaceholderText('例：夏の定番5点')
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'))
    expect(document.getElementById('cr-name-input-error')?.textContent).toBe('名前を入力してください')
    expect(document.getElementById('cr-button-0-error')?.textContent).toBe('送る文を入力してください')
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(calls.create).not.toHaveBeenCalled()
  })

  it('落ちたカードを消せば、消したカードの誤りは残らず保存できる（欄の定義は描くたびに作り直す）', async () => {
    render(<Carousel />)
    fillFirst()
    fireEvent.click(screen.getByRole('button', { name: 'カードを足す' }))
    fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
    await waitFor(() => expect(document.getElementById('cr-text-error')?.textContent).toBe('本文を入力してください'))
    fireEvent.click(screen.getByRole('button', { name: 'このカードを消す' }))
    const confirm = screen.queryByRole('alertdialog') ?? screen.queryByRole('dialog')
    if (confirm) fireEvent.click(within(confirm).getAllByRole('button').find((button) => /消す/.test(button.textContent ?? ''))!)
    await waitFor(() => expect(screen.queryByRole('button', { name: /^2 / })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
    await waitFor(() => expect(calls.create).toHaveBeenCalled())
  })
})

it('空の名前・本文では主保存を止め、本文まで入れると主保存が使える', () => {
  staffRole.value = verifiedStaffRole('owner') as typeof staffRole.value
  render(<Carousel />)
  const save = screen.getByRole('button', { name: '保存して公開' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  fillFirst()
  expect(save.disabled).toBe(false)
  expect(calls.create).not.toHaveBeenCalled()
})
