// @vitest-environment happy-dom
/*
 * 統括 一括配信を作る（・：店の一斉配信と同じ5段＋送るアカウント）・詳細（xOXuY）の動きの試験。
 * ① 配信名 → ② 送るアカウント（窓で選ぶ）→ ③ 本文 → ④ 時刻 → ⑤ 確かめる（作る → preflight → 問題のある店を外す）→ 送る（確かめの窓 → send）。
 * 詳細は失敗した店へのやり直し。閲覧のみ（担当者）には作る画面を出さない。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hq = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), update: vi.fn(), get: vi.fn(), preflight: vi.fn(), exclude: vi.fn(), send: vi.fn(), stop: vi.fn(), cancel: vi.fn(), retry: vi.fn(),
  /* API-18：フォルダ・承認・テスト送信。承認が要らない（人数が少ない）ときの返事。 */
  folders: vi.fn(async () => ({ success: true, data: [] })),
  approvalCandidates: vi.fn(async () => ({ success: true, data: [] })),
  approval: vi.fn(async () => ({ success: true, data: { approval: { status: 'none', requestedByStaffId: null, requestedAt: null, approverStaffId: null, note: null, decidedByStaffId: null, decidedAt: null, rejectReason: null, confirmedCount: null }, gate: { required: false, recipientCount: 0, threshold: 1000, singleOperator: false, operatorCount: 2 }, viewer: { isApprover: false, canApprove: false, isRequester: false } } })),
  testSend: vi.fn(), testRecipients: vi.fn(async () => ({ success: true, data: { count: 1, recipients: [{ id: 'f', displayName: '確認先' }], token: 'a'.repeat(64) } })),
}))
const accounts = vi.hoisted(() => vi.fn())
const folders = vi.hoisted(() => vi.fn())
const scenarioList=vi.hoisted(()=>vi.fn());
const presetList=vi.hoisted(()=>vi.fn());
const tagList = vi.hoisted(() => vi.fn())
const assets = vi.hoisted(() => vi.fn())
const upload = vi.hoisted(() => vi.fn())
const tpl = vi.hoisted(() => ({ folders: { list: vi.fn(async () => []) }, listByKind: vi.fn(async (kind?: string) => { void kind; return [] as unknown[] }), get: vi.fn(), create: vi.fn(), uploadRichMessageImage: vi.fn() }))
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const push = vi.hoisted(() => vi.fn())
const replace = vi.hoisted(() => vi.fn())
const params = vi.hoisted(() => ({ value: new URLSearchParams() }))

vi.mock('@/lib/hq-broadcasts-api', () => ({ hqBroadcastsApi: hq }))
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
  return { ...actual, api: { ...actual.api, lineAccounts: { list: accounts }, lineAccountFolders: { list: folders }, tags: { list: tagList }, broadcastMessageAssets: { list: assets, upload }, scenarios: { list: scenarioList }, segmentPresets: { list: presetList } } }
})
vi.mock('@/lib/staff-role', () => ({ useTenantWideAccess: () => role.value === 'owner' || role.value === 'admin', useStaffRole: () => role.value, canManageRole: (r: string | null) => r === 'owner' || r === 'admin' }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace }), useSearchParams: () => params.value }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children) }))

import HqBroadcastCreate from '@/v8/hq-broadcasts/create'

import { pickEntity } from '@/components/shared/entity-picker-test-helpers'

const check = (accountId: string, accountName: string, audienceCount: number, blockedReasons: string[] = []) => ({
  accountId, accountName, audienceCount, remaining: 10000, connected: true, paused: false, blockedReasons, excluded: false, broadcastId: null,
})
const folder = (id: string, name: string) => ({ id, kind: 'line_account', name, parentId: null, color: '#2f6fde', displayOrder: 1, createdAt: '', updatedAt: '' })

