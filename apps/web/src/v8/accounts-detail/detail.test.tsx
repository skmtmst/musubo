import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * ★V8 LINEアカウントの詳細・乗り換え（src/v8/accounts-detail）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * 閲覧のみには変える操作を置かず帯を出す・動いているアカウントはアーカイブを押せない・
 * 止める理由は必須・資格情報は空の欄を送らない・アーカイブは窓の中で本人確認してから送る・
 * 乗り換えの判断を書き換えると保存の帯が出て本実行は押せない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

let search = 'id=acc-1'
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/accounts/detail',
  useSearchParams: () => new URLSearchParams(search),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', selectedAccount: { id: 'acc-1', name: '本店' }, accounts: [{ id: 'acc-1', name: '本店' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {}, useSettingsNavInline: () => {} }))
let role = 'owner'
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role }
})
// 設定の中のメニューは共通部品（自分の試験がある）。ここでは置き場所だけ。
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => <nav aria-label="設定の中のメニュー" /> }))
const sessionSnapshot = vi.hoisted(() => ({ impersonation: null, unfamiliarAt: null, stepUpMethod: 'totp' }))
vi.mock('@/lib/session-snapshot', async (load) => ({ ...(await load<typeof import('@/lib/session-snapshot')>()), readSessionSnapshot: () => sessionSnapshot }))

import AccountDetailV8 from './detail'
import { CredentialsDialog } from './dialogs'
import AccountHandoverV8 from './handover'
import { credentialLine, shortDateTime, summaryLine, type AccountDetailView } from './view'
import { countsLine, handoverPill, totalsMatch } from './handover-view'

/** 欄の読み上げにつながる誤りの文（共通の Field が欄の下に出す）。 */
const errorTextOf = (el: Element) => (el.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)).find((node) => node?.getAttribute('role') === 'alert' || /-error$/.test(node?.id ?? ''))?.textContent

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const ACCOUNT: AccountDetailView = {
  id: 'acc-1', channelId: '@nen-test', name: '然-NEN-TEST', loginChannelId: 'login-1', liffId: null, isActive: true,
  channelAccessTokenConfigured: true, channelSecretConfigured: true, loginChannelSecretConfigured: true,
  channelAccessTokenLast4: 'x9Qa', channelAccessTokenUpdatedAt: '2026-09-28T01:10:00.000Z',
  channelSecretLast4: null, channelSecretUpdatedAt: null, loginChannelSecretLast4: null, loginChannelSecretUpdatedAt: null,
  isDefault: false, archivedAt: null, friendCapacity: 5000, capacityWarnAt: 4500, iconUrl: null, country: '日本', role: '検証用',
  displayOrder: 0, ogSiteName: null, ogDefaultDescription: null, ogDefaultImageUrl: null, parentLineAccountId: null,
  createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z',
  stats: { friendCount: 1284, activeScenarios: 0, messagesThisMonth: 0 },
  webhook: { expectedUrl: 'https://api.example/webhook', actualUrl: 'https://api.example/webhook', active: true, status: 'matched', checkedAt: null },
  connection: { lastTestAt: '2026-10-01T21:00:00.000Z', lastTestStatus: 'failed', lastReceivedAt: null },
}

let account: AccountDetailView = ACCOUNT
let root: Root
let host: HTMLDivElement
let sent: Array<{ url: string; method: string; body: unknown; stepUp: string | null }> = []
/** acc-1 の詳細の応答を遅らせる（読込の世代の試験）。 */
let gateA: Promise<void> | null = null

