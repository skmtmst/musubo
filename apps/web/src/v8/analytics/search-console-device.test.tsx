// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  const metric = { clicks: 4, impressions: 10, ctr: 0.4, position: 2 }
  return { ...actual, api: { ...actual.api, searchConsole: { performance: vi.fn(async () => ({ success: true, data: { status: 'connected', siteUrl: 'https://example.com/', startDate: '2026-11-01', endDate: '2026-11-26', rangeDays: 28, summary: metric, previousSummary: metric, daily: [], queries: [], pages: [], devices: ['MOBILE', 'constructor', 'toString', '__proto__', 'future'].map(key => ({ key, ...metric })), fetchedAt: '2026-11-26T00:00:00Z' } })) } } }
})
import SearchConsoleV8, { deviceLabel } from './search-console'
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('未知のデバイスも画面とCSVで共通の案内にする', async () => {
  let csvBlob: Blob | undefined
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { csvBlob = blob as Blob; return 'blob:test' })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(<SearchConsoleV8 />)
  const table = await screen.findByRole('table', { name: 'デバイス別のクリック数' })
  expect(within(table).getByText('スマートフォン')).toBeTruthy()
  expect(within(table).getAllByText('その他のデバイス')).toHaveLength(4)
  fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' }))
  expect(csvBlob).toBeDefined()
  const csv = await csvBlob!.text()
  expect(csv.match(/その他のデバイス/g)).toHaveLength(4)
  expect(csv).toContain('スマートフォン')
  expect(csv).not.toContain('function Object')
  expect(deviceLabel('DESKTOP')).toBe('パソコン')
})
