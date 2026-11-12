// @vitest-environment happy-dom
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'
import { attentionFixture } from '@/test-utils/hq-attention-fixture'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { flushListUrlState } from '@/components/shared/list-url-state'
/*
 * V8 統括のアカウント（src/v8/hq/home.tsx）の動きの試験。
 * LINE ID の @ を二重にしない、要確認のカードに引っかかった確認の言葉を出す（全文は title）、
 * 閲覧のみには「更新する」を灰色と理由付きで置く。
 * 「入る」は押すと引き継ぎの状態を確かめ、終わっていれば店へ進み、
 * 未完了・確認失敗なら登録時と同じ進捗画面へ戻す。
 */
import React, { act } from 'react'
import { queryByRole } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const heldFolderConfirm = vi.hoisted(() => ({ current: null as null | (() => unknown) }))
vi.mock('@/components/shared/confirm-dialog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && props.description.startsWith('中のアカウント') && props.onConfirm) heldFolderConfirm.current = props.onConfirm
    return <actual.default {...props} />
  } }
})
const attention = vi.hoisted(() => vi.fn())
const accountFolders = vi.hoisted(() => vi.fn())
const removeAccountFolder = vi.hoisted(() => vi.fn(async () => ({ success: true, data: null })))
const accounts = vi.hoisted(() => vi.fn())
const checkConnection = vi.hoisted(() => vi.fn())
const importState = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
const select = vi.hoisted(() => vi.fn())
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const restoreApi = vi.hoisted(() => vi.fn())
const restoreCallbacks = vi.hoisted(() => ({ card: [] as Array<() => void>, table: [] as Array<() => void> }))

vi.mock('@/lib/api/helpers/styles', () => ({ hqStyleApi: { attention } }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchApi: checkConnection,
    api: {
      ...actual.api,
      lineAccounts: { ...actual.api.lineAccounts, list: accounts, followerImportState: importState, restore: restoreApi },
      lineAccountFolders: { ...actual.api.lineAccountFolders, list: accountFolders, remove: removeAccountFolder },
      tenants: { ...actual.api.tenants, me: vi.fn(async () => ({ success: true, data: { name: '然 -NEN-' } })) },
    },
  }
})
vi.mock('@/components/shared/button', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/shared/button')>()
  return { ...actual, AccountActionButton: (props: React.ComponentProps<typeof actual.AccountActionButton>) => {
    if (props.action === 'restore' && props.onClick) {
      const click = props.onClick
      restoreCallbacks.card.push(() => click({} as React.MouseEvent<HTMLButtonElement>))
    }
    return <actual.AccountActionButton {...props} />
  } }
})
vi.mock('@/components/shared/row-actions', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/shared/row-actions')>()
  return { ...actual, RowMenu: (props: React.ComponentProps<typeof actual.RowMenu>) => {
    const restore = props.items.find(item => item.id === 'restore')?.onSelect
    if (restore) restoreCallbacks.table.push(restore)
    return <actual.RowMenu {...props} />
  } }
})
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/hq',
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/components/hq/platform-notices', () => ({ default: () => null }))
vi.mock('@/lib/staff-role', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/staff-role')>(), useStaffRole: () => role.value }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ accounts: [], setSelectedAccountId: select, refreshAccounts: async () => {} }),
}))

import HqHomeV8 from './home'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const warnedAccount = {
  id: 'acc-1', revision: 1, channelId: '2000000001', name: '然 -NEN- TEST', displayName: '然 -NEN- TEST',
  basicId: '@273ytrca', isActive: true, country: null, role: null, displayOrder: 0, archivedAt: null, tags: [],
  stats: { friendCount: 3, activeScenarios: 0, messagesThisMonth: 0, staffCount: 1 },
  connection: {
    status: 'warn', checkedAt: '2026-10-07T10:00:00+09:00', tokenExpired: false,
    issues: [{
      kind: 'webhook_endpoint', result: 'mismatched', expectedUrl: 'https://stg-api.musubo.jp/webhook',
      registeredUrl: 'https://old.example.test/webhook', webhookActive: true, httpStatus: 200,
    }],
  },
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  accountFolders.mockResolvedValue({ success: true, data: { folders: [], total: 0, unclassifiedCount: 0 } })
  attention.mockReset()
  attention.mockResolvedValue({ success: true, data: { items: [{ accountId: 'acc-1', counts: { connections: 2, unhandledChats: 5, pendingBookings: 0, unpaid: 0, stoppedDeliveries: 0 } }] } })
  accounts.mockResolvedValue({ success: true, data: [warnedAccount] })
  checkConnection.mockReset()
  checkConnection.mockResolvedValue({ success: true, data: {} })
  importState.mockReset()
  importState.mockResolvedValue({ success: true, data: { phase: 'completed' } })
  push.mockReset()
  select.mockReset()
  role.value = 'owner'
})

