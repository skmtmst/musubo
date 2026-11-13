import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * R259〜R263（監査・2026-09-27）: 友だち追加時の配信の編集画面。
 *  - R259: 保存済みの「判定する人」は読取専用。新規では両方選べる。
 *  - R261: 再追加「何も配信しない」は本文・時刻・シナリオを適用外として出す。
 *  - R262: 確認段のテストは経路・想定日時・友だちを指定して実行側と同じ判定へ渡す。
 *  - R263: 再追加シナリオの開始位置（最初から/前回配信した次から）を選び・保存・再読込する。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight component mocks for interaction coverage */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, getByRole, findByRole, within } from '@testing-library/react'

const state = vi.hoisted(() => ({ search: 'step=basic' }))
const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }))
const api = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  conflicts: vi.fn(),
  createDraft: vi.fn(),
  saveDraft: vi.fn(),
  test: vi.fn(),
  friends: { list: vi.fn() },
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/friend-add-settings/new', useRouter: () => navigation,
  useSearchParams: () => new URLSearchParams(state.search),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/components/shared/condition-builder', () => ({ default: () => null }))
vi.mock('@/components/shared/confirm-dialog', () => ({ default: () => null }))
vi.mock('@/components/shared/list-state', () => ({ default: ({ title }: any) => <div>{title}</div> }))
vi.mock('@/components/shared/select', () => ({
  default: ({ value, onChange, options, disabled, ...rest }: any) => (
    <select aria-label={rest['aria-label']} value={value} disabled={disabled}
      onChange={(event: any) => onChange?.(event.target.value)}>
      {options.map((item: any) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>
  ),
}))
vi.mock('@/components/shared/sticky-bar', () => ({ default: ({ actions }: any) => <div>{actions}</div> }))
vi.mock('@/components/shared/text-field', () => ({
  TextField: (props: any) => <input {...props} />,
  TextArea: (props: any) => <textarea {...props} />,
}))
vi.mock('@/components/shared/date-time-field', () => ({
  default: ({ value, onChange, ...rest }: any) => <input {...rest} value={value} onChange={(event: any) => onChange?.(event.target.value)} />,
  TimeField: ({ value, onChange, ...rest }: any) => <input {...rest} value={value} onChange={(event: any) => onChange?.(event.target.value)} />,
}))
vi.mock('@/components/shared/button', () => ({
  default: ({ href, children, ...props }: any) => (href ? <a href={href}>{children}</a> : <button {...props}>{children}</button>),
}))
vi.mock('@/components/shared/line-preview', async (original) => ({ ...await original<typeof import('@/components/shared/line-preview')>(), default: ({ caption, children }: any) => <div data-caption={caption}>{children}</div> }))
vi.mock('@/lib/api', async (importOriginal) => {
  // describeSaveFailure など通信口でないものは本物のままにする。
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      friendAddRules: {
        list: api.list, conflicts: api.conflicts, get: api.get,
        createDraft: api.createDraft, saveDraft: api.saveDraft, test: api.test,
      },
      friends: { list: api.friends.list },
    },
  }
})

const { default: Editor } = await import('@/v8/friend-add/editor')

const OPTIONS = {
  routes: [{ id: 'route-1', name: '紹介QR', kind: 'QR' }],
  scenarios: [{ id: 'scenario-1', name: '再案内シナリオ' }],
  tags: [],
  folders: [],
}

const BASE_DEFINITION = {
  routeIds: ['route-1'], scenarioId: 'scenario-1', messageType: 'text',
  messageText: 'おかえりなさい', timing: 'immediate', actions: [],
  friendCondition: '', activeFrom: null, activeUntil: null,
  resendSuppressionHours: 24, weekdays: [], timeWindows: [],
  deliveryChoices: { sendWelcomeMessage: true, startScenario: true, runActions: true },
  unknownRouteAction: { sendCommonGuidance: true, notifyStaff: false },
}

