// @vitest-environment happy-dom
/*
 * V8-B 代理ログイン中（閲覧のみ） の帯。
 * 差し替えるのは見た目だけ。書き込みへの切り替え・個人情報の表示・
 * 終える先は今のまま。書き込み中の帯は変えない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as renderView, screen, waitFor, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/hq',
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import ImpersonationBar from './impersonation-bar'

const READ_STATE = {
  id: 'imp-1',
  tenantId: 'tenant-1',
  tenantName: '然 -NEN- 本部',
  mode: 'read',
  piiRevealed: false,
  startedAt: '2026-10-15T15:20:00+09:00',
} as const

const mounted: Array<{ root: Root; host: HTMLElement }> = []

function render(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  mounted.push({ root, host })
  act(() => {
    root.render(<ImpersonationBar initial={{ ...READ_STATE, mode: 'read' }} />)
  })
  return host
}

describe('代理ログイン帯のV8（VtJQ6）', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  })

  afterEach(async () => {
    cleanup()
    await act(async () => {
      for (const { root } of mounted) root.unmount()
    })
    for (const { host } of mounted) host.remove()
    mounted.length = 0
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('閲覧のみの帯に板IDと3つの口を出す', () => {
    const host = render()
    expect(host.querySelector('[data-design-node="VtJQ6"]')).not.toBeNull()
    expect(host.querySelector('[data-design-node="WXp5T"]')).toBeNull()
    for (const label of ['代理ログイン中', '閲覧のみ', '個人情報を表示する', '書き込みに切り替える', '代理ログインを終える']) {
      expect(host.textContent).toContain(label)
    }
  })

  it.each([
    ['書き込みに切り替える', '書き込みに切り替える', '/api/ops/impersonation/write'],
    ['個人情報を表示する', '表示する', '/api/ops/impersonation/pii-reveal'],
  ])('%s の確認対象と送信する代理ログインを一致させる', async (open, submit, path) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ success: false, error: '代理ログインが変わりました。読み直してから、もう一度選んでください' }), { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    renderView(<ImpersonationBar initial={{ ...READ_STATE }} />)
    fireEvent.click(screen.getByRole('button', { name: open }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('然 -NEN- 本部')).toBeTruthy()
    expect(within(dialog).getByText('環境')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: submit }).querySelector('.lucide-trash-2')).toBeNull()
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '問い合わせの確認' } })
    fireEvent.click(within(dialog).getByRole('button', { name: submit }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes(path))).toBe(true))
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes(path)) as unknown as [string, RequestInit]
    expect(JSON.parse(String(call[1].body))).toMatchObject({ expectedSessionId: 'imp-1', reason: '問い合わせの確認' })
    await screen.findByText(/代理ログインが変わりました/)
  })

  it('確認中に帯の代理ログインが変わったら送らない', () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderView(<ImpersonationBar initial={{ ...READ_STATE }} />)
    fireEvent.click(screen.getByRole('button', { name: '書き込みに切り替える' }))
    const dialog = screen.getByRole('alertdialog')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '問い合わせの確認' } })
    view.rerender(<ImpersonationBar initial={{ ...READ_STATE, id: 'imp-2', tenantId: 'tenant-2' }} />)
    fireEvent.click(within(dialog).getByRole('button', { name: '書き込みに切り替える' }))
    expect(within(dialog).getByText(/代理ログインが変わりました/)).toBeTruthy()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/ops/impersonation/write'))).toBe(false)
  })

  it('契約先名が分からないときは不明と示す', () => {
    renderView(<ImpersonationBar initial={{ ...READ_STATE, tenantName: null }} />)
    fireEvent.click(screen.getByRole('button', { name: '個人情報を表示する' }))
    expect(within(screen.getByRole('alertdialog')).getByText('不明')).toBeTruthy()
  })
})
