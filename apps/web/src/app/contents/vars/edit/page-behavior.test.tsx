// @vitest-environment happy-dom
/*
 * 共通情報の編集画面を本物の React で描き、読み込み・影響確認の節・保存の失敗・競合・
 * 予約の失敗・離脱の確認・値の欄の上限を押して確かめる。
 * 保存の失敗は理由の言葉で出し、競合しても入力を消さず、影響が読めないときは0か所と言わない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  foldersList: vi.fn(),
  detail: vi.fn(),
  schedules: vi.fn(),
  update: vi.fn(),
  impactPreview: vi.fn(),
  deleteImpact: vi.fn(),
  addSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      commonVars: {
        ...actual.api.commonVars,
        detail: api.detail,
        schedules: api.schedules,
        update: api.update,
        impactPreview: api.impactPreview,
        deleteImpact: api.deleteImpact,
        addSchedule: api.addSchedule,
        deleteSchedule: api.deleteSchedule,
      },
      folders: { ...actual.api.folders, list: api.foldersList },
    },
  }
})

const toast = vi.hoisted(() => ({ notifySaved: vi.fn() }))
vi.mock('@/components/shared/toast', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/components/shared/toast')>()), notifySaved: toast.notifySaved }))

vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

const navigation = vi.hoisted(() => ({ query: 'id=var-1' }))
const routerPush = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: routerPush, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(navigation.query),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-1', loading: false }),
}))

vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, id, value, onChange, options }: {
    'aria-label'?: string
    id?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, id, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))

import { ApiError } from '@/lib/api'
import EditCommonVarPage from './page'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

async function mount(element: React.ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(element) })
}

async function unmount() {
  await act(async () => { root.unmount() })
  host.remove()
}

/** 効果(Promise.all([detail, folders, schedules]))が落ち着くまで進める。 */
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
}

function byId(id: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const el = document.querySelector(`#${id}`)
  if (!el) throw new Error(`見つかりません: #${id}`)
  return el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
}

function byExactText(tag: string, text: string, explicitScope?: ParentNode): HTMLElement {
  const dialog = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).at(-1)
  const scope = explicitScope ?? (text === 'キャンセル' && dialog ? dialog : document)
  const found = Array.from(scope.querySelectorAll(tag)).find((el) => el.textContent?.trim() === text)
  if (!found) throw new Error(`見つかりません: <${tag}> "${text}"`)
  return found as HTMLElement
}

async function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  await act(async () => {
    setter.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    if (element instanceof HTMLSelectElement) element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function click(element: HTMLElement) {
  await act(async () => { element.click() })
}

const baseVar = {
  id: 'var-1', name: '営業時間', varKey: 'shop_hours', type: 'text', value: '10:00-19:00',
  memo: '', folderId: null, version: 3, history: [] as unknown[],
  validFrom: null, validUntil: null, expiryBehavior: 'stop', fallbackValue: null,
}

function emptyImpact(over: Record<string, unknown> = {}) {
  return {
    variable: { id: 'var-1', name: '営業時間', varKey: 'shop_hours' },
    total: 0, blockingTotal: 0, historicalTotal: 0, sendingFixedTotal: 0, unscopedFormTotal: 0,
    canDelete: true, byKind: {}, items: [], unavailableReferences: [],
    checkedAt: '2026-09-16T00:00:00Z', recommendedAction: 'delete',
    ...over,
  }
}

function usage(over: Record<string, unknown> = {}) {
  return {
    kind: 'template', kindLabel: 'テンプレート', name: '来店お礼', status: '公開中',
    href: '/templates/edit?id=t1', blocksDeletion: true, currentPreview: '営業時間は 10:00-19:00 です',
    ...over,
  }
}

function changeImpact(over: Record<string, unknown> = {}) {
  return { ...emptyImpact(), impactProof: 'proof-1', canSave: true, errorTotal: 0, warningTotal: 0, recommendedAction: 'save', ...over }
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  vi.clearAllMocks()
  navigation.query = 'id=var-1'
  api.detail.mockResolvedValue({ success: true, data: { ...baseVar } })
  api.foldersList.mockResolvedValue({ success: true, data: [] })
  api.schedules.mockResolvedValue({ success: true, data: [] })
  api.impactPreview.mockResolvedValue({ success: true, data: changeImpact() })
  api.deleteImpact.mockResolvedValue({ success: true, data: emptyImpact() })
  api.update.mockResolvedValue({ success: true, data: { id: 'var-1' } })
  api.addSchedule.mockResolvedValue({ success: true, data: null })
  api.deleteSchedule.mockResolvedValue({ success: true, data: null })
})

afterEach(async () => {
  if (root) await unmount()
  vi.restoreAllMocks()
})

/** 影響確認は値の変化から 400ms 待って読む。 */
async function waitImpact() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)) })
  await settle()
}