function savedRule(overrides: Record<string, unknown> = {}) {
  return {
    name: '再追加の案内', folderName: null, priority: 2, friendKind: 'returning',
    isFallback: false, status: 'draft', matchedLast7Days: 3, lastTestStatus: null,
    version: 2, routeNames: ['紹介QR'], scenarioName: '再案内シナリオ',
    definition: { ...BASE_DEFINITION, returningMode: 'other', startPosition: 'beginning' },
    ...overrides,
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  state.search = 'step=basic'
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  navigation.replace.mockReset()
  api.get.mockReset()
  api.saveDraft.mockReset().mockResolvedValue({ success: true, data: { id: 'rule-1', version: 3 } })
  api.test.mockReset().mockResolvedValue({
    success: true,
    data: { stateChanged: false, ruleId: 'rule-1', matched: true, reasons: ['確認できました。'], scenarioId: null, message: null, actions: [] },
  })
  api.conflicts.mockReset().mockResolvedValue({ success: true, data: { rules: [], conflicts: [] } })
  api.list.mockReset().mockResolvedValue({ success: true, data: { items: [], options: OPTIONS } })
  api.friends.list.mockReset().mockResolvedValue({ success: true, data: { items: [] } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  vi.useRealTimers()
  await act(async () => { root.unmount() })
  host.remove()
})

async function render(ruleId?: string) {
  await act(async () => {
    root.render(<Editor ruleId={ruleId} />)
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()
  })
}

async function renderExisting(definition?: Record<string, unknown>) {
  const rule = savedRule(definition ? { definition: { ...BASE_DEFINITION, ...definition } } : {})
  api.get.mockResolvedValue({ success: true, data: { rule, options: OPTIONS } })
  await render('rule-1')
}

function deliverySummaryValue() {
  const label = ([...host.querySelectorAll('dt')]
    .find((item) => item.textContent === '最初に送るもの') ?? querySupplementaryPageAction('最初に送るもの'))
  if (!label?.nextElementSibling) throw new Error(`delivery row: ${host.textContent}`)
  return label.nextElementSibling.textContent
}

function button(label: string) {
  const node = ([...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label)) ?? querySupplementaryPageAction(label))
  if (!node) throw new Error(`${label}: ${host.textContent}`)
  return node
}

it('社内メモを保存しても配信対象の条件へ混ぜない', async () => {
  await renderExisting()
  await act(async () => { button('社内メモ').click() })
  const dialog = getByRole(document.body, 'dialog', { name: '社内メモ' })
  await act(async () => { fireEvent.change(within(dialog).getByRole('textbox', { name: '社内メモ' }), { target: { value: '店頭で案内した方向け' } }) })
  expect(dialog.textContent).toContain('配信の条件には使いません')
  await act(async () => { within(dialog).getByRole('button', { name: '閉じる' }).click() })
  await act(async () => { button('下書きを保存').click(); await Promise.resolve() })
  expect(api.saveDraft).toHaveBeenCalledWith('rule-1', expect.objectContaining({ definition: expect.objectContaining({ internalMemo: '店頭で案内した方向け', friendCondition: '' }) }), expect.any(String))
})

it('動きの詳細は実設定の再追加処理と過去28日の取得値を表示する', async () => {
  state.search = 'step=preview'
  api.conflicts.mockResolvedValue({ success: true, data: { rules: [{ id: 'rule-1', matchedLast28Days: 17 }], conflicts: [] } })
  await renderExisting({ returningMode: 'none', actions: [{ type: 'add_tag', targetId: 'tag-1', label: 'タグ「再来店」を付ける' }] })
  await act(async () => { button('動きの詳細を確認').click(); await Promise.resolve() })
  const dialog = getByRole(document.body, 'dialog', { name: '追加された人に起きること' })
  expect(dialog.textContent).toContain('17人')
  expect(dialog.textContent).toContain('「何も配信しない」の設定のため届きません')
  expect(dialog.textContent).toContain('再来店')
  expect(api.conflicts).toHaveBeenCalledWith('account-a', 'returning')
})

it('該当数の取得失敗はゼロと表示せず再試行で回復する', async () => {
  state.search = 'step=preview'
  await renderExisting()
  api.conflicts.mockReset().mockResolvedValueOnce({ success: false, error: '取得失敗' }).mockResolvedValueOnce({ success: true, data: { rules: [{ id: 'rule-1', matchedLast28Days: 0 }], conflicts: [] } })
  await act(async () => { button('動きの詳細を確認').click(); await Promise.resolve() })
  const dialog = getByRole(document.body, 'dialog', { name: '追加された人に起きること' })
  expect(dialog.textContent).toContain('未取得')
  expect(dialog.textContent).not.toContain('0人')
  await act(async () => { within(dialog).getByRole('button', { name: '再試行' }).click(); await Promise.resolve() })
  expect(dialog.textContent).toContain('0人')
  expect(dialog.textContent).not.toContain('取得できませんでした')
})

describe('R259 保存済みの「判定する人」は変えられないと操作前に分かる', () => {
  it('保存済みは選択欄が無効になり、理由と作り直しの入口を説明する', async () => {
    await renderExisting()
    const fields = [...host.querySelectorAll<HTMLInputElement>('input[name="fa-kind"]')]
    expect(fields).toHaveLength(2)
    expect(fields.every((field) => field.disabled)).toBe(true)
    expect(host.textContent).toContain('保存したあとは変えられません')
    expect(host.textContent).toContain('一覧から新しく作ってください')
  })

  it('新規作成では両方の種別を選べる', async () => {
    await render()
    const field = host.querySelector<HTMLInputElement>('input[name="fa-kind"][value="returning"]')!
    expect(field.disabled).toBe(false)
    expect(host.textContent).toContain('保存したあとは変えられません')
    await act(async () => { field.click() })
    expect(field.checked).toBe(true)
  })
})

describe('R263 再追加シナリオの開始位置を選び・保存・再読込する', () => {
  it('「別のシナリオ」で開始位置を選ぶと保存値に乗る', async () => {
    state.search = 'step=message'
    await renderExisting({ returningMode: 'other', startPosition: 'beginning' })
    expect(host.querySelector<HTMLInputElement>('input[name="fa-start"][value="beginning"]')?.checked).toBe(true)
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="fa-start"][value="resume"]')!.click() })
    await act(async () => { button('下書きを保存').click(); await Promise.resolve() })
    expect(api.saveDraft).toHaveBeenCalled()
    const payload = api.saveDraft.mock.calls[0][1] as { definition: { startPosition: string } }
    expect(payload.definition.startPosition).toBe('resume')
  })

  it('保存済みの「前回配信した次から」を再読込で復元する', async () => {
    state.search = 'step=message'
    await renderExisting({ returningMode: 'other', startPosition: 'resume' })
    expect(host.querySelector<HTMLInputElement>('input[name="fa-start"][value="resume"]')?.checked).toBe(true)
  })

  it('「何も配信しない」では開始位置を出さない', async () => {
    state.search = 'step=message'
    await renderExisting({ returningMode: 'none' })
    expect(host.querySelector('input[name="fa-start"]')).toBeNull()
  })
})

