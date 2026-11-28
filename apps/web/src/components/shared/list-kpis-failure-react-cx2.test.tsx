// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, listStats: { get: fixture.get } } }
})
import ListKpis from './list-kpis'
const titles: [string, string, string, string] = ['対象', '利用中', '追加', '未使用']
beforeEach(() => { fixture.get.mockReset() })
afterEach(cleanup)
it.each(['response', 'network'] as const)('%s の失敗は0とせず見出しと失敗を表示する', async (kind) => {
  if (kind === 'response') fixture.get.mockResolvedValue({ success: false })
  else fixture.get.mockRejectedValue(new Error('offline'))
  const build = vi.fn(() => [])
  render(<ListKpis titles={titles} build={build} accountId="account-1" />)
  expect(await screen.findByText('対象')).toBeTruthy()
  for (const title of titles) expect(screen.getByText(title)).toBeTruthy()
  expect(screen.getAllByText('取得できませんでした')).toHaveLength(4)
  expect(screen.getAllByText('—')).toHaveLength(4)
  expect(screen.queryByText('0')).toBeNull()
  expect(build).not.toHaveBeenCalled()
})
it('取得に成功すれば実際の集計を使い0も表示できる', async () => {
  fixture.get.mockResolvedValue({ success: true, data: { marker: 7 } })
  const build = vi.fn(() => [{ title: '対象', value: 0, unit: '件', detail: '' }])
  render(<ListKpis titles={titles} build={build} accountId="account-1" />)
  expect(await screen.findByText('対象')).toBeTruthy()
  expect(screen.getByText('0')).toBeTruthy()
  expect(screen.queryByText('取得できませんでした')).toBeNull()
  expect(build).toHaveBeenCalledWith({ marker: 7 })
})
it('見出しが未指定の取得失敗は見出しと詳細を出さない', async () => {
  fixture.get.mockResolvedValue({ success: false })
  await act(async () => { render(<ListKpis build={() => []} accountId="account-1" />) })
  expect(await screen.findAllByText('—')).toHaveLength(4)
  expect(screen.queryByText('取得できませんでした')).toBeNull()
})
