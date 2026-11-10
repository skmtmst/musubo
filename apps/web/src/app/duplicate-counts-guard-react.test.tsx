// @vitest-environment happy-dom
/*
 * m22d: 同じ「○件」が1画面に3回以上出ないこと（design-lint k=8 の固定）。
 *
 * 件数は「数字のカード」か「一覧の件数」のどちらか1か所に集約する。
 * フォルダの見出し・タブ・見出しの横・一覧の下で同じ数を繰り返さない。
 * 数え方は lint と同じ正規表現（/(\d[\d,]*)\s*件/）。textContent は innerText
 * より広い（隠れた文も含む）ので、ここで通れば lint でも通る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const fns = vi.hoisted(() => ({
  autoRepliesList: vi.fn(),
  autoRepliesSummary: vi.fn(),
  autoRepliesRuns: vi.fn(),
  templatesList: vi.fn(),
  foldersList: vi.fn(),
  friendAddRulesList: vi.fn(),
  friendAddRulesRuns: vi.fn(),
  friendAddRulesGet: vi.fn(),
  friendMigrationsJobs: vi.fn(),
  ecIdentity: vi.fn(),
  opsAudit: vi.fn(),
  opsDashboard: vi.fn(),
  opsMe: vi.fn(),
  opsSupportSummary: vi.fn(),
  opsSupportTickets: vi.fn(),
  opsSupportTicket: vi.fn(),
  friendsList: vi.fn(),
  conversionsPreview: vi.fn(),
  funnelsList: vi.fn(),
  nenSettings: vi.fn(),
  automationsList: vi.fn(),
  lineAccountsList: vi.fn(),
  staffMe: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      autoReplies: {
        ...actual.api.autoReplies,
        list: fns.autoRepliesList,
        summary: fns.autoRepliesSummary,
        runs: fns.autoRepliesRuns,
      },
      templates: { ...actual.api.templates, list: fns.templatesList },
      folders: { ...actual.api.folders, list: fns.foldersList },
      friendAddRules: {
        ...actual.api.friendAddRules,
        list: fns.friendAddRulesList,
        runs: fns.friendAddRulesRuns,
        get: fns.friendAddRulesGet,
      },
      friendMigrations: { ...actual.api.friendMigrations, jobs: fns.friendMigrationsJobs },
      ecCommerce: { ...actual.api.ecCommerce, operationIdentityCandidates: fns.ecIdentity },
      ops: {
        ...actual.api.ops,
        audit: fns.opsAudit,
        dashboard: fns.opsDashboard,
        me: fns.opsMe,
        support: {
          ...(actual.api.ops as Record<string, unknown>).support as object,
          summary: fns.opsSupportSummary,
          tickets: fns.opsSupportTickets,
          ticket: fns.opsSupportTicket,
        },
      },
      friends: { ...actual.api.friends, list: fns.friendsList },
      conversions: { ...actual.api.conversions, previewDefinition: fns.conversionsPreview },
      analytics: { ...actual.api.analytics, v6Funnels: { list: fns.funnelsList } },
      nenCampaigns: { ...actual.api.nenCampaigns, settings: fns.nenSettings },
      automations: { ...actual.api.automations, list: fns.automationsList },
      lineAccounts: { ...actual.api.lineAccounts, list: fns.lineAccountsList },
      staff: { ...actual.api.staff, me: fns.staffMe },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/',
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'visual-qa-account',
    selectedAccount: { id: 'visual-qa-account', name: '画面確認アカウント' },
    accounts: [{ id: 'visual-qa-account', name: '画面確認アカウント' }],
    loading: false,
    accountLoading: false,
  }),
}))

vi.mock('@/components/shell/page-chrome', async (importOriginal: () => Promise<typeof import('@/components/shell/page-chrome')>) => {
  const actual = await importOriginal()
  return { ...actual, usePageTitle: () => {} }
})

vi.mock('@/components/ops/knowledge-ticket', () => ({
  KnowledgeReferences: () => null,
  TicketKnowledge: () => null,
}))

import {
  AUTO_REPLIES,
  AUTO_REPLY_FOLDERS,
  AUTO_REPLY_RUNS,
  FRIEND_ADD_RUNS,
  EC_IDENTITY_CANDIDATES,
  CONVERSION_DEFINITION_PREVIEW,
} from '../../../../scripts/visual-qa/fixtures.mjs'

import AutoRepliesPage from './auto-replies/page'
import AutoReplyRunsPage from './auto-replies/runs/page'
import FriendAddSettingsPage from './friend-add-settings/page'
import FriendAddRunsPage from './friend-add-settings/runs/page'
import IdentityCandidatesPage from './ec-commerce/identity-candidates/page'
import MigrationsPage from './friends/migrations/page'
import OpsAuditPage from './ops/audit/page'
import OpsDashboardPage from './ops/dashboard/page'
import OpsSupportPage from './ops/support/page'
import NewAffiliatePage from './affiliates/new/page'
import NewConversionPage from './conversions/new/page'
import PendingInboxCard from '../components/support/pending-inbox-card'

vi.mock('@/components/identity/identity-review', async (importOriginal: () => Promise<typeof import('@/components/identity/identity-review')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useIdentityReview: () => ({
      state: 'ready',
      items: [
        {
          id: 'ec-identity-1',
          left: { label: '見本 170', detail: 'customer-3', attributes: [{ label: 'メール', valuePreview: 'mi***@example.com' }] },
          right: { label: '見本 162', lineAccountName: '画面確認アカウント' },
          evidenceSummary: ['メールアドレス', '氏名'],
          confidence: { label: 'high', score: 94 },
          detectedAt: '2026-08-25T08:40:00.000Z',
        },
        {
          id: 'ec-identity-2',
          left: { label: '見本 114', detail: 'customer-7', attributes: [{ label: '電話', valuePreview: '***1034' }] },
          right: { label: '見本 113', lineAccountName: '画面確認アカウント' },
          evidenceSummary: ['電話番号', '氏名'],
          confidence: { label: 'medium', score: 82 },
          detectedAt: '2026-08-25T08:12:00.000Z',
        },
        {
          id: 'ec-identity-3',
          left: { label: '見本 175', detail: 'customer-8', attributes: [] },
          right: { label: null, lineAccountName: null },
          evidenceSummary: ['メールアドレス'],
          confidence: { label: 'medium', score: 71 },
          detectedAt: '2026-08-25T07:50:00.000Z',
        },
      ],
      total: 3,
      hasMore: false,
      loadingMore: false,
      loadMore: () => {},
      select: () => {},
      openDialog: () => {},
      detail: null,
      failure: null,
    }),
  }
})

vi.mock('@/app/ec-commerce/ec-tabs-view', () => ({
  default: () => null,
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  vi.clearAllMocks()
  // 口の見本以外は即失敗させる（実網に出ない・EPERM待ちをしない）。
  vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
  fns.staffMe.mockResolvedValue({ success: true, data: { id: 'staff-1' } })
  fns.lineAccountsList.mockResolvedValue({ success: true, data: [{ id: 'visual-qa-account', name: '画面確認アカウント' }] })
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (root) { act(() => { root!.unmount() }); root = null }
  host.remove()
  document.body.innerHTML = ''
})

async function renderPage(element: React.ReactElement) {
  root = createRoot(host)
  await act(async () => {
    root!.render(element)
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  })
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  })
}

/** lint k=8 と同じ数え方。同じ「N件」が3回以上出たら落とす（0件は除く）。 */
function expectNoDuplicateCounts(excludePagination = true) {
  const content = host.cloneNode(true) as HTMLElement
  if (excludePagination) content.querySelector('[data-pagination]')?.remove()
  const text = content.textContent ?? ''
  const counts: Record<string, number> = {}
  for (const m of text.matchAll(/(\d[\d,]*)\s*件(?!\s*(?:ごと|あたり))/g)) counts[m[1]] = (counts[m[1]] || 0) + 1
  const flagged = Object.entries(counts).filter(([n, c]) => c >= 3 && n !== '0')
  expect(flagged).toEqual([])
}

