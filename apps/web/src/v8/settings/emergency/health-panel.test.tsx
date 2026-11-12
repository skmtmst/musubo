// @vitest-environment happy-dom
/*
 * 健全性チェックの表を、口（api.operations）のモックの応答から描いて見る。
 *
 * - サーバーが保存した9つの結果を、決まった並びの9行へ1つずつ対応づける。
 * - 判定と「最後の確認」は同じ結果から採る。10分より古い結果は「古い確認」にし、
 *   結果が無い「未確認」と分ける。
 * - 初回だけ読み込み中を出し、5分ごとの取り直しでは前の結果を残す。
 *   全体の判定は最初の読み込みが終わってから知らせる。
 * - 下の「止めた回数」は配備の記録を数えない。
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OperationHealthCheckKey, OperationHealthSnapshot, OperationHistoryEntry } from '@/lib/api'
import { HealthPanelV8 } from './health'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const calls = vi.hoisted(() => ({
  health: [] as string[],
  history: [] as number[],
  healthResponse: null as null | (() => Promise<unknown>),
  historyResponse: null as null | (() => Promise<unknown>),
  alertsResponse: null as null | (() => Promise<unknown>),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      operations: {
        ...actual.api.operations,
        health: (accountId: string) => {
          calls.health.push(accountId)
          return (calls.healthResponse?.() ?? Promise.resolve({ success: false, error: 'no handler' })) as Promise<never>
        },
        alerts: () => (calls.alertsResponse?.() ?? Promise.resolve({ success: true, data: [] })) as Promise<never>,
        history: (limit: number) => {
          calls.history.push(limit)
          return (calls.historyResponse?.() ?? Promise.resolve({ success: true, data: [] })) as Promise<never>
        },
        lineReceipts: () => Promise.resolve({ success: true, data: [] }) as Promise<never>,
      },
    },
  }
})

/** 板の9行の並び。 */
const ROW_TITLES = [
  'LINE のアカウントとつながっているか',
  '5分ごとの確認が動いているか',
  'API・外部連携',
  '送れる数の上限',
  '友だちの急な減り',
  'Webhook が届いているか',
  '配信が送れているか',
  '保存と送信のしくみ',
  'トークンの期限',
]

