// @vitest-environment happy-dom
/*
 * ★V8 （A-2 採用）受信箱の右の欄でその場で直す：本物の右の欄（FriendInfoSidebar）と
 * 共通の知らせ（ToastHost）を描き、口（api）だけを差し替える。
 * - 対応状況：選んだ瞬間に変えて裏で保存（版を送らない＝その項目だけ変える）→［元に戻す］で前の状態を送る
 * - 失敗：画面を戻し、理由と［もう一度試す］
 * - メモの同時編集：版がずれたら読み直し、相手がメモ以外を直しただけなら黙って保存し直す。
 *   メモも直されていたら、あとから直したこちらを残して知らせ、［元に戻す］で相手のメモに戻せる
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', async original => ({ ...await original<typeof import('next/navigation')>(), useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))

const mocks = vi.hoisted(() => ({
  role: 'owner',
  update: vi.fn(),
  get: vi.fn(),
  addTag: vi.fn(),
  removeTag: vi.fn(),
  orders: vi.fn(),
  metadata: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  const ok = <T,>(data: T) => Promise.resolve({ success: true as const, data })
  return {
    ...actual,
    api: {
      staff: { me: async () => ({ success: true, data: { role: mocks.role, permissionViewKeys: ['/chats', '/friends'] } }) },
      friends: {
        get: (id: string) => ok({
          id, originalId: 'friend-0', displayName: 'Kyohei Yamamoto', pictureUrl: null, isFollowing: true, metadata: {},
          realName: '山本 恭平', systemDisplayName: null, refCode: null, firstTrackedLinkName: null,
          createdAt: '2025-08-13T15:00:00.000Z', formSubmissions: [], formSubmissionTotal: 0,
          tags: [{ id: 'tag-a', name: '未契約', color: '#8B938D' }],
        }),
        mileage: () => ok({ summary: { programName: 'm', available: 0, pending: 0 }, history: [] }),
        richMenu: () => ok({ id: null, name: null, isDefault: true }),
        upcoming: () => ok({ nextBooking: null, nextAutoDelivery: null }),
        addTag: mocks.addTag,
        removeTag: mocks.removeTag,
        updateMetadata: mocks.metadata,
      },
      friendFields: { forFriend: () => ok({ items: [] }) },
      tags: { list: () => ok([{ id: 'tag-b', name: 'VIP', color: '#8B938D' }]), create: vi.fn() },
      ecCommerce: { orders: mocks.orders },
      chats: { update: mocks.update, get: mocks.get },
    },
  }
})
vi.mock('@/v8/booking/prepay-badge', () => ({ default: () => null }))
/* 選ぶ欄は共通 Select（listbox）。ここで見たいのは選んだ後の保存なので、素の select にする。 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, id, value, onChange, options }: {
    'aria-label'?: string; id?: string; value: string; onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement('select', { 'aria-label': label, id, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label))),
}))

import { ApiError } from '@/lib/api'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import FriendInfoSidebar from './friend-info-sidebar'

let host: HTMLDivElement
let root: Root

async function eventually(check: () => void) {
  let last: unknown
  for (let i = 0; i < 60; i += 1) {
    try { check(); return } catch (error) { last = error }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  }
  throw last
}
const button = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined

async function renderPanel(notes: string | null = '前のメモ', friendId = 'friend-0', accountId = 'account-a') {
  await act(async () => {
    root.render(
      <>
        <FriendInfoSidebar
          friendId={friendId}
          chatId={friendId}
          accountId={accountId}
          revision={3}
          chatStatus={{ status: 'unread', notes }}
          operators={[{ id: 'op-k', name: 'Kenta' }, { id: 'op-m', name: 'Masato' }]}
          operatorId="op-k"
        />
        <ToastHost />
      </>,
    )
  })
  await eventually(() => {
    expect(host.querySelector('[data-customer-info-panel] section[aria-label="対応"]')).toBeTruthy()
  })
  // ふだんは値を読む形。以前からの保存・失敗・競合の検証は編集を開いて行う。
  {
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="対応を編集"]')?.click()
      host.querySelector<HTMLButtonElement>('button[aria-label="メモを編集"]')?.click()
    })
  }
}

beforeEach(() => {
  mocks.role = 'owner'
  clearToastsForTest()
  Object.values(mocks).forEach((m) => { if (typeof m !== 'string') m.mockReset() })
  mocks.orders.mockResolvedValue({ success: true, data: { items: [] } })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
  window.localStorage.setItem('lh_staff_role', 'owner')
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  clearToastsForTest()
  window.localStorage.removeItem('lh_staff_role')
  window.localStorage.removeItem('lh_staff_view_permissions')
  delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
})

describe('右の欄でその場で直す', () => {
  it('タグの追加は開いて選べ、Tキーでも開いて入力欄へ移動する', async () => {
    await renderPanel()
    const picker = () => document.getElementById('inbox-panel-tag-picker')!
    expect(picker().hidden).toBe(true)
    await act(async () => { host.querySelector<HTMLButtonElement>('section[aria-label="タグ"] button[aria-controls="inbox-panel-tag-picker"]')!.click() })
    expect(picker().hidden).toBe(false)
    expect(document.querySelector('[aria-label="タグを探して付ける"]')).toBeTruthy()
    await act(async () => { host.querySelector<HTMLButtonElement>('section[aria-label="タグ"] button[aria-controls="inbox-panel-tag-picker"]')!.click() })
    expect(picker().hidden).toBe(true)
    document.activeElement instanceof HTMLElement && document.activeElement.blur()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true })) })
    await eventually(() => {
      expect(picker().hidden).toBe(false)
      expect(document.activeElement?.getAttribute('aria-label')).toBe('タグを探して付ける')
    })
  })

  it('対応状況は選んだ瞬間に変え、版を送らずその項目だけ保存する', async () => {
    mocks.update.mockResolvedValue({ success: true, data: { revision: 4 } })
    await renderPanel()
    const select = document.querySelector('select[aria-label="対応状況を変える"]') as HTMLSelectElement
    await act(async () => {
      select.value = 'in_progress'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(select.value).toBe('in_progress')
    await eventually(() => { expect(host.textContent).toContain('対応状況を「対応中」にしました') })
    expect(mocks.update).toHaveBeenCalledWith('friend-0', { status: 'in_progress' })
    expect(button('元に戻す')).toBeUndefined()
    expect(select.value).toBe('in_progress')
  })

  it('担当の保存に失敗したら選ぶ前に戻し、理由と［もう一度試す］を出す', async () => {
    mocks.update.mockRejectedValueOnce(new ApiError(400, '担当者が見つかりません'))
    await renderPanel()
    const select = document.querySelector('select[aria-label="担当者を変える"]') as HTMLSelectElement
    await act(async () => {
      select.value = 'op-m'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await eventually(() => { expect(host.textContent).toContain('担当を変えられませんでした。担当者が見つかりません') })
    expect((document.querySelector('select[aria-label="担当者を変える"]') as HTMLSelectElement).value).toBe('op-k')
    mocks.update.mockResolvedValue({ success: true, data: { revision: 4 } })
    await act(async () => { button('もう一度試す')!.click() })
    await eventually(() => { expect(host.textContent).toContain('担当をMasatoにしました') })
  })

  it('タグは確認してから1つずつ外す（ほかのタグに触らない）', async () => {
    mocks.removeTag.mockResolvedValue({ success: true, data: null })
    mocks.addTag.mockResolvedValue({ success: true, data: null })
    await renderPanel()
    await act(async () => { host.querySelector<HTMLButtonElement>('section[aria-label="タグ"] button[aria-controls="inbox-panel-tag-picker"]')!.click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="未契約を外す"]')!.click() })
    expect(mocks.removeTag).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('『未契約』を外しますか？')
    expect(document.body.textContent).toContain('この友だちからタグを外します。タグそのものは消えません。')
    await act(async () => { button('外す')!.click() })
    await eventually(() => { expect(host.textContent).toContain('タグ「未契約」を外しました') })
    expect(mocks.removeTag).toHaveBeenCalledWith('friend-0', 'tag-a')
    expect(button('元に戻す')).toBeUndefined()
    expect(mocks.addTag).not.toHaveBeenCalled()
  })

  it('タグを外す確認をキャンセルすると、タグも保存先も変えない', async () => {
    await renderPanel()
    await act(async () => { host.querySelector<HTMLButtonElement>('section[aria-label="タグ"] button[aria-controls="inbox-panel-tag-picker"]')!.click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="未契約を外す"]')!.click() })
    await act(async () => { button('キャンセル')!.click() })
    expect(mocks.removeTag).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('『未契約』を外しますか？')
    expect(document.querySelector('button[aria-label="未契約を外す"]')).toBeTruthy()
  })

  it('確認中に友だちを切り替えたら確認を閉じ、別の友だちから外さない', async () => {
    await renderPanel()
    await act(async () => { host.querySelector<HTMLButtonElement>('section[aria-label="タグ"] button[aria-controls="inbox-panel-tag-picker"]')!.click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="未契約を外す"]')!.click() })
    await act(async () => { root.render(<FriendInfoSidebar friendId="friend-1" chatId="chat-1" />) })
    expect(document.body.textContent).not.toContain('『未契約』を外しますか？')
    expect(mocks.removeTag).not.toHaveBeenCalled()
  })

  it('旧テーマ属性でもタグを外す前にV8の確認を挟む', async () => {
    document.documentElement.dataset.theme = 'v7'
    mocks.removeTag.mockResolvedValue({ success: true, data: null })
    await renderPanel()
    expect(document.querySelector('[role="group"][aria-label="タグ「未契約」"]')).toBeTruthy()
    await act(async () => { host.querySelector<HTMLButtonElement>('section[aria-label="タグ"] button[aria-controls="inbox-panel-tag-picker"]')!.click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="未契約を外す"]')!.click() })
    expect(mocks.removeTag).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('『未契約』を外しますか？')
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === '外す')!.click() })
    expect(mocks.removeTag).toHaveBeenCalledWith('friend-0', 'tag-a')
  })

  describe('メモの同時編集（最後に直した方を残す）', () => {
    const typeMemo = async (text: string) => {
      const area = document.getElementById('inbox-panel-memo') as HTMLTextAreaElement
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
        setter.call(area, text)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }

    it('相手が直したのがメモ以外なら、読み直した版で黙って保存し直す', async () => {
      mocks.update
        .mockRejectedValueOnce(new ApiError(409, 'ほかの担当者が先に更新しました', 'REVISION_CONFLICT'))
        .mockResolvedValueOnce({ success: true, data: { revision: 6 } })
      mocks.get.mockResolvedValue({ success: true, data: { revision: 5, notes: '前のメモ' } })
      await renderPanel()
      await typeMemo('新しいメモ')
      await eventually(() => { expect(host.textContent).toContain('メモを保存しました') }, )
      expect(mocks.update).toHaveBeenNthCalledWith(1, 'friend-0', { notes: '新しいメモ', revision: 3 })
      expect(mocks.update).toHaveBeenNthCalledWith(2, 'friend-0', { notes: '新しいメモ', revision: 5 })
    })

    it('相手もメモを直していたら、あとから直したこちらを残して知らせる', async () => {
      mocks.update
        .mockRejectedValueOnce(new ApiError(409, 'ほかの担当者が先に更新しました', 'REVISION_CONFLICT'))
        .mockResolvedValue({ success: true, data: { revision: 6 } })
      mocks.get.mockResolvedValue({ success: true, data: { revision: 5, notes: '相手のメモ' } })
      await renderPanel()
      await typeMemo('自分のメモ')
      await eventually(() => { expect(host.textContent).toContain('ほかの人が先にメモを直していました') })
      expect(button('元に戻す')).toBeUndefined()
      expect((document.getElementById('inbox-panel-memo') as HTMLTextAreaElement).value).toBe('自分のメモ')
    })
  })
})

describe('古い相手の保存結果（WEB243）', () => {
  it('前の会話の対応状況保存の失敗を現在の会話へ戻さない', async () => {
    let reject!: (error: unknown) => void
    mocks.update.mockReturnValueOnce(new Promise((_, no) => { reject = no }))
    await renderPanel()
    const select = document.querySelector('select[aria-label="対応状況を変える"]') as HTMLSelectElement
    await act(async () => { select.value = 'in_progress'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await renderPanel(null, 'friend-b')
    mocks.update.mockResolvedValue({ success: true, data: { revision: 5 } })
    const nextSelect = document.querySelector('select[aria-label="対応状況を変える"]') as HTMLSelectElement
    await act(async () => { nextSelect.value = 'resolved'; nextSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => { reject(new Error('down')); await Promise.resolve() })
    expect((document.querySelector('select[aria-label="対応状況を変える"]') as HTMLSelectElement).value).toBe('resolved')
  })
  it('同じ会話の古い保存失敗も新しい選択を巻き戻さない', async () => {
    let reject!: (error: unknown) => void
    mocks.update.mockReturnValueOnce(new Promise((_, no) => { reject = no })).mockResolvedValue({ success: true, data: { revision: 5 } })
    await renderPanel()
    const select = document.querySelector('select[aria-label="対応状況を変える"]') as HTMLSelectElement
    await act(async () => { select.value='in_progress';select.dispatchEvent(new Event('change',{ bubbles:true })) })
    await act(async () => { select.value='resolved';select.dispatchEvent(new Event('change',{ bubbles:true })) })
    await act(async () => { reject(new Error('down'));await Promise.resolve() })
    expect(select.value).toBe('resolved')
  })
})
describe('購入のAPIの形と宛先（WEB242）', () => {
  it('現在のアカウントを渡し、同名の別人の注文を合計に含めない', async () => {
    mocks.orders.mockResolvedValue({ success:true,data:{ items:[
      { id:'mine',friendId:'friend-0',orderNumber:'注文A',totalAmount:1200,orderedAt:'2026-10-01T00:00:00Z' },
      { id:'other',friendId:'friend-b',orderNumber:'注文B',totalAmount:9000,orderedAt:'2026-10-02T00:00:00Z' }
    ] } })
    await renderPanel()
    await act(async () => { button('顧客情報をすべて表示')!.click() })
    await eventually(() => { expect(host.textContent).toContain('1,200') })
    expect(mocks.orders).toHaveBeenCalledWith(expect.objectContaining({ lineAccountId:'account-a' }))
    expect(host.textContent).not.toContain('10,200')
  })
  it('取得失敗を購入0件と出さず、再試行を出す', async () => {
    mocks.orders.mockRejectedValue(new Error('down'));await renderPanel()
    await act(async () => { button('顧客情報をすべて表示')!.click() })
    await eventually(() => { expect(host.textContent).toContain('購入を読み込めませんでした') })
    expect(document.querySelector('[aria-label="購入をもう一度読み込む"]')).toBeTruthy()
  })
})


it('閲覧のみでは対応・担当・メモ・タグを変える操作を隠す', async () => {
  mocks.role = 'staff'
  window.localStorage.setItem('lh_staff_role', 'staff')
  window.localStorage.setItem('lh_staff_view_permissions', '["/chats","/friends"]')
  await renderPanel()
  expect(document.querySelector('[aria-label="対応状況を変える"]')).toBeNull()
  expect(document.querySelector('[aria-label="担当者を変える"]')).toBeNull()
  expect(document.getElementById('inbox-panel-memo')).toBeNull()
  expect(button('＋ 追加')).toBeUndefined()
  expect(document.querySelector('[aria-label="未契約を外す"]')).toBeNull()
})

// 選ぶ物の欄も、保存/API境界の試験では以前のSelectと同じ差し替えにする。
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))
