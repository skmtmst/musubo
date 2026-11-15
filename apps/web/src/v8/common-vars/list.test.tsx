import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 共通情報の一覧（src/v8）の動きの試験。BEHAVIOR.md の主要な動きを守る。
 * 行が出る・札で絞れる・行の「…」から止める窓と削除の窓が開く（板 ・）・
 * 閲覧のみでは帯が出て作るボタンを出さない・空のまま使われている帯の「編集する」で絞れる。
 */
import styles from './list.module.css'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const listVars = vi.hoisted(() => vi.fn())
const listFolders = vi.hoisted(() => vi.fn())
const deleteImpact = vi.hoisted(() => vi.fn())
const replacementCandidates = vi.hoisted(() => vi.fn())
const replacementImpact = vi.hoisted(() => vi.fn())
const listExports = vi.hoisted(() => vi.fn())
const setStatus = vi.hoisted(() => vi.fn())
const staffRole = vi.hoisted(() => ({ value: 'owner' as string }))
const currentAccount = vi.hoisted(() => ({ id: 'account-a' }))

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
        replacementCandidates,
        replacementImpact,
        listExports,
        setStatus,
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

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: currentAccount.id, accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => staffRole.value }
})

import CommonVarsListV8 from './list'

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
}
const company = { ...base, id: 'v-company', folderId: null, name: '会社名', varKey: 'company_name', value: '株式会社NEN', usageCount: 15 }
const contact = { ...base, id: 'v-contact', folderId: null, name: '問い合わせ先', varKey: 'contact', value: '', usageCount: 2 }
const notice = { ...base, id: 'v-notice', folderId: null, name: '臨時のお知らせ', varKey: 'temp_notice', value: '本日は17時まで', state: 'draft', usageCount: 0 }

