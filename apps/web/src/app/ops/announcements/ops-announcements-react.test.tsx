// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import OpsAnnouncementsPage from './page'
import OpsAnnouncementNewPage from './new/page'
import { pickDateTime } from '@/test-utils/rich-menu-editor'
import { notifySaved } from '@/components/shared/toast'
import { flushListUrlState } from '@/components/shared/list-url-state'
import { OPS_READONLY_LOCK_REASON } from '@/v8/ops/use-ops-read-only'
import { screen, fireEvent } from '@testing-library/react'

vi.mock('@/components/shared/toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shared/toast')>()), notifySaved: vi.fn(),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
const search = vi.hoisted(() => ({ value: '' }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  usePathname: () => '/ops/announcements',
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({ push: navigation.push, replace: navigation.replace, back: vi.fn() }),
}))

/*
 * 共通の Select は listbox の部品で、その操作は部品自身の試験が持つ。
 * ここで見たいのは選んだ後の配信予約の判断なので、素の <select> に置き換える。
 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, value, onChange, options }: {
    'aria-label'?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))

/** ★管理画面 37-7 お知らせ配信。一覧と作る画面の分離・送り方・宛先の見込み・一覧（LINE送達／画面で既読）が API の形どおりに出ること。 */

const sent = {
  id: 'a1', subject: '9月20日 深夜のメンテナンスのお知らせ', body: '本文', audienceKind: 'all', audiencePlans: [], audienceTenantIds: [],
  audienceLabel: '全契約先', channels: ['line', 'screen', 'email'], channelLabels: ['LINE', '画面', 'メール'], status: 'sent', statusLabel: '送信済み',
  publishAt: null, sentAt: '2026-09-17T10:00:00.000+09:00', recipientsTotal: 24, lineSent: 21, lineFailed: 0, mailSent: 24, mailFailed: 0,
  screenRead: 5, screenTotal: 24, lastError: null, createdByName: '運営 太郎', createdAt: '2026-09-17T09:00:00.000+09:00', updatedAt: '2026-09-17T10:00:00.000+09:00',
}
const draft = { ...sent, id: 'a2', subject: '料金改定のご案内（下書き）', status: 'draft', statusLabel: '下書き', sentAt: null, recipientsTotal: 0, lineSent: 0, mailSent: 0, screenRead: 0, screenTotal: 0 }

let host: HTMLDivElement
let root: Root
let calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }>
let lineConfigured = true
let readOnlyMe = false
let announcements: unknown[] = []
let previewReady: Promise<void> | null = null
let listReady: Promise<void> | null = null
/** M513: PUT の応答を差し替えて競合を起こす（null のときは通常応答）。 */
let putOverride: { status: number; payload: unknown } | null = null
/** 役割の応答を止めて「分からない」状態を作る（null のときはすぐ返す）。 */
let meReady: Promise<void> | null = null
let releaseMe: (() => void) | null = null

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  vi.mocked(notifySaved).mockClear()
  calls = []
  lineConfigured = true
  readOnlyMe = false
  announcements = [sent, draft]
  previewReady = null
  listReady = null
  putOverride = null
  meReady = null
  releaseMe = null
  navigation.push.mockClear()
  navigation.replace.mockClear()
  search.value = ''
  flushListUrlState()
  window.history.replaceState(null, '', '/')
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    const headers: Record<string, string> = {}
    const rawHeaders = init?.headers
    if (rawHeaders) {
      const entries = rawHeaders instanceof Headers ? rawHeaders.entries() : Object.entries(rawHeaders)
      for (const [key, value] of entries) headers[String(key).toLowerCase()] = String(value)
    }
    calls.push({ url, method, body, headers })
    if (putOverride && method === 'PUT' && url.includes('/api/ops/announcements/')) {
      return new Response(JSON.stringify(putOverride.payload), { status: putOverride.status, headers: { 'Content-Type': 'application/json' } })
    }
    let payload: unknown
    if (url.endsWith('/api/ops/announcements/preview')) {
      if (previewReady) await previewReady
      payload = { success: true, data: { tenants: 12, staff: 24, lineLinked: 21, withEmail: 24 } }
    }
    else if (url.endsWith('/api/ops/announcements') && method === 'POST') payload = { success: true, data: { ...sent, id: 'a3', recipientsTotal: 24, lineSent: 21, mailSent: 24 } }
    else if (url.endsWith('/api/ops/announcements')) {
      const data = announcements
      if (listReady) await listReady
      payload = { success: true, data, linked: { linked: 21, total: 24 }, noticeLineConfigured: lineConfigured }
    }
    else if (url.endsWith('/api/ops/me')) {
      if (meReady) await meReady
      payload = { success: true, data: { readOnly: readOnlyMe } }
    }
    else if (url.includes('/api/ops/tenants')) payload = { success: true, data: [] }
    else payload = { success: true, data: null }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