async function open() {
  await mount(React.createElement(EditCommonVarPage))
  await settle()
  await waitImpact()
}

function impactSection(): HTMLElement {
  const section = document.querySelector('section[aria-labelledby="cv-edit-impact-heading"]') as HTMLElement | null
  if (!section) throw new Error('影響確認の節がありません')
  return section
}

function saveButton(): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((el) => /^(?:\d+か所に反映して保存|保存する)$/.test(el.textContent?.trim() ?? ''))
  if (!found) throw new Error('保存の押し口がありません')
  return found as HTMLButtonElement
}

async function saveWithReason(reason = '営業時間の変更') {
  await setValue(byId('cv-change-reason'), reason)
  await click(saveButton())
  await settle()
}

describe('共通情報の編集：読み込み', () => {
  it('詳細・フォルダ・予定は、詳細の返事を待たずに並べて読む', async () => {
    let releaseDetail!: () => void
    api.detail.mockImplementationOnce(() => new Promise((resolve) => { releaseDetail = () => resolve({ success: true, data: { ...baseVar } }) }))
    await mount(React.createElement(EditCommonVarPage))
    await settle()
    expect(api.detail).toHaveBeenCalledWith('var-1', 'account-1')
    expect(api.foldersList).toHaveBeenCalledWith('common_var')
    expect(api.schedules).toHaveBeenCalledWith('var-1', 'account-1')
    await act(async () => { releaseDetail() })
    await settle()
    expect((byId('cv-name') as HTMLInputElement).value).toBe('営業時間')
  })

  it('これまでの変更は新しい5件まで出す', async () => {
    const history = Array.from({ length: 6 }, (_, index) => ({
      id: `h-${index}`, value: `値${index}`, actorName: '担当者', actorId: 'staff-1',
      changeReason: index === 5 ? '最初の登録' : `理由${index}`, createdAt: `2026-09-0${index + 1}T01:00:00Z`,
    }))
    api.detail.mockResolvedValue({ success: true, data: { ...baseVar, history } })
    await open()
    const items = document.querySelectorAll('section[aria-labelledby="cv-edit-history-heading"] li')
    expect(items).toHaveLength(5)
    expect(document.body.textContent).not.toContain('「最初の登録」')
  })

  it('差し込みは差し込みキーの形で案内し、表示名の形にしない', async () => {
    await open()
    const help = document.querySelector('button[aria-expanded] [data-help-mark]')?.closest('button') as HTMLButtonElement | null
    if (!help) throw new Error('題の「？」がありません')
    await click(help)
    const note = document.querySelector('[role="note"]')
    expect(note?.textContent).toContain('{{var.shop_hours}}')
    expect(note?.textContent).not.toContain('{{var.営業時間}}')
  })

  it('社内メモの説明は「お客さまには出ません」', async () => {
    await open()
    expect(document.querySelector('label[for="cv-memo"]')?.textContent).toContain('メモ（お客さまには出ません）')
    expect(document.body.textContent).not.toContain('お客さまには出せません')
  })

  it('文章の値は200文字まで、数値の値は文字数の上限を付けない', async () => {
    await open()
    expect((byId('cv-value') as HTMLInputElement).maxLength).toBe(200)
    await unmount()
    api.detail.mockResolvedValue({ success: true, data: { ...baseVar, type: 'number', value: '3' } })
    await open()
    const numberInput = byId('cv-value') as HTMLInputElement
    expect(numberInput.type).toBe('number')
    expect(numberInput.hasAttribute('maxlength')).toBe(false)
  })
})

