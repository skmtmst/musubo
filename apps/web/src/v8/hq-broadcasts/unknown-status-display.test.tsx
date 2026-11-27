// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), folders: vi.fn(async () => ({ success: true, data: [] })), approvalCandidates: vi.fn(async () => ({ success: true, data: [] })) }))
const params = vi.hoisted(() => ({ value: new URLSearchParams() }))
vi.mock('@/lib/hq-broadcasts-api', () => ({ hqBroadcastsApi: api }))
vi.mock('@/lib/staff-role', () => ({ useTenantWideAccess: () => true, useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => params.value }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
import HqBroadcastList from './list'
import HqBroadcastDetail from './detail'

afterEach(cleanup)
const target = { accountId: 'a', accountName: '本店', audienceCount: 10, remaining: 100, connected: true, paused: false, blockedReasons: [], excluded: false, broadcastId: 'b', failureReasons: [], status: 'future', version: 1, successCount: 0, totalCount: 10, openedCount: null, clickedCount: null, reactionCount: null, retryableCount: 0, stopped: false }
const run = { id: 'r1', title: '春の配信', status: 'scheduled', version: 1, scheduledAt: null, input: { title: '春の配信', messageType: 'text', messageContent: '本文', audience: { kind: 'all' }, accountIds: [], accountTagIds: [], excludedAccountIds: [], requestId: 'r1', scheduledAt: null }, targets: [target] }

it('未知の全体状態を送信済みや予約中と決めつけない', async () => {
  api.list.mockResolvedValue({ data: [{ ...run, status: 'future', targets: [{ ...target, status: 'sent' }] }] })
  render(<HqBroadcastList />)
  const row = (await screen.findByText('春の配信')).closest('tr')!
  expect(within(row).getByText('状態を確認できません')).toBeTruthy()
  expect(within(row).queryByText('送信済み')).toBeNull()
})

it('未知の店舗状態を下書きと決めつけない', async () => {
  params.value = new URLSearchParams('id=r1')
  api.get.mockResolvedValue({ data: run })
  render(<HqBroadcastDetail />)
  const row = (await screen.findAllByText('本店')).map((item) => item.closest('tr')).find(Boolean)!
  expect(within(row).getByText('状態を確認できません')).toBeTruthy()
  expect(within(row).queryByText('下書き')).toBeNull()
})
