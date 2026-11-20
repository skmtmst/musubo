// @vitest-environment happy-dom
/*
 * 公開したウェビナーの画面。
 * 対象未指定・見つからない・取得の失敗を描き分け、読み直しで直らないときは一覧へ戻す。
 * 運用の口：一時停止・複製は表示中の版を送り、通知テストは結果の件数を出す。監視の失敗件数は口の数を出す。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'

const fixture = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
  return { params: 'id=w1', accounts: [{ id: 'account-a', liffId: null as string | null }], get: vi.fn(), editor: vi.fn(), pause: vi.fn(), testNotifications: vi.fn(), duplicate: vi.fn() }
})
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(fixture.params) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: fixture.accounts, loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, webinarApi: { get: fixture.get, editor: fixture.editor, pause: fixture.pause, testNotifications: fixture.testNotifications, duplicate: fixture.duplicate } }
})

import { ApiError } from '@/lib/api'
import PublishedWebinarPage from './page'

const webinar = {
  id: 'w1', accountId: 'account-a', title: '採用ウェビナー', slug: 'recruit', status: 'active',
  videoPrefix: null, durationSeconds: 600, schedule: [], cta: null, createdAt: 'x', updatedAt: 'x',
}
const editor = {
  version: 7,
  viewingCondition: { kind: 'registered', label: '申込者向け' },
  publicPage: { url: null, unavailableReason: null },
  monitoring: { notificationFailures: 2, duplicateRegistrations: 0, viewSegmentFailures: 0, actionFailures: 0 },
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.params = 'id=w1'
  fixture.accounts = [{ id: 'account-a', liffId: null }]
  forgetStaffIdentity(); rememberStaffIdentity({ role: 'owner' } as StaffMember)
  fixture.get.mockResolvedValue({ success: true, data: webinar })
  fixture.editor.mockResolvedValue({ success: true, data: editor })
})
afterEach(() => { cleanup(); forgetStaffIdentity() })

it('対象が指定されていないときは取りに行かず、一覧へ戻る道だけを出す', async () => {
  fixture.params = ''
  render(<PublishedWebinarPage />)
  await screen.findByText('確認するウェビナーが指定されていません')
  expect(screen.getByRole('link', { name: /ウェビナー一覧へ戻る/ }).getAttribute('href')).toBe('/webinars')
  expect(screen.queryByRole('button', { name: /もう一度読み込む/ })).toBeNull()
  expect(fixture.get).not.toHaveBeenCalled()
})

it('見つからないウェビナーは、読み直しではなく一覧へ戻す', async () => {
  fixture.get.mockRejectedValue(new ApiError(404, 'not found'))
  render(<PublishedWebinarPage />)
  await screen.findByText('公開したウェビナーが見つかりませんでした。削除されたか、一覧から選び直してください。')
  expect(screen.getByRole('link', { name: /ウェビナー一覧へ戻る/ }).getAttribute('href')).toBe('/webinars')
  expect(screen.queryByRole('button', { name: /もう一度読み込む/ })).toBeNull()
})

it('取得の失敗は読み直しの口を出し、押すと取り直して公開結果へ戻る', async () => {
  fixture.get.mockRejectedValueOnce(new ApiError(500, 'boom'))
  render(<PublishedWebinarPage />)
  await screen.findByText('公開結果を読み込めませんでした')
  expect(screen.queryByRole('link', { name: /ウェビナー一覧へ戻る/ })).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /もう一度読み込む/ })) })
  await screen.findByText('公開しました')
  expect(fixture.get).toHaveBeenCalledTimes(2)
  expect(fixture.get).toHaveBeenLastCalledWith('w1')
})

it('読み込み中は公開結果を表示しない', () => {
  fixture.get.mockImplementation(() => new Promise(() => {}))
  const view = render(<PublishedWebinarPage />)
  expect(view.container.querySelector('[data-list-state="loading"]')).not.toBeNull()
  expect(screen.queryByText('公開しました')).toBeNull()
  expect(screen.queryByText('公開状態を確認できませんでした')).toBeNull()
})

it('所属先のLIFFだけを使い、無ければ公開ページを案内しない', async () => {
  fixture.editor.mockResolvedValue({ success: true, data: { ...editor, publicPage: { url: 'https://example.invalid/published', unavailableReason: null } } })
  fixture.accounts = [{ id: 'account-a', liffId: null }, { id: 'account-b', liffId: 'other-liff' }]
  const view = render(<PublishedWebinarPage />)
  await screen.findByText('公開しました')
  expect(view.container.textContent).toContain('LIFF IDを確認できないため')
  expect(screen.queryByRole('link', { name: '公開ページを見る' })).toBeNull()
  cleanup()
  fixture.accounts = [{ id: 'account-a', liffId: 'own-liff' }, { id: 'account-b', liffId: 'other-liff' }]
  render(<PublishedWebinarPage />)
  await screen.findByText('公開しました')
  expect(screen.getByRole('link', { name: '公開ページを見る' }).getAttribute('href')).toBe('https://example.invalid/published')
})

it('公開前の状態を完了と見せず、編集画面へ案内する', async () => {
  fixture.get.mockResolvedValueOnce({ success: true, data: { ...webinar, status: 'draft' } })
  render(<PublishedWebinarPage />)
  await screen.findByText('公開状態を確認できませんでした')
  expect(screen.queryByText('公開しました')).toBeNull()
  expect(screen.getByRole('link', { name: '編集画面へ戻る' }).getAttribute('href')).toBe('/webinars/edit?id=w1')
})

it('一時停止は表示中の版で送り、通知テストは結果の件数を出す', async () => {
  fixture.pause.mockResolvedValue({ data: { ...webinar, status: 'draft' } })
  fixture.testNotifications.mockResolvedValue({ data: { sent: 3, failed: 1 } })
  render(<PublishedWebinarPage />)
  await screen.findByText('公開しました')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '通知をテスト' })) })
  expect(fixture.testNotifications).toHaveBeenCalledWith('w1')
  await screen.findByText('通知テスト: 成功 3件・失敗 1件')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '公開を一時停止' })) })
  expect(fixture.pause).toHaveBeenCalledWith('w1', 7)
})

it('複製は表示中の版で送り、できた下書きの編集へ移る', async () => {
  fixture.duplicate.mockResolvedValue({ data: { id: 'w2' } })
  const assign = vi.fn()
  const original = window.location
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } })
  try {
    render(<PublishedWebinarPage />)
    await screen.findByText('公開しました')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ウェビナーを複製して作る' })) })
    expect(fixture.duplicate).toHaveBeenCalledWith('w1', 7)
    expect(assign).toHaveBeenCalledWith('/webinars/edit?id=w2')
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: original })
  }
})

it('監視の通知失敗は口が数えた件数を出す', async () => {
  render(<PublishedWebinarPage />)
  await screen.findByText('公開しました')
  const row = screen.getByText('通知失敗').parentElement!
  expect(row.textContent).toBe('通知失敗2件')
  // 17：1件以上は危険の札で出す（数は黒のまま、危険は札に任せる）。
  expect(row.querySelector('[data-tone="danger"]')?.textContent).toBe('2件')
})
