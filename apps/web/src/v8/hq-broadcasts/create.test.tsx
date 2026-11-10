import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * 統括 一括配信を作る（・：店の一斉配信と同じ5段＋送るアカウント）・詳細（xOXuY）の動きの試験。
 * ① 配信名 → ② 送るアカウント（窓で選ぶ）→ ③ 本文 → ④ 時刻 → ⑤ 確かめる（作る → preflight → 問題のある店を外す）→ 送る（確かめの窓 → send）。
 * 詳細は失敗した店へのやり直し。閲覧のみ（担当者）には作る画面を出さない。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const previewWindow = vi.hoisted(() => ({ hidden: false }))
const retryConfirmation = vi.hoisted(() => ({ current: undefined as undefined | (() => unknown) }))
vi.mock('@/components/shared/confirm-dialog', async original => {
  const { default: ConfirmDialog } = await original<typeof import('@/components/shared/confirm-dialog')>()
  return { default: (props: React.ComponentProps<typeof ConfirmDialog>) => {
    if (props.title === '失敗した店にやり直します') retryConfirmation.current = props.onConfirm
    return <ConfirmDialog {...props} />
  } }
})
vi.mock('@/components/shared/dialog', async original => {
  const { default: Dialog } = await original<typeof import('@/components/shared/dialog')>()
  return { default: (props: React.ComponentProps<typeof Dialog>) => previewWindow.hidden && props.title === 'LINEの見え方' ? null : <Dialog {...props} /> }
})

const hq = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), update: vi.fn(), get: vi.fn(), preflight: vi.fn(), exclude: vi.fn(), send: vi.fn(), stop: vi.fn(), cancel: vi.fn(), retry: vi.fn(), retryPreview: vi.fn(async (_id: string, accountId: string) => ({success:true,data:{count:accountId === 'a3' ? 460 : 10,token:'token-' + accountId}})),
  /* API-18：フォルダ・承認・テスト送信。承認が要らない（人数が少ない）ときの返事。 */
  folders: vi.fn(async () => ({ success: true, data: [] })),
  approvalCandidates: vi.fn(async () => ({ success: true, data: [] })),
  approval: vi.fn(async () => ({ success: true, data: { approval: { status: 'none', requestedByStaffId: null, requestedAt: null, approverStaffId: null, note: null, decidedByStaffId: null, decidedAt: null, rejectReason: null, confirmedCount: null }, gate: { required: false, recipientCount: 0, threshold: 1000, singleOperator: false, operatorCount: 2 }, viewer: { isApprover: false, canApprove: false, isRequester: false } } })),
  testSend: vi.fn(), testRecipients: vi.fn(async () => ({ success: true, data: { count: 1, recipients: [{ id: 'f', displayName: '確認先' }], token: 'a'.repeat(64) } })),
}))
const accounts = vi.hoisted(() => vi.fn())
const folders = vi.hoisted(() => vi.fn())
const tagList = vi.hoisted(() => vi.fn())
const assets = vi.hoisted(() => vi.fn())
const upload = vi.hoisted(() => vi.fn())
const tpl = vi.hoisted(() => ({ folders: { list: vi.fn(async () => []) }, listByKind: vi.fn(async (kind?: string) => { void kind; return [] as unknown[] }), get: vi.fn(), create: vi.fn(), uploadRichMessageImage: vi.fn() }))
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const push = vi.hoisted(() => vi.fn())
const replace = vi.hoisted(() => vi.fn())
const params = vi.hoisted(() => ({ value: new URLSearchParams() }))

vi.mock('@/lib/hq-broadcasts-api', () => ({ hqBroadcastsApi: hq }))
vi.mock('@/lib/api/helpers/gap1', () => ({ chatSafetyApi: { hqSendPreview: async () => ({ success: true, data: { recipients: 6120, excluded: { blocked: 0, optedOut: 0, duplicate: 0 }, purpose: 'marketing', scheduledAt: null, quietHoursShiftTo: null, needsApproval: false, firstText: '本文', sender: null, expectedVersion: 2, perAccount: [{ accountId: 'a1', recipients: 6120, recipientToken: 'a'.repeat(64), excluded: { blocked: 0, optedOut: 0, duplicate: 0 } }] } }) } }))
vi.mock('@/lib/hq-templates-api', async (original) => ({ ...await original<typeof import('@/lib/hq-templates-api')>(), hqTemplatesApi: tpl }))
/*
 * その場で作る：店のカルーセル・リッチメッセージの作る部品（host の口）は、ここでは口だけの代わりにする。
 * 本物の部品の動きは templates/carousel・template-edit/rich の試験が見る。ここで見るのは、組み立てた中身が吹き出しに入ること。
 */
vi.mock('@/v8/templates/carousel', () => ({
  default: ({ host }: { host: { onSave: (content: unknown, distribute: boolean) => void; onCancel: () => void; primaryLabel?: string } }) => React.createElement('div', null,
    React.createElement('button', { type: 'button', onClick: () => host.onSave({ kind: 'carousel', name: 'その場のカルーセル', messageContent: JSON.stringify([{ title: 'A', text: 'a', actions: [{ type: 'uri', label: '見る', uri: 'https://shop.example/a' }] }, { title: 'B', text: 'b', actions: [{ type: 'uri', label: '見る', uri: 'https://shop.example/b' }] }]), tapLimitMode: 'none', tapLimitText: null }, false) }, host.primaryLabel),
    React.createElement('button', { type: 'button', onClick: host.onCancel }, 'キャンセル')),
}))
vi.mock('@/v8/template-edit/rich', () => ({
  default: ({ host }: { host: { onSave: (content: unknown, distribute: boolean) => void; primaryLabel?: string } }) => React.createElement('button', { type: 'button', onClick: () => host.onSave({ kind: 'rich_message', name: 'その場のリッチ', payload: { imageUrl: 'https://cdn.example/rich.png', baseUrl: 'https://cdn.example/rich', baseSize: { width: 1040, height: 1040 }, tapAreas: [{ x: 0, y: 0, width: 100, height: 100, actionType: 'uri', uri: 'https://shop.example/' }] }, media: [{ id: 'm1' }] }, false) }, host.primaryLabel),
}))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return { ...actual, api: { ...actual.api, lineAccounts: { list: accounts }, lineAccountFolders: { list: folders }, tags: { list: tagList }, broadcastMessageAssets: { list: assets, upload }, scenarios: { list: async () => ({ success: true, data: [] }) }, segmentPresets: { list: async () => ({ success: true, data: [] }) } } }
})
vi.mock('@/lib/staff-role', () => ({ useTenantWideAccess: () => role.value === 'owner' || role.value === 'admin', useStaffRole: () => role.value, canManageRole: (r: string | null) => r === 'owner' || r === 'admin' }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace }), useSearchParams: () => params.value }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children) }))

import HqBroadcastCreate from './create'
import HqBroadcastDetail from './detail'
import { pickEntity } from '@/components/shared/entity-picker-test-helpers'

it('通常の最終確認にも送信先だけと環境を示す', async () => {
  render(<HqBroadcastCreate />)
  await fillToConfirm()
  await screen.findByText('送る：1アカウント・6,120 人')
  fireEvent.click(screen.getByRole('button', { name: 'この内容で予約する' }))
  const dialog = await screen.findByRole('dialog', { name: '送る前の確かめ' })
  await waitFor(() => expect(within(dialog).getAllByText('銀座店')).toHaveLength(2))
  expect(within(dialog).queryByText('新宿店')).toBeNull()
  expect(within(dialog).getByText('環境')).toBeTruthy()
  expect(hq.send).not.toHaveBeenCalled()
})

it('単独運用の最終確認に送信先だけと環境を示す', async () => {
  const originalApproval = hq.approval.getMockImplementation()
  hq.approval.mockResolvedValue({ success: true, data: { approval: { status: 'none', requestedByStaffId: null, requestedAt: null, approverStaffId: null, note: null, decidedByStaffId: null, decidedAt: null, rejectReason: null, confirmedCount: null }, gate: { required: true, recipientCount: 6120, threshold: 1000, singleOperator: true, operatorCount: 1 }, viewer: { isApprover: false, canApprove: false, isRequester: false } } })
  render(<HqBroadcastCreate />)
  await fillToConfirm()
  await screen.findByText('送る：1アカウント・6,120 人')
  fireEvent.click(screen.getByRole('button', { name: 'この内容で予約する' }))
  const dialog = await screen.findByRole('dialog', { name: '1アカウントに送ります' })
  expect(within(dialog).getByText('銀座店')).toBeTruthy()
  expect(within(dialog).queryByText('新宿店')).toBeNull()
  expect(within(dialog).getByText('環境')).toBeTruthy()
  expect(hq.send).not.toHaveBeenCalled()
  if (originalApproval) hq.approval.mockImplementation(originalApproval)
})

const check = (accountId: string, accountName: string, audienceCount: number, blockedReasons: string[] = []) => ({
  accountId, accountName, audienceCount, remaining: 10000, connected: true, paused: false, blockedReasons, excluded: false, broadcastId: null,
})
const folder = (id: string, name: string) => ({ id, kind: 'line_account', name, parentId: null, color: '#2f6fde', displayOrder: 1, createdAt: '', updatedAt: '' })

beforeEach(() => {
  previewWindow.hidden = false
  hq.retryPreview.mockImplementation(async (id:string,accountId:string)=>({success:true,data:{count:id==='run-9'&&accountId==='a3'?460:10,token:'token-'+accountId}}))
  role.value = 'owner'
  // 画面の住所（段の切り替えは同じ住所の中で履歴だけを書き換える）。
  window.history.replaceState(null, '', '/hq/broadcasts/new')
  params.value = new URLSearchParams()
  accounts.mockResolvedValue({ success: true, data: [
    { id: 'a1', name: '銀座店', tags: [{ id: 't1', name: '関東', color: null }], stats: { friendCount: 6120 }, folderId: 'f1', folder: folder('f1', '関東') },
    { id: 'a2', name: '新宿店', tags: [{ id: 't1', name: '関東', color: null }], stats: { friendCount: 5880 }, folderId: 'f1', folder: folder('f1', '関東') },
    { id: 'a3', name: '梅田店', tags: [{ id: 't2', name: '関西', color: null }], stats: { friendCount: 3950 }, folderId: 'f2', folder: folder('f2', '関西') },
  ] })
  folders.mockResolvedValue({ success: true, data: { folders: [folder('f1', '関東'), folder('f2', '関西')], total: 3, unclassifiedCount: 0 } })
  tagList.mockResolvedValue({ success: true, data: [{ id: 'x', name: 'VIP' }] })
  hq.list.mockResolvedValue({ data: [] })
  hq.create.mockImplementation(async (body: Record<string, unknown>) => ({ data: { id: 'run-1', title: 't', status: 'prepared', version: 1, scheduledAt: null, targets: [], input: body } }))
  hq.update.mockImplementation(async (id: string, body: Record<string, unknown>) => ({ data: { id, title: 't', status: 'prepared', version: Number(body.expectedVersion) + 1, scheduledAt: null, targets: [], input: body } }))
  assets.mockResolvedValue({ success: true, data: [
    { id: 'as-1', lineAccountId: null, kind: 'coupon', name: '冬の10%オフ', payload: { description: '会計から10%引き', startsAt: '2026-01-01', endsAt: '2026-01-31' }, createdAt: '', updatedAt: '' },
    { id: 'as-2', lineAccountId: 'a1', kind: 'coupon', name: '銀座店だけ', payload: {}, createdAt: '', updatedAt: '' },
  ] })
  hq.preflight.mockResolvedValue({ data: [check('a1', '銀座店', 6120), check('a2', '新宿店', 5880, ['今月の送信枠が足りません'])] })
  hq.exclude.mockResolvedValue({ data: { id: 'run-1', title: 't', status: 'prepared', version: 2, scheduledAt: null, targets: [] } })
  hq.send.mockResolvedValue({ data: {} })
  hq.cancel.mockResolvedValue({ data: {} })
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers() })