describe('R261 再追加「何も配信しない」は配信欄を適用外にする', () => {
  it('初回案内の段は本文必須ではなく「届けない」説明とアクションだけを出す', async () => {
    state.search = 'step=message'
    await renderExisting({ returningMode: 'none' })
    expect(host.textContent).toContain('メッセージを届けません')
    expect(host.textContent).toContain('アクションだけ')
    // 本文・送信時刻・シナリオの入力欄は出さない
    expect(host.querySelector('textarea')).toBeNull()
    expect(host.querySelector('select[aria-label="次に流すシナリオ"]')).toBeNull()
    expect(host.querySelector('select[aria-label="追加から送信まで"]')).toBeNull()
  })

  it('プレビューの吹き出しは「再追加では配信しません」と出す', async () => {
    state.search = 'step=message'
    await renderExisting({ returningMode: 'none' })
    expect(host.textContent).toContain('再追加では配信しません')
  })

  it('R261残部: 確認段の右側プレビューにも保存済み本文を出さない', async () => {
    // 保存済みの本文は設定データとして残るが、届くかのようには見せない。
    state.search = 'step=preview'
    await renderExisting({ returningMode: 'none', messageText: 'おかえりなさい' })
    expect(host.textContent).toContain('再追加では配信しません')
    expect(host.textContent).toContain('配信なし')
    expect(host.textContent).not.toContain('おかえりなさい')
  })

  it('確認段では「別のシナリオ」の保存済み本文はそのまま出す', async () => {
    state.search = 'step=preview'
    await renderExisting({ returningMode: 'other', messageText: 'おかえりなさい' })
    expect(host.querySelector('[data-caption="再追加では配信しません"]')).toBeNull()
    expect(host.textContent).toContain('おかえりなさい')
  })

  it('R261残部: 基本段のサマリーは配信なし設定を「なし」と出す', async () => {
    // 保存済みの本文が残っていても、届く設定かのように見せない。
    state.search = 'step=basic'
    await renderExisting({ returningMode: 'none', messageText: 'おかえりなさい' })
    expect(deliverySummaryValue()).toBe('配信なし')
  })

  it('基本段のサマリーは「別のシナリオ」の保存済み本文を配信ありと出す', async () => {
    state.search = 'step=basic'
    await renderExisting({ returningMode: 'other', messageText: 'おかえりなさい' })
    expect(deliverySummaryValue()).toBe('テキスト 7字')
  })

  it('「別のシナリオ」では通常どおり本文・シナリオ欄を出す', async () => {
    state.search = 'step=message'
    await renderExisting({ returningMode: 'other' })
    await act(async () => { button('初回メッセージを確認・変更').click() })
    expect(getByRole(document.body, 'textbox', { name: '最初に送るメッセージ' })).toBeTruthy()
    expect(host.querySelector('#fa-returning-scenario')).not.toBeNull()
  })
})