describe('共通情報の編集：変える前に影響を見る', () => {
  it('開いたら使用先を読み、か所数と状態ごとの内訳・送信済みが変わらないことを書く', async () => {
    api.deleteImpact.mockResolvedValue({ success: true, data: emptyImpact({
      total: 3, blockingTotal: 2, historicalTotal: 1,
      items: [
        usage(),
        usage({ kind: 'broadcast', kindLabel: '一斉配信', name: '10月のお知らせ', status: '配信予約中', href: '/broadcasts/edit?id=b1' }),
        usage({ kind: 'broadcast', kindLabel: '一斉配信', name: '9月のお知らせ', status: '配信済み', href: '/broadcasts/edit?id=b0', blocksDeletion: false }),
      ],
    }) })
    await open()
    expect(api.deleteImpact).toHaveBeenCalledWith('var-1', 'account-1')
    const section = impactSection()
    expect(section.textContent).toContain('変える前に影響を見る')
    expect(section.textContent).toContain('3か所。次に送る・動くときから新しい値が入ります。')
    expect(section.textContent).toContain('内訳: 公開中1 件・配信予約中1 件')
    expect(section.textContent).toContain('送信済みの1か所は変わりません。')
    expect(section.textContent).toContain('テンプレート')
    expect(section.textContent).toContain('来店お礼')
    expect(section.textContent).not.toContain('9月のお知らせ')
    expect(document.body.textContent).not.toContain('配信中の設定にも反映されます')
  })

  it('どこにも使われていないと確定したら、確かめる文が無いと言う', async () => {
    await open()
    expect(impactSection().textContent).toContain('使われている場所がないため、確かめる文はありません。')
    expect(impactSection().textContent).not.toContain('使用先の本文を確認中です')
  })

  it('使用先が送信済みだけなら、0件とは言わず、すぐ変わる文が無いと言う', async () => {
    api.deleteImpact.mockResolvedValue({ success: true, data: emptyImpact({
      total: 1, historicalTotal: 1,
      items: [usage({ kind: 'broadcast', kindLabel: '一斉配信', name: '9月のお知らせ', status: '配信済み', blocksDeletion: false })],
    }) })
    await open()
    expect(impactSection().textContent).toContain('すぐ変わる使用先の文はありません。')
    expect(impactSection().textContent).not.toContain('使われている場所がないため')
  })

  it('読み込み中は「0か所」と描かず、読み込み中と言う', async () => {
    api.deleteImpact.mockImplementation(() => new Promise(() => {}))
    await open()
    const section = impactSection()
    expect(section.textContent).toContain('読み込んでいます')
    expect(section.textContent).not.toContain('0か所')
    expect(section.textContent).not.toContain('使われている場所がないため')
  })

  it('読めなかったら節は残して理由と再読み込みを出し、押すと読み直す', async () => {
    api.deleteImpact.mockResolvedValueOnce({ success: false, error: 'boom' })
    await open()
    const section = impactSection()
    expect(section.textContent).toContain('読み込めませんでした')
    await click(byExactText('button', '再読み込み', section))
    await settle()
    expect(api.deleteImpact).toHaveBeenCalledTimes(2)
    expect(impactSection().textContent).toContain('使われている場所がないため、確かめる文はありません。')
  })

  it('見る権限が無いときは権限の言葉にし、再読み込みは出さない', async () => {
    api.deleteImpact.mockRejectedValue(new ApiError(403, 'forbidden'))
    await open()
    const section = impactSection()
    expect(section.textContent).toContain('見る権限がありません')
    expect(Array.from(section.querySelectorAll('button')).some((el) => el.textContent?.trim() === '再読み込み')).toBe(false)
  })

  it('値を変えると保存後の文を並べ、作れない行は空にせず「—」と開く案内、上限超えは印を付ける', async () => {
    api.impactPreview.mockResolvedValue({ success: true, data: changeImpact({
      total: 2, blockingTotal: 2,
      items: [
        { ...usage(), changesOnSave: true, previewAvailable: false, nextPreview: null, currentCharacterCount: 14, nextCharacterCount: null, characterLimit: 500, exceedsCharacterLimit: false, errors: [], warnings: [] },
        { ...usage({ kind: 'broadcast', kindLabel: '一斉配信', name: '10月のお知らせ', status: '配信予約中' }), changesOnSave: true, previewAvailable: true, nextPreview: '営業時間は 11:00-20:00 です', currentCharacterCount: 14, nextCharacterCount: 5100, characterLimit: 5000, exceedsCharacterLimit: true, errors: [], warnings: [] },
      ],
    }) })
    await open()
    await setValue(byId('cv-value'), '11:00-20:00')
    await waitImpact()
    expect(api.impactPreview).toHaveBeenCalledWith('var-1', 'account-1', '11:00-20:00', 3)
    const section = impactSection()
    expect(section.textContent).toContain('…—（使用先を開いて確認してください）')
    const over = section.querySelector('[data-over-limit]')
    expect(over?.textContent).toContain('営業時間は 11:00-20:00 です')
    expect(over?.getAttribute('title')).toBe('5,100 / 5,000文字')
  })
})