afterEach(() => {
  act(() => root.unmount())
  flushListUrlState()
  window.history.replaceState(null, '', '/hq')
  container.remove()
  verifiedStaffRole(null)
})

async function render() {
  verifiedStaffRole(role.value)
  await act(async () => { root.render(<HqHomeV8 />) })
  await act(async () => { await Promise.resolve() })
}

it('閉じた統括アカウントフォルダの古い確定は削除しない', async () => {
  removeAccountFolder.mockClear()
  accountFolders.mockResolvedValue({ success: true, data: { folders: [{ id: 'folder-a', name: '確認用フォルダ', displayOrder: 0, color: null, itemCount: 1 }], total: 1, unclassifiedCount: 0 } })
  await render()
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="フォルダ「確認用フォルダ」の操作"]')!.click() })
  await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent?.trim() === '消す')!.click() })
  const held = heldFolderConfirm.current!
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(el => el.textContent?.trim() === 'キャンセル')!.click() })
  await act(async () => { await held() })
  expect(removeAccountFolder).not.toHaveBeenCalled()
})

it('統括アカウントのフォルダ削除前に環境と対象の不確実さを示す', async () => {
  accountFolders.mockResolvedValue({ success: true, data: { folders: [{ id: 'folder-a', name: '確認用フォルダ', displayOrder: 0, color: null, itemCount: 1 }], total: 1, unclassifiedCount: 0 } })
  await render()
  const action = container.querySelector<HTMLButtonElement>('[aria-label="フォルダ「確認用フォルダ」の操作"]')!
  await act(async () => { action.click() })
  const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent?.trim() === '消す')!
  await act(async () => { remove.click() })
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('環境')
  expect(dialog.textContent).toContain('未分類へ移るアカウントの名前を確認できません')
})

it('表の対応が要る件数は同じアカウントの全種類の合計を表示する', async () => {
  await render()
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="表"]')!.click() })
  const row = container.querySelector('tbody tr')!
  expect(row.children[3].textContent).toContain('7 件')
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="カード"]')!.click() })
})

it('対応一覧と同じ口の５種類を合計する', async () => {
  attention.mockResolvedValue({ success: true, data: { items: [attentionFixture] } })
  await render()
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="表"]')!.click() })
  expect(container.querySelector('tbody tr')!.children[3].textContent).toContain('15 件')
})

it('対応が要る数が０件なら、１件に補正しない', async () => {
  attention.mockResolvedValue({ success: true, data: { items: [{ ...attentionFixture, counts: { unhandledChats: 0, pendingBookings: 0, unpaid: 0, connections: 0, stoppedDeliveries: 0 } }] } })
  await render()
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="表"]')!.click() })
  expect(container.querySelector('tbody tr')!.children[3].textContent).toContain('0 件')
})

it('対応が要る数に欠けた種類がある場合は合計を不明にする', async () => {
  attention.mockResolvedValue({ success: true, data: { items: [{ accountId: 'acc-1', counts: { connections: 2 } }] } })
  await render()
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="表"]')!.click() })
  expect(container.querySelector('tbody tr')!.children[3].textContent).not.toContain('2 件')
})

it('対応一覧の取得失敗は 0 件とせず不明を示す', async () => {
  attention.mockRejectedValue(new Error('offline'))
  await render()
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="表"]')!.click() })
  expect(container.querySelector('tbody tr')!.children[3].textContent).not.toContain('0 件')
  expect(container.textContent).toContain('対応件数：表示できませんでした')
  expect(container.textContent).not.toContain('機能設定')
  attention.mockResolvedValue({ success: true, data: { items: [{ accountId: 'acc-1', counts: { unhandledChats: 1, pendingBookings: 0, unpaid: 0, connections: 0, stoppedDeliveries: 0 } }] } })
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'もう一度読み込む')!.click() })
  expect(container.querySelector('tbody tr')!.children[3].textContent).toContain('1 件')
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="カード"]')!.click() })
})