beforeEach(() => {
  role = verifiedStaffRole('owner')
  search = 'id=acc-1'
  account = ACCOUNT
  sent = []
  gateA = null
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method !== 'GET') sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null, stepUp: new Headers(init?.headers).get('X-Step-Up-Token') })
    if (url.includes('/staff/me')) return json({ success: true, data: { role } })
    if (url.includes('/auth/step-up')) return json({ success: true, data: { token: 'grant-1', purpose: 'line_account.archive', expiresAt: '2026-10-07T00:00:00.000Z' } })
    if (url.includes('/test-recipients')) return json({ success: true, data: [{ id: 'f-1', displayName: '見本 18', pictureUrl: null }] })
    if (url.includes('/skipped-deliveries')) return json({ success: true, data: [] })
    if (url.includes('/api/line-accounts/acc-1/handovers')) return json({ success: true, data: [{ id: 'h-1' }] })
    if (url.includes('/api/account-handovers/h-1')) {
      return json({ success: true, data: {
        id: 'h-1', fromAccountId: 'acc-1', toAccountId: 'acc-2', code: 'NEN-1', codeExpiresAt: '2026-10-09T00:00:00.000Z', status: 'previewed',
        providerMatch: 'different', counts: { sourceTotal: 4, auto: 2, review: 2, unmatched: 0, lookalike: 0 }, movedCount: 0, failedCount: 0, failureReason: null,
        createdAt: '2026-10-01T00:00:00.000Z', linkedAt: null, previewedAt: null, resolvedAt: null, executedAt: null,
        unresolvedReviews: 1,
        decisions: [{ id: 'd-1', handover_id: 'h-1', from_friend_id: 'f-a', to_friend_id: 'f-b', decision: 'link', bucket: 'review', note: null, decided_by: null, decided_at: '2026-10-01T00:00:00.000Z', sourceName: '見本 16', candidateName: '高橋 なおと', evidenceLabel: '電話番号が同じ' }],
      } })
    }
    if (/\/api\/line-accounts\/acc-1$/.test(url) && method === 'GET') {
      if (gateA) await gateA
      return json({ success: true, data: account })
    }
    if (/\/api\/line-accounts\/acc-2$/.test(url) && method === 'GET') return json({ success: true, data: { ...account, id: 'acc-2', channelId: '@nen-honten', name: '然-NEN-本店' } })
    if (/\/api\/line-accounts$/.test(url)) return json({ success: true, data: [account, { ...ACCOUNT, id: 'acc-2', name: '然-NEN-本店' }] })
    if (method !== 'GET') return json({ success: true, data: account })
    if (url.includes('/feature')) return json({ success: true, data: { features: {} } })
    return json({ success: false, error: 'not found' }, 404)
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const buttons = (name: string) => [...document.querySelectorAll('button, a')].filter((el) => el.textContent?.trim() === name) as HTMLElement[]
const click = async (el: HTMLElement) => { await act(async () => { el.click() }); await settle() }
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

vi.mock('@/lib/api/helpers/gap1', () => ({ lineSenderApi: { list: async () => ({ success: true, data: [] }), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } }))

