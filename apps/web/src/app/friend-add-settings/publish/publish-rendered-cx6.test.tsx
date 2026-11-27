// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ query: 'id=rule-a', get: vi.fn(), validate: vi.fn(), conflicts: vi.fn(), test: vi.fn() }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useSearchParams: () => new URLSearchParams(fixture.query) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }] }) }))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: vi.fn(), usePageCrumbs: vi.fn() }))
vi.mock('@/lib/use-feature-access', () => ({ useFeatureAccess: () => true }))
vi.mock('@/lib/staff-role', async original => ({ ...(await original<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner', loadStaffIdentity: async () => ({ success: true, data: { name: '担当者' } }) }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, friendAddRules: { ...actual.api.friendAddRules, get: fixture.get, validate: fixture.validate, conflicts: fixture.conflicts, test: fixture.test } } }
})

import { ApiError } from '@/lib/api'
import FriendAddPublishV8 from '@/v8/friend-add-publish/publish'

const rule = {
  id: 'rule-a', versionId: 'version-a', name: '初回の案内', status: 'draft', friendKind: 'new', priority: 2,
  routeNames: ['店頭'], isFallback: false, lastTestStatus: 'succeeded', lastTestedAt: '2026-11-28T10:30:00',
  definition: { routeIds: ['route-a'], messageType: 'text', messageText: 'ご登録ありがとうございます', timing: 'immediate', actions: [], scenarioId: null, resendSuppressionHours: 24 },
}

beforeEach(() => {
  fixture.query = 'id=rule-a'
  fixture.get.mockReset().mockResolvedValue({ success: true, data: { rule, staffNotification: { status: 'connected', reason: null } } })
  fixture.validate.mockReset().mockResolvedValue({ success: true, data: { canPublish: true, checks: [] } })
  fixture.conflicts.mockReset().mockResolvedValue({ success: true, data: { rules: [], conflicts: [] } })
  fixture.test.mockReset()
})
afterEach(cleanup)

describe('公開確認画面', () => {
  it('下書き未指定は選び直しを出し、取得しない', async () => {
    fixture.query = ''
    render(<FriendAddPublishV8 />)
    expect(await screen.findByText('公開する下書きが指定されていません')).toBeTruthy()
    expect(fixture.get).not.toHaveBeenCalled()
  })

  it.each([
    [404, '確認する下書きがありません'],
    [403, 'この設定を公開する権限がありません'],
    [503, '下書きを読み込めませんでした'],
  ])('取得失敗 %i は対応する案内を表示する', async (status, title) => {
    fixture.get.mockRejectedValue(new ApiError(status, 'private error'))
    render(<FriendAddPublishV8 />)
    expect(await screen.findByText(title)).toBeTruthy()
    expect(screen.queryByText('private error')).toBeNull()
  })

  it('5段目を現在地にし、下書きの内容と最後のテストを表示する', async () => {
    render(<FriendAddPublishV8 />)
    const nav = await screen.findByRole('navigation', { name: '初回案内の作る手順' })
    expect(nav.querySelectorAll('li')).toHaveLength(5)
    expect(nav.querySelector('[aria-current="step"]')?.textContent).toContain('確認')
    expect(nav.querySelectorAll('[data-step-state="done"]')).toHaveLength(4)
    const preview = screen.getByRole('region', { name: 'LINEでの見え方' })
    expect(within(preview).getByText('ご登録ありがとうございます')).toBeTruthy()
    expect(screen.getByText(/テストで判定が通っています/).textContent).toContain('2026-11-28 10:30')
    expect(screen.getByText(/未送信・二重送信・シナリオ開始失敗を知らせます/).textContent).toContain('接続済み')
    expect(fixture.test).not.toHaveBeenCalled()
  })

  it.each([
    ['connected', 'Slack（接続済み）'],
    ['disconnected', 'Slack（未接続）'],
    [null, 'Slack'],
  ])('公開後の通知状態 %s と実行結果のリンクを表示する', async (status, expected) => {
    fixture.query = 'id=rule-a&done=1'
    fixture.get.mockResolvedValue({ success: true, data: { rule: { ...rule, status: 'published' }, staffNotification: { status, reason: null } } })
    render(<FriendAddPublishV8 />)
    const complete = await screen.findByRole('region', { name: '有効化の完了' })
    expect(within(complete).getByText(expected)).toBeTruthy()
    expect(within(complete).getByRole('link', { name: '実行結果を見る' }).getAttribute('href')).toBe('/friend-add-settings/runs')
    expect(within(complete).getByRole('link', { name: '一覧へ戻る' }).getAttribute('href')).toBe('/friend-add-settings')
    expect(complete.textContent).toContain('一覧の「…」から止められます')
  })
})
