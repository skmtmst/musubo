// @vitest-environment happy-dom
/*
 * ★V8-B LINEアカウントの乗り換え（板 ）。
 * 管理画面 と同じ口・同じ守りで、未判断が残る間は本実行を押せず、
 * 判断の保存・本人確認の小窓が動くこと。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readUiSource as readFileSync } from '../../../../scripts/test-ui-source.mjs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lineAccountsGet = vi.hoisted(() => vi.fn())
const lineAccountsList = vi.hoisted(() => vi.fn())
const staffMe = vi.hoisted(() => vi.fn())
const handoversListForAccount = vi.hoisted(() => vi.fn())
const handoversGet = vi.hoisted(() => vi.fn())
const handoversSaveDecisions = vi.hoisted(() => vi.fn())
const handoversExecute = vi.hoisted(() => vi.fn())
const handoversPreview = vi.hoisted(() => vi.fn())
const handoversRollback = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => vi.fn())
const nav = vi.hoisted(() => ({ query: 'id=acc-1' }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      staff: { ...actual.api.staff, me: staffMe },
      lineAccounts: { ...actual.api.lineAccounts, get: lineAccountsGet, list: lineAccountsList },
      accountHandovers: {
        ...actual.api.accountHandovers,
        listForAccount: handoversListForAccount,
        get: handoversGet,
        saveDecisions: handoversSaveDecisions,
        execute: handoversExecute,
        preview: handoversPreview,
        rollback: handoversRollback,
      },
    },
  }
})

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams(nav.query),
}))

vi.mock('@/components/shared/toast', async (importOriginal: () => Promise<typeof import('@/components/shared/toast')>) => ({
  ...await importOriginal(),
  notifyToast: toast,
}))

vi.mock('next/link', () => ({
  default: ({ children, ...p }: { children?: React.ReactNode } & Record<string, unknown>) => (
    <a {...(p as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
}))

vi.mock('@/components/step-up-prompt', () => ({
  useStepUpGate: () => ({ gate: async () => 'token', prompt: null }),
}))

vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(),
  usePageTitle: () => {},
}))

import HandoverV8 from '@/v8/accounts-detail/handover'

const v8css = readFileSync(join(process.cwd(), 'src/v8/accounts-detail/handover.module.css'), 'utf8')
const v8tsx = readFileSync(join(process.cwd(), 'src/v8/accounts-detail/handover.tsx'), 'utf8')

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined
}

function dialog(): HTMLElement | null {
  return document.querySelector('[role="alertdialog"], [role="dialog"]')
}

function handoverDetail(over: Record<string, unknown> = {}) {
  return {
    id: 'h1',
    confirmationRevision: 3,
    status: 'previewed',
    code: 'ABC123',
    fromAccountId: 'acc-1',
    toAccountId: 'acc-2',
    providerMatch: 'same',
    counts: { sourceTotal: 14, auto: 10, review: 2, unmatched: 1, lookalike: 1 },
    decisions: [
      {
        id: 'd1',
        from_friend_id: 'f1',
        to_friend_id: 'f2',
        decision: 'link',
        bucket: 'review',
        note: null,
        sourceName: '見本 16',
        candidateName: '高橋 なおと',
        evidenceLabel: '電話番号が同じ',
      },
      {
        id: 'd2',
        from_friend_id: 'f3',
        to_friend_id: null,
        decision: 'new',
        bucket: 'review',
        note: null,
        sourceName: '見本 157',
        candidateName: null,
        evidenceLabel: '候補なし',
      },
    ],
    unresolvedReviews: 2,
    declaredFriendTotal: null,
    rolledBackAt: null,
    rollbackDeadline: null,
    rollbackNote: null,
    linkedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  document.documentElement.dataset.theme='v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  lineAccountsGet.mockReset()
  lineAccountsList.mockReset()
  staffMe.mockReset()
  handoversListForAccount.mockReset()
  handoversGet.mockReset()
  handoversSaveDecisions.mockReset()
  handoversExecute.mockReset()
  handoversPreview.mockReset()
  handoversRollback.mockReset()
  toast.mockReset()
  nav.query = 'id=acc-1'
  lineAccountsGet.mockResolvedValue({ success: true, data: { id: 'acc-1', name: '然-NEN-TEST' } })
  lineAccountsList.mockResolvedValue({ success: true, data: [{ id: 'acc-2', name: '然-NEN-本店' }] })
  staffMe.mockResolvedValue({ success: true, data: { role: 'owner' } })
  handoversListForAccount.mockResolvedValue({ success: true, data: [{ id: 'h1' }] })
  handoversGet.mockResolvedValue({ success: true, data: handoverDetail() })
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove(); delete document.documentElement.dataset.theme
  document.body.innerHTML = ''
})

async function flush() {
  await act(async () => {
    for (let step = 0; step < 10; step += 1) await Promise.resolve()
  })
}

async function renderV8() {
  await act(async () => { root.render(<HandoverV8 />) })
  await flush()
}

describe('V8-B 乗り換え（x2dSNv）', () => {
  it('手順・判断の表・下の帯が出て、未判断の間は本実行を押せない', async () => {
    await renderV8()
    expect(document.querySelector('[data-design-node="x2dSNv"]'), '板IDの枠がある').toBeTruthy()
    expect(document.body.textContent).toContain('乗り換え（然-NEN-TEST → 然-NEN-本店）')
    expect(document.body.textContent).toContain('要確認')
    const execute = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('本実行する')) as HTMLButtonElement
    expect(execute, '本実行の口がある').toBeTruthy()
    expect(execute.disabled, '未判断2人の間は押せない').toBe(true)
    expect(document.body.textContent).toContain('未判断が 2 人残っています')
    const help = document.querySelector('button[aria-label$="の説明"]') as HTMLButtonElement
    await act(async () => { help.click() })
    await flush()
    expect(document.body.textContent).toContain('「要確認」を全部決めるまで本実行できません')
  })

  it('判断を変えて保存すると保存の口を叩く', async () => {
    handoversSaveDecisions.mockResolvedValue({ success: true, data: {} })
    await renderV8()
    // 1行目の判断を「新しく作る」に変える（共有 Select は小さな窓で選ぶ形）
    const selects = document.querySelectorAll('button[aria-label$="の判断"]')
    await act(async () => { (selects[0] as HTMLButtonElement).click() })
    await flush()
    const option = [...document.querySelectorAll('[role="option"] button')].find((o) => o.textContent === '新しく作る') as HTMLElement
    await act(async () => { option!.click() })
    await flush()
    expect(document.body.textContent).toContain('1 件の書き換えをまだ保存していません')
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent === '判断を保存する')
    await act(async () => { save!.click() })
    await flush()
    expect(handoversSaveDecisions, '判断の保存を叩く').toHaveBeenCalled()
  })

  it('V8 の型と共通部品（設定の型・表・下の帯）で描き、色直書き・準備中を持たない', async () => {
    await renderV8()
    expect(document.querySelector('[data-design-node="x2dSNv"]')?.getAttribute('data-template-layout')).toBe('account-handover')
    expect(document.querySelector('table[data-table-presentation="account-handover"]'), '共通の表で判断を出す').toBeTruthy()
    expect(document.querySelector('[data-shared-part="sticky-bar"][data-presentation="account-handover"]'), '共通の下の帯').toBeTruthy()
    expect(v8css).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    // 影は共通のカードの影だけ（2026-10-09 オーナー採用 ）。ほかの影は直書きしない。
    expect(v8css.replace(/box-shadow:\s*var\(--card-shadow\)/g, '')).not.toMatch(/box-shadow\s*:/)
    expect(v8tsx).not.toContain('準備中')
    // 押しても何も起きない「本実行へ進む」を戻さない（入口は確認窓を開く。下の試験で押して確かめる）。
    expect(v8tsx).not.toMatch(/<Button[^>]*>\s*本実行へ進む\s*<\/Button>/)
  })

  it('取得した人数の合計が合うときだけ、事前確認の数を出す', async () => {
    await renderV8()
    expect(handoversListForAccount).toHaveBeenCalledWith('acc-1')
    expect(handoversGet).toHaveBeenCalledWith('h1')
    expect(document.body.textContent).toContain('元の友だち 14 人：自動で同じ人 10・要確認 2・一致しない 1・別人の可能性 1')
    expect(document.body.textContent).toContain('元のアカウントの友だち・履歴・元のID と所属は残します')
  })

  it('合計が元の友だち数と合わないとき、数を出さない', async () => {
    handoversGet.mockResolvedValue({ success: true, data: handoverDetail({ counts: { sourceTotal: 15, auto: 10, review: 2, unmatched: 1, lookalike: 1 } }) })
    await renderV8()
    expect(document.body.textContent).toContain('事前確認の合計が元の友だちの数と合わないので、数を出していません')
    expect(document.body.textContent).not.toContain('元の友だち 15 人')
  })

  it('事前確認をやり直すと、申告の数を添えて事前確認の口を叩き、読み直す', async () => {
    handoversPreview.mockResolvedValue({ success: true, data: {} })
    await renderV8()
    await act(async () => { buttonByText('申告の数を入れる')!.click() })
    await flush()
    const input = document.getElementById('acd-declared') as HTMLInputElement
    expect(input).toBeTruthy()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '14')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    handoversGet.mockClear()
    await act(async () => { buttonByText('事前確認をやり直す')!.click() })
    await flush()
    expect(handoversPreview).toHaveBeenCalledWith('h1', {
      sourceFriendTotal: 14,
      counts: { auto: 10, review: 2, unmatched: 1, lookalike: 1 },
      declaredFriendTotal: 14,
    })
    expect(handoversGet, '事前確認のあとに読み直す').toHaveBeenCalledWith('h1')
  })

  it('決め残しが無ければ本実行は確認窓を開くだけで、窓で押すと本人確認つきで本実行の口へ送る', async () => {
    handoversGet.mockResolvedValue({ success: true, data: handoverDetail({ unresolvedReviews: 0 }) })
    handoversExecute.mockResolvedValue({ success: true, data: { movedCount: 12 } })
    await renderV8()
    const entry = buttonByText('本実行する')
    expect(entry?.disabled).toBe(false)
    await act(async () => { entry!.click() })
    await flush()
    expect(handoversExecute, '入口を押しただけでは実行しない').not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain('本実行しますか？')
    expect(dialog()?.textContent).toContain('元のアカウントの友だち・履歴・配信は消しません')
    const confirm = [...dialog()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === '本実行する') as HTMLButtonElement
    await act(async () => { confirm.click() })
    await flush()
    expect(handoversExecute).toHaveBeenCalledWith('h1', 'token', 3)
    expect(toast).toHaveBeenCalledWith('本実行が終わりました。12 人を移しました。')
  })

  it('実行ずみの再実行は口側の断り（409）をそのまま窓に出す', async () => {
    handoversGet.mockResolvedValue({ success: true, data: handoverDetail({ unresolvedReviews: 0 }) })
    handoversExecute.mockResolvedValue({ success: false, error: 'この引き継ぎはもう実行しました' })
    await renderV8()
    await act(async () => { buttonByText('本実行する')!.click() })
    await flush()
    const confirm = [...dialog()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === '本実行する') as HTMLButtonElement
    await act(async () => { confirm.click() })
    await flush()
    expect(dialog()?.textContent).toContain('この引き継ぎはもう実行しました')
    expect(toast).not.toHaveBeenCalled()
  })

  it('本実行が通信で失敗したら、危険の帯で言う', async () => {
    handoversGet.mockResolvedValue({ success: true, data: handoverDetail({ unresolvedReviews: 0 }) })
    handoversExecute.mockRejectedValue(new TypeError('fetch failed'))
    await renderV8()
    await act(async () => { buttonByText('本実行する')!.click() })
    await flush()
    const confirm = [...dialog()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === '本実行する') as HTMLButtonElement
    await act(async () => { confirm.click() })
    await flush()
    expect(document.body.textContent).toContain('本実行できませんでした。しばらくおいてから、もう一度お試しください。')
  })

  it('?id= なしで開くと、読み込み中のままにせず一覧へ戻す口を出す', async () => {
    nav.query = ''
    await renderV8()
    expect(document.body.textContent).toContain('乗り換えるアカウントが指定されていません')
    expect(document.querySelector('a[href="/accounts"]'), '一覧へ戻る口').toBeTruthy()
    expect(handoversListForAccount).not.toHaveBeenCalled()
  })

  it('本実行の後の切り戻しは管理者だけに出し、閲覧のみには出さない', async () => {
    const completed = handoverDetail({ status: 'completed', unresolvedReviews: 0, rollbackDeadline: '2999-01-01T00:00:00.000Z' })
    handoversGet.mockResolvedValue({ success: true, data: completed })
    await renderV8()
    expect(buttonByText('切り戻す'), 'オーナーには出る').toBeTruthy()
    await act(async () => { root.unmount() })
    root = createRoot(host)
    staffMe.mockResolvedValue({ success: true, data: { role: 'staff' } })
    await renderV8()
    expect(buttonByText('切り戻す'), '閲覧のみには出さない').toBeUndefined()
    expect(document.body.textContent).toContain('引き継ぎの変更はオーナーと管理者だけができます')
  })
})

vi.mock('@/contexts/account-context', () => ({useAccount: () => ({selectedAccountId:'acc-1',selectedAccount:{id:'acc-1',name:'Fixture'},accounts:[],loading:false})}))