describe('R262 確認段のテストは経路・日時・友だちを指定できる', () => {
  it('試す流入リンク・想定日時・試す友だちをテストAPIへ渡す', async () => {
    state.search = 'step=preview'
    await renderExisting()
    await act(async () => { button('試す条件を指定').click() })
    await act(async () => { fireEvent.click(getByRole(document.body, 'button', { name: '試す流入リンク' })) })
    const route = await findByRole(document.body, 'radio', { name: '紹介QR' })
    await act(async () => { fireEvent.click(route); fireEvent.click(within(route.closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: '選ぶ' })); fireEvent.change(getByRole(document.body, 'textbox', { name: '想定日時' }), { target: { value: '2026-09-28T10:00' } }) })
    api.friends.list.mockResolvedValue({
      success: true,
      data: { items: [{ id: 'friend-1', displayName: '見本 141' }], total: 1 },
    })
    await act(async () => { fireEvent.click(getByRole(document.body, 'button', { name: '試す友だち：選ぶ' })) })
    const result = await findByRole(document.body, 'radio', { name: '見本 141' })
    await act(async () => { fireEvent.click(result); fireEvent.click(within(result.closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: '選ぶ' })) })
    await act(async () => { fireEvent.click(getByRole(document.body, 'button', { name: 'この条件でテストする' })); await Promise.resolve() })
    expect(api.test).toHaveBeenCalledWith('account-a', 'rule-1', {
      routeId: 'route-1', expectedAt: '2026-09-28T10:00', friendId: 'friend-1',
    })
  })

  it('試行条件を指定しなければ「いま・どの経路でも・友だち不問」で送る', async () => {
    state.search = 'step=preview'
    await renderExisting()
    await act(async () => { button('テストする（送らずに判定）').click(); await Promise.resolve() })
    expect(api.test).toHaveBeenCalledWith('account-a', 'rule-1', {
      routeId: null, expectedAt: null, friendId: null,
    })
  })
})