describe('LINEアカウントの詳細（V8 ihjfd）', () => {
  it.each([
    [5000, 4500, '上限 5,000／警告 4,500'],
    [5000, null, '上限 5,000／警告なし'],
    [null, null, '上限は未設定'],
  ])('友だち数から上限と警告人数の補足を全文確認できる（%s/%s）', async (capacity, warning, label) => {
    account = { ...ACCOUNT, friendCapacity: capacity as number | null, capacityWarnAt: warning as number | null }
    await act(async () => root.render(<AccountDetailV8 />))
    await settle()
    const explanation = [...host.querySelectorAll<HTMLElement>('[title]')].find(node => node.title === label)
    expect(explanation).toBeTruthy()
    expect(explanation?.textContent).toContain('1,284')
    if (capacity === null) expect(explanation?.textContent).toContain('上限なし')
    expect(sent).toHaveLength(0)
  })

  it('管理者には編集・差し替え・止めるを出し、動いているあいだはアーカイブを押せない（理由を書く）', async () => {
    await act(async () => root.render(<AccountDetailV8 />))
    await settle()
    await act(async () => { (host.querySelector('button[aria-label$="の説明"]') as HTMLButtonElement)?.click() })
    expect(document.body.textContent).toContain('@nen-test・要確認（LINE ID・接続状態を確かめてください）・既定ではない・親アカウントなし')
    expect(buttons('編集する')).toHaveLength(1)
    expect(buttons('差し替える')).toHaveLength(3)
    expect(buttons('送受信を止める')).toHaveLength(1)
    const archive = buttons('アーカイブする')[0] as HTMLButtonElement
    expect(archive.disabled).toBe(true)
    expect(archive.title).toContain('先に送受信を止めてください')
    expect(document.getElementById(archive.getAttribute('aria-describedby')!)?.textContent).toContain('先に送受信を止めてください')
    expect(document.body.textContent).toContain('先に送受信を止めてください')
    expect(document.body.textContent).toContain('見本 18')
  })

  it('閲覧のみには変える操作を置かず、閲覧のみの帯を出す', async () => {
    role = verifiedStaffRole('staff')
    await act(async () => root.render(<AccountDetailV8 />))
    await settle()
    expect(buttons('編集する')).toHaveLength(0)
    expect(buttons('差し替える')).toHaveLength(0)
    expect(buttons('送受信を止める')).toHaveLength(0)
    expect(buttons('アーカイブする')).toHaveLength(0)
    expect(buttons('変える')).toHaveLength(0)
    expect(document.body.textContent).toContain(PERMISSION_LOCK_SUMMARY.feature)
    // 乗り換えは見るための入口なので残す。
    expect(buttons('乗り換え')).toHaveLength(1)
  })

  it('止める理由が空なら送らず、入れたら理由つきで止める', async () => {
    await act(async () => root.render(<AccountDetailV8 />))
    await settle()
    await click(buttons('送受信を止める')[0])
    const dialogButtons = buttons('送受信を止める')
    await click(dialogButtons[dialogButtons.length - 1])
    expect(document.body.textContent).toContain('理由を入れてください')
    expect(sent.filter((s) => s.url.endsWith('/deactivate'))).toHaveLength(0)
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
    const input = document.querySelector('[role="dialog"] input') as HTMLInputElement
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(input)
    await type(input, '乗り換えの準備のため')
    expect(input.getAttribute('aria-invalid')).not.toBe('true')
    const again = buttons('送受信を止める')
    await click(again[again.length - 1])
    expect(sent.find((s) => s.url.endsWith('/deactivate'))?.body).toEqual({ reason: '乗り換えの準備のため' })
  })

  it('資格情報は入れた欄だけ送る（空の欄で今の値を消さない）', async () => {
    await act(async () => root.render(<AccountDetailV8 />))
    await settle()
    await click(buttons('差し替える')[0])
    const inputs = [...document.querySelectorAll('[role="dialog"] input')] as HTMLInputElement[]
    expect(inputs).toHaveLength(2)
    await type(inputs[1], 'new-token')
    await click(buttons('本人確認して保存')[0])
    const put = sent.find((s) => s.url.endsWith('/api/line-accounts/acc-1'))
    expect(put?.method).toBe('PUT')
    expect(put?.body).toEqual({ channelAccessToken: 'new-token' })
  })

  it('A で入れかけた資格情報を、表示が B に変わった後で B へ保存しない（WEB132）', async () => {
    await act(async () => root.render(<AccountDetailV8 />))
    await settle()
    await click(buttons('差し替える')[0])
    const inputs = [...document.querySelectorAll('[role="dialog"] input')] as HTMLInputElement[]
    await type(inputs[0], 'secret-for-a')

    search = 'id=acc-2'
    await act(async () => root.render(<AccountDetailV8 />))
    await settle()
    expect(document.body.textContent).toContain('@nen-honten')
    const leftover = buttons('本人確認して保存')[0]
    if (leftover) await click(leftover)
    expect(sent.filter((s) => s.method === 'PUT')).toEqual([])
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    // B で開き直すと空の欄から始まる。
    await click(buttons('差し替える')[0])
    const fresh = [...document.querySelectorAll('[role="dialog"] input')] as HTMLInputElement[]
    expect(fresh.map((el) => el.value)).toEqual(['', ''])
  })

  it('差し替えの窓は対象のアカウントごとに作り直し、A の入力を B へ送らない（WEB132）', async () => {
    const accountB = { ...ACCOUNT, id: 'acc-2', name: '然-NEN-本店' }
    await act(async () => root.render(<CredentialsDialog account={ACCOUNT} kind="messaging" onClose={() => {}} onSaved={() => {}} />))
    await settle()
    const inputs = [...document.querySelectorAll('[role="dialog"] input')] as HTMLInputElement[]
    await type(inputs[0], 'secret-for-a')
    await act(async () => root.render(<CredentialsDialog account={accountB} kind="messaging" onClose={() => {}} onSaved={() => {}} />))
    await settle()
    const fresh = [...document.querySelectorAll('[role="dialog"] input')] as HTMLInputElement[]
    expect(fresh.map((el) => el.value)).toEqual(['', ''])
    await click(buttons('本人確認して保存')[0])
    expect(sent.filter((s) => s.method === 'PUT')).toEqual([])
  })

  it('A の遅い読込は、後から開いた B の画面を上書きしない（WEB132）', async () => {
    let release: () => void = () => {}
    gateA = new Promise<void>((resolve) => { release = resolve })
    await act(async () => root.render(<AccountDetailV8 />))
    await settle()
    search = 'id=acc-2'
    await act(async () => root.render(<AccountDetailV8 />))
    await settle()
    expect(document.body.textContent).toContain('@nen-honten')

    await act(async () => { release() })
    await settle()
    expect(document.body.textContent).toContain('@nen-honten')
    expect(document.body.textContent).not.toContain('@nen-test')
  })

  it('登録の編集は変えた欄だけ送り、オーナーはタイムゾーンも変えられる（PUT）', async () => {
    await act(async () => root.render(<AccountDetailV8 />))
    await settle()
    await click(buttons('編集する')[0])
    const tz = document.querySelector('[role="dialog"] input[value="Asia/Tokyo"]') as HTMLInputElement
    await type(tz, 'Europe/Paris')
    await click(buttons('保存する')[0])
    const put = sent.find((s) => s.url.endsWith('/api/line-accounts/acc-1'))
    expect(put?.method).toBe('PUT')
    expect(put?.body).toEqual({ timezone: 'Europe/Paris' })
  })

  it('名前を消し、警告を上限より大きくして保存すると、送らず2つの欄に理由を出し、名前の欄へ移る', async () => {
    await act(async () => root.render(<AccountDetailV8 />))
    await settle()
    await click(buttons('編集する')[0])
    const dialog = document.querySelector('[role="dialog"]')!
    const name = dialog.querySelector('input[required]') as HTMLInputElement
    await type(name, '')
    const cap = dialog.querySelector('input[placeholder="管理しない"]') as HTMLInputElement
    const warn = dialog.querySelector('input[placeholder="警告しない"]') as HTMLInputElement
    await type(cap, '100')
    await type(warn, '200')
    sent.length = 0
    await click(buttons('保存する')[0])
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(sent.some((s) => s.method === 'PUT')).toBe(false)
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(errorTextOf(name)).toBe('アカウント名を入れてください。')
    expect(warn.getAttribute('aria-invalid')).toBe('true')
    expect(errorTextOf(warn)).toContain('上限以下にしてください')
    expect(document.activeElement).toBe(name)
  })

  it('管理者（オーナーでない）にはタイムゾーンの欄を出さない', async () => {
    role = verifiedStaffRole('admin')
    await act(async () => root.render(<AccountDetailV8 />))
    await settle()
    await click(buttons('編集する')[0])
    expect(document.querySelector('[role="dialog"] input[value="Asia/Tokyo"]')).toBeNull()
  })

  it('止めたアカウントのアーカイブは、窓の中の6桁で本人確認してから送る', async () => {
    account = { ...ACCOUNT, isActive: false }
    await act(async () => root.render(<AccountDetailV8 />))
    await settle()
    expect(buttons('送受信を再開する')).toHaveLength(1)
    await click(buttons('アーカイブする')[0])
    const confirm = buttons('本人確認してアーカイブする')[0] as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    const slots = [...document.querySelectorAll('[role="dialog"] [role="group"] input')] as HTMLInputElement[]
    expect(slots).toHaveLength(6)
    for (const [index, slot] of slots.entries()) await type(slot, String(index + 1))
    await settle()
    expect(sent.find((s) => s.url.includes('/auth/step-up'))?.body).toMatchObject({ code: '123456', purpose: 'line_account.archive' })
    expect(sent.find((s) => s.url.endsWith('/archive'))?.stepUp).toBe('grant-1')
  })
})