async function selectAccounts(...names: string[]) {
  fireEvent.click(await screen.findByRole('button', { name: /^送るアカウント：(選ぶ|変える)$/ }))
  const dialog = await screen.findByRole('dialog', { name: '送るアカウントを選ぶ' })
  for (const name of names) fireEvent.click(within(dialog).getByRole('checkbox', { name, exact: true }))
  fireEvent.click(within(dialog).getByRole('button', { name: `選ぶ（${names.length}件）` }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

/** ① 配信名 → ② 関東の2店を選ぶ → ③ 本文 → ⑤ 最終確認まで進める。 */
async function fillToConfirm(body = '{店名}より：1月の限定メニュー') {
  fireEvent.change(screen.getByLabelText('配信名'), { target: { value: '1月の限定メニュー' } })
  fireEvent.click(screen.getByRole('button', { name: '対象設定へ' }))
  await selectAccounts('銀座店', '新宿店')
  expect(screen.getByText('12,000 人')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'メッセージ設定へ' }))
  fireEvent.change(screen.getByLabelText('本文'), { target: { value: body } })
  fireEvent.click(screen.getByRole('button', { name: '送信設定へ' }))
  fireEvent.click(screen.getByRole('button', { name: '配信前チェックへ' }))
}

describe('配信イメージの確認', () => {
  it('入力後のキャンセルは確認し、編集を続けると入力を残す', async () => {
    render(<HqBroadcastCreate />)
    fireEvent.change(screen.getByLabelText('配信名'), { target: { value: '架空の配信' } })
    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    const dialog = await screen.findByRole('dialog', { name: '保存していない変更があります' })
    fireEvent.click(within(dialog).getByRole('button', { name: '編集を続ける' }))
    expect((screen.getByLabelText('配信名') as HTMLInputElement).value).toBe('架空の配信')
  })

  it('過去の配信が0件なら複製を止めて理由とキャンセル先を表示する', async () => {
    render(<HqBroadcastCreate />)
    await screen.findByText('複製できる配信がありません。')
    expect((screen.getByRole('radio', { name: /過去の配信を複製/ }) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByRole('link', { name: 'キャンセル' }).getAttribute('href')).toBe('/hq/broadcasts')
  })

  it('履歴取得に失敗したら0件と断定せず、読み直しを案内する', async () => {
    hq.list.mockRejectedValueOnce(new Error('offline'))
    render(<HqBroadcastCreate />)
    expect(await screen.findByText('配信履歴を確認できません。画面を読み直してください。')).toBeTruthy()
    expect((screen.getByRole('radio', { name: /過去の配信を複製/ }) as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByText('複製できる配信がありません。')).toBeNull()
    expect(screen.getByText('配信履歴を読み込めませんでした。')).toBeTruthy()
    expect(screen.queryByText('最近の配信はまだありません。')).toBeNull()
  })

  it('見本の窓が出ない場合はボタンを押しても確認済みにしない', async () => {
    previewWindow.hidden = true
    params.value = new URLSearchParams('step=message')
    render(<HqBroadcastCreate />)
    await screen.findByLabelText('本文')
    const check = screen.getByRole('checkbox', { name: 'LINEプレビューが未確認です' }) as HTMLInputElement
    fireEvent.click(screen.getByRole('button', { name: '配信イメージを見る' }))
    expect(screen.queryByRole('dialog', { name: 'LINEの見え方' })).toBeNull()
    expect(check.checked).toBe(false)
    expect(hq.send).not.toHaveBeenCalled()
  })

  it('現在の見本を開いた時だけ確認し、本文の変更で解除する', async () => {
    params.value = new URLSearchParams('step=message')
    const view = render(<HqBroadcastCreate />)
    const body = await screen.findByLabelText('本文')
    fireEvent.change(body, { target: { value: '目で確かめる本文' } })
    const check = screen.getByRole('checkbox', { name: 'LINEプレビューが未確認です' }) as HTMLInputElement
    expect(check.disabled).toBe(true)
    expect(check.closest('[data-incomplete]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '配信イメージを見る' }))
    const dialog = screen.getByRole('dialog', { name: 'LINEの見え方' })
    expect(within(dialog).getByText('目で確かめる本文')).toBeTruthy()
    expect(check.checked).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
    fireEvent.change(body, { target: { value: '書き直した本文' } })
    expect(check.checked).toBe(false)
    expect(check.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'LINEの見え方を確認' }))
    const narrow = screen.getByRole('dialog', { name: 'LINEの見え方' })
    expect(within(narrow).getByText('書き直した本文')).toBeTruthy()
    expect(within(narrow).getByRole('checkbox', { name: 'LINEプレビュー確認済み' })).toBeTruthy()
    expect(within(narrow).getByRole('button', { name: /テストを送る/ })).toBeTruthy()
    expect(within(narrow).getByRole('group', { name: 'プレビューの端末' })).toBeTruthy()
    expect(within(narrow).queryByRole('button', { name: '配信イメージを見る' })).toBeNull()
    expect(check.checked).toBe(true)
    expect(view.container.textContent).toContain('書き直した本文')
    expect(hq.send).not.toHaveBeenCalled()
  })
})

describe('一括配信を作る（BBRDb：店の一斉配信と同じ5段＋送るアカウント）', () => {
  it('日本で日付が変わった直後でも、予約の初期日は日本の明日になる', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-09T15:00:00Z'))
    params.value = new URLSearchParams('step=schedule')
    render(<HqBroadcastCreate />)
    const date = await screen.findByRole('button', { name: '送る日' })
    expect(date.textContent).toContain('2026年10月11日')
  })

  it('本文の無い吹き出しは帯にせず、吹き出しの下に理由と頭に赤い丸を出し、そこへ移る', async () => {
    render(<HqBroadcastCreate />)
    await toMessage()
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    const bubble = screen.getByLabelText('1通目の吹き出し')
    await waitFor(() => expect(within(bubble).getByRole('alert').textContent).toBe('本文を入れてください'))
    expect(within(bubble).getByRole('img', { name: '1通目に直す欄が1か所' })).toBeTruthy()
    await waitFor(() => expect(bubble.contains(document.activeElement)).toBe(true))
    expect(hq.create).not.toHaveBeenCalled()
  })

  it('窓で確定した宛先を下書きに保存し、読み直しても選択と要約を戻す', async () => {
    const view = render(<HqBroadcastCreate />)
    fireEvent.change(screen.getByLabelText('配信名'), { target: { value: '宛先の下書き' } })
    fireEvent.click(screen.getByRole('button', { name: '対象設定へ' }))
    expect(await screen.findByText('送るアカウントを選ぶ')).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: '銀座店' })).toBeNull()
    await selectAccounts('銀座店', '新宿店', '梅田店')
    expect(screen.getByText('3 アカウント')).toBeTruthy()
    expect(screen.getByText('銀座店・新宿店 ほか1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'メッセージ設定へ' }))
    fireEvent.change(screen.getByLabelText('本文'), { target: { value: 'ご案内です' } })
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    await waitFor(() => expect(hq.create).toHaveBeenCalledTimes(1))
    const input = hq.create.mock.calls[0][0]
    expect(input.accountIds).toEqual(['a1', 'a2', 'a3'])
    view.unmount()
    params.value = new URLSearchParams('id=run-1&step=audience')
    hq.get.mockResolvedValue({ data: { id: 'run-1', status: 'prepared', version: 1, input } })
    render(<HqBroadcastCreate />)
    await screen.findByText('銀座店・新宿店 ほか1')
    fireEvent.click(screen.getByRole('button', { name: '送るアカウント：変える' }))
    const dialog = await screen.findByRole('dialog', { name: '送るアカウントを選ぶ' })
    for (const name of ['銀座店', '新宿店', '梅田店']) expect((within(dialog).getByRole('checkbox', { name }) as HTMLInputElement).checked).toBe(true)
  })

  it('送るアカウントを選び、最終確認で確かめると問題のある店を外し、送ると版を付けて送る', async () => {
    render(<HqBroadcastCreate />)
    await fillToConfirm()
    await screen.findByText('送る：1アカウント・6,120 人')
    const input = hq.create.mock.calls[0][0]
    expect(input.accountIds).toEqual(['a1', 'a2'])
    expect(input.accountTagIds).toEqual([])
    expect(input.title).toBe('1月の限定メニュー')
    expect(input.messageContent).toBe('{{account.name}}より：1月の限定メニュー')
    expect(input.audience).toEqual({ kind: 'all' })
    expect(input.requestId).toBeTruthy()
    /* 送信枠の足りない新宿店は外す（口は外した店を送らない）。版は作ったときの 1。 */
    expect(hq.exclude).toHaveBeenCalledWith('run-1', ['a2'], 1)
    /* 保存した下書きは URL に id を残す（読み直しても同じ下書き）。 */
    expect(new URLSearchParams(window.location.search).get('id')).toBe('run-1')
    /*
     * 段の切り替え・id の書き込みはルーターを通さない（2026-10-08 オーナー：「次へ」で
     * 「このサイトを離れますか？」）。ルーターを通すと RSC を取りに行き、新しい版の後は
     * 画面を丸ごと読み直す。履歴だけを書き換える。
     */
    expect(window.location.pathname).toBe('/hq/broadcasts/new')
    expect(new URLSearchParams(window.location.search).get('step')).toBe('confirm')
    expect(replace).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'この内容で予約する' }))
    fireEvent.click(await screen.findByRole('button', { name: /人に.*予約する$/ }))
    await waitFor(() => expect(hq.send).toHaveBeenCalledWith('run-1', 2, undefined, [{ accountId: 'a1', recipientCount: 6120, recipientToken: 'a'.repeat(64) }]))
    expect(push).toHaveBeenCalledWith('/hq/broadcasts/detail?id=run-1')
  })

  it('手順の済みの段（✓）を押すと、その段へ戻る（今とまだの段は押せない）', async () => {
    render(<HqBroadcastCreate />)
    fireEvent.change(screen.getByLabelText('配信名'), { target: { value: '1月の限定メニュー' } })
    fireEvent.click(screen.getByRole('button', { name: '対象設定へ' }))
    await screen.findByRole('button', { name: '送るアカウント：選ぶ' })
    const steps = screen.getByRole('navigation', { name: '配信作成の進み' })
    /* 今の段（配信対象）とまだの段は押せない。 */
    expect(steps.querySelector('[aria-current="step"]')?.textContent).toContain('配信対象')
    expect(screen.queryByRole('button', { name: '配信対象に戻る' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'メッセージを作成に戻る' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '基本設定に戻る' }))
    /* 基本設定の段が出る（配信名の欄・URL も書き換え）。 */
    expect((await screen.findByLabelText('配信名') as HTMLInputElement).value).toBe('1月の限定メニュー')
    expect(steps.querySelector('[aria-current="step"]')?.textContent).toContain('基本設定')
    /* URL の段は履歴だけを書き換える（ルーターを通さない・#1630 と同じ決まり）。 */
    expect(new URLSearchParams(window.location.search).get('step')).toBeNull()
    expect(replace).not.toHaveBeenCalled()
  })

  it('API-18：フォルダ・社内メモ・シナリオ購読中・除くタグ・2つの吹き出しを口へ送る', async () => {
    hq.folders.mockResolvedValue({ success: true, data: [{ id: 'bf-1', name: 'キャンペーン', revision: 1, item_count: 0 }] })
    render(<HqBroadcastCreate />)
    fireEvent.change(screen.getByLabelText('配信名'), { target: { value: '1月の限定メニュー' } })
    await waitFor(() => expect(hq.folders).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('社内メモ'), { target: { value: '関東だけ' } })
    fireEvent.click(screen.getByRole('button', { name: '対象設定へ' }))
    await selectAccounts('銀座店')
    fireEvent.click(screen.getByRole('radio', { name: /シナリオ購読中の全員に配信する/ }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'メッセージ設定へ' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'メッセージ設定へ' }))
    fireEvent.change(screen.getByLabelText('本文'), { target: { value: '1通目' } })
    fireEvent.click(screen.getByRole('button', { name: /メッセージを追加する/ }))
    fireEvent.change(screen.getByLabelText('2通目の本文'), { target: { value: '2通目' } })
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    await waitFor(() => expect(hq.create).toHaveBeenCalled())
    const input = hq.create.mock.calls[0][0]
    expect(input.internalMemo).toBe('関東だけ')
    expect(input.targetType).toBe('segment')
    expect(input.segmentConditions).toEqual({ operator: 'AND', rules: [{ type: 'scenario_subscribed', value: '' }] })
    const bubbles = JSON.parse(input.messageBubblesJson)
    expect(bubbles.map((b: { content: { text: string } }) => b.content.text)).toEqual(['1通目', '2通目'])
  })

  it('API-18：承認が要るときは送らず［承認を依頼する］（別の担当者を選んで頼む）', async () => {
    hq.approval.mockResolvedValue({ success: true, data: { approval: { status: 'none', requestedByStaffId: null, requestedAt: null, approverStaffId: null, note: null, decidedByStaffId: null, decidedAt: null, rejectReason: null, confirmedCount: null }, gate: { required: true, recipientCount: 6120, threshold: 1000, singleOperator: false, operatorCount: 2 }, viewer: { isApprover: false, canApprove: false, isRequester: false } } })
    hq.approvalCandidates.mockResolvedValue({ success: true, data: [{ id: 's-2', name: '佐々木', role: 'admin', canApprove: true }] })
    render(<HqBroadcastCreate />)
    await fillToConfirm()
    await screen.findByText('送る：1アカウント・6,120 人')
    fireEvent.click(await screen.findByRole('button', { name: '承認を依頼する' }))
    expect(await screen.findByText(/もう1人の承認が要ります/)).toBeTruthy()
    expect(await screen.findByText('承認をお願いする人')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '予約する' })).toBeNull()
    expect(hq.send).not.toHaveBeenCalled()
  })

  it('入れていない所があると口を呼ばず、欄の理由を出してその段へ移る', async () => {
    render(<HqBroadcastCreate />)
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    expect((await screen.findByRole('alert')).textContent).toContain('配信名を入れてください')
    const titleInput = screen.getByLabelText('配信名')
    expect(titleInput.getAttribute('aria-invalid')).toBe('true')
    const errorIds = titleInput.getAttribute('aria-describedby')?.split(' ') ?? []
    expect(errorIds.some(id => document.getElementById(id)?.textContent?.includes('配信名を入れてください'))).toBe(true)
    fireEvent.change(screen.getByLabelText('配信名'), { target: { value: '告知' } })
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    expect((await screen.findByRole('alert')).textContent).toContain('送るアカウントを選んでください')
    expect(await screen.findByRole('heading', { name: '送るアカウント' })).toBeTruthy()
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('送るアカウント：選ぶ'))
    expect(hq.create).not.toHaveBeenCalled()
  })

  it('本文を変えたら、もう一度確かめるまで送らない（同じ下書きを版つきで直す。取り消して作り直さない）', async () => {
    render(<HqBroadcastCreate />)
    await fillToConfirm('はじめの本文')
    await screen.findByText('送る：1アカウント・6,120 人')
    fireEvent.click(screen.getByRole('button', { name: 'メッセージへ戻る' }))
    fireEvent.change(screen.getByLabelText('本文'), { target: { value: '直した本文' } })
    fireEvent.click(screen.getByRole('button', { name: '送信設定へ' }))
    fireEvent.click(screen.getByRole('button', { name: '配信前チェックへ' }))
    await waitFor(() => expect(hq.update).toHaveBeenCalledTimes(1))
    expect(hq.create).toHaveBeenCalledTimes(1)
    expect(hq.cancel).not.toHaveBeenCalled()
    const [id, body] = hq.update.mock.calls[0]
    expect(id).toBe('run-1')
    expect(body).toMatchObject({ messageContent: '直した本文', expectedVersion: 2, requestId: hq.create.mock.calls[0][0].requestId })
  })

  it('WEB011：作れたあと確かめが失敗したら、やり直しは確かめから再開する（作成・更新を繰り返さない）', async () => {
    hq.preflight.mockRejectedValueOnce(new Error('network'))
    render(<HqBroadcastCreate />)
    await fillToConfirm()
    await waitFor(() => expect(hq.create).toHaveBeenCalledTimes(1))
    const again = await screen.findByRole('button', { name: '送る前に確かめる' })
    expect(new URL(window.location.href).searchParams.get('id')).toBe('run-1')
    fireEvent.click(again)
    await screen.findByText('送る：1アカウント・6,120 人')
    expect(hq.create).toHaveBeenCalledTimes(1)
    expect(hq.update).not.toHaveBeenCalled()
  })

  it('WEB011：自動除外が失敗しても、作成せず同じ版から除外をやり直す', async () => {
    hq.exclude.mockRejectedValueOnce(new Error('network'))
    render(<HqBroadcastCreate />)
    await fillToConfirm()
    const again = await screen.findByRole('button', { name: '送る前に確かめる' })
    expect(new URL(window.location.href).searchParams.get('id')).toBe('run-1')
    fireEvent.click(again)
    await screen.findByText('送る：1アカウント・6,120 人')
    expect(hq.create).toHaveBeenCalledTimes(1)
    expect(hq.update).not.toHaveBeenCalled()
    expect(hq.exclude.mock.calls.map((call) => call[2])).toEqual([1, 1])
  })

  it('?id= の下書きを読み、配信名・本文・送るアカウント（タグで作った下書きはそのタグのアカウント）・時刻を戻して、同じ下書きを直す', async () => {
    params.value = new URLSearchParams('id=run-7&step=confirm')
    hq.get.mockResolvedValue({ data: {
      id: 'run-7', title: '1月の限定メニュー', status: 'prepared', version: 3, scheduledAt: null, targets: [],
      input: { requestId: 'req-7', title: '1月', messageType: 'text', messageContent: '{{ account.name }}より：電話 {{var.store_phone}}', accountIds: [], accountTagIds: ['t2'], excludedAccountIds: [], audience: { kind: 'all' }, scheduledAt: null },
    } })
    render(<HqBroadcastCreate />)
    await waitFor(() => expect(screen.getByText('梅田店（1）', { exact: false })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '送る前に確かめる' }))
    await waitFor(() => expect(hq.update).toHaveBeenCalledWith('run-7', expect.objectContaining({ requestId: 'req-7', expectedVersion: 3, title: '1月', accountIds: ['a3'], accountTagIds: [], scheduledAt: null, messageContent: '{{account.name}}より：電話 {{var.store_phone}}' })))
    expect(hq.create).not.toHaveBeenCalled()
  })

  it('タグで絞ると、選んだアカウントのタグの名前から選び、口へは同じ名前のタグで送る', async () => {
    render(<HqBroadcastCreate />)
    fireEvent.change(screen.getByLabelText('配信名'), { target: { value: 'VIP だけ' } })
    fireEvent.click(screen.getByRole('button', { name: '対象設定へ' }))
    await selectAccounts('銀座店')
    fireEvent.click(screen.getByRole('radio', { name: /タグで絞り込んで配信する/ }))
    await waitFor(() => expect(tagList).toHaveBeenCalledWith({ accountId: 'a1' }))
    await waitFor(() => expect((screen.getByRole('button', { name: '含めるタグ：選ぶ' }) as HTMLButtonElement).disabled).toBe(false))
    await pickEntity('含めるタグ', 'VIP')
    fireEvent.click(screen.getByRole('button', { name: 'メッセージ設定へ' }))
    fireEvent.change(screen.getByLabelText('本文'), { target: { value: 'ご案内' } })
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    await waitFor(() => expect(hq.create).toHaveBeenCalled())
    expect(hq.create.mock.calls[0][0].audience).toEqual({ kind: 'tag', tagName: 'VIP' })
  })

  it('クーポンは統括の共有素材（どの店にも属さない）から選び、店側と同じ吹き出しで送る', async () => {
    render(<HqBroadcastCreate />)
    fireEvent.change(screen.getByLabelText('配信名'), { target: { value: '冬のクーポン' } })
    fireEvent.click(screen.getByRole('button', { name: '対象設定へ' }))
    await selectAccounts('銀座店')
    fireEvent.click(screen.getByRole('button', { name: 'メッセージ設定へ' }))
    /* 絵 lLyFR の「その他」がクーポン（統括だけの種類）。 */
    fireEvent.click(screen.getByRole('tab', { name: 'クーポン' }))
    fireEvent.click(await screen.findByRole('button', { name: 'クーポンを選ぶ' }))
    /* 店に属する素材（銀座店だけ）は出さない。 */
    expect(screen.queryByRole('radio', { name: '銀座店だけ' })).toBeNull()
    fireEvent.click(await screen.findByRole('radio', { name: '冬の10%オフ' }))
    fireEvent.click(screen.getByRole('button', { name: '選ぶ' }))
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    await waitFor(() => expect(hq.create).toHaveBeenCalled())
    const input = hq.create.mock.calls[0][0]
    expect(JSON.parse(input.messageBubblesJson)).toEqual([expect.objectContaining({ type: 'coupon', content: expect.objectContaining({ assetId: 'as-1', assetName: '冬の10%オフ' }) })])
    expect(input.messageType).not.toBe('text')
  })

  /** ① 配信名 → ② 銀座店 → ③ を開いたところまで。 */
  async function toMessage(name = '秋の新商品') {
    fireEvent.change(screen.getByLabelText('配信名'), { target: { value: name } })
    fireEvent.click(screen.getByRole('button', { name: '対象設定へ' }))
    await selectAccounts('銀座店')
    fireEvent.click(screen.getByRole('button', { name: 'メッセージ設定へ' }))
  }
  const carouselDetail = (id: string, columns: unknown[]) => ({
    template: { id, name: '秋の新商品 3種', template_type: 'template', description: null, revision: 1, updated_at: '' },
    definition: { schemaVersion: 1, media: [], template: { id, name: '秋の新商品 3種', category: '', messageType: 'carousel', messageContent: JSON.stringify(columns), carouselActionsJson: null, carouselTapLimitMode: 'none', carouselTapLimitText: null, questionJson: null, questionStatus: 'draft' } },
  })

  it('③ の種類のタブはリサーチと未対応の質問を区別し、見出しの右に［テンプレートから選ぶ］', async () => {
    render(<HqBroadcastCreate />)
    await toMessage()
    const tabs = within(screen.getByRole('tablist', { name: '1通目のメッセージ形式' })).getAllByRole('tab').map((tab) => tab.textContent)
    expect(tabs).toEqual(['テキスト', '画像', '動画', '音声', 'スタンプ', 'カルーセル', 'リッチメッセージ', 'リッチビデオ', '位置情報', 'リサーチ', '質問', '紹介', 'クーポン'])
    expect(screen.getByRole('button', { name: 'テンプレートから選ぶ' })).toBeTruthy()
  })

  it('画像はどの店にも属さない置き場へ上げ、店の一斉配信と同じ吹き出し（image）で送る', async () => {
    upload.mockResolvedValue({ success: true, data: { key: 'k', url: 'https://cdn.example/a.png', mimeType: 'image/png', size: 10 } })
    render(<HqBroadcastCreate />)
    await toMessage()
    fireEvent.click(screen.getByRole('tab', { name: '画像' }))
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } })
    await waitFor(() => expect(upload).toHaveBeenCalledWith(file, null))
    await screen.findByAltText('画像のプレビュー')
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    await waitFor(() => expect(hq.create).toHaveBeenCalled())
    const input = hq.create.mock.calls[0][0]
    expect(input.messageType).toBe('image')
    expect(JSON.parse(input.messageBubblesJson)).toEqual([expect.objectContaining({ type: 'image', content: expect.objectContaining({ originalContentUrl: 'https://cdn.example/a.png', previewImageUrl: 'https://cdn.example/a.png' }) })])
  })

  it('スタンプは店と同じ一覧から選び、sticker の吹き出しで送る', async () => {
    render(<HqBroadcastCreate />)
    await toMessage()
    fireEvent.click(screen.getByRole('tab', { name: 'スタンプ' }))
    fireEvent.click(screen.getByRole('button', { name: 'スタンプ 52002734' }))
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    await waitFor(() => expect(hq.create).toHaveBeenCalled())
    const input = hq.create.mock.calls[0][0]
    expect(input.messageType).toBe('sticker')
    expect(JSON.parse(input.messageContent)).toEqual({ packageId: '11537', stickerId: '52002734' })
    expect(JSON.parse(input.messageBubblesJson)[0].type).toBe('sticker')
  })

  it('カルーセルは統括のカルーセルのひな形から選び、カードの中身を控えて carousel の吹き出しで送る', async () => {
    const columns = [{ title: '秋の新商品 3種', text: '定期便なら10%オフ', actions: [{ type: 'uri', label: '商品を見る', uri: 'https://shop.example/a' }] }]
    tpl.listByKind.mockImplementation(async (kind?: string) => (!kind || kind === 'carousel' ? [{ id: 'ct-1', name: '秋の新商品 3種', kind: 'carousel' }] : []))
    tpl.get.mockResolvedValue(carouselDetail('ct-1', columns))
    render(<HqBroadcastCreate />)
    await toMessage()
    fireEvent.click(screen.getByRole('tab', { name: 'カルーセル' }))
    expect(tpl.listByKind).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByLabelText('1通目の吹き出し')).getByRole('button', { name: 'テンプレートから選ぶ' }))
    await waitFor(() => expect(tpl.listByKind).toHaveBeenCalledWith())
    fireEvent.click(await screen.findByRole('radio', { name: '秋の新商品 3種' }))
    fireEvent.click(screen.getByRole('button', { name: 'このテンプレートを使う' }))
    await screen.findByRole('button', { name: '開いて直す' })
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    await waitFor(() => expect(hq.create).toHaveBeenCalled())
    const input = hq.create.mock.calls[0][0]
    expect(input.messageType).toBe('carousel')
    expect(JSON.parse(input.messageContent)).toEqual(columns)
    expect(JSON.parse(input.messageBubblesJson)).toEqual([expect.objectContaining({ type: 'carousel', content: expect.objectContaining({ hqTemplateId: 'ct-1', columnsJson: JSON.stringify(columns) }) })])
  })

  it('ボタンで動きを実行する（postback）カルーセルは、店で押しても動かないので保存しない', async () => {
    tpl.listByKind.mockImplementation(async (kind?: string) => (!kind || kind === 'carousel' ? [{ id: 'ct-2', name: '秋の新商品 3種', kind: 'carousel' }] : []))
    tpl.get.mockResolvedValue(carouselDetail('ct-2', [{ text: 'a', actions: [{ type: 'postback', label: '申し込む', data: 'ctpl=hq&c=0&a=0' }] }]))
    render(<HqBroadcastCreate />)
    await toMessage()
    fireEvent.click(screen.getByRole('tab', { name: 'カルーセル' }))
    fireEvent.click(within(screen.getByLabelText('1通目の吹き出し')).getByRole('button', { name: 'テンプレートから選ぶ' }))
    fireEvent.click(await screen.findByRole('radio', { name: '秋の新商品 3種' }))
    fireEvent.click(screen.getByRole('button', { name: 'このテンプレートを使う' }))
    await screen.findByRole('button', { name: '開いて直す' })
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    expect((await screen.findAllByRole('alert')).map((el) => el.textContent).join('')).toContain('ボタンで動きを実行するカルーセルは、まだ統括からは送れません')
    expect(hq.create).not.toHaveBeenCalled()
  })

  it('まだ送れない紹介・リッチビデオは理由を示し、書いた本文を残す', async () => {
    render(<HqBroadcastCreate />)
    await toMessage()
    fireEvent.change(screen.getByLabelText('本文'), {target:{value:'残す本文'}})
    for (const name of ['質問','紹介','リッチビデオ']) {
      const tab = screen.getByRole('tab', {name})
      expect(tab.getAttribute('aria-disabled')).toBe('true')
      expect(tab.getAttribute('title')).toBeTruthy()
      fireEvent.click(tab)
      expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe('残す本文')
    }
    expect(hq.create).not.toHaveBeenCalled()
  })

  it('［テンプレートから選ぶ］で統括のひな形を選ぶと、開いている吹き出しをその内容にする', async () => {
    tpl.listByKind.mockImplementation(async () => [{ id: 'mt-1', name: '定休日のお知らせ', kind: 'message', content_summary: 'テキスト' }])
    tpl.get.mockResolvedValue({
      template: { id: 'mt-1', name: '定休日のお知らせ', template_type: 'template', description: null, revision: 1, updated_at: '' },
      definition: { schemaVersion: 1, media: [], template: { id: 'mt-1', name: '定休日のお知らせ', category: '', messageType: 'text', messageContent: '{{account.name}}は明日お休みです', carouselActionsJson: null, carouselTapLimitMode: 'none', carouselTapLimitText: null, questionJson: null, questionStatus: 'draft' } },
    })
    render(<HqBroadcastCreate />)
    await toMessage()
    fireEvent.click(screen.getByRole('button', { name: 'テンプレートから選ぶ' }))
    fireEvent.click(await screen.findByRole('radio', { name: '定休日のお知らせ' }))
    fireEvent.click(screen.getByRole('button', { name: 'このテンプレートを使う' }))
    await waitFor(() => expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe('{店名}は明日お休みです'))
  })

  it('① テンプレートを選択：窓で仮選択し、使う操作で1行と③の中身・右の見え方に反映する（EpTBB）', async () => {
    tpl.listByKind.mockImplementation(async () => [{ id: 'mt-1', name: '予約前日のご案内', kind: 'message', content_summary: 'テキスト', updated_at: '2026-09-28T00:00:00Z' }])
    tpl.get.mockResolvedValue({
      template: { id: 'mt-1', name: '予約前日のご案内', template_type: 'template', description: null, revision: 1, updated_at: '' },
      definition: { schemaVersion: 1, media: [], template: { id: 'mt-1', name: '予約前日のご案内', category: '', messageType: 'text', messageContent: '明日のご予約をお待ちしています', carouselActionsJson: null, carouselTapLimitMode: 'none', carouselTapLimitText: null, questionJson: null, questionStatus: 'draft' } },
    })
    render(<HqBroadcastCreate />)
    /* 右の列はどの段でもいつも出す（店の一斉配信と同じ頭とスマホ・PC）。 */
    const aside = screen.getByRole('complementary', { name: 'LINEの見え方' })
    expect(within(aside).getByRole('heading', { name: 'LINE の見え方' })).toBeTruthy()
    expect(within(aside).getByRole('button', { name: 'PC' })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /テンプレートを選択/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'テンプレートを選ぶ' }))
    fireEvent.click(await screen.findByRole('radio', { name: '予約前日のご案内' }))
    expect((screen.getByLabelText('配信名') as HTMLInputElement).value).toBe('')
    expect(within(aside).queryByText('明日のご予約をお待ちしています')).toBeNull()
    await waitFor(() => expect((screen.getByRole('button', { name: 'このテンプレートを使う' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'このテンプレートを使う' }))
    await waitFor(() => expect(within(aside).getByText('明日のご予約をお待ちしています')).toBeTruthy())
    expect((screen.getByLabelText('配信名') as HTMLInputElement).value).toBe('予約前日のご案内')
    expect(screen.getByRole('button', { name: '選び直す' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '対象設定へ' }))
    await selectAccounts('銀座店')
    fireEvent.click(screen.getByRole('button', { name: 'メッセージ設定へ' }))
    expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe('明日のご予約をお待ちしています')
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    await waitFor(() => expect(hq.create).toHaveBeenCalled())
    expect(hq.create.mock.calls[0][0].messageContent).toBe('明日のご予約をお待ちしています')
  })

  it('① 過去の配信を複製：選ぶと配信名に（コピー）を付けて中身を写し、宛先と日時は写さない', async () => {
    hq.list.mockResolvedValue({ data: [{ id: 'run-s', title: '9月キャンペーンのお知らせ', status: 'sent', version: 3, scheduledAt: '2026-09-20T01:00:00Z', targets: [{ ...check('a1', '銀座店', 1284), status: 'sent', totalCount: 1284, successCount: 1284, version: 1, retryableCount: 0, stopped: false, failureReasons: [] }],
      input: { requestId: 'r', title: '9月キャンペーンのお知らせ', messageType: 'text', messageContent: '9月のご案内です', accountIds: ['a1'], accountTagIds: [], excludedAccountIds: [], audience: { kind: 'tag', tagName: 'VIP' }, scheduledAt: '2026-09-20T01:00:00Z' } }] })
    render(<HqBroadcastCreate />)
    await waitFor(() => expect((screen.getByRole('radio', { name: /過去の配信を複製/ }) as HTMLInputElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('radio', { name: /過去の配信を複製/ }))
    hq.get.mockResolvedValue({ data: (await hq.list()).data[0] })
    fireEvent.click(screen.getByRole('button', { name: '過去の配信を選ぶ' }))
    fireEvent.click(await screen.findByRole('radio', { name: '9月キャンペーンのお知らせ' }))
    expect((screen.getByLabelText('配信名') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'この配信を写す' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((screen.getByLabelText('配信名') as HTMLInputElement).value).toBe('9月キャンペーンのお知らせ（コピー）')
    expect(within(screen.getByRole('complementary', { name: 'LINEの見え方' })).getByText('9月のご案内です')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '対象設定へ' }))
    expect(await screen.findByText('送るアカウントを選ぶ')).toBeTruthy()
    expect((screen.getByRole('radio', { name: /友だち全員に配信する/ }) as HTMLInputElement).checked).toBe(true)
  })

  it('③ カルーセルをその場で作る：店のカルーセルの作る部品で作った中身が吹き出しに入り、carousel で送る', async () => {
    render(<HqBroadcastCreate />)
    await toMessage()
    fireEvent.click(screen.getByRole('tab', { name: 'カルーセル' }))
    fireEvent.click(screen.getByRole('button', { name: 'ここで作る' }))
    fireEvent.click(await screen.findByRole('button', { name: 'この吹き出しに入れる' }))
    expect(await screen.findByRole('button', { name: '開いて直す' })).toBeTruthy()
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    await waitFor(() => expect(hq.create).toHaveBeenCalled())
    const input = hq.create.mock.calls[0][0]
    expect(input.messageType).toBe('carousel')
    expect(JSON.parse(input.messageBubblesJson)[0]).toMatchObject({ type: 'carousel', content: { templateName: 'その場のカルーセル' } })
  })

  it('③ リッチメッセージをその場で作る：店のリッチメッセージの作る部品で作った中身を rich_message の吹き出しで送る', async () => {
    render(<HqBroadcastCreate />)
    await toMessage()
    fireEvent.click(screen.getByRole('tab', { name: 'リッチメッセージ' }))
    fireEvent.click(screen.getByRole('button', { name: 'ここで作る' }))
    fireEvent.click(await screen.findByRole('button', { name: 'この吹き出しに入れる' }))
    await screen.findByRole('button', { name: '開いて直す' })
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    await waitFor(() => expect(hq.create).toHaveBeenCalled())
    const bubble = JSON.parse(hq.create.mock.calls[0][0].messageBubblesJson)[0]
    expect(bubble.type).toBe('rich_message')
    expect(bubble.content).toMatchObject({ assetName: 'その場のリッチ', imageUrl: 'https://cdn.example/rich.png' })
    expect(bubble.content.media).toBeUndefined()
  })

  it('［保存してテンプレートにする］：テキストは統括のひな形に保存し、まだ保存できない種類は口を呼ばず理由を出す', async () => {
    tpl.create.mockResolvedValue({ template: { id: 'new' }, definition: {} })
    render(<HqBroadcastCreate />)
    await toMessage('定休日')
    fireEvent.change(screen.getByLabelText('本文'), { target: { value: '{店名}は明日お休みです' } })
    fireEvent.click(screen.getByRole('button', { name: /保存してテンプレートにする/ }))
    fireEvent.click(await screen.findByRole('button', { name: '保存する' }))
    await waitFor(() => expect(tpl.create).toHaveBeenCalledTimes(1))
    const [body] = tpl.create.mock.calls[0]
    expect(body).toMatchObject({ type: 'template', name: '定休日', definition: { template: { messageType: 'text', messageContent: '{{account.name}}は明日お休みです' } } })
    fireEvent.click(screen.getByRole('tab', { name: 'スタンプ' }))
    fireEvent.click(screen.getByRole('button', { name: 'スタンプ 52002734' }))
    fireEvent.click(screen.getByRole('button', { name: /保存してテンプレートにする/ }))
    fireEvent.click(await screen.findByRole('button', { name: '保存する' }))
    expect(await screen.findByText('スタンプは、まだ統括のテンプレートとして保存できません')).toBeTruthy()
    expect(tpl.create).toHaveBeenCalledTimes(1)
  })

  it('画像・ボタンつきのメッセージのひな形（カード）は flex のまま送り、回答フォーム・シナリオのボタン（postback）があれば保存しない', async () => {
    const flex = (action: unknown) => JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '秋の新商品' }] }, footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', action }] } })
    tpl.listByKind.mockImplementation(async () => [{ id: 'mt-9', name: '秋の新商品のお知らせ', kind: 'message', content_summary: '本文・画像 1' }])
    const detail = (content: string) => ({ template: { id: 'mt-9', name: '秋の新商品のお知らせ', template_type: 'template', description: null, revision: 1, updated_at: '' },
      definition: { schemaVersion: 1, media: [], template: { id: 'mt-9', name: '秋の新商品のお知らせ', category: '', messageType: 'flex', messageContent: content, carouselActionsJson: null, carouselTapLimitMode: 'none', carouselTapLimitText: null, questionJson: null, questionStatus: 'draft' } } })
    tpl.get.mockResolvedValue(detail(flex({ type: 'uri', label: '見る', uri: 'https://shop.example/' })))
    render(<HqBroadcastCreate />)
    await toMessage()
    fireEvent.click(screen.getByRole('button', { name: 'テンプレートから選ぶ' }))
    fireEvent.click(await screen.findByRole('radio', { name: '秋の新商品のお知らせ' }))
    fireEvent.click(screen.getByRole('button', { name: 'このテンプレートを使う' }))
    expect(await screen.findByText(/のカードをそのまま送ります/)).toBeTruthy()
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    await waitFor(() => expect(hq.create).toHaveBeenCalled())
    expect(hq.create.mock.calls[0][0].messageType).toBe('flex')
    cleanup(); hq.create.mockClear()
    tpl.get.mockResolvedValue(detail(flex({ type: 'postback', label: '申し込む', data: 'form=1' })))
    render(<HqBroadcastCreate />)
    await toMessage()
    fireEvent.click(screen.getByRole('button', { name: 'テンプレートから選ぶ' }))
    fireEvent.click(await screen.findByRole('radio', { name: '秋の新商品のお知らせ' }))
    fireEvent.click(screen.getByRole('button', { name: 'このテンプレートを使う' }))
    await screen.findByText(/のカードをそのまま送ります/)
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    expect((await screen.findAllByRole('alert')).map((el) => el.textContent).join('')).toContain('回答フォーム・シナリオを開くボタンのあるカードは、まだ統括からは送れません')
    expect(hq.create).not.toHaveBeenCalled()
  })

  it('閲覧のみ（担当者）には作る画面を出さない', async () => {
    role.value = 'staff'
    render(<HqBroadcastCreate />)
    expect(screen.getByText(/統括全体の編集権限がある人/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /下書きを保存する|予約する|今すぐ送る/ })).toBeNull()
  })
})

