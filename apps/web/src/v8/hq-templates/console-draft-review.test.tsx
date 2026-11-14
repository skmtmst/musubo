import { findPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * 統括のテンプレート（・）：作るは店のテンプレートの作る画面（メッセージ ・クーポン ）を使い、
 * 下の帯の主ボタンは［保存する］。保存は統括の口（ひな形）へ、配るは「アカウントへ配る」へ進む。
 * 詳細は「配った先」（API-14 の配った先のアカウント名）と［配る］（読み上げは「〇〇を配る」）。
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => Object.fromEntries(['context', 'list', 'listByKind', 'kindCounts', 'accounts', 'get', 'create', 'update', 'remove', 'duplicate', 'preflight', 'distribute', 'result', 'messageReferences', 'folderList', 'deleteImage', 'uploadRichMessageImage', 'uploadImage', 'listStats', 'versions', 'receivedVersions', 'compareVersions', 'restoreVersion'].map((key) => [key, vi.fn()])))
const access = vi.hoisted(() => ({ canEdit: true }))
const push = vi.hoisted(() => vi.fn())
const selectAccount = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    lineAccounts: { ...actual.api.lineAccounts, list: vi.fn(async () => ({ success: true, data: [
      { id: 'a-1', name: '然 -NEN- 本店', folderId: 'direct' }, { id: 'a-2', name: '然 -NEN- 渋谷店', folderId: 'direct' },
    ] })) },
    lineAccountFolders: { ...actual.api.lineAccountFolders, list: vi.fn(async () => ({ success: true, data: { folders: [{ id: 'direct', name: '直営店', color: '#2563eb', displayOrder: 0 }] } })) },
  } }
})
vi.mock('@/lib/hq-templates-api', async (original) => ({ ...await original<typeof import('@/lib/hq-templates-api')>(), TEMPLATE_TYPES: ['tag', 'template', 'rich_menu', 'form', 'scenario'], hqTemplatesApi: { ...calls, folders: { list: calls.folderList } } }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/hq/templates',
}))
vi.mock('@/lib/staff-role', () => ({ useTenantWideAccess: () => access.canEdit, useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [], selectedAccountId: null, selectedAccount: null, setSelectedAccountId: selectAccount, loading: false }) }))
const chrome = vi.hoisted(() => ({ crumbs: null as Array<{ label: string; href?: string; onSelect?: () => void }> | null }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: (crumbs: typeof chrome.crumbs) => { chrome.crumbs = crumbs } }))
vi.mock('@/components/auto-replies/inline-action-list', () => ({ useActionOptions: () => ({ tags: [], scenarios: [], templates: [], forms: [], reminders: [], richMenus: [] }) }))

import HqTemplatesV8 from './console'

const message = {
  schemaVersion: 1,
  template: { id: 'hq-authored-message', name: '予約前日のご案内', category: 'general', messageType: 'text', messageContent: '{{name}}さん、明日のご予約です', carouselActionsJson: null, carouselTapLimitMode: 'none', carouselTapLimitText: null, questionJson: null, questionStatus: 'draft' },
  media: [],
}
const detail = (definition: unknown = message) => ({ template: { id: 't-1', name: '予約前日のご案内', description: '', template_type: 'template', folder_id: null, revision: 3, updated_at: '2026-08-21T09:02:00Z' }, definition })
const listRow = { ...detail().template, kind: 'message', content_summary: '本文', distributed_account_count: 4, distributed_account_names: ['然 -NEN- 本店', '然 -NEN- 渋谷店', '2025年イベント'], distributed_account_more: 1 }