describe('LINEアカウントの詳細の状態ごとの出し分け（V8 ihjfd）', () => {
  const renderDetail = async () => {
    await act(async () => root.render(<AccountDetailV8 />))
    await settle()
  }

  it('?id= で選んだアカウントを読み、資格情報と Webhook の見出しへ飛べる', async () => {
    search = 'id=acc-2'
    await renderDetail()
    expect(document.body.textContent).toContain('@nen-honten')
    const credentials = document.getElementById('acd-credentials')
    expect(credentials?.textContent).toBe('資格情報')
    expect(host.querySelector('[aria-labelledby="acd-credentials"]')).toBeTruthy()
    expect(document.getElementById('acd-webhook')?.textContent).toContain('Webhookの利用')
  })

  it('?id= なしで開くと、読み込みのままにせず一覧へ戻す口を出す', async () => {
    search = ''
    await renderDetail()
    expect(document.body.textContent).toContain('見るアカウントが指定されていません')
    expect(host.querySelector('a[href="/accounts"]')).toBeTruthy()
  })

  it('資格情報は値を出さず、登録・最後の確認だけを言う', async () => {
    account = { ...ACCOUNT, connection: { lastTestAt: '2026-10-01T21:00:00.000Z', lastTestStatus: 'ok', lastReceivedAt: '2026-10-02T03:04:00.000Z' } }
    await renderDetail()
    expect(document.body.textContent).toContain('秘密値そのものは表示しません')
    expect(document.body.textContent).toContain(`登録済み・最後の確認 ${shortDateTime('2026-10-01T21:00:00.000Z')}`)
    expect(document.body.textContent).toContain(`最後の受信 ${shortDateTime('2026-10-02T03:04:00.000Z')}`)
    expect(document.body.textContent).toContain('LINE側に登録したURL')
  })

  it('止める前に、何が止まって何が残るかを窓と注意で読ませる', async () => {
    await renderDetail()
    expect(document.body.textContent).toContain('停止しても、友だちと履歴は消えません')
    await click(buttons('送受信を止める')[0])
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('予約した配信は送られません')
    const label = [...(dialog?.querySelectorAll('label') ?? [])].find((el) => el.textContent?.startsWith('止める理由'))
    expect(label?.parentElement?.querySelector('[data-required-badge]'), '止める理由は必須の札つき').toBeTruthy()
  })

  it('止まっているアカウントは「再開する」になり、理由を必須にして自動で送り直さないと言う', async () => {
    account = { ...ACCOUNT, isActive: false }
    await renderDetail()
    expect(buttons('送受信を止める')).toHaveLength(0)
    await click(buttons('送受信を再開する')[0])
    const dialog = document.querySelector('[role="dialog"]')
    const label = [...(dialog?.querySelectorAll('label') ?? [])].find((el) => el.textContent?.startsWith('再開する理由'))
    expect(label?.parentElement?.querySelector('[data-required-badge]'), '再開する理由は必須の札つき').toBeTruthy()
    expect(dialog?.textContent).toContain('自動で送り直しません')
  })

  it('アーカイブ済みは「アーカイブから戻す」だけを出し、押すと戻す窓を開く', async () => {
    account = { ...ACCOUNT, isActive: false, archivedAt: '2026-10-01T00:00:00.000Z' }
    await renderDetail()
    expect(buttons('送受信を再開する')).toHaveLength(0)
    expect(buttons('アーカイブする')).toHaveLength(0)
    await click(buttons('アーカイブから戻す')[0])
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('アーカイブから戻す')
  })
})