describe('一括配信の詳細（xOXuY ⑤ 送った結果）', () => {
  it('下書きから送る前に対象アカウントと環境を確認できる', async () => {
    params.value = new URLSearchParams('id=run-detail')
    hq.approval.mockResolvedValue({ success: true, data: { approval: { status: 'none', requestedByStaffId: null, requestedAt: null, approverStaffId: null, note: null, decidedByStaffId: null, decidedAt: null, rejectReason: null, confirmedCount: null }, gate: { required: false, recipientCount: 50, threshold: 1000, singleOperator: false, operatorCount: 2 }, viewer: { isApprover: false, canApprove: false, isRequester: false } } })
    hq.get.mockResolvedValue({ data: { id: 'run-detail', title: '配信', status: 'prepared', version: 1, scheduledAt: null, input: { messageType: 'text', messageContent: '本文' }, targets: [{ ...check('a1', '銀座店', 50), status: 'prepared' }, { ...check('a2', '除外した新宿店', 10), excluded: true, status: 'excluded' }, { ...check('a3', '確認が必要な横浜店', 20, ['接続できません']), status: 'prepared' }] } })
    render(<HqBroadcastDetail />)
    fireEvent.click(await screen.findByRole('button', { name: '1店に送る' }))
    const dialog = await screen.findByRole('dialog', { name: '1店に送ります' })
    expect(within(dialog).getByText('銀座店')).toBeTruthy()
    expect(within(dialog).queryByText('除外した新宿店')).toBeNull()
    expect(within(dialog).queryByText('確認が必要な横浜店')).toBeNull()
    expect(within(dialog).getByText('環境')).toBeTruthy()
    expect(hq.send).not.toHaveBeenCalled()
  })
  it('店ごとの結果を出し、失敗した店にやり直す（店の配信の版を付ける）', async () => {
    params.value = new URLSearchParams('id=run-9')
    hq.get.mockResolvedValue({ data: {
      id: 'run-9', title: '1月の限定メニュー', status: 'scheduled', version: 4, scheduledAt: '2026-01-15T02:00:00.000Z',
      targets: [
        { ...check('a1', '銀座店', 6120), status: 'sent', totalCount: 6120, successCount: 6118, version: 3, retryableCount: 0, stopped: false, broadcastId: 'b1' },
        { ...check('a3', '名古屋店', 460), status: 'failed', totalCount: 460, successCount: 0, version: 5, retryableCount: 460, retryableToken: 'token-a3', stopped: false, broadcastId: 'b3' },
      ],
    } })
    hq.retry.mockResolvedValue({ data: {} })
    render(<HqBroadcastDetail />)
    await screen.findByText('アカウントごとの送った結果')
    expect(screen.getByText('送れた')).toBeTruthy()
    /* 表の中（店ごと）：見出しの「失敗」と名古屋店の札の2つ。上の数の帯の「失敗」は数えない。 */
    expect(within(document.querySelector('[data-design="hq-broadcast-result"]') as HTMLElement).getAllByText('失敗')).toHaveLength(2)
    expect(hq.retryPreview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /失敗した店にやり直す/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'やり直す' }))
    expect(hq.retryPreview).toHaveBeenCalledWith('run-9','a3')
    await waitFor(() => expect(hq.retry).toHaveBeenCalledWith('run-9', 'a3', 5, {count:460,token:'token-a3'}))
    expect(hq.retry).toHaveBeenCalledTimes(1)
  })

  it('店ごとの失敗の理由（口の failureReasons）を表の下に出す。下書きには［下書きを直す］', async () => {
    params.value = new URLSearchParams('id=run-9')
    hq.get.mockResolvedValue({ data: {
      id: 'run-9', title: '1月の限定メニュー', status: 'scheduled', version: 4, scheduledAt: '2026-01-15T02:00:00.000Z',
      targets: [
        { ...check('a3', '名古屋店', 460), status: 'failed', totalCount: 460, successCount: 0, version: 5, retryableCount: 460, retryableToken: 'token-a3', stopped: false, broadcastId: 'b3',
          failureReasons: [{ code: 'line_busy', label: 'LINEが混雑しています', count: 460, retryable: true }] },
      ],
    } })
    render(<HqBroadcastDetail />)
    const reasons = await waitFor(() => { const el = document.querySelector('[data-failure-reasons]'); if (!el) throw new Error('まだ'); return el as HTMLElement })
    expect(reasons.textContent).toContain('名古屋店')
    expect(reasons.textContent).toContain('LINEが混雑しています（460 人）・やり直せます')
    cleanup()
    hq.get.mockResolvedValue({ data: { id: 'run-9', title: '下書き', status: 'prepared', version: 1, scheduledAt: null, targets: [], input: { messageContent: '' } } })
    render(<HqBroadcastDetail />)
    expect((await screen.findByRole('link', { name: /下書きを直す/ })).getAttribute('href')).toBe('/hq/broadcasts/new?id=run-9')
  })
})