describe('共通情報の編集：保存', () => {
  it('保存できたら知らせを出し、変える理由を空に戻す', async () => {
    await open()
    await setValue(byId('cv-value'), '11:00-20:00')
    await waitImpact()
    await saveWithReason()
    expect(api.update).toHaveBeenCalledWith('var-1', 'account-1', expect.objectContaining({ value: '11:00-20:00', expectedVersion: 3, impactProof: 'proof-1' }))
    expect(toast.notifySaved).toHaveBeenCalledTimes(1)
    expect((byId('cv-change-reason') as HTMLInputElement).value).toBe('')
  })

  it.each([
    [new ApiError(403, 'forbidden'), '操作する権限がありません。共通情報を保存できるのは管理者だけです。'],
    [new ApiError(404, 'not found'), 'この共通情報は見つかりませんでした。'],
    [new TypeError('Failed to fetch'), '保存できませんでした。通信が切れている可能性があります。'],
  ])('保存が落ちたら一言で片付けず理由を言う（%s）', async (failure, message) => {
    api.update.mockRejectedValue(failure)
    await open()
    await saveWithReason()
    expect(document.body.textContent).toContain(message)
    expect(document.body.textContent).not.toContain('保存に失敗しました。通信を確かめて、もう一度お試しください。')
  })

  it('先に別の人が保存していた（409）ら、入力は残したまま版だけ取り直し、誰の保存かを出す', async () => {
    api.update.mockRejectedValue(new ApiError(409, 'conflict'))
    await open()
    await setValue(byId('cv-name'), '営業時間（新）')
    await setValue(byId('cv-value'), '11:00-20:00')
    await waitImpact()
    api.detail.mockResolvedValue({ success: true, data: { ...baseVar, version: 4, history: [{ id: 'h-9', value: '9:00-18:00', actorName: '佐藤', actorId: 's-2', changeReason: '', createdAt: '2026-09-20T01:00:00Z' }] } })
    await saveWithReason()
    expect(api.detail).toHaveBeenCalledTimes(2)
    expect(api.foldersList).toHaveBeenCalledTimes(1)
    expect((byId('cv-name') as HTMLInputElement).value).toBe('営業時間（新）')
    expect((byId('cv-value') as HTMLInputElement).value).toBe('11:00-20:00')
    expect(document.body.textContent).toContain('佐藤さんが')
  })
})

describe('共通情報の編集：更新の予約', () => {
  it('予約が落ちたら生の英文を出さず、予約の言葉で言う', async () => {
    api.addSchedule.mockRejectedValue(new ApiError(500, 'API error: 500'))
    await open()
    await click(byExactText('button', '予定を足す'))
    await setValue(byId('sc-value'), '切替後の値')
    await click(byExactText('button', '登録する'))
    await settle()
    expect(api.addSchedule).toHaveBeenCalled()
    expect(document.body.textContent).toContain('予約を登録できませんでした。時間をおいて、もう一度お試しください。')
    expect(document.body.textContent).not.toContain('API error: 500')
  })

  it('更新後の値も種別の検査を通し、合わなければ予約を送らない', async () => {
    api.detail.mockResolvedValue({ success: true, data: { ...baseVar, type: 'url', value: 'https://example.com/a' } })
    await open()
    await click(byExactText('button', '予定を足す'))
    await setValue(byId('sc-value'), 'これはURLではありません')
    await click(byExactText('button', '登録する'))
    await settle()
    expect(api.addSchedule).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('更新後の値')
  })
})

describe('共通情報の編集：離脱の確認', () => {
  it('入力を変えたまま一覧へ移ろうとすると確認を出し、「保存せずに移る」だけが移る', async () => {
    await open()
    await setValue(byId('cv-name'), '途中の名前')
    const link = Array.from(document.querySelectorAll('a')).find((el) => el.getAttribute('href') === '/contents/vars') as HTMLAnchorElement | undefined
    if (!link) throw new Error('一覧へのリンクがありません')
    await click(link)
    expect(document.body.textContent).toContain('保存していない変更があります')
    expect(routerPush).not.toHaveBeenCalled()
    await click(byExactText('button', '編集を続ける', document.body))
    expect((byId('cv-name') as HTMLInputElement).value).toBe('途中の名前')
    await click(link)
    await click(byExactText('button', '保存せずに移る', document.body))
    expect(routerPush).toHaveBeenCalledWith('/contents/vars')
  })
})

it('対象未指定の編集入口には一覧への道と、その場で選ぶ入口を残す',async()=>{
 navigation.query=''
 await mount(<EditCommonVarPage/>); await settle()
 expect([...host.querySelectorAll('button')].some(el=>el.textContent==='編集する共通情報を選択する')).toBe(true)
 expect(host.querySelector('a[href="/contents/vars"]')?.textContent).toBe('共通情報一覧へ戻る')
 expect(api.detail).not.toHaveBeenCalled()
})
