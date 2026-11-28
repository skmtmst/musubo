// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ details: vi.fn() }))
vi.mock('@/lib/api/helpers/styles', () => ({ hqStyleApi: { catalogDetails: net.details } }))
import { CatalogDetails } from './catalog-details'

const selection = { kind: 'rich_menu' as const, templateId: 'menu', versionId: 'v1' }
const data = { ...selection, name: 'メニュー', version: 2, lines: [], pages: [{ name: 'ページ1', width: 100, height: 50, areas: [{ label: '予約', destination: '予約ページ', x: 0, y: 0, width: 50, height: 50 }] }] }
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('読み込み失敗の返答は読み込み中のままにせず、再読み込みできる', async () => {
  net.details.mockResolvedValueOnce({ success: false, error: 'offline' }).mockResolvedValueOnce({ success: true, data })
  render(<CatalogDetails selection={selection} onClose={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: /もう一度/ }))
  expect(await screen.findByText('予約ページ')).toBeTruthy()
  expect(net.details).toHaveBeenCalledTimes(2)
})

it('配置の一覧が不正なら空の内容として見せず、再読み込みできる', async () => {
  net.details.mockResolvedValueOnce({ success: true, data: { ...data, pages: [{ ...data.pages[0], areas: null }] } }).mockResolvedValueOnce({ success: true, data })
  render(<CatalogDetails selection={selection} onClose={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: /もう一度/ }))
  await waitFor(() => expect(screen.getByText('予約ページ')).toBeTruthy())
  expect(net.details).toHaveBeenCalledTimes(2)
})