it('統括でリサーチの質問と公開版を読み込み下書きへ保存する', async () => {
 tpl.listByKind.mockResolvedValue([{id:'research1',name:'健康調査',kind:'research',content_summary:'リサーチ'}]);
 tpl.get.mockResolvedValue({template:{id:'research1',name:'健康調査',template_type:'template',current_version_id:'v1'},definition:{schemaVersion:1,media:[],template:{id:'source1',name:'健康調査',messageType:'text',messageContent:''},asset:{kind:'research',payload:{questions:[{text:'体調',format:'free',required:true}],answerActions:[]}}}});
 render(<HqBroadcastCreate />);fireEvent.change(screen.getByLabelText('配信名'),{target:{value:'健康調査'}});fireEvent.click(screen.getByRole('button',{name:'対象設定へ'}));await selectAccounts('銀座店');fireEvent.click(screen.getByRole('button',{name:'メッセージ設定へ'}));
 expect(screen.getByRole('tab',{name:'リサーチ'}).getAttribute('aria-disabled')).not.toBe('true');
 fireEvent.click(screen.getByRole('button',{name:'テンプレートから選ぶ'}));
 fireEvent.click(await screen.findByRole('radio',{name:'健康調査'}));fireEvent.click(screen.getByRole('button',{name:'このテンプレートを使う'}));
 await waitFor(()=>expect(screen.queryByRole('radio',{name:'健康調査'})).toBeNull());
 fireEvent.click(getPageAction({name:'下書きを保存する'}));
 await waitFor(()=>expect(hq.create).toHaveBeenCalled());
 expect(JSON.parse(hq.create.mock.calls[0][0].messageBubblesJson)[0]).toMatchObject({type:'research',content:{hqTemplateId:'research1',hqTemplateVersionId:'v1'}});
});