beforeEach(() => {
  currentAccount.id = 'account-a'
  setStatus.mockReset().mockResolvedValue({ success: true, data: {} })
  document.documentElement.dataset.theme = 'v8'
  staffRole.value = verifiedStaffRole('owner')
  listVars.mockImplementation(async () => ({ success: true, data: [company, contact, notice] }))
  listFolders.mockImplementation(async () => ({ success: true, data: [], unfiledCount: 3 }))
  listExports.mockImplementation(async () => ({ success: true, data: [] }))
  deleteImpact.mockImplementation(async () => ({
    success: true,
    data: {
      variable: { id: 'v-company', name: '会社名', varKey: 'company_name' },
      total: 15,
      blockingTotal: 15,
      historicalTotal: 0,
      unscopedFormTotal: 0,
      canDelete: false,
      byKind: {},
      items: [
        { kind: 'broadcast', kindLabel: '一斉配信', name: '10月のお知らせ', status: '配信予約中', href: '/broadcasts/edit?id=b1', blocksDeletion: true, currentPreview: '' },
      ],
      unavailableReferences: [],
      checkedAt: '2026-09-07T10:00:00.000+09:00',
      recommendedAction: 'review_references',
    },
  }))
  replacementCandidates.mockImplementation(async () => ({ success: true, data: { source: { id: 'v-company', name: '会社名', type: 'text', version: 1 }, candidates: [] } }))
  replacementImpact.mockImplementation(async () => ({ success: false, error: 'none' }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/contents/vars')
  delete document.documentElement.dataset.theme
})

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

function buttonByLabel(label: string): HTMLButtonElement {
  const found = document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null
  expect(found, `「${label}」のボタンがありません`).toBeTruthy()
  return found as HTMLButtonElement
}

function buttonByText(text: string): HTMLElement {
  const found = ([...document.querySelectorAll('button, [role="menuitem"]')]
    .find((element) => element.textContent?.trim() === text) ?? querySupplementaryPageAction(text)) as HTMLElement | undefined
  expect(found, `「${text}」がありません`).toBeTruthy()
  return found as HTMLElement
}

describe('V8 共通情報の一覧（src/v8）の動き', () => {
  it.each(['止める', '削除する'])('%sの理由を入力したら画面移動を確認する', async (action) => {
    act(() => { root.render(<CommonVarsListV8 />) }); await flush()
    act(() => { buttonByLabel('共通情報「会社名」の操作').click() }); await flush()
    act(() => { buttonByText(action).click() }); await flush()
    const placeholder = action === '止める' ? 'キャンペーンが終わったため' : '店舗情報の変更のため'
    const input = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => { setter.call(input, '変更のため'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    const link = document.createElement('a'); link.href = '/templates'; document.body.appendChild(link)
    act(() => { link.click() }); await flush()
    expect(document.body.textContent).toContain('保存していない変更があります')
    link.remove()
  })
  it('詳細の名前を編集して移動するときは入力を保って確認する', async () => {
    window.history.replaceState(null, '', '/contents/vars?row=v-company')
    act(() => { root.render(<CommonVarsListV8 />) }); await flush()
    act(() => { buttonByLabel('共通情報の名前を変更する').click() })
    const input = document.querySelector<HTMLInputElement>('input[aria-label="共通情報の名前"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => { setter.call(input, '編集途中の名前'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    const link = document.createElement('a'); link.href = '/templates'; document.body.appendChild(link)
    act(() => { link.click() }); await flush()
    expect(document.body.textContent).toContain('保存していない変更があります')
    expect(document.querySelector<HTMLInputElement>('input[aria-label="共通情報の名前"]')?.value).toBe('編集途中の名前')
    link.remove()
  })
  it('詳細の名前を編集中に次の行へ移るときは一度確かめる', async () => {
    window.history.replaceState(null, '', '/contents/vars?row=v-company')
    act(() => { root.render(<CommonVarsListV8 />) }); await flush()
    act(() => { buttonByLabel('共通情報の名前を変更する').click() })
    const input = document.querySelector<HTMLInputElement>('input[aria-label="共通情報の名前"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => { setter.call(input, '編集途中の名前'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    act(() => { buttonByLabel('次の行').click() }); await flush()
    expect(document.body.textContent).toContain('保存していない変更があります')
    act(() => { buttonByText('編集を続ける').click() }); await flush()
    expect(document.querySelector<HTMLInputElement>('input[aria-label="共通情報の名前"]')?.value).toBe('編集途中の名前')
    act(() => { buttonByLabel('次の行').click() }); await flush()
    act(() => { buttonByText('保存せずに移る').click() }); await flush()
    expect(document.body.textContent).not.toContain('保存していない変更があります')
    expect(new URL(window.location.href).searchParams.get('row')).toBe('v-contact')
  })
  it('名前の編集中に履歴で別の行へ戻っても入力を失わず確認する', async () => {
    window.history.replaceState(null, '', '/contents/vars?row=v-company')
    act(() => { root.render(<CommonVarsListV8 />) }); await flush()
    act(() => { buttonByLabel('共通情報の名前を変更する').click() })
    const input = document.querySelector<HTMLInputElement>('input[aria-label="共通情報の名前"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => { setter.call(input, '編集途中の名前'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    window.history.replaceState(null, '', '/contents/vars?row=v-contact')
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')) }); await flush()
    expect(document.body.textContent).toContain('保存していない変更があります')
    expect(document.querySelector<HTMLInputElement>('input[aria-label="共通情報の名前"]')?.value).toBe('編集途中の名前')
    expect(go).toHaveBeenCalledWith(1)
    go.mockRestore()
  })
  it('未入力と取得できない数を分け、実値の0を残す', async () => {
    // 使用先の列が出る1440相当。狭い板ではこの列を詳細へ畳む。
    const media = vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
      matches:false, media:query, onchange:null,
      addEventListener:vi.fn(), removeEventListener:vi.fn(),
      addListener:vi.fn(), removeListener:vi.fn(), dispatchEvent:vi.fn(()=>true),
    }))
    try {
      listVars.mockResolvedValue({success:true,data:[{...company,usageCount:undefined},contact,{...notice,value:'0'}]})
      act(() => { root.render(<CommonVarsListV8 />) })
      await flush()
      const rows = [...host.querySelectorAll('tbody tr')]
      const companyRow = (rows.find(row=>row.textContent?.includes('会社名')) ?? querySupplementaryPageAction('会社名'))!
      expect(companyRow.querySelector('[title="使われている場所を取得できていません"]')?.textContent).toBe('—')
      expect((rows.find(row=>row.textContent?.includes('問い合わせ先')) ?? querySupplementaryPageAction('問い合わせ先'))?.textContent).toContain('未設定')
      const zeroRow = (rows.find(row=>row.textContent?.includes('臨時のお知らせ')) ?? querySupplementaryPageAction('臨時のお知らせ'))!
      expect([...zeroRow.querySelectorAll('td')].some(cell=>cell.textContent==='0')).toBe(true)
      expect(zeroRow.textContent).toContain('なし')
      expect(host.textContent).not.toContain('—（未取得）')
    } finally { media.mockRestore() }
  })
  it('行が出て、数の帯と空のままの帯が出る', async () => {
    act(() => { root.render(<CommonVarsListV8 />) })
    await flush()
    expect(host.textContent).toContain('会社名')
    expect(host.querySelector('[data-list-name]')?.textContent).not.toContain('{{var.company_name}}')
    expect(host.textContent).toContain('問い合わせ先')
    expect([...host.querySelectorAll('[data-kpi-label]')].map(node => node.textContent)).toContain('使っている所')
    expect(host.textContent).toContain('「問い合わせ先」が空のまま 2か所で使われています。')
  })

  it('札「下書き・止めた」で下書きだけになり、もう一度押すと戻る', async () => {
    act(() => { root.render(<CommonVarsListV8 />) })
    await flush()
    act(() => { buttonByText('下書き・止めた').click() })
    await flush()
    expect(host.textContent).toContain('臨時のお知らせ')
    expect(host.textContent).not.toContain('株式会社NEN')
    act(() => { buttonByText('下書き・止めた').click() })
    await flush()
    expect(host.textContent).toContain('株式会社NEN')
  })

  it('空のままの帯の「編集する」で、空のものだけに絞る', async () => {
    act(() => { root.render(<CommonVarsListV8 />) })
    await flush()
    const fix = ([...host.querySelectorAll('[role="status"] button')].find((b) => b.textContent === '編集する') ?? querySupplementaryPageAction('編集する')) as HTMLButtonElement
    expect(fix, '帯の「編集する」がありません').toBeTruthy()
    act(() => { fix.click() })
    await flush()
    expect(host.textContent).not.toContain('株式会社NEN')
    expect(host.textContent).toContain('問い合わせ先')
  })

  it('行の「…」から止める窓（Hhl9M）が開き、予約中の配信を知らせる', async () => {
    act(() => { root.render(<CommonVarsListV8 />) })
    await flush()
    const menu = buttonByLabel('共通情報「会社名」の操作')
    expect(menu.parentElement?.classList.contains(styles.menuBox)).toBe(true)
    act(() => { menu.click() })
    await flush()
    act(() => { buttonByText('止める').click() })
    await flush()
    expect(document.body.textContent).toContain('「会社名」を止める')
    expect(document.querySelector('[data-design-node="Hhl9M"]')?.textContent).toContain('LINEアカウント')
    expect(document.body.textContent).toContain('予約中の一斉配信「10月のお知らせ」が送られなくなります。')
  })

  it('理由を入力して止めた後、次の確認でも操作できる', async () => {
    act(() => { root.render(<CommonVarsListV8 />) }); await flush()
    act(() => { buttonByLabel('共通情報「会社名」の操作').click() }); await flush()
    act(() => { buttonByText('止める').click() }); await flush()
    const input = document.querySelector<HTMLInputElement>('input[placeholder="キャンペーンが終わったため"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => { setter.call(input, '確認のため'); input.dispatchEvent(new Event('input', { bubbles: true })) }); await flush()
    const dialog = document.querySelector('[data-design-node="Hhl9M"]')!
    const confirm = [...dialog.querySelectorAll('button')].find(item => item.textContent?.trim() === '止める')!
    await act(async () => { confirm.click() }); await flush()
    expect(setStatus).toHaveBeenCalledWith('v-company', 'account-a', { to: 'stopped', changeReason: '確認のため' })
    act(() => { buttonByLabel('共通情報「会社名」の操作').click() }); await flush()
    act(() => { buttonByText('止める').click() }); await flush()
    expect(document.querySelector('[data-design-node="Hhl9M"]')).toBeTruthy()
  })

  it('アカウント切替後に古い停止確定を保持しても送らない', async () => {
    act(() => { root.render(<CommonVarsListV8 />) }); await flush()
    act(() => { buttonByLabel('共通情報「会社名」の操作').click() }); await flush()
    act(() => { buttonByText('止める').click() }); await flush()
    const input = document.querySelector<HTMLInputElement>('input[placeholder="キャンペーンが終わったため"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => { setter.call(input, '確認のため'); input.dispatchEvent(new Event('input', { bubbles: true })) }); await flush()
    const dialog = document.querySelector('[data-design-node="Hhl9M"]')!
    const target = [...dialog.querySelectorAll('button')].find(item => item.textContent?.trim() === '止める')!
    const key = Object.keys(target).find(item => item.startsWith('__reactProps$'))!
    const handler = (target as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    currentAccount.id = 'account-b'; act(() => { root.render(<CommonVarsListV8 />) }); await flush()
    currentAccount.id = 'account-a'; act(() => { root.render(<CommonVarsListV8 />) }); await flush()
    await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: target, target }) })
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('行の「…」から削除の窓（xxKtW）が開き、使われているものは「まだ消せません」', async () => {
    const original = await deleteImpact()
    deleteImpact.mockResolvedValue({ ...original, data: {
      ...original.data,
      historicalTotal: 1,
      items: [...original.data.items, { kind: 'broadcast', kindLabel: '一斉配信', name: '送信済みのお知らせ', status: '配信済み', href: '/broadcasts/edit?id=sent', blocksDeletion: false, currentPreview: '' }],
    } })
    act(() => { root.render(<CommonVarsListV8 />) })
    await flush()
    act(() => { buttonByLabel('共通情報「会社名」の操作').click() })
    await flush()
    act(() => { buttonByText('削除する').click() })
    await flush()
    expect(document.body.textContent).toContain('「会社名」はまだ消せません')
    expect(document.querySelector('[data-design-node="xxKtW"] [data-detail-value]')?.textContent).toBe('会社名')
    expect(document.body.textContent).toContain('どうしますか')
    const reason = document.querySelector<HTMLInputElement>('input[aria-label="消した理由・止める理由（記録に残ります）"]')
    expect(reason).toBeTruthy()
    expect(reason?.closest('[class*="footer"]')).toBeNull()
    expect(document.querySelector('button[aria-label="確認した範囲の説明"]')).toBeNull()
    expect(document.body.textContent).toContain('消さずに止める')
    expect(document.body.textContent).toContain('送信済みの配信はこれから変わりません')
    expect(document.body.textContent).toContain('送信済みのお知らせ')
    expect(document.querySelector('a[href="/broadcasts/edit?id=sent"]')).toBeNull()
    expect(document.querySelector('a[href="/broadcasts/edit?id=b1"]')).not.toBeNull()
  })

  // 2026-10-06 オーナー決定：閲覧のみには押せないボタンを置かずに隠す（帯は出す）。
  it('閲覧のみ（staff）では帯が出て、作成・変更は隠しコピーだけを使える', async () => {
    staffRole.value = verifiedStaffRole('staff')
    act(() => { root.render(<CommonVarsListV8 />) })
    await flush()
    expect(host.textContent).toContain(PERMISSION_LOCK_SUMMARY.feature)
    const create = [...host.querySelectorAll('button, a')].filter((b) => b.textContent?.includes('共通情報を作る'))
    expect(create.length).toBeGreaterThan(0)
    expect(create.every(button => button.getAttribute('aria-disabled') === 'true')).toBe(true)
    act(() => { (create[0] as HTMLButtonElement).click() })
    expect(host.querySelector('a[href="/contents/vars/new"]')).toBeNull()
    act(() => { buttonByLabel('共通情報「会社名」の操作').click() })
    await flush()
    const menu = document.querySelector('[role="menu"]')!
    expect(menu.textContent).toContain('差し込みキーをコピー')
    for (const label of ['編集', '止める', '削除する', '再開する']) expect(menu.textContent).not.toContain(label)
  })
})

afterEach(() => { verifiedStaffRole(null) })
