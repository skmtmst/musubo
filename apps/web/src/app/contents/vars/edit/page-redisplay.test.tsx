// @vitest-environment happy-dom
/*
 * 「保存した社内メモは、編集画面を開き直すと再表示される」を本物の
 * React(react-dom/client)で確かめる試験(#687 再差し戻し(2))。
 *
 * これまで `page.interaction.spec.ts`(Playwright)にしか無く、Required PR
 * gateの `pnpm --filter web test`(vitest)からは呼ばれていなかった。
 * `apps/web/src/app/contents/vars/edit/` 配下にも試験が1つも無かった。
 * ここでは新規作成画面(`../new/page`)を実mountして社内メモを保存し、
 * 実際にAPIへ渡った内容を編集画面(`./page`)の詳細取得へそのまま返して、
 * 編集画面の社内メモ欄に同じ値が出ることを見る。
 * `.test.tsx` は `vitest.config.ts` の include に入るため、Required gate
 * で必ず実行される。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  create: vi.fn(),
  foldersList: vi.fn(),
  detail: vi.fn(),
  schedules: vi.fn(),
  update: vi.fn(),
  impactPreview: vi.fn(),
  deleteImpact: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      commonVars: {
        ...actual.api.commonVars,
        create: api.create,
        detail: api.detail,
        schedules: api.schedules,
        update: api.update,
        impactPreview: api.impactPreview,
        deleteImpact: api.deleteImpact,
      },
      folders: { ...actual.api.folders, list: api.foldersList },
    },
  }
})

vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

const navigation = vi.hoisted(() => ({ query: 'id=var-1' }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(navigation.query),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-1', loading: false }),
}))

/*
 * 共通の Select は listbox の部品で、その操作は部品自身の試験が持つ。
 * ここで見たいのは選んだ後の共通情報の判断なので、素の <select> に置き換える。
 */
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

import NewCommonVarPage from '../new/page'
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

function byExactText(tag: string, text: string): HTMLElement {
  const found = Array.from(document.querySelectorAll(tag)).find((el) => (text === '共通情報を保存する' ? /^(?:\d+か所に反映して保存|保存する)$/.test(el.textContent?.trim() ?? '') : el.textContent?.trim() === text))
  if (!found) throw new Error(`見つかりません: <${tag}> "${text}"`)
  return found as HTMLElement
}

/** V8の社内メモ欄を読む。 */
function memoInput(): HTMLInputElement {
  return byId('cv-memo') as HTMLInputElement
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

/** 暦で YYYY-MM-DD の日を選ぶ（日付・日時の選択の★管理画面）。 */
async function pickCalendarDay(iso: string) {
  const [y, mo, d] = iso.split('-').map(Number)
  const week = '日月火水木金土'[new Date(y, mo - 1, d).getDay()]
  for (let i = 0; i < 36; i += 1) {
    const grid = document.querySelector('[role="grid"]')
    const label = grid?.getAttribute('aria-label')
    if (label === `${y}年${mo}月`) break
    const target = y * 12 + mo
    const currentLabel = /^(\d+)年(\d+)月$/.exec(label ?? '')
    const current = currentLabel ? Number(currentLabel[1]) * 12 + Number(currentLabel[2]) : target
    const nav = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === (target > current ? '次の月' : '前の月'),
    )!
    await click(nav)
  }
  const day = Array.from(document.querySelectorAll('button')).find((b) =>
    (b.getAttribute('aria-label') ?? '').startsWith(`${y}年${mo}月${d}日（${week}）`),
  )!
  await click(day)
  const calendarDialog = document.querySelector('[role="dialog"][aria-label="日付を選ぶ"]')
  if (calendarDialog) await click(Array.from(calendarDialog.querySelectorAll('button')).find((b) => b.textContent?.trim() === '確定')!)
}

/** 日付の選択で YYYY-MM-DD を選ぶ。値は今までどおりの文字列。 */
async function setDateValue(id: string, iso: string) {
  await click(byId(id) as unknown as HTMLElement)
  await pickCalendarDay(iso)
  await closeDatePicker()
}

/** 開いている日時の選択箱を閉じる（次の欄の前に必ず呼ぶ）。日付の選択は選ぶと閉じる。 */
async function closeDatePicker() {
  const picker = document.querySelector('[role="dialog"][aria-label="日時を選ぶ"]')
  if (!picker) return
  const close = Array.from(picker.querySelectorAll('button')).find((b) => b.textContent?.trim() === '確定')!
  await click(close)
}

