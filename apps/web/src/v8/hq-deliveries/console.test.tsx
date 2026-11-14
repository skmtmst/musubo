import { getPageAction, findPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => { process.env.NEXT_PUBLIC_API_URL = 'http://worker.test' })
const calls = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), update: vi.fn(), create: vi.fn(), preflight: vi.fn(), distribute: vi.fn(), accounts: vi.fn(), folders: vi.fn(), resources: vi.fn() }))
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
vi.mock('@/components/shared/hq-account-picker', () => ({ useHqAccountFolders: () => ({ folders:[], membership:new Map([['account-1',{folderId:null,folder:null}]]), failed:false }) }))
vi.mock('@/lib/api/helpers/hq-deliveries', () => ({ hqDeliveriesApi: calls }))
vi.mock('@/lib/hq-templates-api', () => ({ hqTemplatesApi: { accounts: calls.accounts, folders: { list: calls.folders } } }))
vi.mock('@/lib/api/helpers/hq-resource-search', () => ({ searchHqTemplateResources: calls.resources }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => role.value, canManageRole: (value: string) => value === 'owner' || value === 'admin' }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {} }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
import HqDeliveryConsole from './console'

const detail = {
  template: { id: 'delivery-1', name: '追加のお礼', description: null, template_type: 'friend_add_rule', revision: 2, distributed_account_count: 0, content_summary: '本文', distributed_account_names: [], distributed_account_more: 0 },
  definition: { schemaVersion: 1, references: [], settings: { name: '店での名前', friendKind: 'first_time', priority: 0, definition: { messageText: '最初の本文', routeIds: ['route-1'], actions: [] } } },
}
beforeEach(() => {
  vi.resetAllMocks(); role.value = 'owner'
  calls.list.mockResolvedValue([detail.template]); calls.detail.mockResolvedValue(structuredClone(detail)); calls.update.mockResolvedValue(detail)
  calls.accounts.mockResolvedValue([{ id: 'account-1', name: '本店' }]); calls.folders.mockResolvedValue([])
  calls.preflight.mockResolvedValue({ preflightId: 'run-1', stores: [{ accountId: 'account-1', accountName: '本店', items: [{ sourceId: 'delivery-1', name: '追加のお礼', allowedModes: ['create'] }] }] })
  calls.distribute.mockResolvedValue({ runId: 'run-1', status: 'completed', stores: [{ accountId: 'account-1', status: 'succeeded' }] })
})
afterEach(cleanup)