it('対応件数が権限不足なら管理者への案内を出し再試行しない', async () => {
  attention.mockRejectedValue({ status: 403 })
  await render()
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="表"]')!.click() })
  expect(container.textContent).toContain('統括の管理者に頼んでください')
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'もう一度読み込む')).toBe(false)
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="カード"]')!.click() })
})

it('対応一覧に対象アカウントが無い場合は別店舗の件数を表示しない', async () => {
  attention.mockResolvedValue({ success: true, data: { items: [{ accountId: 'another', counts: { unhandledChats: 9, pendingBookings: 0, unpaid: 0, connections: 0, stoppedDeliveries: 0 } }] } })
  await render()
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="表"]')!.click() })
  const count = container.querySelector('tbody tr')!.children[3].textContent
  expect(count).not.toContain('9 件')
  expect(count).not.toContain('0 件')
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="カード"]')!.click() })
})

it('接続情報を更新したら対応件数も取り直す', async () => {
  attention.mockResolvedValueOnce({ success: true, data: { items: [{ accountId: 'acc-1', counts: { unhandledChats: 0, pendingBookings: 0, unpaid: 0, connections: 1, stoppedDeliveries: 0 } }] } })
    .mockResolvedValue({ success: true, data: { items: [{ accountId: 'acc-1', counts: { unhandledChats: 0, pendingBookings: 0, unpaid: 0, connections: 0, stoppedDeliveries: 0 } }] } })
  await render()
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === '更新する')!.click() })
  await act(async () => { await Promise.resolve() })
  expect(attention.mock.calls.length).toBeGreaterThanOrEqual(2)
  expect(attention).toHaveBeenLastCalledWith({ cache: 'reload' })
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="表"]')!.click() })
  expect(container.querySelector('tbody tr')!.children[3].textContent).toContain('0 件')
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="カード"]')!.click() })
})

it('更新中に古い対応件数が届いても表示しない', async () => {
  let resolveOld!: (value: unknown) => void
  let resolveUpdate!: (value: unknown) => void
  attention.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    .mockResolvedValue({ success: true, data: { items: [{ accountId: 'acc-1', counts: { unhandledChats: 0, pendingBookings: 0, unpaid: 0, connections: 0, stoppedDeliveries: 0 } }] } })
  checkConnection.mockImplementationOnce(() => new Promise(resolve => { resolveUpdate = resolve }))
  await render()
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === '更新する')!.click() })
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="表"]')!.click() })
  await act(async () => { resolveOld({ success: true, data: { items: [{ accountId: 'acc-1', counts: { unhandledChats: 9, pendingBookings: 0, unpaid: 0, connections: 0, stoppedDeliveries: 0 } }] } }) })
  expect(container.querySelector('tbody tr')!.children[3].textContent).toBe('—')
  await act(async () => { resolveUpdate({ success: true }) })
  expect(container.querySelector('tbody tr')!.children[3].textContent).toContain('0 件')
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="カード"]')!.click() })
})