beforeEach(() => {
  access.canEdit = true
  Object.values(calls).forEach((mock) => mock.mockReset())
  window.history.replaceState(null, '', '/hq/templates')
  window.sessionStorage.clear()
  calls.context.mockResolvedValue({ tenantId: 'tenant-a', actorId: 'owner' })
  calls.list.mockResolvedValue([listRow])
  calls.listByKind.mockResolvedValue([listRow])
  calls.kindCounts.mockResolvedValue({ message: 1, carousel: 0, rich_message: 0, question: 0, coupon: 0, research: 0 })
  calls.accounts.mockResolvedValue([{ id: 'a-1', name: '然 -NEN- 本店' }, { id: 'a-2', name: '然 -NEN- 渋谷店' }])
  calls.folderList.mockResolvedValue([{ id: 'f-1', name: '予約', revision: 1 }])
  calls.messageReferences.mockResolvedValue([])
  calls.listStats.mockResolvedValue({ thisMonthSentCount: 0, outdatedTemplateCount: 0 })
  calls.versions.mockResolvedValue([])
  calls.receivedVersions.mockResolvedValue([])
  calls.get.mockResolvedValue(detail())
  calls.create.mockImplementation(async (input: { name: string; definition: unknown }) => ({ template: { ...detail().template, id: 't-new', name: input.name }, definition: input.definition }))
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

const BANNER = '一時保存できなかった入力があります'
const dk = (type: string, kind: string) => `lh_hq_create_draft_v1:tenant-a:owner:${type}:${kind}`
const scope = { tenantId: 'tenant-a', actorId: 'owner' }
const openCreate = async (tab?: RegExp) => {
  if (tab) fireEvent.click(await screen.findByRole('tab', { name: tab }))
  const createButton = await waitFor(() => {
    const button = screen.getAllByRole('button', { name: /テンプレートを作る/ })[0]
    expect(button.hasAttribute('disabled')).toBe(false)
    return button
  }, { timeout: 3000 })
  fireEvent.click(createButton)
  return screen.findByLabelText('テンプレート名', {}, { timeout: 3000 })
}
const atCreate = () => window.history.replaceState(null, '', '/hq/templates?mode=create')
const seedFromMount = async (tab: RegExp, kind: string) => {
  const v = render(<HqTemplatesV8 type="template" />)
  const name = await openCreate(tab)
  fireEvent.change(name, { target: { value: '架空の途中' } })
  await waitFor(() => expect(window.sessionStorage.getItem(dk('template', kind))).toContain('架空の途中'))
  v.unmount()
  return JSON.parse(window.sessionStorage.getItem(dk('template', kind))!)
}

describe('R1 通知', () => {
  it('一覧の読み込みが終わってから作成画面を開く', async () => {
    let releaseContext!: (value: typeof scope) => void
    calls.context.mockReturnValue(new Promise(resolve => { releaseContext = resolve }))
    render(<HqTemplatesV8 type="template" />)
    const button = (await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0]
    expect(button.hasAttribute('disabled')).toBe(true)
    const opening = openCreate()
    await act(async () => { await Promise.resolve() })
    await act(async () => { releaseContext(scope) })
    expect(await opening).toBeTruthy()
  })
  it('R1a template は保存失敗を画面に出す', async () => {
    render(<HqTemplatesV8 type="template" />)
    const name = await openCreate()
    fireEvent.change(name, { target: { value: 'x'.repeat(201) } })
    await waitFor(() => expect(document.body.textContent).toContain(BANNER))
  })
  it('R1b tag も保存失敗を画面に出す', async () => {

    calls.list.mockResolvedValue([]); calls.folderList.mockResolvedValue([])
    render(<HqTemplatesV8 type="tag" />)
    fireEvent.click((await screen.findAllByRole('button', { name: /タグを作る/ }))[0])
    await screen.findByRole('heading', { name: 'タグのひな形を作る' })
    fireEvent.change(screen.getByLabelText('タグ名'), { target: { value: '旧タグ' } })
    await waitFor(() => expect(window.sessionStorage.getItem(dk('tag', 'tag')) ?? '').toContain('旧タグ'))
    fireEvent.change(screen.getByLabelText('タグ名'), { target: { value: 'x'.repeat(201) } })
    await waitFor(() => expect(window.sessionStorage.getItem(dk('tag', 'tag'))).toBeNull(), { timeout: 3000 })
    await act(async () => {})
    expect(document.body.textContent).toContain(BANNER)
  })
  it('R1c 取消後の一覧に古い失敗通知を残さない', async () => {
    render(<HqTemplatesV8 type="template" />)
    const name = await openCreate()
    fireEvent.change(name, { target: { value: 'x'.repeat(201) } })
    await waitFor(() => expect(document.body.textContent).toContain(BANNER))
    fireEvent.click(await findPageAction({ name: 'キャンセル' }))
    await screen.findAllByRole('button', { name: /テンプレートを作る/ })
    expect(document.body.textContent).not.toContain(BANNER)
  })
  it('R1e 壊れた記録は読込時に通知する', async () => {
    window.sessionStorage.setItem(dk('template', 'message'), '{broken')
    atCreate(); render(<HqTemplatesV8 type="template" />)
    await screen.findByLabelText('テンプレート名')
    await waitFor(() => expect(document.body.textContent).toContain(BANNER))
  })
})

describe('R1x 通知の後始末', () => {
  it('R1f 取消して新しい作成を始めると、前の失敗通知を持ち越さない', async () => {
    render(<HqTemplatesV8 type="template" />)
    const name = await openCreate()
    fireEvent.change(name, { target: { value: 'x'.repeat(201) } })
    await waitFor(() => expect(document.body.textContent).toContain(BANNER))
    fireEvent.click(await findPageAction({ name: 'キャンセル' }))
    await openCreate()
    expect(document.body.textContent).not.toContain(BANNER)
  })
})

describe('R2 raw editorState の破損', () => {
  const inject = (kind: string, editorState: unknown) => window.sessionStorage.setItem(dk('template', kind), JSON.stringify({ version: 1, ...scope, type: 'template', kind, draft: { kind, name: '架空の破損', payload: {}, media: [], editorState } }))
  it.each([
    ['rich_message', 'areas null', (s: Record<string, unknown>) => { s.areas = null }],
    ['research', 'questions 文字列', (s: Record<string, unknown>) => { s.questions = 'x' }],
    ['coupon', 'couponDraft 文字列', (s: Record<string, unknown>) => { s.couponDraft = 'x' }],
    ['research', 'choiceTapExtras 文字列', (s: Record<string, unknown>) => { s.questions = [{ key: 'q', text: '架空', format: 'single', required: true, choices: ['a'], choiceTapExtras: 'x' }] }],
    ['coupon', 'couponUseActions [null]', (s: Record<string, unknown>) => { s.couponUseActions = [null] }],
    ['research', 'answerActions [null]', (s: Record<string, unknown>) => { s.answerActions = [null] }],
    ['coupon', 'tapExtras 文字列', (s: Record<string, unknown>) => { s.tapExtras = 'x' }],
    ['coupon', 'pickedMedia 数値', (s: Record<string, unknown>) => { s.pickedMedia = 1 }],
    ['rich_message', 'pickedMedia 数値', (s: Record<string, unknown>) => { s.pickedMedia = 1 }],
    ['rich_message', 'area.tapExtras 文字列', (s: Record<string, unknown>) => { s.areas = { A: { kind: 'message', uri: '', text: '', refId: '', tapExtras: 'x' } } }],
    ['rich_message', 'shapeValue 不明', (s: Record<string, unknown>) => { s.shapeValue = 'nope' }],
  ])('R2 %s %s は画面を落とさない', async (kind, _label, mutate) => {
    const tab = kind === 'coupon' ? /クーポン/ : kind === 'research' ? /リサーチ/ : /リッチメッセージ/
    const rec = await seedFromMount(tab, kind)
    cleanup()
    const state = rec.draft.editorState; mutate(state)
    inject(kind, state)
    atCreate()
    const silence = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<HqTemplatesV8 type="template" />)
    let crashed = ''
    try { await screen.findByLabelText('テンプレート名', {}, { timeout: 2000 }) } catch (e) { crashed = String(e).slice(0, 120) }
    silence.mockRestore()
    expect(crashed).toBe('')
  })
})

describe('R3 結果不明の再確認後', () => {
  it('coupon の依頼を再読込後に再確認して保存済みなら、coupon の一時下書きも消す', async () => {
    const { persistEditorDraft, persistCreationAttempt } = await import('@/lib/hq-template-create-attempt')
    const definition = { ...message, asset: { kind: 'coupon', payload: { title: '架空' } } }
    persistEditorDraft(window.sessionStorage, scope, 'template', 'coupon', { kind: 'coupon', name: '架空の保存済み', payload: {} })
    persistCreationAttempt(window.sessionStorage, scope, 'template', { requestId: 'req-1', distribute: false, input: { type: 'template', name: '架空の保存済み', description: '', folderId: null, definition } as never })
    atCreate(); render(<HqTemplatesV8 type="template" />)
    fireEvent.click(await screen.findByRole('button', { name: '前回の保存を再確認' }))
    await waitFor(() => expect(calls.create).toHaveBeenCalled())
    await waitFor(() => expect(window.sessionStorage.getItem('lh_hq_create_v1:tenant-a:owner:template')).toBeNull())
    expect(window.sessionStorage.getItem(dk('template', 'coupon'))).toBeNull()
  })
})

describe('R4 初回描画の空下書き', () => {
  it.each([[/クーポン/, 'coupon'], [/リサーチ/, 'research'], [/リッチメッセージ/, 'rich_message']])('%s 何も入力しない作る画面は下書きを作らない', async (tab, kind) => {
    render(<HqTemplatesV8 type="template" />)
    await openCreate(tab)
    await act(async () => {})
    expect(window.sessionStorage.getItem(dk('template', kind))).toBeNull()
  })
  it('空のリッチが残っても、入力済みクーポンを隠さない', async () => {
    const v = render(<HqTemplatesV8 type="template" />)
    await openCreate(/リッチメッセージ/)
    await act(async () => {})
    v.unmount() // サイドバーで離脱
    window.history.replaceState(null, '', '/hq/templates')
    const w = render(<HqTemplatesV8 type="template" />)
    const name = await openCreate(/クーポン/)
    fireEvent.change(name, { target: { value: '架空の入力済みクーポン' } })
    await waitFor(() => expect(window.sessionStorage.getItem(dk('template', 'coupon'))).toContain('架空の入力済みクーポン'))
    w.unmount()
    atCreate(); render(<HqTemplatesV8 type="template" />)
    expect(await screen.findByDisplayValue('架空の入力済みクーポン', {}, { timeout: 2000 })).toBeTruthy()
  })
})

describe('R5 復元後の再保存', () => {
  it('期間なしクーポンは送らない', async () => {
    await seedFromMount(/クーポン/, 'coupon')
    atCreate(); render(<HqTemplatesV8 type="template" />)
    await screen.findByDisplayValue('架空の途中')
    fireEvent.click(await findPageAction({ name: '下書きを保存' }))
    await act(async () => {})
    expect(calls.create).not.toHaveBeenCalled()
  })
  it('質問未完成のリサーチは送らない', async () => {
    await seedFromMount(/リサーチ/, 'research')
    atCreate(); render(<HqTemplatesV8 type="template" />)
    await screen.findByDisplayValue('架空の途中')
    fireEvent.click(await findPageAction({ name: '下書きを保存' }))
    await act(async () => {})
    expect(calls.create).not.toHaveBeenCalled()
  })
  it('画像なしリッチは送らない', async () => {
    await seedFromMount(/リッチメッセージ/, 'rich_message')
    atCreate(); render(<HqTemplatesV8 type="template" />)
    await screen.findByDisplayValue('架空の途中')
    fireEvent.click(await findPageAction({ name: '下書きを保存' }))
    await act(async () => {})
    expect(calls.create).not.toHaveBeenCalled()
  })
  it('リッチ: imageUrl だけで uploaded が無い記録でも例外で固まらず送らない', async () => {
    const rec = await seedFromMount(/リッチメッセージ/, 'rich_message')
    rec.draft.editorState.imageUrl = 'https://example.invalid/a.png'
    rec.draft.editorState.areas = Object.fromEntries(['A','B','C'].map(l => [l, { kind: 'message', uri: '', text: '架空', refId: '' }]))
    window.sessionStorage.setItem(dk('template', 'rich_message'), JSON.stringify(rec))
    const rejections: unknown[] = []
    const on = (e: unknown) => { rejections.push(e) }
    process.on('unhandledRejection', on)
    atCreate(); render(<HqTemplatesV8 type="template" />)
    await screen.findByDisplayValue('架空の途中')
    fireEvent.click(await findPageAction({ name: '下書きを保存' }))
    await act(async () => {})
    process.off('unhandledRejection', on)
    expect(calls.create).not.toHaveBeenCalled()
    expect(rejections.length).toBe(0)
  })
  it('完成クーポンは全項目が戻り、editorState を送らず、保存後に下書きを消す', async () => {
    const rec = await seedFromMount(/クーポン/, 'coupon')
    Object.assign(rec.draft.editorState, { couponTitle: '架空クーポン名', couponStartsAt: '2030-01-01T00:00', couponEndsAt: '2030-01-31T23:59' }); Object.assign(rec.draft.editorState.couponDraft, { amount: '500', instructions: '架空の案内', conditions: '架空の条件', code: 'FAKE', showCode: false })
    rec.draft.folderId = 'f-1'
    window.sessionStorage.setItem(dk('template', 'coupon'), JSON.stringify(rec))
    atCreate(); render(<HqTemplatesV8 type="template" />)
    await screen.findByDisplayValue('架空の途中')
    expect(screen.getByDisplayValue('架空クーポン名')).toBeTruthy()
    fireEvent.click(await findPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(calls.create).toHaveBeenCalled(), { timeout: 3000 })
    const input = calls.create.mock.calls[0][0]
    expect(JSON.stringify(input)).not.toContain('editorState')
    expect(input.folderId).toBe('f-1')
    await waitFor(() => expect(window.sessionStorage.getItem(dk('template', 'coupon'))).toBeNull())
  })
})

describe('R6 フォルダ', () => {
  it('消えたフォルダの下書きは未分類扱いで送る（form/scenario と同じ）', async () => {
    const { persistEditorDraft } = await import('@/lib/hq-template-create-attempt')
    persistEditorDraft(window.sessionStorage, scope, 'template', 'message', { kind: 'message', name: '架空', messageType: 'text', messageContent: '架空本文', folderId: 'f-gone' })
    atCreate(); render(<HqTemplatesV8 type="template" />)
    await screen.findByDisplayValue('架空')
    await act(async () => {})
    fireEvent.click(await findPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(calls.create).toHaveBeenCalled(), { timeout: 3000 })
    expect(calls.create.mock.calls[0][0].folderId).toBeNull()
  })
})

describe('R7 クーポンの離脱後保存成功', () => {
  it('coupon でも消える', async () => {
    const rec = await seedFromMount(/クーポン/, 'coupon')
    Object.assign(rec.draft.editorState, { couponTitle: '架空クーポン名', couponStartsAt: '2030-01-01T00:00', couponEndsAt: '2030-01-31T23:59' }); Object.assign(rec.draft.editorState.couponDraft, { amount: '500', instructions: '架空の案内', conditions: '架空の条件', code: 'FAKE', showCode: false })
    window.sessionStorage.setItem(dk('template', 'coupon'), JSON.stringify(rec))
    let done!: () => void
    calls.create.mockImplementation((input: { name: string; definition: unknown }) => new Promise(resolve => { done = () => resolve({ template: { ...detail().template, name: input.name }, definition: input.definition }) }))
    atCreate(); const v = render(<HqTemplatesV8 type="template" />)
    await screen.findByDisplayValue('架空の途中')
    fireEvent.click(await findPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(calls.create).toHaveBeenCalled(), { timeout: 3000 })
    v.unmount()
    await act(async () => { done() })
    expect(window.sessionStorage.getItem(dk('template', 'coupon'))).toBeNull()
  })
})

it('入力済みの種類が複数あるときは最後に編集した下書きを復元する', async () => {
  await seedFromMount(/リッチメッセージ/, 'rich_message')
  window.history.replaceState(null, '', '/hq/templates')
  const second = render(<HqTemplatesV8 type="template" />)
  const name = await openCreate(/クーポン/)
  fireEvent.change(name, { target: { value: '架空の最新クーポン' } })
  await waitFor(() => expect(window.sessionStorage.getItem(dk('template', 'coupon'))).toContain('架空の最新クーポン'))
  second.unmount()
  atCreate()
  render(<HqTemplatesV8 type="template" />)
  expect(await screen.findByDisplayValue('架空の最新クーポン')).toBeTruthy()
})

const pickFolder = async (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'フォルダ' }))
  fireEvent.click(within(await screen.findByRole('option', { name })).getByRole('button'))
}

