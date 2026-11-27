// @vitest-environment happy-dom
import React, { useLayoutEffect } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InitialMenuChoice, type InitialMenuSelection } from './initial-menu-choice'

const net = vi.hoisted(() => ({ resources: vi.fn() }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: net }))

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

function PaintProbe({ accountId, mode, snapshots }: { accountId: string; mode: string; snapshots: Array<{ accountId: string; mode: string; hasError: boolean }> }) {
  useLayoutEffect(() => {
    snapshots.push({
      accountId,
      mode,
      hasError: Boolean(document.body.textContent?.includes('メニューを読み込めませんでした')),
    })
  })
  return null
}

function Subject({
  accountId,
  value,
  snapshots,
}: {
  accountId: string
  value: InitialMenuSelection
  snapshots: Array<{ accountId: string; mode: string; hasError: boolean }>
}) {
  return (
    <>
      <InitialMenuChoice accountId={accountId} style="restaurant" value={value} onChange={vi.fn()} />
      <PaintProbe accountId={accountId} mode={value.value} snapshots={snapshots} />
    </>
  )
}

describe('InitialMenuChoice の既存メニュー読み込みエラーのアカウント紐づけ', () => {
  it('A で読み込み失敗した直後に B へ切り替えた描画フレームに A のエラーを出さない', async () => {
    net.resources.mockImplementation((accountId: string) => {
      if (accountId === 'acc-a') return Promise.reject(new Error('network'))
      return new Promise(() => {})
    })
    const snapshots: Array<{ accountId: string; mode: string; hasError: boolean }> = []

    const view = render(<Subject accountId="acc-a" value={{ value: 'existing' }} snapshots={snapshots} />)
    await waitFor(() => expect(screen.getByText('メニューを読み込めませんでした')).toBeTruthy())

    view.rerender(<Subject accountId="acc-b" value={{ value: 'existing' }} snapshots={snapshots} />)

    const framesForB = snapshots.filter((entry) => entry.accountId === 'acc-b')
    expect(framesForB.length).toBeGreaterThan(0)
    expect(framesForB.every((entry) => entry.hasError === false)).toBe(true)
  })

  it('A で失敗したあとに simple へ戻して再び existing を開いた初回描画でも前のエラーを出さない', async () => {
    let callCount = 0
    net.resources.mockImplementation(() => {
      callCount += 1
      if (callCount === 1) return Promise.resolve({ success: false, error: 'down' })
      return new Promise(() => {})
    })
    const snapshots: Array<{ accountId: string; mode: string; hasError: boolean }> = []

    const view = render(<Subject accountId="acc-a" value={{ value: 'existing' }} snapshots={snapshots} />)
    await waitFor(() => expect(screen.getByText('メニューを読み込めませんでした')).toBeTruthy())

    view.rerender(<Subject accountId="acc-a" value={{ value: 'simple' }} snapshots={snapshots} />)
    snapshots.length = 0

    view.rerender(<Subject accountId="acc-a" value={{ value: 'existing' }} snapshots={snapshots} />)

    expect(snapshots.length).toBeGreaterThan(0)
    expect(snapshots.every((entry) => entry.hasError === false)).toBe(true)
  })
})