describe('LINEアカウントの乗り換え（V8 x2dSNv）', () => {
  it('判断を書き換えると保存の帯が出て、本実行は押せない。閲覧のみには変える操作を出さない', async () => {
    await act(async () => root.render(<AccountHandoverV8 />))
    await settle()
    expect(document.body.textContent).toContain('乗り換え（然-NEN-TEST → 然-NEN-本店）')
    expect(document.body.textContent).toContain('未判断が 1 人残っています（要確認 2 人のうち 1 人を決めた）')
    expect(document.body.textContent).not.toContain('書き換えをまだ保存していません')
    await click(document.querySelector('[aria-label="見本 16の判断"]') as HTMLElement)
    await click(buttons('新しく作る')[0])
    expect(document.body.textContent).toContain('1 件の書き換えをまだ保存していません')
    const run = buttons('本実行する（あと 1 人）')[0] as HTMLButtonElement
    expect(run.disabled).toBe(true)
    await click(buttons('判断を保存する')[0])
    expect(sent.find((s) => s.url.endsWith('/decisions'))).toBeTruthy()
  })

  it('閲覧のみには判断の選択・やめる・本実行を出さない', async () => {
    role = verifiedStaffRole('staff')
    await act(async () => root.render(<AccountHandoverV8 />))
    await settle()
    expect(document.querySelector('[aria-label="見本 16の判断"]')).toBeNull()
    expect(buttons('引き継ぎをやめる')).toHaveLength(0)
    expect(buttons('本実行する（あと 1 人）')).toHaveLength(0)
    expect(document.body.textContent).toContain('閲覧のみで見ています')
  })
})