/** 行の右端の「…」を開き、中の項目を探す（：行の右端は「…」1つ）。 */
async function openRowMenu(subject: string): Promise<HTMLElement[]> {
  const more = host.querySelector<HTMLButtonElement>(`button[aria-label="「${subject}」の操作"]`)
  expect(more).not.toBeNull()
  await act(async () => { more!.click() })
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve() })
}

const button = (label: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)

/** 下の帯の［下書きを保存する］を押す。 */
async function clickDraftSave() {
  const item = button('下書きを保存する')
  expect(item).toBeTruthy()
  await act(async () => { item!.click() })
  await flush()
}
const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('一覧', () => {
  it('一覧に状態・LINE送達・画面で既読が出て、右上に［お知らせを作る］がある', async () => {
    await act(async () => { root.render(<OpsAnnouncementsPage />) })
    await flush()
    const text = host.textContent ?? ''
    expect(host.querySelector('button[aria-label="契約者専用LINEの登録状況"]')).not.toBeNull()
    expect(text).toContain('9月20日 深夜のメンテナンスのお知らせ')
    expect(text).toContain('送信済み')
    expect(text).toContain('21/24')
    expect(text).toContain('5/24')
    expect(text).toContain('下書き')
    // 作る欄は別画面。ここには件名の入力欄を置かない。
    expect(document.querySelector('input[placeholder^="例："]')).toBeNull()
    const create = document.querySelector<HTMLAnchorElement>('a[href="/ops/announcements/new"]')
    expect(create?.textContent).toContain('お知らせを作る')
    expect(document.querySelector('[data-design-node="tQ2MJ"]')).not.toBeNull()
  })

  it('下書きの行は編集（直す画面へ）・削除、送信済みの行は写して新しく作る', async () => {
    await act(async () => { root.render(<OpsAnnouncementsPage />) })
    await flush()
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === '編集する' || b.textContent === '直す')).toBe(false)
    const draftItems = await openRowMenu('料金改定のご案内（下書き）')
    const edit = draftItems.find((el) => el.textContent?.includes('編集する'))
    expect(edit?.getAttribute('href')).toBe('/ops/announcements/new?id=a2')
    expect(draftItems.some((el) => el.textContent?.includes('削除する'))).toBe(true)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    const sentItems = await openRowMenu('9月20日 深夜のメンテナンスのお知らせ')
    const copy = sentItems.find((el) => el.textContent?.includes('編集する'))
    expect(copy?.textContent).toContain('中身を写して新しく作ります')
    expect(copy?.getAttribute('href')).toBe('/ops/announcements/new?copy=a1')
    expect(sentItems.some((el) => el.textContent?.includes('削除する'))).toBe(false)
  })

  it('削除は確認の窓を挟み、実行したら一覧を読み直す', async () => {
    await act(async () => { root.render(<OpsAnnouncementsPage />) })
    await flush()
    const items = await openRowMenu('料金改定のご案内（下書き）')
    await act(async () => { items.find((el) => el.textContent?.includes('削除する'))!.click() })
    expect(document.body.textContent).toContain('「料金改定のご案内（下書き）」を削除しますか？')
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('環境')
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('LINEアカウント')
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('不明')
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('1件')
    await act(async () => { button('削除する')!.click() })
    await flush()
    expect(calls.some((c) => c.url.endsWith('/api/ops/announcements/a2') && c.method === 'DELETE')).toBe(true)
    expect(calls.filter((c) => c.url.endsWith('/api/ops/announcements') && c.method === 'GET').length).toBeGreaterThan(1)
  })

  it('閲覧のみは作るボタンも行の操作も押せない形＋理由で出す', async () => {
    readOnlyMe = true
    await act(async () => { root.render(<OpsAnnouncementsPage />) })
    await flush()
    expect(document.querySelector('a[href="/ops/announcements/new"]')).toBeNull()
    const locked = button('お知らせを作る')
    expect(locked).not.toBeUndefined()
    expect(locked?.getAttribute('aria-disabled')).toBe('true')
    expect(locked?.hasAttribute('data-permission-locked')).toBe(true)
    expect(document.getElementById(locked!.getAttribute('aria-describedby')!)?.textContent).toBe(OPS_READONLY_LOCK_REASON)
    const items = await openRowMenu('料金改定のご案内（下書き）')
    const edit = items.find((el) => el.textContent?.includes('編集する'))!
    const remove = items.find((el) => el.textContent?.includes('削除する'))!
    expect(edit.getAttribute('aria-disabled')).toBe('true')
    expect(edit.hasAttribute('data-permission-locked')).toBe(true)
    expect(document.getElementById(edit.getAttribute('aria-describedby')!)?.textContent).toBe(OPS_READONLY_LOCK_REASON)
    expect(remove.getAttribute('aria-disabled')).toBe('true')
    expect(remove.hasAttribute('data-permission-locked')).toBe(true)
    expect(edit.getAttribute('href')).toBeNull()
  })

  it('役割が分かるまでは理由なしの押せない形で出し、分かったら切り替える', async () => {
    meReady = new Promise<void>((resolve) => { releaseMe = resolve })
    await act(async () => { root.render(<OpsAnnouncementsPage />) })
    await flush()
    expect(document.querySelector('a[href="/ops/announcements/new"]')).toBeNull()
    const waiting = button('お知らせを作る')
    expect(waiting?.disabled).toBe(true)
    expect(waiting?.hasAttribute('data-permission-locked')).toBe(false)
    const items = await openRowMenu('料金改定のご案内（下書き）')
    expect(items.find((el) => el.textContent?.includes('編集する'))?.hasAttribute('disabled')).toBe(true)
    await act(async () => { releaseMe!() })
    await flush()
    expect(document.querySelector<HTMLAnchorElement>('a[href="/ops/announcements/new"]')?.textContent).toContain('お知らせを作る')
  })

  it('?highlight= の行を光らせ、印は1回だけ使って消す', async () => {
    window.history.replaceState(null, '', '/ops/announcements?highlight=a2')
    await act(async () => { root.render(<OpsAnnouncementsPage />) })
    await flush()
    expect(host.querySelector('[data-row-id="a2"]')?.getAttribute('data-highlight')).toBe('true')
    expect(host.querySelector('[data-row-id="a1"]')?.getAttribute('data-highlight')).toBeNull()
    flushListUrlState()
    expect(window.location.search).toBe('')
  })
})