describe('P 正常入力を検査が弾かないか', () => {
  it('Pa リサーチの選択肢を消しても一時保存できる', async () => {
    render(<HqTemplatesV8 type="template" />)
    const name = await openCreate(/リサーチ/)
    fireEvent.change(name, { target: { value: '架空の調査' } })
    const key = dk('template', 'research')
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toContain('架空の調査'))
    fireEvent.click(await screen.findByRole('button', { name: '問 1 の選択肢 2 を消す' }))
    await act(async () => {})
    const raw = window.sessionStorage.getItem(key)
    expect(document.body.textContent).not.toContain(BANNER)
    expect(raw).toContain('架空の調査')
  })
  it('Pa2 選択肢の削除後に再読込しても入力が戻る', async () => {
    const v = render(<HqTemplatesV8 type="template" />)
    const name = await openCreate(/リサーチ/)
    fireEvent.change(name, { target: { value: '架空の調査' } })
    await waitFor(() => expect(window.sessionStorage.getItem(dk('template', 'research'))).toContain('架空の調査'))
    fireEvent.click(await screen.findByRole('button', { name: '問 1 の選択肢 2 を消す' }))
    await act(async () => {})
    v.unmount(); atCreate(); render(<HqTemplatesV8 type="template" />)
    expect(await screen.findByDisplayValue('架空の調査', {}, { timeout: 2000 })).toBeTruthy()
  })
  it('Pa3 選択肢の追加処理を設定しても保存できる', async () => {
    const { persistEditorDraft } = await import('@/lib/hq-template-create-attempt')
    const s = window.sessionStorage
    const base: Record<string, unknown> = { couponDraft: { amount: '', percent: '', before: '', after: '', conditions: '', code: '', instructions: '', showCode: false, couponType: 'discount', mode: 'amount' }, description: '', couponTitle: '', imageUrl: '', pickedMedia: null, couponOnce: 'once', countTouched: false, couponVisibility: 'friends', lottery: false, lotteryRate: '20', winnerLimit: '500', couponStartsAt: '', couponEndsAt: '', couponUseActions: [], researchStartsAt: '', researchEndsAt: '', targetTagId: '', answerActions: [], tapExtras: undefined }
    const scope = { tenantId: 'tenant-a', actorId: 'owner' }
    const q = (extra: unknown) => [{ key: 'q', text: '', format: 'single', required: true, choices: ['', ''], choiceTapExtras: extra }]
    const results = { undefined: persistEditorDraft(s, scope, 'template', 'research', { kind: 'research', name: 'a', payload: {}, editorState: { ...base, questions: q(undefined) } }),
      array: persistEditorDraft(s, scope, 'template', 'research', { kind: 'research', name: 'a', payload: {}, editorState: { ...base, questions: q([{ tagIds: [], scoreChange: null }, {}]) } }),
      nan: persistEditorDraft(s, scope, 'template', 'research', { kind: 'research', name: 'a', payload: {}, editorState: { ...base, questions: q([{ scoreChange: Number('abc') }]) } }) }
    expect(results.array).toBe(true)
    expect(results.nan).toBe(true)
    expect(results.undefined).toBe(true)
  })
})