describe('言葉', () => {
  it('資格情報の1行は、値を出さず登録・末尾・確認・更新だけ', () => {
    expect(credentialLine({ configured: false })).toBe('未登録')
    expect(credentialLine({ configured: true, last4: 'x9Qa', updatedAt: '2026-09-28T01:10:00.000Z' })).toBe('登録済み・末尾 …x9Qa・更新 09/28')
    expect(credentialLine({ configured: true, checkedAt: '2026-10-01T21:00:00.000Z' })).toBe('登録済み・最後の確認 10/02 06:00')
  })
  it('題の下の1行は、確認が通っていれば「正常」', () => {
    const ok = { ...ACCOUNT, connection: { lastTestStatus: 'succeeded' } }
    expect(summaryLine(ok, null)).toBe('@nen-test・正常・既定ではない・親アカウントなし')
    expect(summaryLine({ ...ok, parentLineAccountId: 'acc-2', isDefault: true }, '本店')).toBe('@nen-test・正常・既定のアカウント・親アカウント 本店')
  })
  it('乗り換えの段と数', () => {
    expect(handoverPill('linked')).toBe(2)
    expect(handoverPill('previewed')).toBe(3)
    expect(handoverPill('resolved')).toBe(4)
    expect(totalsMatch({ auto: 10, review: 2, unmatched: 1, lookalike: 1 }, 14)).toBe(true)
    expect(totalsMatch({ auto: 10, review: 2, unmatched: 1, lookalike: 1 }, 15)).toBe(false)
    expect(countsLine({ sourceTotal: 12, auto: 10, review: 0, unmatched: 2, lookalike: 0 })).toBe('元の友だち 12 人：自動で同じ人 10・要確認 0・一致しない 2')
  })
})

afterEach(() => { verifiedStaffRole(null) })