describe('作る画面', () => {
  it('件名・本文を入れて「今すぐ送る」→確認の窓→送信。mode=send と送り方が API に渡り、一覧へ戻る', async () => {
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    const subject = document.querySelector<HTMLInputElement>('input[placeholder^="例："]')!
    const body = document.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => { setValue(subject, 'メンテナンスのお知らせ'); setValue(body, '本文です') })
    fireEvent.click(screen.getByRole('checkbox', { name: 'メール', exact: true }))
    fireEvent.click(screen.getByRole('checkbox', { name: '契約者専用LINE', exact: true }))
    await act(async () => { button('今すぐ送る')!.click() })
    await flush()
    // 板 「送る前の確認」：宛先・届く方法・日時と件名・本文を見てから送る。
    const confirm = document.body.querySelector('[data-design-node="TJUUl"]')
    expect(confirm, '送る前の確認の窓が出ない').not.toBeNull()
    for (const row of ['このお知らせを送りますか？', '宛先', '届く方法', '送る日時', '件名：メンテナンスのお知らせ', '取り下げられます', '戻って直す', '今すぐ送る']) {
      expect(confirm?.textContent ?? '', `「${row}」がない`).toContain(row)
    }
    const sendInDialog = Array.from(confirm?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === '今すぐ送る')
    expect(sendInDialog, '小窓の中に送るボタンがない').not.toBeUndefined()
    await act(async () => { (sendInDialog as HTMLButtonElement).click() })
    await flush()
    const post = calls.find((c) => c.url.endsWith('/api/ops/announcements') && c.method === 'POST')!
    expect(post.body).toMatchObject({ subject: 'メンテナンスのお知らせ', body: '本文です', audienceKind: 'all', channels: ['screen', 'line'], mode: 'send', publishAt: null })
    expect(notifySaved).toHaveBeenCalledWith('送りました（24人。LINE 21・メール 24）')
    expect(navigation.push).toHaveBeenCalledWith('/ops/announcements?highlight=a3')
  })

  it('確認を開いた後に入力が変わったら古い確認では送らない', async () => {
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    const subject = document.querySelector<HTMLInputElement>('input[placeholder^="例："]')!
    const body = document.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => { setValue(subject, '確認した件名'); setValue(body, '本文です') })
    await act(async () => { button('今すぐ送る')!.click() })
    const dialog = document.body.querySelector('[data-design-node="TJUUl"]')!
    const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.trim() === '今すぐ送る')!
    expect(confirm).toBeTruthy()
    await act(async () => { setValue(subject, '変わった件名') })
    await act(async () => { confirm.click() })
    await flush()
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/ops/announcements'))).toBe(false)
  })

  it('公開日時を入れると主ボタンが「配信を予約する」になり、mode=schedule で送る', async () => {
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    await act(async () => {
      setValue(document.querySelector<HTMLInputElement>('input[placeholder^="例："]')!, '予約のお知らせ')
      setValue(document.querySelector<HTMLTextAreaElement>('textarea')!, '本文')
    })
    const picked = new Date(Date.now() + 86400_000).toISOString().slice(0, 10)
    await pickDateTime('公開日時（日本時間）', `${picked}T02:00`)
    expect(button('今すぐ送る')).toBeUndefined()
    await act(async () => { button('配信を予約する')!.click() })
    await flush()
    const confirmation = document.body.querySelector('[data-design-node="TJUUl"]')!
    const send = [...confirmation.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('02:00') && item.textContent.includes('に送る'))!
    await act(async () => { send.click() })
    await flush()
    const post = calls.find((c) => c.url.endsWith('/api/ops/announcements') && c.method === 'POST')!
    expect(post.body).toMatchObject({ mode: 'schedule', publishAt: `${picked}T02:00:00+09:00` })
  })

  it('契約者専用LINEが未設定なら注意を出し、LINE を含む送信は止める', async () => {
    lineConfigured = false
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    expect(host.textContent?.replace(/\s/g, '')).toContain('契約者専用LINEのアカウントが未設定です')
    fireEvent.click(screen.getByRole('checkbox', { name: '契約者専用LINE', exact: true }))
    await act(async () => {
      setValue(document.querySelector<HTMLInputElement>('input[placeholder^="例："]')!, 'x')
      setValue(document.querySelector<HTMLTextAreaElement>('textarea')!, 'y')
    })
    await act(async () => { button('今すぐ送る')!.click() })
    await flush()
    const confirm = document.body.querySelector('[data-design-node="TJUUl"]')
    const sendInDialog = Array.from(confirm?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === '今すぐ送る') as HTMLButtonElement
    await act(async () => { sendInDialog.click() })
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('契約者専用LINEのアカウントが未設定です。メンバー管理の「運営の情報」で指定してください')
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/ops/announcements'))).toBe(false)
  })

  it('未入力で保存を押すと欄の誤りを出す（監査 R154）', async () => {
    announcements = []
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    await clickDraftSave()
    await flush()
    expect(document.querySelector('#ann-subject-error')?.textContent).toBe('件名を入力してください')
    expect(document.querySelector('#ann-subject')?.getAttribute('aria-invalid')).toBe('true')
  })

  it('入力中に画面内リンクを押すと離脱の確認が出て、「編集を続ける」で入力が残る（監査 R155）', async () => {
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    await act(async () => {
      setValue(document.querySelector<HTMLInputElement>('input[placeholder^="例："]')!, '書きかけの件名')
    })
    // 左メニューなどの画面内リンクを踏むのと同じクリックを起こす
    const link = document.createElement('a')
    link.href = '/ops/announcements'
    document.body.appendChild(link)
    await act(async () => { link.click() })
    await flush()
    link.remove()
    expect(document.body.textContent).toContain('保存していない変更があります')
    await act(async () => { button('編集を続ける')!.click() })
    await flush()
    expect(document.querySelector<HTMLInputElement>('input[placeholder^="例："]')!.value).toBe('書きかけの件名')
    expect(navigation.push).not.toHaveBeenCalled()
  })

  it('離脱の確認で「保存せずに移る」を押すと移動する（監査 R155）', async () => {
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    await act(async () => {
      setValue(document.querySelector<HTMLInputElement>('input[placeholder^="例："]')!, '書きかけの件名')
    })
    const link = document.createElement('a')
    link.href = '/ops/announcements'
    document.body.appendChild(link)
    await act(async () => { link.click() })
    await flush()
    link.remove()
    await act(async () => { button('保存せずに移る')!.click() })
    await flush()
    expect(navigation.push).toHaveBeenCalledWith('/ops/announcements')
  })

  it('宛先の取得中と、実際に選んだ送り方に合わせて見込みを表示する', async () => {
    let resolvePreview!: () => void
    previewReady = new Promise<void>((resolve) => { resolvePreview = resolve })
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    const previewButton = screen.getByRole('button', { name: '宛先の見込み', exact: true })
    const previewText = () => document.getElementById(previewButton.getAttribute('aria-describedby')!)?.textContent
    await act(async () => { previewButton.click() })
    expect(previewText()).toBe('宛先を数えています…')
    await act(async () => { resolvePreview() })
    await flush()
    expect(previewText()).toBe('12 件の契約先・24 人の権限者。メールは24 人に届きます')
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: '契約者専用LINE', exact: true })) })
    expect(previewText()).toBe('12 件の契約先・24 人の権限者。うち契約者専用LINEに登録済みの21 人へ届きます。メールは24 人に届きます')
    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'メール', exact: true }))
      fireEvent.click(screen.getByRole('checkbox', { name: '契約者専用LINE', exact: true }))
    })
    expect(previewText()).toBe('12 件の契約先・24 人の権限者')
  })

  it.each([
    { publishAt: null, label: '空のままならすぐに送る' },
    { publishAt: '2026-09-20T02:00:00+09:00', label: '2026年9月20日（日）02:00' },
  ])('?id= で開くと保存済みを読み込み、日時 $publishAt を編集欄へ復元する', async ({ publishAt, label }) => {
    announcements = [{ ...draft, publishAt }]
    search.value = 'id=a2'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    expect(document.querySelector<HTMLInputElement>('input[placeholder^="例："]')!.value).toContain('料金改定のご案内')
    expect(screen.getByRole('button', { name: '公開日時（日本時間）', exact: true }).textContent).toBe(label)
  })

  it('?copy= で開くと中身を写して新しいお知らせとして作る', async () => {
    search.value = 'copy=a1'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    expect(document.querySelector<HTMLInputElement>('input[placeholder^="例："]')!.value).toContain('9月20日 深夜のメンテナンスのお知らせ')
    expect(host.textContent).toContain('送ったお知らせの中身を写しました')
    expect(button('削除する')).toBeUndefined()
  })

  it('無い id で開くと見つからない旨を出す', async () => {
    search.value = 'id=missing'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    expect(host.textContent).toContain('お知らせが見つかりませんでした')
  })

  it('閲覧のみは保存のボタンを押せない形で出し、入力は無効にする', async () => {
    readOnlyMe = true
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    expect(button('今すぐ送る')?.getAttribute('aria-disabled')).toBe('true')
    expect(document.querySelector<HTMLFieldSetElement>('fieldset[aria-label="お知らせの入力"]')!.disabled).toBe(true)
    const item = button('下書きを保存する')
    expect(item?.getAttribute('aria-disabled')).toBe('true')
    expect(item?.hasAttribute('data-permission-locked')).toBe(true)
  })

  it('閲覧のみは直す画面の削除も押せない形＋理由で出す', async () => {
    readOnlyMe = true
    search.value = 'id=a2'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    const remove = button('削除する')
    expect(remove).not.toBeUndefined()
    expect(remove?.getAttribute('aria-disabled')).toBe('true')
    expect(remove?.hasAttribute('data-permission-locked')).toBe(true)
    expect(document.getElementById(remove!.getAttribute('aria-describedby')!)?.textContent).toBe(OPS_READONLY_LOCK_REASON)
  })

  it('?id= で直して送ると一覧へ戻して送った行を光らせる', async () => {
    search.value = 'id=a2'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    putOverride = { status: 200, payload: { success: true, data: { ...draft, id: 'a2', status: 'sent', statusLabel: '送信済み', updatedAt: '2026-10-09T11:00:00.000+09:00', publishAt: '2026-10-09T11:00:00+09:00' } } }
    await act(async () => { button('今すぐ送る')!.click() })
    await flush()
    const confirm = document.body.querySelector('[data-design-node="TJUUl"]')
    const sendInDialog = Array.from(confirm?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === '今すぐ送る') as HTMLButtonElement
    await act(async () => { sendInDialog.click() })
    await flush()
    expect(calls.some((c) => c.url.includes('/api/ops/announcements/a2') && c.method === 'PUT')).toBe(true)
    expect(navigation.push).toHaveBeenCalledWith('/ops/announcements?highlight=a2')
  })

  it('送ったものを ?id= で開いたら写しに切り替える', async () => {
    search.value = 'id=a1'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    expect(navigation.replace).toHaveBeenCalledWith('/ops/announcements/new?copy=a1')
    // 切替中は読み込み中のままにし、空の作る欄を出さない。
    expect(host.querySelector('[data-list-state="loading"]')).not.toBeNull()
    expect(document.querySelector('input[placeholder^="例："]')).toBeNull()
  })

  it('直す画面から送信済みの写しへ移ったら新規として送る', async () => {
    search.value = 'id=a2'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    search.value = 'copy=a1'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    expect(document.querySelector<HTMLInputElement>('input[placeholder^="例："]')?.value).toBe(sent.subject)
    await act(async () => { button('今すぐ送る')!.click() })
    const dialog = document.body.querySelector('[data-design-node="TJUUl"]')!
    const confirm = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent?.trim() === '今すぐ送る')!
    await act(async () => { confirm.click() })
    await flush()
    expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/ops/announcements'))).toBe(true)
    expect(calls.some(c => c.method === 'PUT' && c.url.includes('/api/ops/announcements/a2'))).toBe(false)
  })

  it('前の URL の遅い応答で別のお知らせを表示しない', async () => {
    let release!: () => void
    listReady = new Promise<void>((resolve) => { release = resolve })
    announcements = [draft, { ...draft, id: 'a3', subject: '新しいお知らせ' }]
    search.value = 'id=a2'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    listReady = null
    search.value = 'id=a3'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    expect(document.querySelector<HTMLInputElement>('input[placeholder^="例："]')?.value).toBe('新しいお知らせ')
    await act(async () => { release() })
    await flush()
    expect(document.querySelector<HTMLInputElement>('input[placeholder^="例："]')?.value).toBe('新しいお知らせ')
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('URL が変わった後は古い削除確認から削除できない', async () => {
    search.value = 'id=a2'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    await act(async () => { button('削除する')!.click() })
    const oldConfirm = Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((b) => b.textContent?.trim() === '削除する')!
    expect(oldConfirm).toBeTruthy()
    search.value = 'id=missing'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    await act(async () => { oldConfirm.click() })
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('?id= の削除は確認の窓を挟み、実行したら一覧へ戻る', async () => {
    search.value = 'id=a2'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    await act(async () => { button('削除する')!.click() })
    await flush()
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]')!
    expect(dialog.textContent).toContain('「料金改定のご案内（下書き）」を削除しますか？')
    expect(dialog.textContent).toContain('環境')
    expect(dialog.textContent).toContain('LINEアカウント')
    expect(dialog.textContent).toContain('不明')
    expect(dialog.textContent).toContain('1件')
    const confirmRemove = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.trim() === '削除する')!
    await act(async () => { confirmRemove.click() })
    await flush()
    expect(calls.some((c) => c.url.endsWith('/api/ops/announcements/a2') && c.method === 'DELETE')).toBe(true)
    expect(navigation.push).toHaveBeenCalledWith('/ops/announcements')
  })
})