describe('Q 空の下書き', () => {
  it('Qa フォルダを選んで外すと空の下書きを残さない', async () => {
    render(<HqTemplatesV8 type="template" />)
    await openCreate()
    await pickFolder('予約')
    const key = dk('template', 'message')
    await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(key)!).draft.folderId).toBe('f-1'))
    await pickFolder('未分類')
    await act(async () => {})
    expect(window.sessionStorage.getItem(key)).toBeNull()
  })
  it('Qb 一覧の絞り込みから開いただけの空画面は、入力済みの下書きを隠さない', async () => {
    const v0 = render(<HqTemplatesV8 type="template" />)
    const name = await openCreate(/クーポン/)
    fireEvent.change(name, { target: { value: '架空の入力済み' } })
    await waitFor(() => expect(window.sessionStorage.getItem(dk('template', 'coupon'))).toContain('架空の入力済み'))
    v0.unmount()
    window.history.replaceState(null, '', '/hq/templates?kind=message&folderFilter=f-1')
    const v1 = render(<HqTemplatesV8 type="template" />)
    await screen.findAllByRole('button', { name: /テンプレートを作る/ })
    const filterBtn = screen.queryAllByRole('button', { name: /予約/ })[0]
    if (filterBtn && !window.location.search.includes('f-1')) fireEvent.click(filterBtn)
    await act(async () => {})
    fireEvent.click((await screen.findAllByRole('button', { name: /テンプレートを作る/ }))[0])
    await screen.findByLabelText('テンプレート名')
    await act(async () => {})
    v1.unmount()
    atCreate(); render(<HqTemplatesV8 type="template" />)
    expect(await screen.findByDisplayValue('架空の入力済み', {}, { timeout: 2000 })).toBeTruthy()
  })
})
it('絞り込みから開いた空画面でもURLから初期フォルダを復元する', async () => {
  window.history.replaceState(null, '', '/hq/templates?folderFilter=f-1')
  const view = render(<HqTemplatesV8 type="template" />)
  await openCreate()
  expect(screen.getByRole('button', { name: 'フォルダ' }).textContent).toContain('予約')
  const url = window.location.href
  view.unmount()
  window.history.replaceState(null, '', url)
  render(<HqTemplatesV8 type="template" />)
  await screen.findByLabelText('テンプレート名')
  expect(screen.getByRole('button', { name: 'フォルダ' }).textContent).toContain('予約')
})
it('フォルダだけの空クーポンを復元して未分類へ戻すと記録を消す', async () => {
  const view = render(<HqTemplatesV8 type="template" />)
  await openCreate(/クーポン/)
  await pickFolder('予約')
  view.unmount()
  atCreate()
  render(<HqTemplatesV8 type="template" />)
  await screen.findByLabelText('テンプレート名')
  await pickFolder('未分類')
  expect(window.sessionStorage.getItem(dk('template', 'coupon'))).toBeNull()
})
it('初期フォルダから未分類へ明示変更した状態はURLに優先して復元する', async () => {
  window.history.replaceState(null, '', '/hq/templates?folderFilter=f-1')
  const view = render(<HqTemplatesV8 type="template" />)
  await openCreate()
  await pickFolder('未分類')
  const url = window.location.href
  view.unmount()
  window.history.replaceState(null, '', url)
  render(<HqTemplatesV8 type="template" />)
  await screen.findByLabelText('テンプレート名')
  expect(screen.getByRole('button', { name: 'フォルダ' }).textContent).toContain('未分類')
})
