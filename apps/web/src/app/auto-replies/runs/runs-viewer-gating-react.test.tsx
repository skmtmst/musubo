// @vitest-environment happy-dom
/*
 * 再実行・停止は許可が無くても理由付きで残す。読む操作とCSVは保つ。
 * 再実行の口側の staff 拒否は Worker の試験で見る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runsMock = vi.hoisted(() => vi.fn())
const staffMeMock = vi.hoisted(() => vi.fn())
const actions = vi.hoisted(() => ({ retry: vi.fn(), stop: vi.fn(), confirm: undefined as (() => void) | undefined }))

vi.mock('@/lib/api', () => ({
  api: {
    autoReplies: {
      runs: runsMock,
      get: vi.fn().mockResolvedValue({ success: true, data: { id: 'rule-1', lineAccountId: null, confirmationRevision: 1 } }),
      retryRun: actions.retry,
      stop: actions.stop,
      update: vi.fn(),
    },
    staff: { me: staffMeMock },
  },
  ApiError: class extends Error {
    readonly status: number
    constructor(status: number, message?: string) {
      super(message ?? `API error: ${status}`)
      this.name = 'ApiError'
      this.status = status
    }
  },
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/auto-replies/runs',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: vi.fn(),
}))

import AutoReplyRunsPage from './page'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import { querySupplementaryPageAction } from '@/test-utils/page-action'

vi.mock('@/components/shared/confirm-dialog', async importOriginal => {
  const { default: ConfirmDialog } = await importOriginal<typeof import('@/components/shared/confirm-dialog')>()
  return { default: (props: React.ComponentProps<typeof ConfirmDialog>) => {
    if (props.open) actions.confirm = () => { void props.onConfirm() }
    return <ConfirmDialog {...props} />
  } }
})

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function listResponse() {
  return {
    success: true,
    data: {
      rule: { id: 'rule-1', name: '予約問い合わせ', isActive: true, priorityPosition: 1 },
      summary: {
        monthHits: 1,
        totalHits: 1,
        handovers: 0,
        errors: 1,
        lastRunAt: '2026-09-15T01:00:00.000Z',
        averageResponseMs: 800,
      },
      handovers: { waiting: 0, inProgress: 0, completed: 0 },
      triggerBreakdown: [{ trigger: '予約', count: 1, share: 1 }],
      items: [
        {
          id: 'evaluation-1',
          status: 'permanent_failed',
          detail: '返信または一部の処理だけ完了しました',
          durationMs: 800,
          canRetry: true,
          friendName: '田中さん',
          inputPreview: '予約したい',
          triggerLabel: '予約',
          accountLabel: '本店',
          replyStatus: 'accepted',
          actionSummary: { executed: 1, failed: 1 },
          occurredAt: '2026-09-15T01:00:00.000Z',
        },
      ],
      pagination: { total: 1, limit: 20, offset: 0 },
    },
  }
}

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    for (let step = 0; step < 10; step += 1) await Promise.resolve()
  })
}

async function renderPage() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<AutoReplyRunsPage />)
  })
  await flush()
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
  forgetStaffIdentity()
  forgetSessionSnapshot()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

beforeEach(() => {
  forgetStaffIdentity()
  forgetSessionSnapshot()
  actions.confirm = undefined
  actions.retry.mockResolvedValue({ success: true, data: {} })
  actions.stop.mockResolvedValue({ success: true, data: {} })
  runsMock.mockResolvedValue(listResponse())
})

function buttonLabels(): string[] {
  return Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '')
}
const button = (text: string) => ([...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text) ?? querySupplementaryPageAction(text)) as HTMLButtonElement
const proxy = (mode: 'read' | 'write') => ({ impersonation: { id: 'runs-proxy', tenantId: 'tenant', mode, piiRevealed: false, startedAt: '' }, unfamiliarAt: null, stepUpMethod: 'none' as const })
async function openMenu() {
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label$="記録の操作"]')!.click() })
}

describe('R530 実行結果の出し分け（役割×操作）', () => {
  it.each([{ role: 'staff' }, { role: 'viewer' }, { role: 'owner', readOnly: true }, { role: 'admin', roleBundle: 'view_only' }])('拒否された本人%jは灰色の再実行・停止・編集を残し、起動しない', async identity => {
    staffMeMock.mockResolvedValue({ success: true, data: identity })
    await renderPage()
    for (const label of ['一時停止する', '失敗した処理をもう一度', 'ルールの編集へ']) {
      const control = button(label)
      expect(control.getAttribute('aria-disabled')).toBe('true')
      expect(control.disabled).toBe(false)
      expect(control.getAttribute('href')).toBeNull()
      await act(async () => { control.click(); control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); control.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })) })
    }
    await openMenu()
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('実行の詳細を見る')
    const retry = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-disabled="true"]')!
    expect(retry.textContent).toContain('もう一度実行')
    await act(async () => { retry.click() })
    expect(document.querySelectorAll('[data-read-only-notice]')).toHaveLength(1)
    expect(actions.retry).not.toHaveBeenCalled()
    expect(actions.stop).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
    expect(container.querySelector('[aria-label="実行の記録"]')).not.toBeNull()
    expect(buttonLabels().some((label) => label.includes('CSVで書き出す'))).toBe(true)
  })

  it('owner の失敗行には再実行・一時停止が出る', async () => {
    staffMeMock.mockResolvedValue({ success: true, data: { role: 'owner' } })
    await renderPage()

    const more = container.querySelector<HTMLButtonElement>('button[aria-label$="記録の操作"]')!
    await act(async () => { more.click() })
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('もう一度実行')
    expect(buttonLabels().some((label) => label.includes('一時停止'))).toBe(true)
    expect(document.querySelector('[data-read-only-notice]')).toBeNull()
  })

  it.each(['owner', 'admin'])('%sの正規再実行・停止はそれぞれ1回', async role => {
    staffMeMock.mockResolvedValue({ success: true, data: { role } })
    await renderPage()
    await act(async () => { button('失敗した処理をもう一度').click() })
    expect(actions.retry).toHaveBeenCalledExactlyOnceWith('evaluation-1')
    await act(async () => { button('一時停止する').click() })
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]')!
    await act(async () => { [...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === '一時停止する')!.click() })
    expect(actions.stop).toHaveBeenCalledExactlyOnceWith('rule-1', { reason: null, expectedVersion: 1 }, expect.any(String))
  })

  it('本人未知は帯と理由無しでdisabled、owner確定後は操作できる', async () => {
    let resolve!: (value: unknown) => void
    staffMeMock.mockImplementation(() => new Promise(answer => { resolve = answer }))
    await renderPage()
    for (const label of ['一時停止する', '失敗した処理をもう一度', 'ルールの編集へ', 'CSVで書き出す']) {
      expect(button(label).disabled).toBe(true)
      await act(async () => { button(label).click() })
    }
    expect(document.querySelector('[data-read-only-notice], [data-permission-locked]')).toBeNull()
    expect(button('ルールの編集へ').getAttribute('href')).toBeNull()
    expect(document.querySelector('a[href^="/auto-replies/edit"]')).toBeNull()
    expect(actions.stop).not.toHaveBeenCalled()
    expect(actions.retry).not.toHaveBeenCalled()
    await act(async () => { resolve({ success: true, data: { role: 'owner' } }) })
    expect(button('一時停止する').disabled).toBe(false)
    await act(async () => { button('失敗した処理をもう一度').click() })
    expect(actions.retry).toHaveBeenCalledTimes(1)
  })

  it('開いた停止窓をread代理で閉じ、保持したconfirmも0、writeへ戻すと停止1', async () => {
    staffMeMock.mockResolvedValue({ success: true, data: { role: 'owner' } })
    await renderPage()
    await act(async () => { button('一時停止する').click() })
    const confirm = actions.confirm!
    await act(async () => { rememberSessionSnapshot(proxy('read')) })
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
    expect(document.querySelectorAll('[data-read-only-notice]')).toHaveLength(1)
    expect(button('一時停止する').getAttribute('aria-disabled')).toBe('true')
    await act(async () => { confirm(); button('失敗した処理をもう一度').click() })
    expect(actions.stop).not.toHaveBeenCalled()
    expect(actions.retry).not.toHaveBeenCalled()
    await act(async () => { rememberSessionSnapshot(proxy('write')) })
    await act(async () => { confirm() })
    expect(actions.stop).toHaveBeenCalledTimes(1)
  })

  it('一括再実行の1件目の後にread代理へ変わったら2件目を送らない', async () => {
    staffMeMock.mockResolvedValue({ success: true, data: { role: 'owner' } })
    const response = listResponse()
    response.data.items.push({ ...response.data.items[0], id: 'evaluation-2' })
    runsMock.mockResolvedValue(response)
    actions.retry.mockImplementation(async () => { rememberSessionSnapshot(proxy('read')); return { success: true, data: {} } })
    await renderPage()
    await act(async () => { button('失敗した処理をもう一度').click() })
    expect(actions.retry).toHaveBeenCalledExactlyOnceWith('evaluation-1')
    expect(document.querySelectorAll('[data-read-only-notice]')).toHaveLength(1)
  })

  it('read代理でも詳細・失敗の絞り込み・GETからのローカルCSVを残す', async () => {
    staffMeMock.mockResolvedValue({ success: true, data: { role: 'owner' } })
    rememberSessionSnapshot(proxy('read'))
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:local-runs' })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await renderPage()
    await act(async () => { button('CSVで書き出す').click() })
    expect(runsMock).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100, offset: 0 }))
    expect(blobs).toHaveLength(1)
    expect(await blobs[0].text()).toContain('田中さん')
    await act(async () => { button('失敗だけ見る').click() })
    expect(container.textContent).toContain('田中さん')
    await openMenu()
    const detail = [...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent?.includes('実行の詳細を見る')) as HTMLElement
    await act(async () => { detail.click() })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('実行記録の中身')
    expect(actions.retry).not.toHaveBeenCalled()
    expect(actions.stop).not.toHaveBeenCalled()
  })
})

/*
 * 変更の可否は共通の出し分け（useStaffRole・canManageRole）で決める。上の描画の試験が
 * 役割ごとに押して見る。403 の権限の説明は auto-reply-runs-retry.test.tsx が見る。
 * ここは手元の保存値で決める古い形に戻さない見張りだけ。
 */
const PAGE = readFileSync(join(__dirname, '../../../v8/auto-replies/runs.tsx'), 'utf8')

describe('R530 実行結果の出し分け契約', () => {
  it('変更の可否を手元の保存値で決めない', () => {
    expect(PAGE).not.toContain("localStorage.getItem('lh_staff_role')")
  })
})

 it('四つの集計に項目別の印を表示する', async () => {
  staffMeMock.mockResolvedValue({ success: true, data: { role: 'owner' } })
  await renderPage()
  const labels = Array.from(container.querySelectorAll('[data-kpi-label]'))
  expect(labels).toHaveLength(4)
  const icons = labels.map(label => label.querySelector('[data-kpi-icon] svg'))
  expect(icons.every(Boolean)).toBe(true)
  expect(new Set(icons.map(icon => icon?.getAttribute('class'))).size).toBe(4)
 })