describe('二重押しと同時保存（M512/M513）', () => {
  it('M512: 作成に再実行キー（UUID）を添えて送る', async () => {
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    await act(async () => {
      setValue(document.querySelector<HTMLInputElement>('input[placeholder^="例："]')!, 'メンテナンスのお知らせ')
      setValue(document.querySelector<HTMLTextAreaElement>('textarea')!, '本文です')
    })
    await act(async () => { button('今すぐ送る')!.click() })
    await flush()
    const confirm = document.body.querySelector('[data-design-node="TJUUl"]')
    const sendInDialog = Array.from(confirm?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === '今すぐ送る') as HTMLButtonElement
    await act(async () => { sendInDialog.click() })
    await flush()
    const post = calls.find((c) => c.url.endsWith('/api/ops/announcements') && c.method === 'POST')!
    expect(post.headers['idempotency-key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('M513: 編集するときは開いたときの版を添え、競合時は入力を残したまま理由を出す', async () => {
    search.value = 'id=a2'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    expect(document.querySelector<HTMLInputElement>('input[placeholder^="例："]')!.value).toContain('料金改定のご案内')
    await act(async () => {
      setValue(document.querySelector<HTMLInputElement>('input[placeholder^="例："]')!, '料金改定のご案内（修正）')
    })
    // ほかの人が先に保存した想定で409を返す。
    putOverride = {
      status: 409,
      payload: {
        success: false,
        code: 'VERSION_CONFLICT',
        error: 'ほかの人が先に保存しました。一覧を読み直してから、もう一度保存してください。',
        data: { latest: { subject: 'ほかの人の件名', updatedAt: '2026-09-18T00:00:00.000+09:00' } },
      },
    }
    await clickDraftSave()
    await flush()
    const put = calls.find((c) => c.url.includes('/api/ops/announcements/a2') && c.method === 'PUT')!
    expect(put.body).toMatchObject({ subject: '料金改定のご案内（修正）', expectedUpdatedAt: '2026-09-17T10:00:00.000+09:00' })
    expect(document.body.textContent).toContain('ほかの人が先にお知らせを保存しました')
    // 入力は消えない。
    expect(document.querySelector<HTMLInputElement>('input[placeholder^="例："]')!.value).toBe('料金改定のご案内（修正）')
  })

  it('配信済みへの保存の409は競合と分け、届いた文を出す', async () => {
    search.value = 'id=a2'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    // 版の違いではない409（符号なし）。
    putOverride = { status: 409, payload: { success: false, error: '配信済みのお知らせは変えられません' } }
    await clickDraftSave()
    await flush()
    expect(document.body.textContent).toContain('配信済みのお知らせは変えられません')
    expect(document.body.textContent).not.toContain('ほかの人が先にお知らせを保存しました')
  })

  it('送信の準備の409の後は版を読み直し、次は自分の保存と競合しない', async () => {
    search.value = 'id=a2'
    await act(async () => { root.render(<OpsAnnouncementNewPage />) })
    await flush()
    // 下書きは通って版だけ進んだ想定。
    announcements = [{ ...draft, updatedAt: '2026-10-09T12:00:00.000+09:00' }]
    putOverride = { status: 409, payload: { success: false, error: '送信の準備に失敗しました' } }
    await clickDraftSave()
    await flush()
    expect(document.body.textContent).toContain('送信の準備に失敗しました')
    expect(document.body.textContent).not.toContain('ほかの人が先にお知らせを保存しました')
    putOverride = { status: 200, payload: { success: true, data: { ...draft, updatedAt: '2026-10-09T12:00:00.000+09:00' } } }
    await clickDraftSave()
    await flush()
    const saved = calls.filter((call) => call.method === 'PUT')
    expect(saved).toHaveLength(2)
    expect(saved[0].body).toMatchObject({ expectedUpdatedAt: '2026-09-17T10:00:00.000+09:00' })
    expect(saved[1].body).toMatchObject({ expectedUpdatedAt: '2026-10-09T12:00:00.000+09:00' })
  })
})

it('編集の保存後はその場に残り、次の保存には更新後の版を添える', async () => {
  search.value = 'id=a2'
  await act(async () => { root.render(<OpsAnnouncementNewPage />) })
  await flush()
  const title = document.querySelector<HTMLInputElement>('input[placeholder^="例："]')!
  await act(async () => setValue(title, '編集した件名'))
  putOverride = { status: 200, payload: { success: true, data: { ...draft, subject: '編集した件名', updatedAt: '2026-10-09T11:00:00+09:00' } } }
  await clickDraftSave()
  await flush()
  expect(title.value).toBe('編集した件名')
  expect(navigation.push).not.toHaveBeenCalled()
  await clickDraftSave()
  await flush()
  const saved = calls.filter(call => call.method === 'PUT')
  expect(saved).toHaveLength(2)
  expect(saved[1].body).toMatchObject({ expectedUpdatedAt: '2026-10-09T11:00:00+09:00' })
})