describe('統括のアカウント', () => {
  it('カードの入口は短い「入る」にし、読み上げにはアカウント名を残す', async () => {
    await render()
    const enter = container.querySelector('button[aria-label="然 -NEN- TEST へ入る"]')!
    expect(enter.textContent).toBe('入る')
  })
  it('LINE ID の @ を二重にしない', async () => {
    await render()
    const card = container.querySelector('article')!
    expect(card.textContent).toContain('@273ytrca')
    expect(card.textContent).not.toContain('@@')
  })

  it('要確認のカードは、引っかかった確認の言葉を出し、全文を title に持つ', async () => {
    await render()
    const card = container.querySelector('article')!
    const reason = card.querySelector('[title*="old.example.test"]')
    expect(reason?.textContent).toContain('Webhook の URL がこの環境と違います')
    const band = reason!.closest('[data-design-part="notice"]')!
    expect(band.closest('article')).toBe(card)
    expect(card.querySelector('dl')!.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(band.compareDocumentPosition(card.querySelector('button[aria-label$="へ入る"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(band.querySelector('[data-notice-dot]')).toBeTruthy()
    expect(card.textContent).not.toContain('LINE ID・接続状態を確かめてください')
    expect([...card.querySelectorAll('button')].some((button) => button.textContent === '更新する')).toBe(true)
  })

  it('正常のカードには理由の帯を出さない', async () => {
    accounts.mockResolvedValue({ success: true, data: [{ ...warnedAccount, connection: { status: 'ok', issues: [] } }] })
    await render()
    expect(container.querySelector('article [data-design-part="notice"]')).toBeNull()
  })

  it('期限切れのカードは知らせ1つにまとめ、素の期限の文字を出さない', async () => {
    accounts.mockResolvedValue({ success: true, data: [{ ...warnedAccount, tokenExpiry: { status: 'expired', label: 'トークンの期限が切れています' } }] })
    await render()
    const card = container.querySelector('article')!
    const notices = card.querySelectorAll('[data-design-part="notice"]')
    expect(notices).toHaveLength(1)
    expect(notices[0].textContent).toContain('LINE のトークンの期限が切れています')
    expect(notices[0].textContent).toContain('ほかに接続の確認事項が1件')
    expect(card.querySelector('[title="トークンの期限が切れています"]')).toBeNull()
  })

  it('期限が近いだけのカードも同じ形の知らせを1つ出す', async () => {
    accounts.mockResolvedValue({ success: true, data: [{ ...warnedAccount, connection: { status: 'ok', issues: [] }, tokenExpiry: { status: 'expiring', label: 'トークンの期限が近づいています' } }] })
    await render()
    const card = container.querySelector('article')!
    const notices = card.querySelectorAll('[data-design-part="notice"]')
    expect(notices).toHaveLength(1)
    expect(notices[0].textContent).toContain('LINE のトークンの期限が近づいています')
    expect(card.querySelector('[title="トークンの期限が近づいています"]')).toBeNull()
  })

  it('一覧の上の期限の行は共通の知らせで出す', async () => {
    accounts.mockResolvedValue({ success: true, data: [
      { ...warnedAccount, tokenExpiry: { status: 'expired', label: 'トークンの期限が切れています' } },
      { ...warnedAccount, id: 'acc-2', name: '二号店', displayName: '二号店', connection: { status: 'ok', issues: [] }, tokenExpiry: { status: 'expiring', label: 'トークンの期限が近づいています' } },
    ] })
    await render()
    const bands = [...container.querySelectorAll('[data-design-part="notice"]')]
      .filter((band) => !band.closest('article'))
    expect(bands).toHaveLength(1)
    expect(bands[0].textContent).toContain('期限切れ 1 件・期限が近い 1 件')
    expect(bands[0].textContent).toContain('表示中のLINE接続の期限（接続に問題とは別の数え方）')
  })

  it('期限の案内は検索結果とアーカイブの一覧に合わせる', async () => {
    accounts.mockResolvedValue({ success: true, data: [
      { ...warnedAccount, tokenExpiry: { status: 'expired', label: '期限切れ' } },
      { ...warnedAccount, id: 'acc-2', name: '二号店', displayName: '二号店', tokenExpiry: { status: 'expiring', label: '期限が近い' } },
      { ...warnedAccount, id: 'acc-3', archivedAt: '2026-10-01', tokenExpiry: { status: 'expired', label: '期限切れ' } },
    ] })
    await render()
    const search = container.querySelector<HTMLInputElement>('input[placeholder="名前・LINE ID・フォルダで探す"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '二号店')
      search.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 350))
    })
    expect(container.textContent).toContain('期限が近い 1 件')
    expect(container.textContent).not.toContain('期限切れ 1 件')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '')
      search.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 350))
    })
    const archive = [...container.querySelectorAll('button')].find(el => el.textContent?.startsWith('アーカイブ'))!
    await act(async () => { archive.click() })
    expect(container.textContent).not.toContain('期限切れ 1 件')
    expect(container.textContent).not.toContain('期限が近い 1 件')
  })

  it('表の LINE 接続は状態の札に期限の札を添え、素の期限の文字を出さない', async () => {
    accounts.mockResolvedValue({ success: true, data: [{ ...warnedAccount, tokenExpiry: { status: 'expired', label: 'トークンの期限が切れています' } }] })
    await render()
    const table = container.querySelector<HTMLButtonElement>('button[aria-label="表"]')!
    await act(async () => { table.click() })
    const row = container.querySelector('tbody tr')!
    expect(row.textContent).toContain('期限切れ')
    expect(row.textContent).not.toContain('トークンの期限が切れています')
    window.history.replaceState(null, '', '/hq')
  })

  it('分類のないカードではLINE IDの情報の次に数を読み、正常ならそのまま操作へ進める', async () => {
    accounts.mockResolvedValue({ success: true, data: [{ ...warnedAccount, connection: { status: 'ok', issues: [] } }] })
    await render()
    const card = container.querySelector('article')!
    const stats = card.querySelector('dl')!
    expect(card.querySelector('[data-tag-overflow]')).toBeNull()
    expect(stats.previousElementSibling?.textContent).toContain('@273ytrca')
    expect(stats.nextElementSibling).toBeNull()
    expect(card.querySelector('button[aria-label$="へ入る"]')).not.toBeNull()
  })

  it('「入る」を押すと引き継ぎの状態を確かめ、終わっていればそのアカウントを覚えて店へ進む', async () => {
    await render()
    const enter = container.querySelector<HTMLButtonElement>('button[aria-label="然 -NEN- TEST へ入る"]')!
    await act(async () => { enter.click() })
    await act(async () => { await Promise.resolve() })
    expect(importState).toHaveBeenCalledWith('acc-1')
    expect(select).toHaveBeenCalledWith('acc-1')
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0][0]).toBe('/')
  })

  it('引き継ぎ中は店舗を選択せず登録時と同じ進捗画面へ戻す', async () => {
    importState.mockResolvedValue({ success: true, data: { phase: 'importing_ids' } })
    await render()
    const enter = container.querySelector<HTMLButtonElement>('button[aria-label="然 -NEN- TEST へ入る"]')!
    await act(async () => { enter.click() })
    await act(async () => { await Promise.resolve() })
    expect(importState).toHaveBeenCalledWith('acc-1')
    expect(push).toHaveBeenCalledWith('/accounts/new/handover?accountId=acc-1')
    expect(select).not.toHaveBeenCalled()
  })

  it('引き継ぎ状態を読めないときも進捗画面へ戻し、次は止まらない', async () => {
    importState.mockRejectedValueOnce(new Error('worker unavailable'))
    await render()
    const enter = container.querySelector<HTMLButtonElement>('button[aria-label="然 -NEN- TEST へ入る"]')!
    await act(async () => { enter.click() })
    await act(async () => { await Promise.resolve() })
    expect(push).toHaveBeenCalledWith('/accounts/new/handover?accountId=acc-1')
    expect(select).not.toHaveBeenCalled()
    importState.mockResolvedValue({ success: true, data: { phase: 'completed' } })
    await act(async () => { enter.click() })
    await act(async () => { await Promise.resolve() })
    expect(select).toHaveBeenCalledWith('acc-1')
  })

  it('閲覧のみでも引き継ぎが終わっていれば入れる（状態の確認は読み取りだけ）', async () => {
    role.value = 'viewer'
    await render()
    const enter = container.querySelector<HTMLButtonElement>('button[aria-label="然 -NEN- TEST へ入る"]')!
    await act(async () => { enter.click() })
    await act(async () => { await Promise.resolve() })
    expect(importState).toHaveBeenCalledWith('acc-1')
    expect(select).toHaveBeenCalledWith('acc-1')
  })

  it('カードの更新は押した1件だけに送り、失敗したアカウント名を伝える', async () => {
    accounts.mockResolvedValue({ success: true, data: [warnedAccount, { ...warnedAccount, id: 'acc-2', name: '二号店', displayName: '二号店' }] })
    checkConnection.mockRejectedValueOnce(new Error('network'))
    await render()
    const card = [...container.querySelectorAll('article')].find(item => item.textContent?.includes('二号店'))!
    const update = [...card.querySelectorAll('button')].find(button => button.textContent === '更新する')!
    await act(async () => { update.click() })
    expect(checkConnection).toHaveBeenCalledTimes(1)
    expect(checkConnection).toHaveBeenCalledWith('/api/line-accounts/acc-2/connection-checks', expect.objectContaining({ method: 'POST' }))
    expect(container.textContent).toContain('二号店の接続情報を更新できませんでした。')
  })

  it('更新して正常になったカードの警告は再読込の結果に合わせて消す', async () => {
    await render()
    accounts.mockResolvedValue({ success: true, data: [{ ...warnedAccount, connection: { status: 'ok', issues: [] } }] })
    const update = [...container.querySelector('article')!.querySelectorAll('button')].find(button => button.textContent === '更新する')!
    await act(async () => { update.click() })
    expect(container.querySelector('article [data-design-part="notice"]')).toBeNull()
    expect(container.querySelector('article')!.textContent).toContain('正常')
  })

  it('閲覧のみにはNoticeの更新を灰色と理由付きで置き、変更しない', async () => {
    role.value = 'viewer'
    await render()
    const card = container.querySelector('article')!
    const update = [...card.querySelectorAll('button')].find(button => button.textContent === '更新する')!
    expect(update.getAttribute('aria-disabled')).toBe('true')
    await act(async () => { update.click(); update.focus() })
    expect(checkConnection).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('閲覧のみ')
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '全部を更新')).toBe(false)
  })
  it.each(['owner', 'admin', 'viewer'])('アカウントの用途文から権限を推測せず、現在の人%sで設定の入口を決める', async viewerRole => {
    role.value = viewerRole
    accounts.mockResolvedValue({ success: true, data: [{ ...warnedAccount, role: '本店の配信に使う', connection: { status: 'ok', issues: [] } }] })
    await render()
    expect(container.querySelector('button[aria-label$="の設定"]') !== null).toBe(viewerRole !== 'viewer')
  })



  it('接続に問題の数は対応が要るものの接続の絞り込みへ進める', async () => {
    await render()
    const link = [...container.querySelectorAll('a')].find((anchor) => anchor.textContent?.includes('対応が要るものへ'))!
    expect(link.getAttribute('href')).toBe('/hq/attention?kind=connections')
  })

  it('閲覧のみでも所属とタグを読め、権限者を含む補足の全文へ届く', async () => {
    role.value = 'viewer'
    accounts.mockResolvedValue({ success: true, data: [{ ...warnedAccount, folderId: 'area', folder: { name: '渋谷エリア', color: '#0088ff' }, tags: [{ id: 'main', name: '本店', color: '#0088ff' }], stats: { ...warnedAccount.stats, staffCount: 4 } }] })
    await render()
    const card = container.querySelector('article')!
    expect(card.querySelector('[aria-label="フォルダ：渋谷エリア"]')).not.toBeNull()
    expect(card.querySelector('[aria-label="タグ「本店」"]')).not.toBeNull()
    expect(card.textContent).toContain('権限者 4 人')
    expect([...card.querySelectorAll('button')].some(button => button.textContent === '設定')).toBe(false)
  })
})

