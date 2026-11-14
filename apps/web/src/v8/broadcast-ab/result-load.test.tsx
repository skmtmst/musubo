// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import BroadcastAbResult, { useAbResult } from './result'

function Page() {
  const ab = useAbResult('broadcast-1')
  return <><p>配信の概要</p><BroadcastAbResult broadcastId="broadcast-1" ab={ab} canSend={false} accounts={[]} /></>
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('HTTP 200 の失敗を知らせ、再試行で結果を読み直す', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(json({ success: false, error: 'unavailable' }))
    .mockResolvedValueOnce(json({ success: true, data: { status: 'testing', variants: [], remainder: { count: 0 } } }))
  vi.stubGlobal('fetch', fetchMock)
  render(<Page />)
  expect(await screen.findByText('結果を読めませんでした。')).toBeTruthy()
  expect(screen.getByText('配信の概要')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度試す' }))
  await waitFor(() => expect(screen.queryByText('結果を読めませんでした。')).toBeNull())
  expect(screen.getByText('A/B の結果')).toBeTruthy()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('404 だけを未設定として区画を隠す', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'not_found' }, 404)))
  render(<Page />)
  await waitFor(() => expect(screen.queryByText('読み込んでいます…')).toBeNull())
  expect(screen.queryByText('A/B の結果')).toBeNull()
  expect(screen.getByText('配信の概要')).toBeTruthy()
})

it('成功でも結果が空なら未設定と扱わず失敗を知らせる', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ success: true, data: null })))
  render(<Page />)
  expect(await screen.findByText('結果を読めませんでした。')).toBeTruthy()
})

it('サーバー失敗も区画だけに知らせる', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'unavailable' }, 503)))
  render(<Page />)
  expect(await screen.findByText('結果を読めませんでした。')).toBeTruthy()
  expect(screen.getByText('配信の概要')).toBeTruthy()
})

it('権限不足を未設定と偽らず、失敗として示す', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'forbidden' }, 403)))
  render(<Page />)
  expect(await screen.findByText('結果を読めませんでした。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'A を送る' })).toBeNull()
})