/** 日時の選択で YYYY-MM-DDTHH:mm を選ぶ。値は今までどおり日本時間の文字列。 */
async function setDateTimeValue(id: string, iso: string) {
  const [date, time] = iso.split('T')
  const [hour, minute] = time.split(':')
  await click(byId(id) as unknown as HTMLElement)
  const picker = document.querySelector('[role="dialog"][aria-label="日時を選ぶ"]')!
  await pickCalendarDay(date)
  const reopened = document.querySelector('[role="dialog"][aria-label="日時を選ぶ"]')!
  const timeInput = reopened.querySelector('input[inputmode="numeric"]') as HTMLInputElement
  await setValue(timeInput, `${hour}:${minute}`)
  await act(async () => { timeInput.dispatchEvent(new FocusEvent('blur', { bubbles: true })); timeInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
  await closeDatePicker()
}

/** 日付の選択を空にする。 */
async function clearPickerDate(id: string) {
  await click(byId(id) as unknown as HTMLElement)
  const picker = document.querySelector('[role="dialog"][aria-label="日付を選ぶ"]')!
  const clear = Array.from(picker.querySelectorAll('button')).find((b) => b.textContent?.trim() === '消す')!
  await click(clear)
  await click(Array.from(document.querySelector('[role="dialog"][aria-label="日付を選ぶ"]')!.querySelectorAll('button')).find((b) => b.textContent?.trim() === '確定')!)
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  vi.clearAllMocks()
  navigation.query = 'id=var-1'
  api.foldersList.mockResolvedValue({ success: true, data: [] })
  api.create.mockResolvedValue({ success: true, data: { id: 'var-1' } })
  api.schedules.mockResolvedValue({ success: true, data: [] })
  api.impactPreview.mockResolvedValue({ success: true, data: { impactProof: 'proof-1', canSave: true, total: 0, blockingTotal: 0, byKind: {}, items: [], unavailableReferences: [], checkedAt: '2026-09-16T00:00:00Z' } })
  api.deleteImpact.mockResolvedValue({ success: true, data: { total: 0, blockingTotal: 0, byKind: {}, items: [], unavailableReferences: [], checkedAt: '2026-09-16T00:00:00Z' } })
  api.update.mockResolvedValue({ success: true, data: { id: 'var-1' } })
})

afterEach(async () => {
  if (root) await unmount()
  vi.restoreAllMocks()
})

describe('共通情報: 保存した社内メモの再表示(実React)', () => {
  it('UTC保存値をJSTの入力へ戻し、変更した期間外動作を保存する', async () => {
    api.detail.mockResolvedValue({
      success: true,
      data: {
        id: 'var-1', name: '期間案内', varKey: 'period_notice', type: 'text', value: '受付中',
        memo: '', folderId: null, version: 3, history: [],
        validFrom: '2026-09-16T01:00:00.000Z', validUntil: '2026-09-16T03:00:00.000Z',
        expiryBehavior: 'stop', fallbackValue: null,
      },
    })
    await mount(React.createElement(EditCommonVarPage))
    await settle()
    expect(byId('cv-valid-from').textContent).toContain('2026年9月16日（水）10:00')
    expect(byId('cv-valid-until').textContent).toContain('2026年9月16日（水）12:00')
    await setValue(byId('cv-expiry-behavior'), 'fallback')
    await setValue(byId('cv-fallback-value'), '受付終了')
    await setValue(byId('cv-change-reason'), '期間の修正')
    await click(byExactText('button', '共通情報を保存する'))
    expect(api.update).toHaveBeenCalledWith('var-1', 'account-1', expect.objectContaining({
      expectedVersion: 3, validFrom: '2026-09-16T10:00', validUntil: '2026-09-16T12:00',
      expiryBehavior: 'fallback', fallbackValue: '受付終了', changeReason: '期間の修正',
    }))
  })

  it.each([
    ['long_text', '案内'.repeat(5_000), 'TEXTAREA', '更新した案内', '更新した案内'],
    ['date', '2028-02-29', 'BUTTON', '2028年2月29日（火）', '2028-03-01'],
    ['datetime', '2028-02-29T23:59', 'BUTTON', '2028年2月29日（火）23:59', '2028-03-01T00:00'],
    ['boolean', 'false', 'SELECT', 'false', 'true'],
  ])('%sの既存値を適切な入力欄へ再表示し、保存値をAPIへ渡す', async (type, originalValue, tagName, shownValue, nextValue) => {
    api.detail.mockResolvedValue({
      success: true,
      data: {
        id: 'var-1', name: `${type}の項目`, varKey: `${type}_value`, type, value: originalValue,
        memo: '', folderId: null, version: 1, history: [],
      },
    })
    await mount(React.createElement(EditCommonVarPage))
    await settle()

    const control = byId('cv-value')
    expect(control.tagName).toBe(tagName)
    if (type === 'date' || type === 'datetime') {
      // 日付・日時は日本語で見せ、値は今までどおりの文字列で持つ。
      expect(control.textContent).toContain(shownValue)
      if (type === 'date') await setDateValue('cv-value', nextValue)
      else await setDateTimeValue('cv-value', nextValue)
    } else {
      expect((control as HTMLInputElement).value).toBe(originalValue)
      await setValue(control, nextValue)
    }
    await setValue(byId('cv-change-reason'), '値の更新')
    await click(byExactText('button', '共通情報を保存する'))

    expect(api.update).toHaveBeenCalledWith('var-1', 'account-1', expect.objectContaining({
      value: nextValue, expectedVersion: 1, impactProof: 'proof-1', changeReason: '値の更新',
    }))
  })

  it('新規作成で保存した社内メモが、編集画面を開き直すと同じ内容で表示される', async () => {
    // 1. 新規作成画面で社内メモを含めて保存する。
    await mount(React.createElement(NewCommonVarPage))
    await setValue(byId('cv-name'), '再表示確認用')
    await setValue(byId('cv-key'), 'redisplay_check')
    await setValue(byId('cv-value'), '平日 10:00〜18:00')
    await setValue(byId('cv-memo'), '更新は毎月1日に確認する')
    await click(byExactText('button', '保存して公開'))

    expect(api.create).toHaveBeenCalledTimes(1)
    const created = api.create.mock.calls[0][0]
    expect(created.memo).toBe('更新は毎月1日に確認する')
    await unmount()

    // 2. 実際にAPIへ渡った内容を、詳細取得の応答としてそのまま返す
    //    (契約試験のように固定文字列を2回書かない)。
    api.detail.mockResolvedValue({
      success: true,
      data: {
        id: 'var-1',
        name: created.name,
        varKey: created.varKey,
        type: created.type,
        value: created.value,
        memo: created.memo,
        folderId: null,
        version: 1,
        history: [],
      },
    })

    // 3. 編集画面を開き直す。
    await mount(React.createElement(EditCommonVarPage))
    await settle()

    expect(memoInput().value).toBe(created.memo)
  })
})

describe('共通情報の編集: 型別の入力エラー(VAR-06, 実React)', () => {
  it('年月日型の値を空にすると、理由を出して保存を送らない', async () => {
    api.detail.mockResolvedValue({
      success: true,
      data: {
        id: 'var-1', name: '開店日', varKey: 'open_date', type: 'date', value: '2028-02-29',
        memo: '', folderId: null, version: 1, history: [],
      },
    })
    await mount(React.createElement(EditCommonVarPage))
    await settle()

    await clearPickerDate('cv-value')
    await click(byExactText('button', '共通情報を保存する'))

    expect(api.update).not.toHaveBeenCalled()
    expect(host.textContent).toContain('値の日付を入力してください')
  })

  it('期間外の代替値が種別に合わないと止める', async () => {
    api.detail.mockResolvedValue({
      success: true,
      data: {
        id: 'var-1', name: 'ロゴ', varKey: 'logo_url', type: 'image',
        value: 'https://cdn.example.com/logo.png', memo: '', folderId: null,
        version: 1, history: [],
      },
    })
    await mount(React.createElement(EditCommonVarPage))
    await settle()

    await setValue(byId('cv-expiry-behavior'), 'fallback')
    await setValue(byId('cv-fallback-value'), 'not-an-image')
    await click(byExactText('button', '共通情報を保存する'))

    expect(api.update).not.toHaveBeenCalled()
    expect(host.textContent).toContain('代替値は https:// からはじまるURLで入力してください')
  })

  it('URL型にURLでない文章を入れると止め、欄のすぐ下にも理由を出す(R36)', async () => {
    api.detail.mockResolvedValue({
      success: true,
      data: {
        id: 'var-1', name: '店舗リンク', varKey: 'shop_link', type: 'url',
        value: 'https://example.com/old', memo: '', folderId: null,
        version: 1, history: [],
      },
    })
    await mount(React.createElement(EditCommonVarPage))
    await settle()

    await setValue(byId('cv-value'), 'これはURLではありません')
    await click(byExactText('button', '共通情報を保存する'))

    expect(api.update).not.toHaveBeenCalled()
    expect(host.textContent).toContain('http://')
    const valueField = byId('cv-value').closest('section')
    expect(valueField?.textContent).toContain('http://')
  })
})