/** サーバーの結果の種類 → 画面の行。 */
const ROW_OF_KEY: Record<OperationHealthCheckKey, string> = {
  line_connection: 'LINE のアカウントとつながっているか',
  monitoring_heartbeat: '5分ごとの確認が動いているか',
  external_integrations: 'API・外部連携',
  message_quota: '送れる数の上限',
  friend_change: '友だちの急な減り',
  webhook: 'Webhook が届いているか',
  dispatch_jobs: '配信が送れているか',
  infra_canary: '保存と送信のしくみ',
  credential_expiry: 'トークンの期限',
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

function snapshot(results: Array<{ checkKey: OperationHealthCheckKey; status: 'normal' | 'warning' | 'danger'; summary: string; observedAt: string }>): { success: true; data: OperationHealthSnapshot } {
  const now = new Date().toISOString()
  return {
    success: true,
    data: {
      latestRun: {
        id: 'run-1',
        lineAccountId: 'account-1',
        scopeKey: 'account-1',
        windowStartedAt: now,
        source: 'scheduled',
        status: 'completed',
        overallStatus: 'warning',
        actorId: null,
        startedAt: now,
        completedAt: now,
        errorMessage: null,
        results: results.map((result, index) => ({
          id: `result-${index}`,
          runId: 'run-1',
          value: null,
          threshold: null,
          source: 'fixture',
          ...result,
        })),
      },
      overallStatus: 'warning',
      lastCheckedAt: now,
      nextCheckAt: null,
      serverNow: now,
    },
  } as { success: true; data: OperationHealthSnapshot }
}

function rows(): HTMLElement[] {
  const table = screen.getByRole('table', { name: '確かめていること' })
  return within(table).getAllByRole('row').slice(1)
}

function rowOf(title: string): HTMLElement {
  const row = rows().find((item) => within(item).queryByText(title))
  expect(row, `${title} の行がある`).toBeDefined()
  return row as HTMLElement
}

function kpiNumber(title: string): string | null {
  const label = [...document.querySelectorAll('[data-kpi-label]')].find((item) => item.textContent === title)
  return label?.closest('[data-kpi-presentation]')?.querySelector('[data-kpi-number]')?.textContent ?? null
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

let intervals: Array<{ delay: number; run: () => void }> = []

beforeEach(() => {
  intervals = []
  const original = window.setInterval.bind(window)
  vi.spyOn(window, 'setInterval').mockImplementation(((handler: () => void, delay?: number) => {
    intervals.push({ delay: delay ?? 0, run: handler })
    return original(() => undefined, 1_000_000_000)
  }) as typeof window.setInterval)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  calls.health = []
  calls.history = []
  calls.healthResponse = null
  calls.historyResponse = null
  calls.alertsResponse = null
})

describe('健全性チェックの表', () => {
  it('9行を板の並びで出し、サーバーの9種類の結果をそれぞれの行へ対応づける', async () => {
    const keys = Object.keys(ROW_OF_KEY) as OperationHealthCheckKey[]
    calls.healthResponse = () => Promise.resolve(snapshot(keys.map((checkKey) => ({
      checkKey, status: 'warning', summary: `要約-${checkKey}`, observedAt: minutesAgo(1),
    }))))
    render(<HealthPanelV8 canManage accountId="account-1" manualRunRequest={0} onSeverity={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('要約-webhook')).toBeTruthy())

    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['確かめていること', '判定', '最後の確認', '判定の見方'])
    expect(rows().map((row) => ROW_TITLES.find((title) => within(row).queryByText(title)))).toEqual(ROW_TITLES)
    for (const key of keys) {
      const row = rowOf(ROW_OF_KEY[key])
      expect(within(row).getByText(`要約-${key}`)).toBeTruthy()
      expect(within(row).getByText('注意')).toBeTruthy()
    }
    expect(calls.health).toEqual(['account-1'])
    expect(screen.getByText(`全体の状態：注意 ${keys.length} 件`)).toBeTruthy()
  })

  it('判定と最後の確認は同じ結果から採り、10分より古いものだけ「古い確認」にして未確認と分ける', async () => {
    calls.healthResponse = () => Promise.resolve(snapshot([
      { checkKey: 'webhook', status: 'normal', summary: '受け取れています', observedAt: minutesAgo(11) },
      { checkKey: 'dispatch_jobs', status: 'normal', summary: '送れています', observedAt: minutesAgo(9) },
    ]))
    render(<HealthPanelV8 canManage accountId="account-1" manualRunRequest={0} onSeverity={vi.fn()} />)
    await waitFor(() => expect(within(rowOf('Webhook が届いているか')).getByText('古い確認')).toBeTruthy())

    const old = rowOf('Webhook が届いているか')
    expect(old.textContent).toContain('（11分前）')
    expect(within(old).queryByText('正常')).toBeNull()

    const fresh = rowOf('配信が送れているか')
    expect(within(fresh).getByText('正常')).toBeTruthy()
    expect(within(fresh).queryByText('古い確認')).toBeNull()

    const missing = rowOf('保存と送信のしくみ')
    expect(within(missing).getByText('未確認')).toBeTruthy()
    expect(within(missing).queryByText('古い確認')).toBeNull()
  })

  it('異常があれば表の上に開いている件数を出す', async () => {
    calls.healthResponse = () => Promise.resolve(snapshot([]))
    const alert = (id: string) => ({
      id, lineAccountId: 'account-1', checkKey: 'webhook', status: 'open', severity: 'warning',
      summary: `異常-${id}`, sourceRunId: 'run-1', firstDetectedAt: minutesAgo(30), lastDetectedAt: minutesAgo(1),
      acknowledgedAt: null, acknowledgedById: null, acknowledgementNote: null, resolvedAt: null, version: 1, reopenedCount: 0,
      createdAt: minutesAgo(30), updatedAt: minutesAgo(1),
      notification: { queued: 0, sending: 0, sent: 1, failed: 0, unconfigured: 0, total: 1 }, events: [],
    })
    calls.alertsResponse = () => Promise.resolve({ success: true, data: [alert('a'), alert('b')] })
    render(<HealthPanelV8 canManage accountId="account-1" manualRunRequest={0} onSeverity={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: '開いている異常 2 件' })).toBeTruthy()
  })

  it('開いている異常は重要度順、同じ重要度では新しい順に示す', async () => {
    calls.healthResponse = () => Promise.resolve(snapshot([]))
    const alert = (id: string, severity: string, minutes: number) => ({
      id, lineAccountId: 'account-1', checkKey: 'webhook', status: 'open', severity,
      summary: `異常-${id}`, sourceRunId: 'run-1', firstDetectedAt: minutesAgo(minutes), lastDetectedAt: minutesAgo(minutes),
      acknowledgedAt: null, acknowledgedById: null, acknowledgementNote: null, resolvedAt: null, version: 1, reopenedCount: 0,
      createdAt: minutesAgo(minutes), updatedAt: minutesAgo(minutes),
      notification: { queued: 0, sending: 0, sent: 1, failed: 0, unconfigured: 0, total: 1 }, events: [],
    })
    calls.alertsResponse = () => Promise.resolve({ success: true, data: [alert('注意', 'warning', 1), alert('古いエラー', 'danger', 30), alert('新しいエラー', 'danger', 5)] })
    render(<HealthPanelV8 canManage accountId="account-1" manualRunRequest={0} onSeverity={vi.fn()} />)
    const section = await screen.findByRole('region', { name: '開いている異常' })
    const text = section.textContent ?? ''
    for (const label of ['異常-新しいエラー', '異常-古いエラー', '異常-注意']) expect(text).toContain(label)
    expect(text.indexOf('異常-新しいエラー')).toBeLessThan(text.indexOf('異常-古いエラー'))
    expect(text.indexOf('異常-古いエラー')).toBeLessThan(text.indexOf('異常-注意'))
    expect(text).not.toContain('古い異常')
  })

  it('E33: 48時間より古い確認は日に直す（72時間前→3日前）', async () => {
    calls.healthResponse = () => Promise.resolve(snapshot([
      { checkKey: 'webhook', status: 'normal', summary: '受け取れています', observedAt: minutesAgo(3 * 24 * 60) },
    ]))
    render(<HealthPanelV8 canManage accountId="account-1" manualRunRequest={0} onSeverity={vi.fn()} />)
    const row = rowOf('Webhook が届いているか')
    await waitFor(() => expect(row.textContent).toContain('3日前'))
    expect(row.textContent).not.toContain('時間前')
  })
})