it('本文の手順でも作成型を重ねず、見出し・入力・保存帯を同じ板に保つ', async () => {
  params.value = new URLSearchParams('step=message')
  const { container } = render(React.createElement(HqBroadcastCreate))
  await waitFor(() => expect(screen.getByText(/メッセージ（/)).not.toBeNull())
  expect(container.querySelectorAll('[data-page-template="create"]')).toHaveLength(1)
  const frame = container.querySelector('[data-page-template="create"]')!
  expect(frame.querySelector('[data-template-region="heading"]')).not.toBeNull()
  expect(frame.querySelector('[data-template-region="content"] [role="textbox"]')).not.toBeNull()
  expect(frame.querySelector('[data-sticky-actions]')).not.toBeNull()
})

it.each(['競合', '結果不明'])('送信が%sなら窓に理由を残し、送る前の確かめをやり直すまで再送しない', async kind => {
  const { ApiError } = await import('@/lib/api')
  hq.send.mockRejectedValueOnce(kind === '競合' ? new ApiError(409, 'ほかの人が先に変更しました。') : new Error('通信の応答を確認できませんでした。'))
  hq.approval.mockResolvedValue({ success: true, data: { approval: { status: 'none' }, gate: { required: false, recipientCount: 6120, threshold: 1000, singleOperator: false, operatorCount: 2 }, viewer: { isApprover: false, canApprove: false, isRequester: false } } })
  render(<HqBroadcastCreate />)
  await fillToConfirm()
  await screen.findByText('送る：1アカウント・6,120 人')
  fireEvent.click(screen.getByRole('button', { name: 'この内容で予約する' }))
  const dialog = await screen.findByRole('dialog', { name: '送る前の確かめ' })
  fireEvent.click(await within(dialog).findByRole('button', { name: /人に予約する$/ }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('閉じて、送る前の確かめをやり直してください。')
  expect(screen.getByRole('dialog', { name: '送る前の確かめ' })).toBe(dialog)
  const resend = within(dialog).getByRole('button', { name: /人に予約する$/ })
  expect(resend.hasAttribute('disabled')).toBe(true)
  fireEvent.click(resend); fireEvent.click(resend)
  expect(hq.send).toHaveBeenCalledTimes(1)
  fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByRole('button', { name: '送る前に確かめる' })).toBeTruthy()
})

it('一括配信の再送確認は実際にやり直す店と環境を示す', async () => {
 hq.retry.mockReset().mockResolvedValue({ data: {} })
 params.value = new URLSearchParams('id=run-retry-targets')
 const target = (id: string, name: string, status: string, version: number) => ({ ...check(id, name, 10), status, totalCount: 10, successCount: status === 'sent' && id === 'a1' ? 10 : 0, version, retryableCount: id === 'a1' ? 0 : 10, stopped: false, broadcastId: 'b-' + id })
 hq.get.mockResolvedValue({ data: { id: 'run-retry-targets', title: '結果の確認', status: 'completed', version: 4, scheduledAt: null, targets: [target('a1', '銀座店', 'sent', 3), target('a3', '名古屋店', 'sent', 5)] } })
 render(<HqBroadcastDetail />)
 fireEvent.click(await screen.findByRole('button', { name: /失敗した店にやり直す/ }))
 const dialog = await screen.findByRole('dialog', { name: '失敗した店にやり直します' })
 expect(within(dialog).getByText('名古屋店')).toBeTruthy()
 expect(within(dialog).queryByText('銀座店')).toBeNull()
 expect(within(dialog).getByText('環境')).toBeTruthy()
 expect(within(dialog).getByText('1店・約10人に送ります')).toBeTruthy()
 expect(hq.retry).not.toHaveBeenCalled()
})

it('店別の再送確認は選んだ店と環境を示す', async () => {
 hq.retry.mockReset().mockResolvedValue({ data: {} })
 params.value = new URLSearchParams('id=run-retry-one')
 const target = { ...check('a3', '名古屋店', 10), status: 'sent', totalCount: 10, successCount: 0, version: 5, retryableCount: 10, stopped: false, broadcastId: 'b-a3' }
 hq.get.mockResolvedValue({ data: { id: 'run-retry-one', title: '結果の確認', status: 'completed', version: 4, scheduledAt: null, targets: [target] } })
 render(<HqBroadcastDetail />)
 fireEvent.click(await screen.findByRole('button', { name: '名古屋店のその他操作' }))
 fireEvent.click(await screen.findByRole('menuitem', { name: 'この店にやり直す' }))
 const dialog = await screen.findByRole('dialog', { name: 'この店にやり直します' })
 expect(within(dialog).getByText('名古屋店')).toBeTruthy()
 expect(within(dialog).getByText('環境')).toBeTruthy()
 expect(within(dialog).getByText('約10人に送ります')).toBeTruthy()
 expect(hq.retry).not.toHaveBeenCalled()
})

it.each([true, false])('送信前に止まった店は理由の有無が%sでも人数がまだ決まらないと示す', async hasReason => {
 params.value = new URLSearchParams('id=run-retry-unknown')
 hq.retryPreview.mockRejectedValue(new Error('確認できません'))
 const target = { ...check('a3', '名古屋店', 10), status: 'failed', totalCount: 0, successCount: 0, version: 5, retryableCount: 5, stopped: false, broadcastId: 'b-a3', failureReasons: hasReason ? [{ code: 'before_send_failed', label: '送信前に止まりました', count: 0, retryable: true }] : [] }
 hq.get.mockResolvedValue({ data: { id: 'run-retry-unknown', title: '結果の確認', status: 'completed', version: 4, scheduledAt: null, targets: [target] } })
 render(<HqBroadcastDetail />)
 fireEvent.click(await screen.findByRole('button', { name: /失敗した店にやり直す/ }))
 const dialog = await screen.findByRole('dialog', { name: '失敗した店にやり直します' })
 expect(within(dialog).getByText('1店・人数は送る時に決まります')).toBeTruthy()
 expect(within(dialog).getByRole('button',{name:'やり直す'}).hasAttribute('disabled')).toBe(true)
 expect(hq.retry).not.toHaveBeenCalled()
})

it.each([['既知', 7, '2店・約17人に送ります'], ['未確定', 0, '2店・人数は送る時に決まります']] as const)('一括再送で人数が%sの店を含むときは全店の人数を示す', async (_label, secondCount, expected) => {
 params.value = new URLSearchParams('id=run-retry-multiple')
 hq.retryPreview.mockImplementation(async (_id:string,accountId:string)=>{if(accountId==='a3'&&secondCount===0)throw new Error('確認できません');return {success:true,data:{count:accountId==='a3'?secondCount:10,token:'token-'+accountId}}})
 const target = (id: string, name: string, count: number) => ({ ...check(id, name, 10), status: count > 0 ? 'sent' : 'failed', totalCount: 10, successCount: 0, version: 5, retryableCount: count, stopped: false, broadcastId: 'b-' + id })
 hq.get.mockResolvedValue({ data: { id: 'run-retry-multiple', title: '結果の確認', status: 'completed', version: 4, scheduledAt: null, targets: [target('a1', '銀座店', 10), target('a3', '名古屋店', secondCount)] } })
 render(<HqBroadcastDetail />)
 fireEvent.click(await screen.findByRole('button', { name: /失敗した店にやり直す/ }))
 const dialog = await screen.findByRole('dialog', { name: '失敗した店にやり直します' })
 expect(within(dialog).getByText(expected)).toBeTruthy()
})

it('停止していない配信中の店は再送の候補にしない', async () => {
 params.value = new URLSearchParams('id=run-retry-running')
 const target = { ...check('a3', '名古屋店', 10), status: 'sending', totalCount: 10, successCount: 0, version: 5, retryableCount: 5, stopped: false, broadcastId: 'b-a3' }
 hq.get.mockResolvedValue({ data: { id: 'run-retry-running', title: '結果の確認', status: 'completed', version: 4, scheduledAt: null, targets: [target] } })
 render(<HqBroadcastDetail />)
 await screen.findAllByText('名古屋店')
 expect(screen.queryByRole('button', { name: /失敗した店にやり直す/ })).toBeNull()
 expect(screen.queryByRole('button', { name: '名古屋店のその他操作' })).toBeNull()
})

it('停止した配信の再送人数は確定前として表示する', async () => {
 params.value = new URLSearchParams('id=run-retry-stopped')
 hq.retryPreview.mockRejectedValue(new Error('確認できません'))
 const target = { ...check('a3', '名古屋店', 10), status: 'sending', totalCount: 10, successCount: 0, version: 5, retryableCount: 5, stopped: true, broadcastId: 'b-a3' }
 hq.get.mockResolvedValue({ data: { id: 'run-retry-stopped', title: '結果の確認', status: 'completed', version: 4, scheduledAt: null, targets: [target] } })
 render(<HqBroadcastDetail />)
 fireEvent.click(await screen.findByRole('button', { name: /失敗した店にやり直す/ }))
 const dialog = await screen.findByRole('dialog', { name: '失敗した店にやり直します' })
 expect(within(dialog).getByText('1店・人数は送る時に決まります')).toBeTruthy()
})

it('送信済みの一時失敗は再送人数を表示する', async () => {
 params.value = new URLSearchParams('id=run-retry-sent')
 hq.retryPreview.mockResolvedValue({success:true,data:{count:5,token:'token-a3'}})
 const target = { ...check('a3', '名古屋店', 10), status: 'sent', totalCount: 10, successCount: 5, version: 5, retryableCount: 5, stopped: false, broadcastId: 'b-a3' }
 hq.get.mockResolvedValue({ data: { id: 'run-retry-sent', title: '結果の確認', status: 'completed', version: 4, scheduledAt: null, targets: [target] } })
 render(<HqBroadcastDetail />)
 fireEvent.click(await screen.findByRole('button', { name: /失敗した店にやり直す/ }))
 const dialog = await screen.findByRole('dialog', { name: '失敗した店にやり直します' })
 expect(within(dialog).getByText('1店・約5人に送ります')).toBeTruthy()
})

it('一覧と人数が違う時は確認APIの人数と対象をそのまま送る', async () => {
 params.value=new URLSearchParams('id=run-preview-current')
 const target={...check('a3','名古屋店',10),status:'failed',totalCount:0,successCount:0,version:5,retryableCount:5,stopped:false,broadcastId:'b-a3'}
 hq.get.mockResolvedValue({data:{id:'run-preview-current',title:'結果の確認',status:'completed',version:4,scheduledAt:null,targets:[target]}})
 hq.retryPreview.mockResolvedValue({success:true,data:{count:13,token:'confirmed-token'}});hq.retry.mockReset().mockResolvedValue({data:{}})
 render(<HqBroadcastDetail />);fireEvent.click(await screen.findByRole('button',{name:/失敗した店にやり直す/}))
 const dialog=await screen.findByRole('dialog',{name:'失敗した店にやり直します'})
 expect(within(dialog).getByText('1店・約13人に送ります')).toBeTruthy()
 fireEvent.click(within(dialog).getByRole('button',{name:'やり直す'}))
 await waitFor(()=>expect(hq.retry).toHaveBeenCalledExactlyOnceWith('run-preview-current','a3',5,{count:13,token:'confirmed-token'}))
})

it('1店でも確認できなければ他の店も送り始めない', async () => {
 params.value=new URLSearchParams('id=run-preview-partial');retryConfirmation.current=undefined;hq.retry.mockReset()
 const target=(id:string)=>({...check(id,id==='a1'?'銀座店':'名古屋店',10),status:'failed',totalCount:0,successCount:0,version:5,retryableCount:5,stopped:false,broadcastId:'b-'+id})
 hq.get.mockResolvedValue({data:{id:'run-preview-partial',title:'結果の確認',status:'completed',version:4,scheduledAt:null,targets:[target('a1'),target('a3')]}})
 hq.retryPreview.mockImplementation(async (_id:string,accountId:string)=>{if(accountId==='a3')throw new Error('通信断');return {success:true,data:{count:10,token:'token-a1'}}})
 render(<HqBroadcastDetail />);fireEvent.click(await screen.findByRole('button',{name:/失敗した店にやり直す/}))
 const dialog=await screen.findByRole('dialog',{name:'失敗した店にやり直します'})
 expect(within(dialog).getByText('2店・人数は送る時に決まります')).toBeTruthy()
 expect(within(dialog).getByRole('button',{name:'やり直す'}).hasAttribute('disabled')).toBe(true)
 await act(async()=>{await retryConfirmation.current?.()});expect(hq.retry).not.toHaveBeenCalled()
})

it('再送確認中に人数が変わったら同じ版でも送信しない', async () => {
 hq.retry.mockReset().mockResolvedValue({ data: {} })
 params.value = new URLSearchParams('id=run-retry-count-change')
 const target = { ...check('a3', '名古屋店', 10), status: 'sent', totalCount: 10, successCount: 5, version: 5, retryableCount: 5, stopped: false, broadcastId: 'b-a3' }
 const run = { id: 'run-retry-count-change', title: '結果の確認', status: 'completed', version: 4, scheduledAt: null, targets: [target] }
 hq.get.mockResolvedValue({ data: run })
 render(<HqBroadcastDetail />)
 fireEvent.click(await screen.findByRole('button', { name: /失敗した店にやり直す/ }))
 const dialog = await screen.findByRole('dialog', { name: '失敗した店にやり直します' })
 run.targets = [{ ...target, retryableCount: 6 }]
 fireEvent.click(within(dialog).getByRole('button', { name: 'やり直す' }))
 expect(await within(dialog).findByRole('alert')).toBeTruthy()
 expect(hq.retry).not.toHaveBeenCalled()
})

it('再送の確認中に対象が変わったら送信せず読み直しを促す', async () => {
 hq.retry.mockReset().mockResolvedValue({ data: {} })
 params.value = new URLSearchParams('id=run-retry-change')
 const target = (id: string, name: string, version: number) => ({ ...check(id, name, 10), status: 'failed', totalCount: 10, successCount: 0, version, retryableCount: 10, stopped: false, broadcastId: 'b-' + id })
 const run = { id: 'run-retry-change', title: '結果の確認', status: 'completed', version: 4, scheduledAt: null, targets: [target('a1', '銀座店', 3)] }
 hq.get.mockResolvedValue({ data: run })
 render(<HqBroadcastDetail />)
 fireEvent.click(await screen.findByRole('button', { name: /失敗した店にやり直す/ }))
 const dialog = await screen.findByRole('dialog', { name: '失敗した店にやり直します' })
 run.targets.push(target('a3', '名古屋店', 5))
 fireEvent.click(within(dialog).getByRole('button', { name: 'やり直す' }))
 expect(await within(dialog).findByRole('alert')).toBeTruthy()
 expect(hq.retry).not.toHaveBeenCalled()
})

it('閉じた再送確認の確定口は送信しない', async () => {
 hq.retry.mockReset().mockResolvedValue({ data: {} })
 retryConfirmation.current = undefined
 params.value = new URLSearchParams('id=run-retry-closed')
 const target = { ...check('a1', '銀座店', 10), status: 'failed', totalCount: 10, successCount: 0, version: 3, retryableCount: 10, stopped: false, broadcastId: 'b-a1' }
 hq.get.mockResolvedValue({ data: { id: 'run-retry-closed', title: '結果の確認', status: 'completed', version: 4, scheduledAt: null, targets: [target] } })
 render(<HqBroadcastDetail />)
 fireEvent.click(await screen.findByRole('button', { name: /失敗した店にやり直す/ }))
 const dialog = await screen.findByRole('dialog', { name: '失敗した店にやり直します' })
 const oldConfirm = retryConfirmation.current!
 expect(oldConfirm).toBeTypeOf('function')
 fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
 await waitFor(() => expect(screen.queryByRole('dialog', { name: '失敗した店にやり直します' })).toBeNull())
 await act(async () => { await oldConfirm() })
 expect(hq.retry).not.toHaveBeenCalled()
})

it.each(['通信断', '500', '409'])('一括配信の店別やり直しの%sは窓内で止め、閉じた後の読直しで未完了の最新の版だけ送る', async kind => {
 const { ApiError } = await import('@/lib/api')
 params.value = new URLSearchParams('id=run-retry')
 const target = (id: string, version: number, status: string) => ({ ...check(id, id === 'a1' ? '銀座店' : '名古屋店', 10), status, totalCount: 10, successCount: status === 'sent' ? 10 : 0, version, retryableCount: status === 'sent' ? 0 : 10, retryableToken: 'token-' + id, stopped: false, broadcastId: 'b-' + id })
 hq.retryPreview.mockImplementation(async (_id: string, accountId: string) => ({success:true,data:{count:10,token:'token-' + accountId}}))
 const run = { id: 'run-retry', title: '結果の確認', status: 'completed', version: 4, scheduledAt: null, targets: [target('a1', 3, 'failed'), target('a3', 5, 'failed')] }
 hq.get.mockResolvedValueOnce({ data: run }).mockResolvedValue({ data: { ...run, version: 5, targets: [target('a1', 4, 'sent'), target('a3', 6, 'failed')] } })
 hq.retry.mockReset().mockResolvedValue({ data: {} }).mockResolvedValueOnce({ data: {} }).mockRejectedValueOnce(kind === '通信断' ? new Error('通信できませんでした。') : new ApiError(Number(kind), '保存を確認できませんでした。'))
 render(<HqBroadcastDetail />)
 fireEvent.click(await screen.findByRole('button', { name: /失敗した店にやり直す/ }))
 const dialog = await screen.findByRole('dialog', { name: '失敗した店にやり直します' })
 fireEvent.click(within(dialog).getByRole('button', { name: 'やり直す' }))
 expect((await within(dialog).findByRole('alert')).textContent).toContain('閉じて最新の状態を確認')
 const retry = within(dialog).getByRole('button', { name: 'もう一度' }); expect(retry.hasAttribute('disabled')).toBe(true)
 fireEvent.click(retry); expect(hq.retry.mock.calls).toEqual([['run-retry', 'a1', 3, {count:10,token:'token-a1'}], ['run-retry', 'a3', 5, {count:10,token:'token-a3'}]])
 fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
 await waitFor(() => expect(hq.get).toHaveBeenCalledTimes(2))
 fireEvent.click(screen.getByRole('button', { name: /失敗した店にやり直す/ }))
 const fresh = await screen.findByRole('dialog', { name: '失敗した店にやり直します' })
 fireEvent.click(within(fresh).getByRole('button', { name: 'やり直す' }))
 await waitFor(() => expect(hq.retry).toHaveBeenCalledTimes(3))
 expect(hq.retry.mock.calls[2]).toEqual(['run-retry', 'a3', 6, {count:10,token:'token-a3'}])
})

it('複数店の再送で一部が409なら開始済みの店と止まった店の今の人数を伝える',async()=>{
 const {ApiError}=await import('@/lib/api');params.value=new URLSearchParams('id=run-partial')
 const target=(accountId:string,accountName:string)=>({...check(accountId,accountName,10),status:'failed',totalCount:10,successCount:0,version:1,retryableCount:10,stopped:false,broadcastId:'b-'+accountId})
 hq.get.mockResolvedValue({data:{id:'run-partial',title:'配信',status:'completed',version:1,scheduledAt:null,targets:[target('a1','銀座店'),target('a3','名古屋店')]}})
 hq.retryPreview.mockImplementation(async (_id:string,accountId:string)=>({success:true,data:{count:10,token:'token-'+accountId}}))
 hq.retry.mockReset().mockResolvedValueOnce({data:{}}).mockRejectedValueOnce(new ApiError(409,'送る相手が変わりました',undefined,{currentCount:7}))
 render(<HqBroadcastDetail />);fireEvent.click(await screen.findByRole('button',{name:/失敗した店にやり直す/}))
 const dialog=await screen.findByRole('dialog',{name:'失敗した店にやり直します'});fireEvent.click(within(dialog).getByRole('button',{name:'やり直す'}))
 const message=(await within(dialog).findByRole('alert')).textContent??''
 expect(message).toContain('銀座店は送り始めました');expect(message).toContain('名古屋店（今は 7 人）')
 expect(message.match(/閉じて最新の状態を確認してください/g)).toHaveLength(1)
})

describe('読み込めない配信の保護', () => {
  const source = (raw: string) => ({ id: 'run-x', status: 'prepared', version: 1, targets: [], input: { requestId: 'r', title: '元の配信', messageContent: '元の本文', messageBubblesJson: raw, accountIds: [], accountTagIds: [], excludedAccountIds: [], audience: { kind: 'all' }, scheduledAt: null } })
  const unknown = JSON.stringify([{ type: 'future_kind', content: { value: '保持' } }])
  const mixed = JSON.stringify([{ type: 'text', content: { text: '正常' } }, { type: 'future_kind', content: { value: '保持' } }])
  it.each([['未知のみ', unknown], ['混在', mixed], ['質問', JSON.stringify([{type:'question',content:{}}])], ['紹介', JSON.stringify([{type:'intro',content:{}}])], ['壊れたJSON', '{'], ['配列以外', '{}'], ['null要素', '[null]'], ['上限超過', JSON.stringify(Array.from({length:6}, () => ({type:'text',content:{text:'a'}})))]])('%s の下書きは編集・保存・送信を止める', async (_name, raw) => {
    params.value = new URLSearchParams('id=run-x')
    const saved = source(raw)
    hq.get.mockResolvedValue({ data: saved })
    render(<HqBroadcastCreate />)
    expect((await screen.findByRole('alert')).textContent).toContain('編集・保存・送信はできません')
    expect(screen.queryByRole('button', { name: /下書きを保存する|今すぐ送る|予約する/ })).toBeNull()
    expect(screen.getByRole('link', { name: '一括配信の一覧へ' }).getAttribute('href')).toBe('/hq/broadcasts')
    expect(saved.input.messageBubblesJson).toBe(raw)
    expect(hq.create).not.toHaveBeenCalled(); expect(hq.update).not.toHaveBeenCalled(); expect(hq.send).not.toHaveBeenCalled()
  })
  it.each([['id', 'image'], ['copy', 'flex']])('吹き出しのない旧形式 %s / %s は保存を止める', async (param, messageType) => {
    params.value = new URLSearchParams(`${param}=run-x`)
    const saved = source('')
    hq.get.mockResolvedValue({ data: { ...saved, input: { ...saved.input, messageType } } })
    render(<HqBroadcastCreate />)
    expect((await screen.findByRole('alert')).textContent).toContain('編集・保存・送信はできません')
    expect(screen.queryByRole('button', { name: /下書きを保存する|今すぐ送る|予約する/ })).toBeNull()
    expect(hq.create).not.toHaveBeenCalled(); expect(hq.update).not.toHaveBeenCalled(); expect(hq.send).not.toHaveBeenCalled()
  })
  it('未対応の複製元を読み込んでも保存・送信しない', async () => {
    params.value = new URLSearchParams('copy=run-x')
    hq.get.mockResolvedValue({ data: source(mixed) })
    render(<HqBroadcastCreate />)
    expect((await screen.findByRole('alert')).textContent).toContain('編集・保存・送信はできません')
    expect(screen.queryByRole('button', { name: /下書きを保存する|今すぐ送る|予約する/ })).toBeNull()
    expect(hq.create).not.toHaveBeenCalled(); expect(hq.update).not.toHaveBeenCalled(); expect(hq.send).not.toHaveBeenCalled()
  })
  it('編集中の未対応配信の複製を拒否し入力を保持する', async () => {
    const saved = { ...source(mixed), status: 'sent', title: '過去の配信' }
    hq.list.mockResolvedValue({ data: [saved] })
    hq.get.mockResolvedValue({ data: saved })
    render(<HqBroadcastCreate />)
    fireEvent.change(screen.getByLabelText('配信名'), { target: { value: '編集中の名前' } })
    await waitFor(() => expect((screen.getByRole('radio', { name: /過去の配信を複製/ }) as HTMLInputElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('radio', { name: /過去の配信を複製/ }))
    fireEvent.click(screen.getByRole('button', { name: '過去の配信を選ぶ' }))
    fireEvent.click(await screen.findByRole('radio', { name: '過去の配信' }))
    fireEvent.click(screen.getByRole('button', { name: 'この配信を写す' }))
    expect((await screen.findByRole('alert')).textContent).toContain('複製できません')
    expect((screen.getByLabelText('配信名') as HTMLInputElement).value).toBe('編集中の名前')
    expect(hq.create).not.toHaveBeenCalled(); expect(hq.update).not.toHaveBeenCalled(); expect(hq.send).not.toHaveBeenCalled()
  })
  it('読込待ちにも保存・送信口を出さない', async () => {
    params.value = new URLSearchParams('id=run-x')
    hq.get.mockImplementation(() => new Promise(() => {}))
    render(<HqBroadcastCreate />)
    expect(screen.getByRole('status').textContent).toContain('読み込んでいます')
    expect(screen.queryByRole('button', { name: /下書きを保存する|今すぐ送る|予約する/ })).toBeNull()
    expect(hq.create).not.toHaveBeenCalled(); expect(hq.update).not.toHaveBeenCalled(); expect(hq.send).not.toHaveBeenCalled()
  })
})

it('一括配信の最終確認を閉じた後は古い確定から送らない', async () => {
  render(<HqBroadcastCreate />)
  await fillToConfirm()
  await screen.findByText('送る：1アカウント・6,120 人')
  fireEvent.click(screen.getByRole('button', { name: 'この内容で予約する' }))
  const dialog = within(await screen.findByRole('dialog', { name: '送る前の確かめ' }))
  const button = await dialog.findByRole('button', { name: /人に予約する$/ })
  const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
  const held = (button as unknown as Record<string,{onClick:(e:unknown)=>unknown}>)[key].onClick
  fireEvent.click(dialog.getByRole('button', { name: '戻る' }))
  fireEvent.click(screen.getByRole('button', { name: 'この内容で予約する' }))
  const reopened = within(await screen.findByRole('dialog', { name: '送る前の確かめ' }))
  await reopened.findByRole('button', { name: /人に予約する$/ })
  await act(async () => { await held({ defaultPrevented:false, preventDefault(){}, stopPropagation(){}, currentTarget:button, target:button }) })
  expect(hq.send).not.toHaveBeenCalled()
  fireEvent.click(reopened.getByRole('button', { name: /人に予約する$/ }))
  await waitFor(() => expect(hq.send).toHaveBeenCalledOnce())
})

it('単独運用の最終確認を閉じた後は古い確定から送らない', async () => {
  const originalApproval = hq.approval.getMockImplementation()
  hq.approval.mockResolvedValue({ success: true, data: { approval: { status: 'none', requestedByStaffId: null, requestedAt: null, approverStaffId: null, note: null, decidedByStaffId: null, decidedAt: null, rejectReason: null, confirmedCount: null }, gate: { required: true, recipientCount: 6120, threshold: 1000, singleOperator: true, operatorCount: 1 }, viewer: { isApprover: false, canApprove: false, isRequester: false } } })
  render(<HqBroadcastCreate />)
  await fillToConfirm()
  await screen.findByText('送る：1アカウント・6,120 人')
  fireEvent.click(screen.getByRole('button', { name: 'この内容で予約する' }))
  const dialog = within(await screen.findByRole('dialog', { name: '1アカウントに送ります' }))
  fireEvent.change(dialog.getByLabelText('人数を入れる'), { target: { value: '6120' } })
  const button = dialog.getByRole('button', { name: '予約する' })
  const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
  const held = (button as unknown as Record<string,{onClick:(e:unknown)=>unknown}>)[key].onClick
  fireEvent.click(dialog.getByRole('button', { name: 'キャンセル' }))
  await act(async () => { await held({ defaultPrevented:false, preventDefault(){}, stopPropagation(){}, currentTarget:button, target:button }) })
  expect(hq.send).not.toHaveBeenCalled()
  if (originalApproval) hq.approval.mockImplementation(originalApproval)
})
