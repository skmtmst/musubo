// @vitest-environment happy-dom
/*
 * タグの編集フォーム（TagEditForm）を描いて押す。
 * マイルの欄の言葉・遡及は初期オフで専用の確認窓を通す・題はトップの見出しだけ・
 * 連動の行は複製でき、対象を選ぶ種類だけ対象の欄を出す・消す前の注意を右に出す。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tag } from '@line-crm/shared'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
const net = vi.hoisted(() => ({ preview: vi.fn(), list: vi.fn() }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    commonActions: { ...actual.api.commonActions, resources: async () => ({ success: false, error: 'not configured' }) },
    tags: { ...actual.api.tags, list: net.list, retroactivePreview: net.preview },
  } }
})
import { TagEditForm } from './edit-form'
import { RetroactiveDialog, type LinkedAction, type TagEditorValues } from '@/components/friend-fields/tag-editor-v4'

type Props = Partial<React.ComponentProps<typeof TagEditForm>>
function renderForm(props: Props = {}) {
  const onSave = vi.fn()
  const tag = { id: 't1', name: 'VIP', status: 'active', linkedEnabled: true, mileageReward: 100, friendCount: 5 } as Tag
  render(<TagEditForm tag={tag} groups={[]} dependencies={null} accountId="a1" readOnly={false} conflict={false} compareBusy={false} onCompare={vi.fn()} onReloadLatest={vi.fn()} retroactiveReference={false} initialActions={[]} saving={false} error="" onCancel={vi.fn()} onSave={onSave} onDelete={vi.fn()} {...props} />)
  return onSave
}
const openRegion = (name: string) => fireEvent.click(within(screen.getByRole('region', { name })).getByRole('button', { name: '開く' }))

beforeEach(() => {
  net.list.mockReset().mockResolvedValue({ success: true, data: [] })
  net.preview.mockResolvedValue({ success: true, data: { selfTargets: 4, referralTargets: 1, selfMiles: 400, referralMiles: 0, selfExcluded: 1, referralExcluded: 0, previewToken: 'pt-1' } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('マイル', () => {
  it('付いたときの本人・紹介者のマイル、付け直しの扱い、今後の倍率を言葉で出す', () => {
    renderForm()
    openRegion('マイル')
    expect(screen.getByRole('button', { name: '今後のマイル倍率' })).toBeTruthy()
    const grant = within(screen.getByRole('region', { name: 'このタグが付いたらマイル' }))
    expect(grant.getByText('本人へのマイル付与')).toBeTruthy()
    expect(grant.getByText('紹介者へのマイル付与')).toBeTruthy()
    expect(grant.getByText(/^タグを外して付け直したときの扱い：/)).toBeTruthy()
  })

  it('遡及は初期オフで、オフのまま保存すると確認窓を出さずに送る', () => {
    const onSave = renderForm()
    openRegion('マイル')
    expect(screen.getByRole('switch', { name: 'さかのぼって反映' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'タグを保存する' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ applyToExisting: false }), false)
    expect(screen.queryByText(/さかのぼってマイルを積みますか？$/)).toBeNull()
  })

  it('遡及をオンにして保存すると、サーバーの人数で専用の確認窓を出し、確かめて押すと引き換え券つきで送る', async () => {
    const onSave = renderForm()
    openRegion('マイル')
    fireEvent.click(screen.getByRole('switch', { name: 'さかのぼって反映' }))
    fireEvent.click(screen.getByRole('button', { name: 'タグを保存する' }))
    const title = await screen.findByText('5人にさかのぼってマイルを積みますか？')
    const dialog = title.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')!
    expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
    expect(within(dialog).getByText('環境')).toBeTruthy()
    expect(dialog.textContent).toContain('この操作は取り消せません')
    expect(dialog.textContent).toContain('新規作成のときはこのダイアログは出ません')
    expect(onSave).not.toHaveBeenCalled()
    const go = within(dialog).getByRole('button', { name: 'さかのぼって反映して保存する' }) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '人数と合計マイルを確認しました' }))
    await waitFor(() => expect(go.disabled).toBe(false))
    fireEvent.click(go)
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ applyToExisting: true }), true, 'pt-1')
  })

  it('アカウント切替後は以前の人数と確認で遡及を実行しない', async () => {
    const values = { name: 'VIP', groupId: '', isStarred: false, linked: false, rewardMiles: 100, referralRewardMiles: 0, multiplierBps: null, multiplierPriority: 0, applyToExisting: true, reapplyPolicy: 'first_only', actions: [] } as TagEditorValues
    const save = vi.fn()
    net.preview.mockResolvedValueOnce({ success: true, data: { selfTargets: 4, referralTargets: 1, selfMiles: 400, referralMiles: 0, selfExcluded: 1, referralExcluded: 0, previewToken: 'pt-1' } }).mockReturnValueOnce(new Promise(() => {}))
    const view = render(<RetroactiveDialog values={values} count={5} tagId="t1" accountId="a1" onCancel={vi.fn()} onSaveWithoutApplying={vi.fn()} onSave={save} />)
    await screen.findByText('5人にさかのぼってマイルを積みますか？')
    fireEvent.click(screen.getByRole('checkbox', { name: '人数と合計マイルを確認しました' }))
    const button = screen.getByRole('button', { name: 'さかのぼって反映して保存する' })
    view.rerender(<RetroactiveDialog values={values} count={5} tagId="t1" accountId="a2" onCancel={vi.fn()} onSaveWithoutApplying={vi.fn()} onSave={save} />)
    fireEvent.click(button)
    expect(save).not.toHaveBeenCalled()
  })
})

describe('題と注意', () => {
  it.each([
    ['タグの名前', {}, 'VIP'],
    ['名前が無ければ「タグを編集」', { tag: { id: 't1', name: '', status: 'active' } as Tag }, 'タグを編集'],
  ])('題は%sをトップの見出しに出す', (_label, props, title) => {
    renderForm(props as Props)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title)
  })

  it('右の欄に、消すと条件から外れる注意を出す', () => {
    renderForm()
    expect(screen.getByText('このタグを消すと、上の配信やフォームの条件から外れます。消す前に確認が出ます。')).toBeTruthy()
  })
})

describe('連動の行', () => {
  const actions: LinkedAction[] = [
    { id: 'a1', type: 'シナリオ', label: 'シナリオを始める', timing: 'すぐに', definition: { id: 'a1', type: 'start_scenario', params: { scenarioId: 's1', delayMinutes: 0 }, onFailure: 'stop' } } as LinkedAction,
    { id: 'a2', type: 'テキスト送信', label: 'ありがとう', timing: 'すぐに', definition: { id: 'a2', type: 'send_message', params: { content: 'ありがとう', delayMinutes: 0 }, onFailure: 'stop' } } as LinkedAction,
  ]

  it('「…」の「複製する」で同じ中身の行をすぐ下に足し、保存する値に届く', async () => {
    const onSave = renderForm({ initialActions: actions })
    openRegion('タグ連動')
    fireEvent.click(screen.getAllByRole('button', { name: /1つ目の行うこと.*操作/ })[0]!)
    await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name: '複製する' })) })
    fireEvent.click(screen.getByRole('button', { name: 'タグを保存する' }))
    const saved = onSave.mock.calls[0]![0].actions as LinkedAction[]
    expect(saved.map((action) => action.label)).toEqual(['シナリオを始める', 'シナリオを始める', 'ありがとう'])
    expect(saved[1]!.id).not.toBe('a1')
  })

  it('対象を選ぶ種類の行だけ「連動の対象」の欄を出す', () => {
    renderForm({ initialActions: actions })
    openRegion('タグ連動')
    fireEvent.click(screen.getByRole('button', { name: 'シナリオを始める' }))
    expect(screen.getByRole('button', { name: /^連動の対象：/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'シナリオを始める' }))
    fireEvent.click(screen.getByRole('button', { name: 'ありがとう' }))
    expect(screen.queryByRole('button', { name: /^連動の対象：/ })).toBeNull()
  })
})

it.each(['response', 'network'])('タグ編集の同名確認%s失敗を知らせ、名前を残して読み直せる', async failure => {
  if (failure === 'response') net.list.mockResolvedValueOnce({ success: false })
  else net.list.mockRejectedValueOnce(new Error('offline'))
  net.list.mockResolvedValueOnce({ success: true, data: [{ id: 'other', name: '見本' }] })
  renderForm()
  fireEvent.change(screen.getByLabelText('タグ名'), { target: { value: '見本' } })
  expect(await screen.findByText(/同じ名前のタグを確認できませんでした/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '重複を確認し直す' }))
  await waitFor(() => expect(screen.queryByText(/同じ名前のタグを確認できませんでした/)).toBeNull())
  expect((screen.getByLabelText('タグ名') as HTMLInputElement).value).toBe('見本')
  expect(screen.getByText(/同じ名前のタグがすでにあります/)).toBeTruthy()
  expect(net.list).toHaveBeenCalledTimes(2)
})

it('アカウント切替後は前の遅い同名候補を出さない', async () => {
  let finishOld!: (value: unknown) => void
  net.list.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    .mockResolvedValueOnce({ success: true, data: [] })
  const tag = { id: 't1', name: '見本', status: 'active', linkedEnabled: false } as Tag
  const props = { tag, groups: [], dependencies: null, readOnly: false, conflict: false, compareBusy: false, onCompare: vi.fn(), onReloadLatest: vi.fn(), retroactiveReference: false, initialActions: [], saving: false, error: '', onCancel: vi.fn(), onSave: vi.fn(), onDelete: vi.fn() }
  const view = render(<TagEditForm {...props} accountId="a" />)
  view.rerender(<TagEditForm {...props} accountId="b" />)
  await waitFor(() => expect(net.list).toHaveBeenCalledTimes(2))
  await act(async () => { finishOld({ success: true, data: [{ id: 'old', name: '見本' }] }) })
  expect(screen.queryByText(/同じ名前のタグがすでにあります/)).toBeNull()
})

it('閲覧のみでは同名の確認を取得しない', async () => {
  renderForm({ readOnly: true })
  await act(async () => {})
  expect(net.list).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '重複を確認し直す' })).toBeNull()
})