describe('読み込みと取り直し', () => {
  it('初回だけ確認中を出し、判定は読み終えてから知らせ、5分ごとの取り直しでは前の結果を残す', async () => {
    let resolveFirst: (value: unknown) => void = () => undefined
    calls.healthResponse = () => new Promise((resolve) => { resolveFirst = resolve })
    const onSeverity = vi.fn()
    render(<HealthPanelV8 canManage accountId="account-1" manualRunRequest={0} onSeverity={onSeverity} />)
    await flush()
    expect(screen.getByText('全体の状態：確認中')).toBeTruthy()
    expect(onSeverity).not.toHaveBeenCalled()

    await act(async () => {
      resolveFirst(snapshot([{ checkKey: 'webhook', status: 'warning', summary: '失敗が続いています', observedAt: minutesAgo(1) }]))
    })
    await waitFor(() => expect(screen.getByText('全体の状態：注意 1 件')).toBeTruthy())
    expect(onSeverity).toHaveBeenLastCalledWith('warning')

    // 5分ごとの取り直し（返事はまだ来ない）。前の結果のまま、確認中へ戻さない。
    calls.healthResponse = () => new Promise(() => undefined)
    const refresh = intervals.filter((entry) => entry.delay === 5 * 60 * 1000)
    expect(refresh.length).toBeGreaterThan(0)
    await act(async () => { for (const entry of refresh) entry.run() })
    await flush()
    expect(calls.health).toEqual(['account-1', 'account-1'])
    expect(screen.queryByText('全体の状態：確認中')).toBeNull()
    expect(screen.getByText('全体の状態：注意 1 件')).toBeTruthy()
  })
})

describe('下の3つの数', () => {
  it('止めた回数は停止の記録だけを数え、配備の記録は数えない', async () => {
    calls.healthResponse = () => Promise.resolve(snapshot([]))
    const entry = (id: string, historyKind: 'incident' | 'deployment') => ({
      id, historyKind, createdAt: minutesAgo(60), stoppedAt: minutesAgo(60), resolvedAt: minutesAgo(30),
    }) as unknown as OperationHistoryEntry
    calls.historyResponse = () => Promise.resolve({ success: true, data: [entry('stop-1', 'incident'), entry('deploy-1', 'deployment'), entry('deploy-2', 'deployment')] })
    render(<HealthPanelV8 canManage accountId="account-1" manualRunRequest={0} onSeverity={vi.fn()} />)
    await waitFor(() => expect(kpiNumber('止めた回数')).toBe('1'))
    expect(calls.history).toEqual([200])
  })
})
