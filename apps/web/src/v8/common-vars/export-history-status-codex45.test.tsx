// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, commonVars: { ...actual.api.commonVars, listExports: calls.list, exportDetail: calls.detail } } }
})
import { useVarsExportPanel } from './export-panel'
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const job = { id: 'job-example', lineAccountId: 'account-a', folderId: null, ungrouped: false, status: 'running', totalCount: 2, processedCount: 1, rowCount: null, byteSize: null, createdBy: 'actor', createdByName: '見本', createdAt: '2026-09-01T00:00:00Z', startedAt: null, finishedAt: null, expiresAt: null, failureReason: null, downloadUrl: null }
function Panel() { const panel = useVarsExportPanel({ accountId: 'account-a', folderId: null }); return <>{panel.action}{panel.status}</> }
let host: HTMLDivElement, root: Root
beforeEach(() => { vi.clearAllMocks(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers() })
async function render() { await act(async () => root.render(<Panel />)) }

describe('共通情報の書き出し状況', () => {
  it('履歴の読み込み失敗を知らせ、再試行で履歴を表示する', async () => {
    calls.list.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ success: true, data: [job] })
    await render()
    expect(host.textContent).toContain('書き出し履歴を読み込めませんでした。')
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'もう一度読み込む')!
    await act(async () => retry.click())
    expect(host.textContent).not.toContain('書き出し履歴を読み込めませんでした。')
    expect(host.textContent).toContain('書き出し中')
  })
})