describe('統括の配信設定を共通の一覧と配布画面で扱う', () => {
  it('F7: 参照の無い行は「—」を描かず、内容の要約だけを出す', async () => {
    render(<HqDeliveryConsole type="auto_reply" />)
    await screen.findByRole('searchbox', { name: 'ひな形を検索' })
    const row = screen.getByRole('button', { name: '追加のお礼', exact: true }).closest('tr') as HTMLElement
    expect(row.textContent).toContain('本文')
    expect(row.textContent).not.toContain('—')
  })

  it.each([['auto_reply', '自動応答'], ['friend_add_rule', '友だち追加時の配信'], ['reminder', 'リマインダ']] as const)('%s の一覧の題はパンくずと同じ「%sを配る」', async (type, label) => {
    render(<HqDeliveryConsole type={type} />)
    await screen.findByRole('searchbox', { name: 'ひな形を検索' })
    expect(screen.getByRole('heading', { name: `${label}を配る` })).toBeTruthy()
  })

  it('自動応答の一覧の参照先は内容だけを出し、「—」を付けない', async () => {
    render(<HqDeliveryConsole type="auto_reply" />)
    const row = await screen.findByRole('row', { name: /追加のお礼/ })
    const references = within(row).getAllByRole('cell')[1]
    expect(references.textContent).toBe('本文')
    expect(references.textContent).not.toContain('—')
  })

  it('名前が空の作成は保存の理由を出し、入力すると解除する', async () => {
    render(<HqDeliveryConsole type="auto_reply" />)
    const search = await screen.findByRole('searchbox', { name: 'ひな形を検索' })
    fireEvent.click(within(search.closest('[data-template-region="toolbar"]') as HTMLElement).getByRole('button', { name: 'ひな形を作る', exact: true }))
    const save = await findPageAction({ name: '下書きとして保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(save.title).toBe('統括での名前を入力してください。')
    fireEvent.click(save)
    expect(calls.create).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(/^統括での名前/), { target: { value: '予約の返事' } })
    const enabled = getPageAction({ name: '下書きとして保存' }) as HTMLButtonElement
    expect(enabled.disabled).toBe(false)
    expect(enabled.title).toBe('')
    calls.create.mockResolvedValue({ ...detail, template: { ...detail.template, name: '予約の返事' } })
    fireEvent.click(enabled)
    await waitFor(() => expect(calls.create).toHaveBeenCalledOnce())
    expect(calls.create.mock.calls[0][0].name).toBe('予約の返事')
  })

  it('友だち追加の本文を入れ子の設定へ保存し、配布先を選べる', async () => {
    render(<HqDeliveryConsole type="friend_add_rule" />)
    fireEvent.click(await screen.findByRole('button', { name: '追加のお礼', exact: true }))
    const message = await screen.findByLabelText('最初に送る内容')
    expect((message as HTMLTextAreaElement).value).toBe('最初の本文')
    fireEvent.change(message, { target: { value: '新しい本文' } })
    fireEvent.click(getPageAction({ name: '下書きを保存する' }))
    await waitFor(() => expect(calls.update).toHaveBeenCalled())
    const input = calls.update.mock.calls[0][1]
    expect(input.expectedRevision).toBe(2)
    expect(input.definition.settings.definition).toEqual({ messageText: '新しい本文', routeIds: ['route-1'], actions: [] })
    expect(input.definition.settings.messageText).toBeUndefined()
    expect(await screen.findByRole('checkbox', { name: '本店', exact: true })).toBeTruthy()
  })

  it('読込に失敗したひな形では配布先へ進まない', async () => {
    calls.detail.mockRejectedValue(new Error('offline'))
    render(<HqDeliveryConsole type="friend_add_rule" />)
    // 行の右端は「…」1つ。配るはその中。
    fireEvent.click(await screen.findByRole('button', { name: '「追加のお礼」の操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /アカウントへ配る/ }))
    expect(await screen.findByText('ひな形を開けませんでした。一覧を読み直してください。')).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: '本店', exact: true })).toBeNull()
    expect(calls.preflight).not.toHaveBeenCalled()
  })

  it.each([null, 'staff'])('閲覧のみ（%s）には作成・保存・配布の操作を出さない', async value => {
    role.value = value
    render(<HqDeliveryConsole type="friend_add_rule" />)
    const name = await screen.findByRole('button', { name: '追加のお礼', exact: true })
    expect(screen.queryByRole('button', { name: '「追加のお礼」の操作' })).toBeNull()
    for (const el of screen.queryAllByRole('button', { name: 'ひな形を作る', exact: true })) expect(((el: HTMLElement) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled)(el)).toBe(true)
    fireEvent.click(name)
    expect(await screen.findByText('最初の本文')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    for (const el of screen.queryAllByRole('button', { name: '下書きを保存する' })) expect(((el: HTMLElement) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled)(el)).toBe(true)
  })

  it('選んだアカウントと確認番号を使って配り、成功を表示する', async () => {
    render(<HqDeliveryConsole type="friend_add_rule" />)
    // 行の右端は「…」1つ。配るはその中。
    fireEvent.click(await screen.findByRole('button', { name: '「追加のお礼」の操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /アカウントへ配る/ }))
    fireEvent.click(await screen.findByRole('checkbox', { name: '本店', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '選んだ1アカウントを確かめる' }))
    await waitFor(() => expect(calls.preflight).toHaveBeenCalledWith('delivery-1', ['account-1']))
    fireEvent.click(await screen.findByRole('button', { name: '選んだ内容で配る' }))
    await waitFor(() => expect(calls.distribute).toHaveBeenCalledWith('delivery-1', 'run-1', [{ accountId: 'account-1', sourceId: 'delivery-1', mode: 'create' }]))
    expect(await screen.findByText('本店：完了')).toBeTruthy()
  })
})


it('保存できない欄の理由を出し、入力した本文を残す', async () => {
  calls.update.mockRejectedValue({ status: 422, fields: { 'definition.settings.definition.messageText': '本文を短くしてください' } })
  render(<HqDeliveryConsole type="friend_add_rule" />)
  fireEvent.click(await screen.findByRole('button', { name: '追加のお礼', exact: true }))
  const input = await screen.findByLabelText('最初に送る内容')
  fireEvent.change(input, { target: { value: '保存前の本文' } })
  fireEvent.click(getPageAction({ name: '下書きを保存する' }))
  expect(await screen.findByText('本文を短くしてください')).toBeTruthy()
  expect((input as HTMLTextAreaElement).value).toBe('保存前の本文')
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(calls.preflight).not.toHaveBeenCalled()
})

it('編集中の取消しは確認し、戻るを選ぶと本文を残す', async () => {
  render(<HqDeliveryConsole type="friend_add_rule" />)
  fireEvent.click(await screen.findByRole('button', { name: '追加のお礼', exact: true }))
  const input = await screen.findByLabelText('最初に送る内容')
  fireEvent.change(input, { target: { value: '保存前の本文' } })
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル', exact: true }))
  await screen.findByRole('dialog', { name: '入力を破棄しますか？' })
  fireEvent.click(screen.getByRole('button', { name: '編集を続ける', exact: true }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect((input as HTMLTextAreaElement).value).toBe('保存前の本文')
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル', exact: true }))
  fireEvent.click(await screen.findByRole('button', { name: '保存せずに移る' }))
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '最初に送る内容' })).toBeNull())
  expect(calls.update).not.toHaveBeenCalled()
})

it('保存済みテンプレートと後処理を正しく案内し、他欄の保存でも参照・失敗時設定を保持する', async () => {
  const definition = { schemaVersion: 1, references: [{ sourceId: 'template-source', kind: 'template', name: '予約の案内' }, { sourceId: 'tag-source', kind: 'tag', name: '回答済み' }], settings: {
    name: '店の返事', keyword: '予約', matchType: 'exact', responseType: 'text', responseContent: '', templateId: 'template-source',
    actions: [{ actionType: 'tag', config: { op: 'add', tagIds: ['tag-source'] }, onFailure: 'stop' }],
  } }
  const loaded = { ...detail, template: { ...detail.template, template_type: 'auto_reply' }, definition }
  calls.list.mockResolvedValue([loaded.template]); calls.detail.mockResolvedValue(loaded); calls.update.mockResolvedValue(loaded)
  render(<HqDeliveryConsole type="auto_reply" />)
  fireEvent.click(await screen.findByRole('button', { name: '追加のお礼', exact: true }))
  expect(await screen.findByText('テンプレート「予約の案内」')).toBeTruthy()
  expect(screen.getByText('1つ')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('説明'), { target: { value: '変更した説明' } })
  fireEvent.click(getPageAction({ name: '下書きとして保存' }))
  await waitFor(() => expect(calls.update).toHaveBeenCalled())
  expect(calls.update).toHaveBeenCalledWith('delivery-1', { name: '追加のお礼', description: '変更した説明', definition, expectedRevision: 2 })
})


it('HQ action selection saves canonical actions and references with the original revision and unrelated settings', async () => {
 const preserved = { actionType: 'notify_staff', config: { notificationRuleId: 'notice', notificationRuleVersion: 7 }, onFailure: 'continue' }
 const loaded = { ...detail, template: { ...detail.template, template_type: 'auto_reply' }, definition: { schemaVersion: 1, settings: { name: '店の返事', keyword: '予約', matchType: 'exact', responseType: 'text', responseContent: '返答', priority: 42, actions: [preserved] }, references: [{ sourceId: 'notice', kind: 'notification_rule', name: '担当者' }] } }
 calls.list.mockResolvedValue([loaded.template]); calls.detail.mockResolvedValue(loaded); calls.update.mockResolvedValue(loaded)
 calls.resources.mockResolvedValue({ success: true, data: { kind: 'tag', items: [{ id: 'tag-a', name: '会員', accountId: 'account-1', accountName: '本店' }], total: 1, nextCursor: null } })
 render(<HqDeliveryConsole type="auto_reply" />)
 fireEvent.click(await screen.findByRole('button', { name: '追加のお礼', exact: true }))
 fireEvent.click(await screen.findByRole('button', { name: '何を返すかに進む' }))
 fireEvent.click(screen.getByRole('button', { name: '行うことを足す' })); fireEvent.click(screen.getByRole('menuitem', { name: 'タグを付ける' }))
 fireEvent.click(await screen.findByRole('radio', { name: /会員/ })); fireEvent.click(screen.getByRole('button', { name: '選ぶ', exact: true }))
 fireEvent.click(getPageAction({ name: '下書きとして保存' }))
 await waitFor(() => expect(calls.update).toHaveBeenCalled())
 expect(calls.update.mock.calls[0][1]).toMatchObject({ expectedRevision: 2, definition: { schemaVersion: 1, settings: { priority: 42, responseContent: '返答', actions: [preserved, { actionType: 'tag', config: { op: 'add', tagIds: ['tag-a'] }, onFailure: 'stop' }] }, references: [{ sourceId: 'notice', kind: 'notification_rule', name: '担当者' }, { sourceId: 'tag-a', kind: 'tag', name: '会員', accountId: 'account-1' }] } })
 expect(calls.distribute).not.toHaveBeenCalled(); expect(calls.preflight).not.toHaveBeenCalled()
})