it('フォルダがタグにも返っても札は一つで、アーカイブの詳細には矢印を出さない', async () => {
  accounts.mockResolvedValue({ success: true, data: [{ ...warnedAccount, archivedAt: '2026-10-01', folderId: 'area', folder: { name: '渋谷エリア', color: '#0088ff' }, tags: [{ id: 'same', name: '渋谷エリア', color: '#0088ff' }, { id: 'other', name: '本店' }] }] })
  await render()
  const archiveFilter = [...container.querySelectorAll('button')].find(el => el.textContent?.startsWith('アーカイブ'))!
  await act(async () => { archiveFilter.click() })
  const card = container.querySelector('article')!
  const labels = [...card.querySelectorAll('[data-icon-label], [role="group"]')].filter(el => !el.closest('[aria-hidden="true"]') && el.textContent === '渋谷エリア')
  expect(labels).toHaveLength(1)
  const edit = [...card.querySelectorAll('button')].find(el => el.textContent === '登録内容を編集')!
  expect(edit).toBeTruthy()
  expect(edit.querySelectorAll('svg')).toHaveLength(1)
  expect([...card.querySelectorAll('button')].some(el => el.textContent === '詳細')).toBe(false)
  expect([...card.querySelectorAll('button')].find(el => el.textContent === '戻す')?.querySelector('svg')).not.toBeNull()
})


