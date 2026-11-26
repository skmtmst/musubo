// @vitest-environment happy-dom
/*
 * 共通情報の一覧の削除（行の削除の窓 xxKtW・まとめて削除の確認）を、本物の画面を描いて押して確かめる。
 * 使用先を読んでから進めること、消せないものを消させないこと、失敗や遅れて返った答えで
 * 成功扱いにしないこと、差し替えに確認時の版と世代を渡すことを守る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const listVars = vi.hoisted(() => vi.fn())
const listFolders = vi.hoisted(() => vi.fn())
const deleteImpact = vi.hoisted(() => vi.fn())
const deleteVar = vi.hoisted(() => vi.fn())
const replaceVar = vi.hoisted(() => vi.fn())
const replacementCandidates = vi.hoisted(() => vi.fn())
const replacementImpact = vi.hoisted(() => vi.fn())
const listExports = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      commonVars: {
        ...actual.api.commonVars,
        list: listVars,
        deleteImpact,
        delete: deleteVar,
        replace: replaceVar,
        replacementCandidates,
        replacementImpact,
        listExports,
      },
      folders: { ...actual.api.folders, list: listFolders },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}))

const account = vi.hoisted(() => ({ id: 'account-a' }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, accounts: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '支店' }], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner' }
})

import { ApiError } from '@/lib/api'
import CommonVarsListV8 from './list'
import { checkedAtText } from './model'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const base = {
  lineAccountId: 'account-a',
  type: 'text',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  nextSchedule: null,
  pendingScheduleCount: 0,
  validFrom: null,
  validUntil: null,
  folderId: null,
}
const company = { ...base, id: 'v-company', name: '会社名', varKey: 'company_name', value: '株式会社NEN', usageCount: 15 }
const contact = { ...base, id: 'v-contact', name: '問い合わせ先', varKey: 'contact', value: '03-0000-0000', usageCount: 0 }
const notice = { ...base, id: 'v-notice', name: '臨時のお知らせ', varKey: 'temp_notice', value: '本日は17時まで', usageCount: 0 }

function impactOf(variable: { id: string; name: string; varKey: string }, over: Record<string, unknown> = {}) {
  return {
    variable,
    total: 0,
    blockingTotal: 0,
    historicalTotal: 0,
    sendingFixedTotal: 0,
    unscopedFormTotal: 0,
    canDelete: true,
    byKind: {},
    items: [],
    unavailableReferences: [],
    checkedAt: '2026-09-07T10:00:00.000+09:00',
    recommendedAction: 'delete',
    ...over,
  }
}

const blockedCompany = impactOf(company, {
  total: 15,
  blockingTotal: 15,
  canDelete: false,
  items: [{ kind: 'broadcast', kindLabel: '一斉配信', name: '10月のお知らせ', status: '配信予約中', href: '/broadcasts/edit?id=b1', blocksDeletion: true, currentPreview: '' }],
  recommendedAction: 'review_references',
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  account.id = 'account-a'
  listVars.mockReset().mockImplementation(async () => ({ success: true, data: [company, contact, notice] }))
  listFolders.mockReset().mockImplementation(async () => ({ success: true, data: [], unfiledCount: 3 }))
  listExports.mockReset().mockImplementation(async () => ({ success: true, data: [] }))
  deleteImpact.mockReset().mockImplementation(async (id: string) => ({
    success: true,
    data: id === company.id ? blockedCompany : impactOf([company, contact, notice].find((item) => item.id === id) ?? notice),
  }))
  deleteVar.mockReset().mockImplementation(async () => ({ success: true, data: null }))
  replaceVar.mockReset().mockImplementation(async () => ({ success: true, data: {} }))
  replacementCandidates.mockReset().mockImplementation(async () => ({ success: true, data: { source: { id: company.id, name: company.name, type: 'text', version: 1 }, candidates: [] } }))
  replacementImpact.mockReset().mockImplementation(async () => ({ success: false, error: 'none' }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks()
})

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

async function render() {
  act(() => { root.render(<CommonVarsListV8 />) })
  await flush()
}

function byLabel<T extends HTMLElement = HTMLElement>(label: string): T {
  const found = document.querySelector(`[aria-label="${label}"]`) as T | null
  expect(found, `「${label}」がありません`).toBeTruthy()
  return found as T
}

function findButton(text: string, scope: ParentNode = document): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button, [role="menuitem"]')]
    .find((element) => element.textContent?.trim() === text) as HTMLButtonElement | undefined
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = findButton(text, scope)
  expect(found, `「${text}」がありません`).toBeTruthy()
  return found as HTMLButtonElement
}

async function click(element: HTMLElement) {
  await act(async () => { element.click() })
  await flush()
}

async function type(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

async function openRowDelete(name: string) {
  await click(byLabel(`共通情報「${name}」の操作`))
  await click(button('削除する'))
}

function deleteDialog(): HTMLElement {
  const dialog = document.querySelector('[data-design-node="xxKtW"]') as HTMLElement | null
  expect(dialog, '削除の窓（xxKtW）が開いていません').toBeTruthy()
  return dialog as HTMLElement
}

function inputByPlaceholder(placeholder: string, scope: ParentNode = document): HTMLInputElement {
  const found = scope.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement | null
  expect(found, `「${placeholder}」の欄がありません`).toBeTruthy()
  return found as HTMLInputElement
}

describe('行の削除の窓（xxKtW）', () => {
  it('一覧を出しただけでは使用先を読まず、窓を開けてから選択中のアカウントで読む', async () => {
    await render()
    expect(deleteImpact).not.toHaveBeenCalled()
    await openRowDelete('臨時のお知らせ')
    expect(deleteImpact).toHaveBeenCalledTimes(1)
    expect(deleteImpact).toHaveBeenCalledWith('v-notice', 'account-a')
    expect(deleteDialog().textContent).toContain('「臨時のお知らせ」を削除しますか？')
    expect(deleteDialog().textContent).toContain('LINEアカウント')
    expect(deleteDialog().textContent).toContain('環境')
    expect(deleteDialog().querySelector('[data-detail-value]')?.textContent).toBe('臨時のお知らせ')
  })

  it('使用先が読めないときは理由を出し、削除の押し口を出さない', async () => {
    deleteImpact.mockRejectedValue(new ApiError(503, 'unavailable'))
    await render()
    await openRowDelete('臨時のお知らせ')
    expect(document.body.textContent).toContain('使用先を確認できませんでした')
    expect(findButton('このまま削除')).toBeUndefined()
    expect(deleteVar).not.toHaveBeenCalled()
  })

  it('差し込みキーと理由がそろうまで削除を止め、そろえば理由つきで消して一覧を読み直す', async () => {
    await render()
    await openRowDelete('臨時のお知らせ')
    const dialog = deleteDialog()
    expect(dialog.textContent).toContain('削除する場合は、差し込みキーを入力してください')
    expect(button('このまま削除').disabled).toBe(true)
    await type(inputByPlaceholder('店舗情報の変更のため', dialog), '期間が終わったため')
    expect(button('このまま削除').disabled).toBe(true)
    await type(inputByPlaceholder('{{var.temp_notice}}', dialog), '{{var.temp_notice}}')
    const listCalls = listVars.mock.calls.length
    await click(button('このまま削除'))
    expect(deleteVar).toHaveBeenCalledWith('v-notice', 'account-a', '期間が終わったため')
    expect(listVars.mock.calls.length).toBe(listCalls + 1)
    expect(document.querySelector('[data-design-node="xxKtW"]')).toBeNull()
  })

  it('アカウント切替後に古い確定を保持しても削除しない', async () => {
    await render()
    await openRowDelete('臨時のお知らせ')
    const dialog = deleteDialog()
    await type(inputByPlaceholder('店舗情報の変更のため', dialog), '期間が終わったため')
    await type(inputByPlaceholder('{{var.temp_notice}}', dialog), '{{var.temp_notice}}')
    const target = button('このまま削除', dialog)
    const key = Object.keys(target).find(item => item.startsWith('__reactProps$'))!
    const handler = (target as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    account.id = 'account-b'
    await render()
    account.id = 'account-a'
    await render()
    await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: target, target }) })
    expect(deleteVar).not.toHaveBeenCalled()
    expect(document.querySelector('[data-design-node="xxKtW"]')).toBeNull()
  })

  it('消すときに使われ始めていた（409）ら、使用先を読み直して「まだ消せません」に変える', async () => {
    deleteVar.mockRejectedValue(new ApiError(409, 'common_var_delete_blocked'))
    await render()
    await openRowDelete('臨時のお知らせ')
    const dialog = deleteDialog()
    await type(inputByPlaceholder('店舗情報の変更のため', dialog), '期間が終わったため')
    await type(inputByPlaceholder('{{var.temp_notice}}', dialog), '{{var.temp_notice}}')
    deleteImpact.mockResolvedValueOnce({ success: true, data: impactOf(notice, { total: 2, blockingTotal: 2, canDelete: false, items: [] }) })
    await click(button('このまま削除'))
    expect(deleteImpact).toHaveBeenCalledTimes(2)
    expect(deleteImpact).toHaveBeenLastCalledWith('v-notice', 'account-a')
    expect(document.body.textContent).toContain('いま使われ始めたため、削除できませんでした。使用先を読み直しました。')
    expect(document.body.textContent).toContain('「臨時のお知らせ」はまだ消せません')
    expect(deleteDialog().querySelector('[data-detail-value]')?.textContent).toBe('臨時のお知らせ')
    expect(findButton('このまま削除')).toBeUndefined()
  })

  it('閉じて別の共通情報を開いたあと、遅れて返った前の結果を窓に映さない', async () => {
    const slow = deferred<unknown>()
    deleteImpact.mockImplementationOnce(() => slow.promise)
    await render()
    await openRowDelete('会社名')
    await click(button('キャンセル', deleteDialog()))
    await openRowDelete('臨時のお知らせ')
    expect(deleteDialog().textContent).toContain('「臨時のお知らせ」を削除しますか？')
    expect(deleteDialog().querySelector('[data-detail-value]')?.textContent).toBe('臨時のお知らせ')
    await act(async () => { slow.resolve({ success: true, data: blockedCompany }) })
    await flush()
    const dialog = deleteDialog()
    expect(dialog.textContent).toContain('「臨時のお知らせ」を削除しますか？')
    expect(dialog.textContent).not.toContain('まだ消せません')
    expect(dialog.textContent).not.toContain('10月のお知らせ')
  })

  it('確認した範囲に、いつ時点で9種類を確かめたかを書く', async () => {
    await render()
    await openRowDelete('臨時のお知らせ')
    const summary = [...deleteDialog().querySelectorAll('summary')].find((element) => element.textContent?.includes('確認した範囲'))
    expect(summary, '「確認した範囲」がありません').toBeTruthy()
    await click(summary as HTMLElement)
    expect(checkedAtText('2026-09-07T10:00:00.000+09:00')).not.toBe('—')
    expect(deleteDialog().textContent).toContain(`${checkedAtText('2026-09-07T10:00:00.000+09:00')} 時点で、テンプレート・一斉配信・シナリオ・リマインダ・自動応答・回答フォーム・オートメーション・友だち追加時・共通アクションの9種類を確認しました。`)
  })

  it('使われているものは差し替え先と影響を読んでから、理由つきで確認時の版と世代を渡して差し替える', async () => {
    const candidate = { id: 'v-contact', name: '問い合わせ先', varKey: 'contact', type: 'text' }
    replacementCandidates.mockResolvedValue({ success: true, data: { source: { id: company.id, name: company.name, type: 'text', version: 4 }, candidates: [candidate] } })
    replacementImpact.mockResolvedValue({
      success: true,
      data: {
        source: { id: company.id, name: company.name, version: 4 },
        replacement: { id: candidate.id, name: candidate.name },
        revision: 'revision-7',
        canReplace: true,
        replaceableTotal: 15,
        blockedTotal: 0,
      },
    })
    await render()
    await openRowDelete('会社名')
    expect(replacementImpact).toHaveBeenCalledWith('v-company', 'account-a', 'v-contact')
    const dialog = deleteDialog()
    expect(dialog.textContent).toContain('別の共通情報に差し替えて消す（おすすめ）')
    expect(dialog.querySelector('[data-window-actions] input')).toBeNull()
    expect(dialog.querySelectorAll('[data-window-body] input[aria-label="消した理由・止める理由（記録に残ります）"]')).toHaveLength(1)
    expect(dialog.textContent).toContain('消さずに止める')
    expect(dialog.querySelector('[aria-label="差し替え先"]')).toBeTruthy()
    expect(dialog.textContent).toContain('差し替えると、15か所の「株式会社NEN」が問い合わせ先の中身になります。')
    expect(document.body.textContent).not.toContain('差し替えて削除')
    const replace = button('差し替えて消す')
    expect(replace.disabled).toBe(true)
    await type(byLabel<HTMLInputElement>('消した理由・止める理由（記録に残ります）'), '電話番号に統一するため')
    expect(button('差し替えて消す').disabled).toBe(false)
    await click(button('差し替えて消す'))
    expect(replaceVar).toHaveBeenCalledWith('v-company', 'account-a', {
      replacementId: 'v-contact',
      expectedVersion: 4,
      expectedRevision: 'revision-7',
      changeReason: '電話番号に統一するため',
    })
  })

  it('自動で差し替えられない箇所があるときは、差し替えの押し口を止める', async () => {
    const candidate = { id: 'v-contact', name: '問い合わせ先', varKey: 'contact', type: 'text' }
    replacementCandidates.mockResolvedValue({ success: true, data: { source: { id: company.id, name: company.name, type: 'text', version: 4 }, candidates: [candidate] } })
    replacementImpact.mockResolvedValue({
      success: true,
      data: {
        source: { id: company.id, name: company.name, version: 4 },
        replacement: { id: candidate.id, name: candidate.name },
        revision: 'revision-7',
        canReplace: false,
        replaceableTotal: 12,
        blockedTotal: 3,
      },
    })
    await render()
    await openRowDelete('会社名')
    expect(deleteDialog().textContent).toContain('3か所は自動で差し替えられません。先に個別に確認してください。')
    await type(byLabel<HTMLInputElement>('消した理由・止める理由（記録に残ります）'), '電話番号に統一するため')
    expect(button('差し替えて消す').disabled).toBe(true)
  })
})

async function selectRows(...names: string[]) {
  for (const name of names) await click(byLabel(`${name}を選ぶ`))
}

function confirmDialog(): HTMLElement {
  const title = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
    .find((element) => element.textContent?.includes('を削除しますか？')) as HTMLElement | undefined
  expect(title, 'まとめて削除の確認が開いていません').toBeTruthy()
  return title as HTMLElement
}

describe('まとめて削除の確認', () => {
  it('一括削除の理由を入力したら画面移動を確認する', async () => {
    await render()
    await selectRows('問い合わせ先', '臨時のお知らせ')
    await click(button('選択した共通情報を削除'))
    await type(inputByPlaceholder('店舗情報の変更のため', confirmDialog()), '整理のため')
    const link = document.createElement('a'); link.href = '/templates'; document.body.appendChild(link)
    await click(link)
    expect(document.body.textContent).toContain('保存していない変更があります')
    link.remove()
  })
  it('アカウントを切り替えて戻しても古い一括確定では削除しない', async () => {
    await render()
    await selectRows('問い合わせ先', '臨時のお知らせ')
    await click(button('選択した共通情報を削除'))
    await type(inputByPlaceholder('店舗情報の変更のため', confirmDialog()), '整理のため')
    const target = button('削除する', confirmDialog())
    const key = Object.keys(target).find(item => item.startsWith('__reactProps$'))!
    const handler = (target as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    account.id = 'account-b'; await render()
    account.id = 'account-a'; await render()
    await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: target, target }) })
    expect(deleteVar).not.toHaveBeenCalled()
  })

  it('使用先を確かめてから共通の確認窓を開き、消えるもの・残るもの・戻せないことを伝える', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm')
    await render()
    await selectRows('問い合わせ先', '臨時のお知らせ')
    await click(button('選択した共通情報を削除'))
    expect(deleteImpact.mock.calls).toEqual([['v-contact', 'account-a'], ['v-notice', 'account-a']])
    expect(nativeConfirm).not.toHaveBeenCalled()
    const dialog = confirmDialog()
    // 題は共通の確認窓が「「先頭の名前」を削除しますか？」に整える。件数は説明で伝える。
    expect(dialog.textContent).toContain('「問い合わせ先」を削除しますか？')
    expect(dialog.textContent).toContain('選択した2 件の共通情報と、登録値・次回予約を削除します。テンプレート、配信、フォルダ、友だちは削除しません。この操作は元に戻せません。')
  })

  it('1件だけなら、その名前を題に出す', async () => {
    await render()
    await selectRows('臨時のお知らせ')
    await click(button('選択した共通情報を削除'))
    expect(confirmDialog().textContent).toContain('「臨時のお知らせ」を削除しますか？')
  })

  it('理由を入れて削除すると、選択中のアカウントで1件ずつ消し、窓を閉じて一覧を読み直す', async () => {
    await render()
    await selectRows('問い合わせ先', '臨時のお知らせ')
    await click(button('選択した共通情報を削除'))
    expect(confirmDialog().textContent).toContain('LINEアカウント')
    await type(inputByPlaceholder('店舗情報の変更のため', confirmDialog()), '整理のため')
    const listCalls = listVars.mock.calls.length
    await click(button('削除する', confirmDialog()))
    expect(deleteVar.mock.calls).toEqual([['v-contact', 'account-a', '整理のため'], ['v-notice', 'account-a', '整理のため']])
    expect(listVars.mock.calls.length).toBe(listCalls + 1)
    expect(document.body.textContent).not.toContain('を削除しますか？')
  })

  it('使われているものが混ざっていたら、確認窓を開かず件数と使用先の数を言う', async () => {
    await render()
    await selectRows('会社名', '臨時のお知らせ')
    await click(button('選択した共通情報を削除'))
    expect(document.body.textContent).toContain('1 件は、合計15か所で使用中のため削除できません。')
    expect(document.body.textContent).not.toContain('を削除しますか？')
    expect(deleteVar).not.toHaveBeenCalled()
  })

  it('使用先を確かめられないときは確認窓を開かない', async () => {
    deleteImpact.mockResolvedValue({ success: false, error: 'boom' })
    await render()
    await selectRows('臨時のお知らせ')
    await click(button('選択した共通情報を削除'))
    expect(document.body.textContent).toContain('使用先を確認できないため削除できません。もう一度お試しください。')
    expect(document.body.textContent).not.toContain('を削除しますか？')
  })

  it('一部が失敗を返したら成功扱いにせず、窓を閉じずに消せなかったものだけを残す', async () => {
    deleteVar.mockImplementation(async (id: string) => (id === 'v-notice' ? { success: false, error: 'busy' } : { success: true, data: null }))
    await render()
    await selectRows('問い合わせ先', '臨時のお知らせ')
    await click(button('選択した共通情報を削除'))
    await type(inputByPlaceholder('店舗情報の変更のため', confirmDialog()), '整理のため')
    await click(button('削除する', confirmDialog()))
    const dialog = confirmDialog()
    expect(dialog.textContent).toContain('「臨時のお知らせ」を削除しますか？')
    expect(dialog.textContent).toContain('1 件の共通情報を削除できませんでした。削除できなかったものだけを残しています。')
  })

  it('削除中は二重に送らず、確認窓も閉じない', async () => {
    const pending = deferred<unknown>()
    deleteVar.mockImplementationOnce(() => pending.promise)
    await render()
    await selectRows('臨時のお知らせ')
    await click(button('選択した共通情報を削除'))
    await type(inputByPlaceholder('店舗情報の変更のため', confirmDialog()), '整理のため')
    await click(button('削除する', confirmDialog()))
    expect(deleteVar).toHaveBeenCalledTimes(1)
    const busyConfirm = [...confirmDialog().querySelectorAll('button')].find((element) => element.getAttribute('aria-busy') === 'true' || element.textContent?.includes('処理中'))
    expect(busyConfirm, '削除中の押し口が処理中になっていません').toBeTruthy()
    expect((busyConfirm as HTMLButtonElement).disabled).toBe(true)
    await click(busyConfirm as HTMLButtonElement)
    const cancel = button('キャンセル', confirmDialog())
    expect(cancel.disabled).toBe(true)
    await click(cancel)
    expect(deleteVar).toHaveBeenCalledTimes(1)
    expect(confirmDialog().textContent).toContain('「臨時のお知らせ」を削除しますか？')
    await act(async () => { pending.resolve({ success: true, data: null }) })
    await flush()
  })

  it('一度に消せるのは20件まで。超えたら使用先を読まずに絞り込みを案内する', async () => {
    const many = Array.from({ length: 21 }, (_, index) => ({ ...base, id: `v-${index}`, name: `項目${index}`, varKey: `item_${index}`, value: 'x', usageCount: 0 }))
    listVars.mockResolvedValue({ success: true, data: many })
    await render()
    await click(byLabel('このページの共通情報をすべて選ぶ'))
    await click(button('条件に合う21件すべてを選択する'))
    await click(button('選択した共通情報を削除'))
    expect(deleteImpact).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('一度に削除できるのは20 件までです。フォルダや検索で絞り込んで分けて削除してください。')
    expect(document.body.textContent).not.toContain('を削除しますか？')
  })

  it('LINEアカウントを切り替えたら、前のアカウントで選んだものを外す', async () => {
    await render()
    await selectRows('問い合わせ先', '臨時のお知らせ')
    expect(findButton('選択した共通情報を削除')).toBeTruthy()
    account.id = 'account-b'
    await render()
    expect(listVars).toHaveBeenLastCalledWith('account-b')
    expect(byLabel<HTMLInputElement>('問い合わせ先を選ぶ').checked).toBe(false)
    expect(byLabel<HTMLInputElement>('臨時のお知らせを選ぶ').checked).toBe(false)
    expect(document.body.textContent).not.toContain('2件を選択中')
  })
})
