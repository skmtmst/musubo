// @vitest-environment happy-dom
import { act } from 'react'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FriendDetail } from '@/lib/api'
import type { FriendDetailState } from './use-friend-detail'
import type { FriendDetailPermissions } from './permissions'

const fixture = vi.hoisted(() => ({ accountId: 'account-a', tags: vi.fn(), add: vi.fn(), remove: vi.fn(), toast: vi.fn(), confirm: undefined as (() => void) | undefined }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.accountId }) }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, tags: { list: fixture.tags }, friends: { addTag: fixture.add, removeTag: fixture.remove } } }
})
vi.mock('@/lib/api/helpers/gap3', () => ({ memberRanksApi: { friend: async () => ({ success: true, data: null }) } }))
vi.mock('@/components/shared/toast', () => ({ notifyToast: fixture.toast }))
vi.mock('@/components/shared/dialog', async (original) => {
  const { default: Dialog } = await original<typeof import('@/components/shared/dialog')>()
  return { default: (props: import('@/components/shared/dialog').DialogProps) => { fixture.confirm = props.onConfirm; return <Dialog {...props} /> } }
})
vi.mock('./delivery-consent', () => ({ default: () => null, DeliveryConsentSummary: () => null, useDeliveryConsents: () => ({ rows: [], status: 'ready', reload: vi.fn() }) }))

import { FriendSummaryRail } from './overview-tab'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const tags = [{ id: 'old', name: '既存タグ', color: '#008000' }, { id: 'new', name: '追加タグ', color: '#008000' }]
function rail(friendId: string, loadFriend: () => Promise<void>, canEdit = true) {
  const friend = { id: friendId, displayName: friendId, tags: [tags[0]], formSubmissions: [] } as unknown as FriendDetail
  const data = { loadFriend, loadFields: vi.fn(), fieldsStatus: 'ready', hiddenPersonalCount: 0, historyStatus: 'ready', historyItems: [], mileageStatus: 'ready', richMenuStatus: 'ready' } as unknown as FriendDetailState
  const perms: FriendDetailPermissions = { manage: canEdit, editSupport: canEdit, saveFields: canEdit, canEditField: () => canEdit, viewOnly: !canEdit }
  return <FriendSummaryRail friend={friend} friendId={friendId} data={data} perms={perms} fields={[]} values={{}} realName={friendId} onEditSupport={vi.fn()} />
}
async function openEditor() {
  fireEvent.click(screen.getByRole('button', { name: '＋ 追加' }))
  const dialog = await screen.findByRole('dialog', { name: 'タグを編集' })
  await within(dialog).findByRole('checkbox', { name: '追加タグ' })
  return dialog
}
function changeTags(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('checkbox', { name: '追加タグ' }))
  fireEvent.click(within(dialog).getByRole('checkbox', { name: '既存タグ' }))
}