it.each([
  { archived: true, friends: 0, expected: '—' },
  { archived: true, friends: 5, expected: '5' },
  { archived: true, friends: undefined, expected: '—' },
  { archived: false, friends: 0, expected: '0' },
])('友だち数をカードと表で同じ基準にする：$archived / $friends', async ({ archived, friends, expected }) => {
  accounts.mockResolvedValue({ success: true, data: [{ ...warnedAccount, archivedAt: archived ? '2026-10-01' : null, stats: { ...warnedAccount.stats, friendCount: friends } }] })
  await render()
  if (archived) {
    const filter = [...container.querySelectorAll('button')].find(el => el.textContent?.startsWith('アーカイブ'))!
    await act(async () => { filter.click() })
  }
  const card = container.querySelector('article')!
  const friendLabel = [...card.querySelectorAll('dt')].find(el => el.textContent === '友だち')!
  expect(friendLabel.nextElementSibling?.textContent).toBe(expected)
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="表"]')!.click() })
  expect(container.querySelectorAll('tbody tr td')[4]?.textContent).toBe(expected)
})

it.each([
  { staffCount: undefined, label: '権限者 —' },
  { staffCount: 0, label: '権限者 0 人' },
])('権限者数の未取得と本当の0人をカードと表で分ける：$label', async ({ staffCount, label }) => {
  window.history.replaceState(null, '', '/hq')
  accounts.mockResolvedValue({ success: true, data: [{ ...warnedAccount, stats: { ...warnedAccount.stats, staffCount } }] })
  await render()
  const card = container.querySelector('article')!
  expect(card.textContent).toContain(label)
  expect(card.querySelector('[title*="権限者"]')?.getAttribute('title')).toContain(label)
  if (staffCount === undefined) expect(card.textContent).not.toContain('権限者 0 人')
  const table = container.querySelector<HTMLButtonElement>('button[aria-label="表"]')!
  await act(async () => { table.click() })
  const row = container.querySelector('tbody tr')!
  expect(row.textContent).toContain(label)
  expect(row.querySelector('[title*="権限者"]')?.getAttribute('title')).toContain(label)
})