const RULES = [
  { id: 'rule-shop', name: '店頭QRの初回案内', folderName: '店頭', priority: 1, isFallback: false, status: 'published', routeNames: ['店頭QRコード'], scenarioName: '新規登録7日間フォロー', matchedLast7Days: 41, definition: { actions: [], messageType: 'text', messageText: '来店クーポン' } },
  { id: 'rule-instagram', name: '広告からの初回案内', folderName: '広告', priority: 2, isFallback: false, status: 'published', routeNames: ['Instagramプロフィール'], scenarioName: '新規登録7日間フォロー', matchedLast7Days: 24, definition: { actions: [], messageType: 'text', messageText: '資料' } },
  { id: 'rule-referral', name: '紹介キャンペーンの初回案内', folderName: '紹介', priority: 3, isFallback: false, status: 'published', routeNames: ['紹介'], scenarioName: '新規登録7日間フォロー', matchedLast7Days: 9, definition: { actions: [], messageType: 'text', messageText: '特典' } },
  { id: 'rule-fallback', name: '経路が分からなかった人', folderName: null, priority: 999999, isFallback: true, status: 'published', routeNames: [], scenarioName: '共通のあいさつ', matchedLast7Days: 12, definition: { actions: [], messageType: 'text', messageText: 'ありがとう' } },
]

