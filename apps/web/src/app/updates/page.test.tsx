// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { PageChromeProvider, usePageChrome } from '@/components/shell/page-chrome'

const historyEnvironment = vi.hoisted(() => {
  const previous = { apiUrl: process.env.NEXT_PUBLIC_API_URL, adminKey: process.env.NEXT_PUBLIC_ADMIN_API_KEY }
  process.env.NEXT_PUBLIC_API_URL ||= 'http://worker.test'
  process.env.NEXT_PUBLIC_ADMIN_API_KEY = 'fixture-admin-key'
  return previous
})
import UpdatesPage from './page'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
afterAll(() => {
  if (historyEnvironment.adminKey === undefined) delete process.env.NEXT_PUBLIC_ADMIN_API_KEY
  else process.env.NEXT_PUBLIC_ADMIN_API_KEY = historyEnvironment.adminKey
  if (historyEnvironment.apiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL
  else process.env.NEXT_PUBLIC_API_URL = historyEnvironment.apiUrl
})

it.each([401, 403])('履歴の認証が拒まれたHTTP %sは未構成の案内を保つ', async status => {
  const fetch = vi.fn().mockResolvedValue(new Response('', { status }))
  vi.stubGlobal('fetch', fetch)
  render(<UpdatesPage />)
  expect(await screen.findByText('この環境では自動アップデートが構成されていないため、履歴はありません。')).toBeTruthy()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(document.body.textContent).not.toContain('history fetch')
})

it('履歴のサーバーの失敗を英語で出さず、再試行を案内する', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })))
  render(<UpdatesPage />)
  expect(await screen.findByText('更新履歴の読み込みに失敗しました。時間をおいて、もう一度お試しください。')).toBeTruthy()
  expect(document.body.textContent).not.toContain('history fetch')
  expect(document.body.textContent).not.toContain('構成されていないため')
})

function BreadcrumbProbe() {
  const { crumbs, title } = usePageChrome()
  return <div data-testid="chrome">{JSON.stringify({ crumbs, title })}</div>
}

it('統括から来た時だけパンくずから統括へ戻れる', () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
  window.history.replaceState({}, '', '/updates?from=hq')
  const view=render(<PageChromeProvider><UpdatesPage /><BreadcrumbProbe /></PageChromeProvider>)
  expect(screen.getByTestId('chrome').textContent).toContain('"label":"統括","href":"/hq"')
  expect(screen.getByTestId('chrome').textContent).toContain('"title":"更新履歴"')
  expect(screen.queryByRole('link', { name: '統括へ戻る' })).toBeNull()
  view.unmount()
  window.history.replaceState({}, '', '/updates')
  render(<PageChromeProvider><UpdatesPage /><BreadcrumbProbe /></PageChromeProvider>)
  expect(screen.getByTestId('chrome').textContent).toContain('"crumbs":null')
  expect(screen.queryByRole('link', { name: '統括へ戻る' })).toBeNull()
})