describe('アーカイブから戻す入口の権限表示', () => {
  beforeEach(() => {
    restoreCallbacks.card.length = 0
    restoreCallbacks.table.length = 0
    restoreApi.mockReset()
    accounts.mockResolvedValue({ success: true, data: [{ ...warnedAccount, name: '架空の保管店', displayName: '架空の保管店', archivedAt: '2026-10-01', connection: { status: 'ok', issues: [] } }] })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, data: {} })))
    forgetSessionSnapshot()
  })
  afterEach(() => {
    act(() => { forgetSessionSnapshot() })
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', '/hq')
  })
  const restoredDialog = () => document.querySelector('[role="dialog"]')
  const restoreControl = () => (queryByRole(document.body, 'button', { name: '戻す' }) ?? queryByRole(document.body, 'menuitem', { name: '戻す' })) as HTMLButtonElement | null
  const noWrites = () => {
    expect(restoreApi).not.toHaveBeenCalled()
    expect(checkConnection.mock.calls.some(([, options]) => options?.method && options.method !== 'GET')).toBe(false)
    expect(vi.mocked(fetch).mock.calls.some(([, options]) => options?.method && options.method !== 'GET')).toBe(false)
  }
  async function openArchived(layout: 'card' | 'table') {
    await render()
    const archive = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('アーカイブ'))!
    expect(archive).toBeTruthy()
    await act(async () => { archive.click() })
    await act(async () => { container.querySelector<HTMLButtonElement>(layout === 'card' ? 'button[aria-label="カード"]' : 'button[aria-label="表"]')!.click() })
    if (layout === 'table') {
      await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="架空の保管店の操作"]')!.click() })
    }
  }
  for (const layout of ['card', 'table'] as const) {
    it(`${layout}の管理者にはオーナー限定の理由を示し、窓も変更要求も増やさない`, async () => {
      role.value = 'admin'
      await openArchived(layout)
      const restore = restoreControl()!
      expect(restore).toBeTruthy()
      expect(restore.getAttribute('aria-disabled')).toBe('true')
      expect(restore.hasAttribute('data-permission-locked')).toBe(true)
      const ids = (restore.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
      expect(ids.map(id => document.getElementById(id)?.textContent)).toEqual([PERMISSION_LOCK_REASON.owner])
      await act(async () => { restore.focus() })
      const tips = [...document.querySelectorAll('[role="tooltip"]')]
      expect(tips).toHaveLength(1)
      expect(tips[0].textContent).toBe(PERMISSION_LOCK_REASON.owner)
      await act(async () => { restore.click() })
      expect(restoredDialog()).toBeNull()
      await act(async () => { restoreCallbacks[layout].at(-1)!() })
      expect(restoredDialog()).toBeNull()
      noWrites()
    })
    it(`${layout}のオーナーは従来の本人確認の窓を開ける`, async () => {
      await openArchived(layout)
      const restore = restoreControl()!
      expect(restore).toBeTruthy()
      expect(restore.getAttribute('aria-disabled')).toBeNull()
      await act(async () => { restore.click() })
      expect(restoredDialog()?.textContent).toContain('「架空の保管店」をアーカイブから戻しますか？')
      expect(restoredDialog()?.textContent).toContain('本人確認して戻す')
      expect(restoredDialog()?.textContent).toContain('戻した直後は「止まっている」状態です。')
      noWrites()
    })
    it.each(['viewer', 'staff', null, 'read-proxy'] as const)(`${layout}の%sには復元入口を新設しない`, async staffRole => {
      role.value = staffRole === 'read-proxy' ? 'owner' : staffRole
      if (staffRole === 'read-proxy') rememberSessionSnapshot({ impersonation: { id: 'archive-read', tenantId: 'fixture-tenant', mode: 'read', piiRevealed: false, startedAt: '' }, unfamiliarAt: null, stepUpMethod: 'none' })
      await openArchived(layout)
      expect(restoreControl()).toBeNull()
      expect(restoreCallbacks[layout]).toHaveLength(0)
      expect(restoredDialog()).toBeNull()
      noWrites()
    })
    it.each(['admin', 'read-proxy'] as const)(`${layout}の古いオーナー操作は%sへ変わると窓を開かない`, async nextRole => {
      await openArchived(layout)
      const oldControl = restoreControl()!
      const oldCallback = restoreCallbacks[layout].at(-1)!
      expect(oldControl).toBeTruthy()
      expect(oldCallback).toBeTypeOf('function')
      await act(async () => {
        if (nextRole === 'admin') role.value = verifiedStaffRole('admin')
        else rememberSessionSnapshot({ impersonation: { id: 'archive-read', tenantId: 'fixture-tenant', mode: 'read', piiRevealed: false, startedAt: '' }, unfamiliarAt: null, stepUpMethod: 'none' })
        root.render(<HqHomeV8 />)
      })
      await act(async () => { oldControl.click(); oldCallback() })
      expect(restoredDialog()).toBeNull()
      expect(Boolean(restoreControl())).toBe(nextRole === 'admin')
      noWrites()
    })
  }
})