describe('m22d 同じ件数は1画面に1か所', () => {
  it('auto-replies は有効・要確認の件数を重ねず、名前を1行にする', async () => {
    fns.autoRepliesList.mockResolvedValue({ success: true, data: AUTO_REPLIES })
    fns.templatesList.mockResolvedValue({ success: true, data: [] })
    fns.autoRepliesSummary.mockResolvedValue({ success: true, data: { conflicts: [], conflictCount: 3, receiveSourceCounts: null, matchedLast28Days: null } })
    fns.foldersList.mockResolvedValue({ success: true, data: AUTO_REPLY_FOLDERS, unfiledCount: 0 })
    await renderPage(React.createElement(AutoRepliesPage))
    expectNoDuplicateCounts()
    expect(host.querySelector('[data-list-name]')?.textContent).not.toContain('ほか3つ')
  })

  it('auto-replies/runs は失敗した行に理由を出す（「失敗1件」を出さない）', async () => {
    fns.autoRepliesRuns.mockResolvedValue({ success: true, data: { ...AUTO_REPLY_RUNS, pagination: { total: 4, limit: 20, offset: 0 } } })
    await renderPage(React.createElement(AutoReplyRunsPage))
    expectNoDuplicateCounts()
    expect(host.textContent).toContain('LINEへの返信を受け付けてもらえませんでした')
  })

  it('friend-add-settings は数の帯を重ねず、のページ送りに表示範囲を出す', async () => {
    fns.friendAddRulesList.mockResolvedValue({
      success: true,
      data: {
        items: RULES,
        summary: { rules: 4, active: 3, recentAdds: 86, captured: 74, unknownRoute: 12, delivered: 84, failed: 2 },
        options: { folders: [{ name: '店頭' }, { name: '広告' }, { name: '紹介' }] },
        total: 4,
        folderCounts: [
          { name: '店頭', count: 1 },
          { name: '広告', count: 1 },
          { name: '紹介', count: 1 },
          { name: null, count: 1 },
        ],
      },
    })
    await renderPage(React.createElement(FriendAddSettingsPage))
    const pagination = host.querySelector('[data-pagination]')!
    expect(pagination.textContent).toContain('4件中 1〜4件')
    // の範囲表示を除き、すべての件数の重複を引き続き見張る。
    expectNoDuplicateCounts(true)
    expect(host.textContent).toContain('初回案内')
  })

  it('friend-add-settings/runs は失敗した実行の行に理由を出す', async () => {
    /* 見本の5行目（再追加・Instagram）は V8 の絵  のための行。経路の内訳が「1件」を4つ並べるのはデータの都合なので、
       この見張り（同じ件数の繰り返し）は従来の4行で見る。 */
    fns.friendAddRulesRuns.mockResolvedValue({ success: true, data: { ...FRIEND_ADD_RUNS, items: FRIEND_ADD_RUNS.items.slice(0, 4) } })
    fns.friendAddRulesGet.mockResolvedValue({ success: true, data: { rule: { id: 'rule-shop', version: 1 } } })
    await renderPage(React.createElement(FriendAddRunsPage))
    expectNoDuplicateCounts()
    expect(host.textContent).toContain('失敗した処理')
  })

  it('ec-commerce/identity-candidates は売上カードの副文で件数を繰り返さない', async () => {
    fns.ecIdentity.mockResolvedValue({ success: true, data: EC_IDENTITY_CANDIDATES })
    await renderPage(React.createElement(IdentityCandidatesPage))
    expectNoDuplicateCounts()
    expect(host.textContent).not.toContain('この24件ぶん')
  })

  it('friends/migrations は行の単位を見出しに寄せ、一覧の件数は ListRange に出す', async () => {
    fns.friendMigrationsJobs.mockResolvedValue({
      success: true,
      data: [
        { id: 'import-1', kind: 'import', line_account_id: 'visual-qa-account', total_count: 231, update_count: 34, conflict_count: 3, status: 'completed', created_by_name: '見本 太郎', created_at: '2026-09-03T05:20:00.000Z' },
        { id: 'import-2', kind: 'import', line_account_id: 'visual-qa-account', total_count: 231, update_count: 34, conflict_count: 3, status: 'previewed', created_by_name: '見本 25', created_at: '2026-09-03T02:05:00.000Z' },
        { id: 'export-1', kind: 'export', line_account_id: 'visual-qa-account', row_count: 231, status: 'expired', created_by_name: '見本 25', created_at: '2026-09-02T10:40:00.000Z', expires_at: '2026-09-09T10:40:00.000Z' },
      ],
    })
    await renderPage(React.createElement(MigrationsPage))
    expectNoDuplicateCounts()
    expect(host.querySelectorAll('tbody tr')).toHaveLength(3)
    expect(host.textContent).toContain('書き出し・取り込みの履歴')
  })

  it('ops/audit は一覧の件数の1か所（見出しの横に出さない）', async () => {
    fns.opsAudit.mockResolvedValue({
      success: true,
      data: [
        { id: 'a1', staff_name: '検証 太郎', tenant_name: '検証商事', action: 'tenant.status.change', reason: '検証用', detail: '{}', ip: null, visible_to_tenant: 1, created_at: '2026-09-05T10:00:00+09:00' },
        { id: 'a2', staff_name: '検証 太郎', tenant_name: null, action: 'ticket.view', reason: null, detail: '{}', ip: null, visible_to_tenant: 0, created_at: '2026-09-06T10:00:00+09:00' },
      ],
      total: 2,
    })
    await renderPage(React.createElement(OpsAuditPage))
    expectNoDuplicateCounts()
    expect(host.querySelector('[title="2件中 1〜2件を表示"]')).not.toBeNull()
  })

  it('ops/dashboard はプラン別の行を割合だけにする', async () => {
    fns.opsDashboard.mockResolvedValue({
      success: true,
      data: {
        period: 'month', periodLabel: '2026年9月', pricing: 'list_price', lastSyncedAt: null,
        ai: { callsThisMonth: 12, draftsThisMonth: 9, articlesActive: 3 },
        kpis: {
          revenueThisMonth: 129200, revenueDelta: 9800, refundsThisMonth: 0,
          contractMonthlyTotal: 129200, filledByListPriceCount: 2, active: 4,
          byPlan: { light: 1, standard: 2, pro: 1 },
          trialing: 2, newInPeriod: 1, churnInPeriod: 0, churnRate: 0,
        },
        revenueByMonth: [{ month: '2026-09', label: '9月', yen: 129200, current: true }],
        planShare: {
          total: 6,
          rows: [
            { key: 'light', label: 'ライト', count: 1, percent: 17 },
            { key: 'standard', label: 'スタンダード', count: 2, percent: 33 },
            { key: 'pro', label: 'プロ', count: 1, percent: 17 },
            { key: 'trial', label: 'トライアル', count: 2, percent: 33 },
          ],
        },
        alerts: { pastDue: 1, trialEndingSoon: 1, lineTokenExpiring: 0, unansweredTickets: 2 },
        tickets: { newCount: 2, inProgressCount: 1, avgFirstReplyMinutes: 95, closedInPeriod: 5 },
        lineRegistration: { registered: 8, total: 10, unregisteredCount: 2 },
        usage: [],
      },
    })
    fns.opsMe.mockResolvedValue({ success: true, data: { readOnly: true } })
    await renderPage(React.createElement(OpsDashboardPage))
    expectNoDuplicateCounts()
  })

  it('ops/support は一覧の件数と詳細の来歴を書き分ける', async () => {
    fns.opsSupportSummary.mockResolvedValue({
      success: true,
      data: {
        byStage: { all: 51, new: 4, in_progress: 7, waiting: 2, resolved: 38, closed: 0 },
        kpis: { untouched: 1, untouchedFromLine: 0, avgFirstReplyMinutes: 95, prevAvgFirstReplyMinutes: 120, resolutionRate: 80, prevResolutionRate: 75, avgResolutionMinutes: 300, prevAvgResolutionMinutes: 360 },
      },
    })
    fns.opsSupportTickets.mockResolvedValue({
      success: true,
      data: [
        { id: 'visual-ticket-1', ticketNo: 1, ticketLabel: 'No.1', tenantId: 'visual-tenant-1', tenantName: '検証商事', staffName: '検証 一郎', kind: 'usage', kindLabel: '使い方', subject: '検証用の問い合わせ', subjectAuto: false, stage: 'new', stageLabel: '新規', priority: 'high', priorityLabel: '高', channel: 'admin', channelLabel: '管理画面', lastMessageAt: '2026-09-06T10:00:00+09:00', createdAt: '2026-09-06T10:00:00+09:00', updatedAt: '2026-09-06T10:00:00+09:00' },
        { id: 'visual-ticket-2', ticketNo: 2, ticketLabel: 'No.2', tenantId: 'visual-tenant-2', tenantName: '見本物産', staffName: '—', kind: 'bug', kindLabel: '不具合', subject: '検証用の対応中の問い合わせ', subjectAuto: true, stage: 'in_progress', stageLabel: '対応中', priority: 'medium', priorityLabel: '中', channel: 'line', channelLabel: 'LINE', lastMessageAt: '2026-09-05T12:00:00+09:00', createdAt: '2026-09-05T10:00:00+09:00', updatedAt: '2026-09-05T12:00:00+09:00' },
      ],
      total: 2,
    })
    fns.opsSupportTicket.mockResolvedValue({
      success: true,
      data: {
        ticket: { id: 'visual-ticket-1', ticketNo: 1, ticketLabel: 'No.1', tenantId: 'visual-tenant-1', tenantName: '検証商事', staffName: '検証 一郎', staffRole: 'owner', kind: 'usage', subject: '検証用の問い合わせ', subjectAuto: false, stage: 'new', stageLabel: '新規', priority: 'high', priorityLabel: '高', channel: 'admin', channelLabel: '管理画面', tenantPlanKey: 'standard', tenantPlanStatus: 'active', body: '本文', attachments: [], createdAt: '2026-09-06T10:00:00+09:00' },
        tenant: { accountCount: 2, staffCount: 5, staffWithLine: 3, pastTickets: 2, pastOpen: 1 },
        messages: [{ id: 'visual-msg-1', authorKind: 'tenant', authorName: '検証 一郎', body: '本文', attachments: [], createdAt: '2026-09-06T10:00:00+09:00' }],
        draft: null,
        ai: { available: false },
        knowledge: null,
      },
    })
    await renderPage(React.createElement(OpsSupportPage))
    expectNoDuplicateCounts()
    expect(host.querySelector('[title*="これまで2のうち未解決1件"]')).not.toBeNull()
  })

  it('affiliates/new は「1件あたり」を注記と欄名で重ねない', async () => {
    fns.friendsList.mockResolvedValue({ success: true, data: { items: [], total: 231 } })
    await renderPage(React.createElement(NewAffiliatePage))
    expectNoDuplicateCounts()
    expect(host.textContent).not.toContain('1件あたりの金額を決めます')
  })

  it('conversions/new は「1件」を試算の1か所に集約する', async () => {
    fns.conversionsPreview.mockResolvedValue({ success: true, data: CONVERSION_DEFINITION_PREVIEW })
    fns.funnelsList.mockResolvedValue({ success: true, data: [] })
    fns.nenSettings.mockResolvedValue({ success: true, data: [] })
    fns.automationsList.mockResolvedValue({ success: true, data: [] })
    await renderPage(React.createElement(NewConversionPage))
    expectNoDuplicateCounts()
    expect(host.textContent).not.toContain('買うたびに1件')
    expect(host.textContent).not.toContain('1件ごとの金額です')
  })

  it('ホームの受信プレビューは件数を小カードの1か所に集約する', async () => {
    vi.stubGlobal('fetch', (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/support/inbox')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: {
              items: [1, 2, 3, 4, 5].map((n) => ({
                id: `inbox-${n}`,
                channel: 'line',
                customerName: `確認 ${n}`,
                preview: '予約について確認したいです',
                lastIncomingAt: '2026-09-07T04:30:00.000Z',
              })),
              summary: { total: 5, line: 1, email: 4, emailUnread: 4, oldestWaitMinutes: 9110 },
            },
          }),
        })
      }
      return Promise.reject(new TypeError('fetch failed'))
    })
    await renderPage(React.createElement(PendingInboxCard))
    expectNoDuplicateCounts()
    expect(host.textContent).not.toContain('5件')
  })
})