describe('タグ編集の権限と保存後の対象', () => {
  beforeEach(() => {
    fixture.accountId = 'account-a'
    fixture.tags.mockReset().mockResolvedValue({ success: true, data: tags })
    fixture.add.mockReset().mockResolvedValue({ success: true })
    fixture.remove.mockReset().mockResolvedValue({ success: true })
    fixture.toast.mockReset()
    document.documentElement.dataset.theme = 'v8'
  })
  afterEach(() => { cleanup(); delete document.documentElement.dataset.theme })

  it('開いたあとに権限を失うと窓を閉じ、保持していた保存操作もadd/removeを始めない', async () => {
    const view = render(rail('A', vi.fn(async () => {})))
    const dialog = await openEditor()
    changeTags(dialog)
    const save = within(dialog).getByRole('button', { name: '保存する' })
    const pendingConfirm = fixture.confirm
    expect(pendingConfirm).toBeTypeOf('function')
    view.rerender(rail('A', vi.fn(async () => {}), false))
    fireEvent.click(save)
    await act(async () => { pendingConfirm?.() })
    expect(screen.queryByRole('dialog', { name: 'タグを編集' })).toBeNull()
    for (const el of screen.queryAllByRole('button', { name: '＋ 追加' })) expect(((el: HTMLElement) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled)(el)).toBe(true)
    expect(fixture.add).not.toHaveBeenCalled()
    expect(fixture.remove).not.toHaveBeenCalled()
  })

  it.each(['success', 'partial', 'exception'] as const)('同じ対象の%s完了は保存結果を表示する', async (outcome) => {
    if (outcome === 'partial') fixture.add.mockResolvedValue({ success: false, error: 'failed' })
    if (outcome === 'exception') fixture.add.mockRejectedValue(new Error('failed'))
    const reload = vi.fn(async () => {})
    render(rail('A', reload))
    const dialog = await openEditor()
    changeTags(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(reload).toHaveBeenCalledOnce())
    if (outcome === 'success') {
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'タグを編集' })).toBeNull())
      expect(fixture.toast).toHaveBeenCalledWith('タグを更新しました')
    } else {
      await within(dialog).findByText(outcome === 'partial' ? '一部のタグを保存できませんでした。現在の内容を読み直してください' : 'タグを保存できませんでした。現在の内容を読み直してください')
    }
  })

  it.each(['success', 'partial', 'exception'].flatMap(outcome => ['friend', 'account'].map(scope => [outcome, scope])))('Aの%s後のreload待機中に%sを替えてもBの窓に作用しない', async (outcome, scope) => {
    if (outcome === 'partial') fixture.add.mockResolvedValue({ success: false, error: 'failed' })
    if (outcome === 'exception') fixture.add.mockRejectedValue(new Error('failed'))
    const reload = deferred<void>()
    const loadA = vi.fn(() => reload.promise)
    const view = render(rail('A', loadA))
    const dialogA = await openEditor()
    changeTags(dialogA)
    fireEvent.click(within(dialogA).getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(loadA).toHaveBeenCalledOnce())
    const bTags = deferred<{ success: boolean; data: typeof tags }>()
    fixture.tags.mockReturnValue(bTags.promise)
    if (scope === 'account') fixture.accountId = 'account-b'
    view.rerender(rail(scope === 'friend' ? 'B' : 'A', vi.fn(async () => {})))
    fireEvent.click(screen.getByRole('button', { name: '＋ 追加' }))
    const dialogB = await screen.findByRole('dialog', { name: 'タグを編集' })
    await act(async () => { reload.resolve() })
    expect(screen.getByRole('dialog', { name: 'タグを編集' })).toBe(dialogB)
    expect(dialogB.getAttribute('aria-busy')).toBe('true')
    expect(within(dialogB).queryByText(/保存できませんでした/)).toBeNull()
    expect(fixture.toast).not.toHaveBeenCalled()
    expect(within(dialogB).queryByRole('checkbox')).toBeNull()
    await act(async () => { bTags.resolve({ success: true, data: tags }) })
    await within(dialogB).findByRole('checkbox', { name: '追加タグ' })
    expect(within(dialogB).getByRole('button', { name: '保存する' }).getAttribute('aria-disabled')).not.toBe('true')
  })
})

describe('要点の行の文字操作', () => {
  afterEach(() => { cleanup(); verifiedStaffRole(null) })

  it('リッチメニューの変更を共通の文字操作として同じ行き先へ残す', () => {
    verifiedStaffRole('owner')
    render(rail('A', vi.fn(async () => {})))
    const section = screen.getByRole('region', { name: 'リッチメニュー' })
    const link = within(section).getByRole('link', { name: '変える' })
    expect(link.getAttribute('href')).toBe('/rich-menus')
    expect(link.getAttribute('data-variant')).toBe('text')
    expect(link.getAttribute('aria-disabled')).toBeNull()
    expect(within(screen.getByRole('region', { name: '配信の受け取り' })).getByRole('button', { name: '変える' }).getAttribute('data-variant')).toBe('text')
  })

  it('役割が未確認の間はリンクを出さず変更を止める', () => {
    verifiedStaffRole(null)
    render(rail('A', vi.fn(async () => {}), false))
    const region = screen.getByRole('region', { name: 'リッチメニュー' })
    const action = within(region).getByRole('button', { name: '変える' }) as HTMLButtonElement
    expect(action.disabled).toBe(true)
    expect(within(region).queryByRole('link')).toBeNull()
  })

  it('閲覧のみでは変更を灰色の理由つきにし、押しても移動しない', async () => {
    verifiedStaffRole('viewer')
    render(rail('A', vi.fn(async () => {}), false))
    const action = within(screen.getByRole('region', { name: 'リッチメニュー' })).getByRole('button', { name: '変える' })
    expect(action.getAttribute('aria-disabled')).toBe('true')
    expect(action.getAttribute('data-variant')).toBe('text')
    expect(action.getAttribute('href')).toBeNull()
    fireEvent.focus(action)
    expect((await screen.findByRole('tooltip')).textContent).toContain('閲覧のみ')
    expect(fireEvent.keyDown(action, { key: 'Enter' })).toBe(false)
    expect(fireEvent.click(action)).toBe(false)
    expect(within(screen.getByRole('region', { name: '配信の受け取り' })).getByRole('button', { name: '見る' })).toBeTruthy()
  })
})