it('表の対応件数は対応が要る全種類を数える', async () => {
  await render()
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="表"]')!.click() })
  expect(container.querySelector('tbody tr')!.children[3].textContent).toContain('7 件')
})

it('接続の件数が取得できないとき不明とし、再読込できる', async () => {
  attention.mockRejectedValue(new Error('offline'))
  await render()
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="表"]')!.click() })
  expect(container.querySelector('tbody tr')!.children[3].textContent).not.toContain('0 件')
  expect(container.textContent).toContain('対応件数：表示できませんでした')
  attention.mockResolvedValue({ success: true, data: { items: [{ accountId: 'acc-1', counts: { connections: 2, unhandledChats: 0, pendingBookings: 0, unpaid: 0, stoppedDeliveries: 0 } }] } })
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'もう一度読み込む')!.click() })
  expect(container.querySelector('tbody tr')!.children[3].textContent).toContain('2 件')
})

it('接続の問題の帯は接続のみ、表は全種類の合計を出す', async () => {
  await render()
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="表"]')!.click() })
  const band = [...container.querySelectorAll('[data-kpi-presentation]')].find(el => el.textContent?.includes('接続に問題'))
  expect(band?.textContent).toMatch(/2\s*件/)
  expect(container.querySelector('tbody tr')!.children[3].textContent).toContain('7 件')
  expect(container.querySelector('thead')!.textContent).toContain('対応が要る')
})

it('接続の問題を取得できないとき、帯も不明として0件にしない', async () => {
  attention.mockRejectedValue(new Error('offline'))
  await render()
  const band = [...container.querySelectorAll('[data-kpi-presentation]')].find(el => el.textContent?.includes('接続に問題'))
  expect(band?.textContent).toContain('読み込めませんでした')
  expect(band?.textContent).not.toMatch(/0\s*件/)
})