beforeEach(() => {
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


it('UI-03 実画面: シナリオ/保存条件失敗でもエラーと再試行を出さない',async()=>{
 scenarioList.mockRejectedValue(new Error('fixture scenario offline'));presetList.mockRejectedValue(new Error('fixture preset offline'));
 render(<HqBroadcastCreate/>);fireEvent.change(screen.getByLabelText('配信名'),{target:{value:'fixture'}});fireEvent.click(screen.getByRole('button',{name:'対象設定へ'}));await selectAccounts('銀座店');
 await waitFor(()=>expect(scenarioList).toHaveBeenCalled());await waitFor(()=>expect(presetList).toHaveBeenCalled());
 expect(await screen.findByText(/タグ.*読み込めませんでした/)).toBeTruthy();
 expect(screen.getByRole('button',{name:'もう一度読み込む'})).toBeTruthy();
 scenarioList.mockResolvedValue({success:true,data:[]});presetList.mockResolvedValue({success:true,data:[]});
 fireEvent.click(screen.getByRole('button',{name:'もう一度読み込む'}));
 await waitFor(()=>expect(screen.queryByRole('button',{name:'もう一度読み込む'})).toBeNull());
 expect(hq.send).not.toHaveBeenCalled();expect(hq.create).not.toHaveBeenCalled();
});
it('反証: タグ取得失敗は実画面でエラーと再試行を出す',async()=>{
 scenarioList.mockResolvedValue({success:true,data:[]});presetList.mockResolvedValue({success:true,data:[]});tagList.mockRejectedValueOnce(new Error('fixture tags offline'));
 render(<HqBroadcastCreate/>);fireEvent.change(screen.getByLabelText('配信名'),{target:{value:'fixture'}});fireEvent.click(screen.getByRole('button',{name:'対象設定へ'}));await selectAccounts('銀座店');
 expect(await screen.findByRole('button',{name:'もう一度読み込む'})).toBeTruthy();expect(screen.getByText(/タグを読み込めませんでした/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'もう一度読み込む'}));await waitFor(()=>expect(screen.queryByRole('button',{name:'もう一度読み込む'})).toBeNull());expect(tagList).toHaveBeenCalledTimes(2);
});

it('HQ coupon read failure shows retry instead of no coupons',async()=>{
 scenarioList.mockResolvedValue({success:true,data:[]});presetList.mockResolvedValue({success:true,data:[]})
 assets.mockRejectedValueOnce(new Error('人工取得失敗'))
 render(<HqBroadcastCreate/>);fireEvent.change(screen.getByLabelText('配信名'),{target:{value:'人工配信'}})
 fireEvent.click(screen.getByRole('button',{name:'対象設定へ'}));await selectAccounts('銀座店')
 fireEvent.click(screen.getByRole('button',{name:'メッセージ設定へ'}))
 fireEvent.click(screen.getByRole('tab',{name:'クーポン',exact:true}))
 const error=await screen.findByText('クーポンを読み込めませんでした')
 fireEvent.click(error.closest('[data-list-state="error"]')!.querySelector('button')!)
 await waitFor(()=>expect(screen.queryByText('クーポンを読み込めませんでした')).toBeNull())
})
it('HQ carousel choices use the shared picker without an unused background request',async()=>{
 tpl.listByKind.mockClear();scenarioList.mockResolvedValue({success:true,data:[]});presetList.mockResolvedValue({success:true,data:[]})
 render(<HqBroadcastCreate/>);fireEvent.change(screen.getByLabelText('配信名'),{target:{value:'人工配信'}})
 fireEvent.click(screen.getByRole('button',{name:'対象設定へ'}));await selectAccounts('銀座店')
 fireEvent.click(screen.getByRole('button',{name:'メッセージ設定へ'}));fireEvent.click(screen.getByRole('tab',{name:'カルーセル',exact:true}))
 await waitFor(()=>expect(screen.getAllByRole('button',{name:'テンプレートから選ぶ'}).length).toBeGreaterThan(0))
 expect(tpl.listByKind).not.toHaveBeenCalled()
})
