// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import OpsAuditPage from './page'
import type { OpsAuditRow } from '@/lib/api'
import styles from '@/v8/ops/audit.module.css'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 現役V8の日時の欄と、監査R159（CSVの全件）を守る。 */

const row = (index: number): OpsAuditRow => ({
  id: `log-${index}`,
  created_at: '2026-09-27T03:00:00.000Z',
  staff_name: '運営 太郎',
  tenant_name: '株式会社サンプル',
  action: auditAction,
  reason: 'テスト',
  ip: '203.0.113.1',
  visible_to_tenant: false,
} as OpsAuditRow)

let host: HTMLDivElement
let root: Root
let calls: Array<{ url: string }>
let totalRows = 0
let auditAction = 'tenant.status.change'
let readOnly = false

beforeEach(() => {
  calls = []
  totalRows = 120
  auditAction = 'tenant.status.change'
  readOnly = false
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push({ url })
    if (new URL(url).pathname === '/api/ops/me') return new Response(JSON.stringify({ success: true, data: { id: 'operator', readOnly } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const params = new URL(url).searchParams
    const limit = Number(params.get('limit') ?? '50')
    const offset = Number(params.get('offset') ?? '0')
    const slice = Array.from({ length: Math.max(0, Math.min(limit, totalRows - offset)) }, (_, i) => row(offset + i))
    return new Response(JSON.stringify({ success: true, data: slice, total: totalRows }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function flush() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve() })
}

describe('未知の操作名', () => {
  it('継承名でも一覧と記録の詳細に操作名を出す', async () => {
    auditAction = 'constructor'
    totalRows = 1
    await act(async () => { root.render(<OpsAuditPage />) })
    await flush()
    const button = host.querySelector<HTMLButtonElement>('[data-part="row-name"]')!
    expect(button.textContent).toBe('constructor')
    expect(button.title).toBe('constructor')
    await act(async () => { button.click() })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('constructor')
  })
})

describe('日付範囲の折返し（R158）', () => {
  it('省略される長い操作名も、タイトルで全文を確認できる', async () => {
    auditAction = 'impersonation.write'
    await act(async () => { root.render(<OpsAuditPage />) })
    await flush()
    const button = [...host.querySelectorAll<HTMLButtonElement>('[data-part="row-name"]')][0]
    expect(button.textContent).toBe('代理ログイン（書き込み）')
    expect(button.title).toBe('代理ログイン（書き込み）')
  })
  it.each([true, false])('運営メンバーの閲覧のみ=%s に応じて記録のコピーを出し分ける', async (value) => {
    readOnly = value
    await act(async () => { root.render(<OpsAuditPage />) })
    await flush()
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-part="row-name"]')!.click() })
    expect(document.querySelector('[aria-label="この記録をコピー"]') !== null).toBe(!value)
  })
  it('理由の全文にIPと公開範囲を添え、脚注で全件数と表示範囲を確認できる', async () => {
    await act(async () => { root.render(<OpsAuditPage />) })
    await flush()
    const titles = [...host.querySelectorAll<HTMLElement>('[title]')].map(node => node.title)
    expect(titles).toContain('テスト・IP 203.0.113.1・運営のみ')
    const reason = host.querySelector('td[title="テスト・IP 203.0.113.1・運営のみ"]')!
    expect(reason.getAttribute('data-cell-grow')).toBe('true')
    expect(reason.textContent).toBe('テスト')
    const operation = [...host.querySelectorAll('th')].find(cell => cell.textContent === '操作')!
    expect(operation.querySelector('.sr-only')).toBeNull()
    expect(titles).toContain('120件中 1〜50件を表示')
  })
  it('開始・終了の欄はV8の折返す道具の段で幅を守る', async () => {
    await act(async () => { root.render(<OpsAuditPage />) })
    await flush()
    const from = document.querySelector('button[aria-label="開始日"]')!
    expect(from).not.toBeNull()
    expect(document.querySelector('button[aria-label="終了日"]')).not.toBeNull()
    const to = document.querySelector('button[aria-label="終了日"]')!
    expect(from.closest('[role="group"]')?.textContent).toContain('開始日')
    expect(to.closest('[role="group"]')?.textContent).toContain('終了日')
    expect(from.closest('[role="group"]')).not.toBe(to.closest('[role="group"]'))
  })
})

describe('日時は1行（B23）', () => {
  it('日時のセルは1つの文で、折らない印を持つ', async () => {
    totalRows = 1
    await act(async () => { root.render(<OpsAuditPage />) })
    await flush()
    const cell = host.querySelector('tbody tr td')
    expect(cell?.textContent).toBe('09/27 12:00')
    // 折返し自体は実ブラウザの写真で見る。ここでは印の結びを守る。
    expect(cell?.className.split(' ')).toContain(styles.atCell)
  })
})

describe('CSVで書き出す（R159）', () => {
  it('表示中の50件ではなく、いまの条件の全件をページを追って取得して書き出す', async () => {
    const createdUrls: Blob[] = []
    const anchorClicks: string[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob) => { createdUrls.push(blob); return 'blob:audit' })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchorClicks.push(this.download)
    })

    await act(async () => { root.render(<OpsAuditPage />) })
    await flush()
    // 範囲が画面に出る（一覧の件数の1か所。見出しの横では繰り返さない m22d）
    expect(host.querySelector('[title="120件中 1〜50件を表示"]')).not.toBeNull()
    expect(host.textContent).not.toContain('いまの条件の全')

    const csvButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('CSVで書き出す'))!
    await act(async () => { csvButton.click() })
    await flush()

    // 1ページ50件ではなく、大きい limit で全件を取りにいく
    const exportCalls = calls.filter((c) => c.url.includes('limit=500'))
    expect(exportCalls.length).toBeGreaterThanOrEqual(1)
    const blob = createdUrls[0]
    const text = await blob.text()
    // 見出し 1 行 + 全 120 行
    expect(text.trim().split('\n').length).toBe(121)
    expect(anchorClicks[0]).toMatch(/^運営の操作履歴_\d{4}-\d{2}-\d{2}\.csv$/)
    expect(host.textContent).toContain('いまの条件の 120 件を書き出しました')
  })
})
