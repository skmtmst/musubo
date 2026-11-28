// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/lib/hq-templates-api', () => ({ hqTemplatesApi: {} }))
vi.mock('@/lib/hq-broadcasts-api', () => ({ hqBroadcastsApi: { list: calls.list, folders: async () => ({ data: [] }) } }))
import HqBroadcastSourcePicker from './source-picker'

afterEach(cleanup)
it.each(['toString', 'constructor', '__proto__', 'future'])('未知の配信状態 %s を状態不明として表示する', async (status) => {
  calls.list.mockResolvedValue({ data: [{ id: 'one', title: '見本の配信', status, input: { folderId: null } }] })
  render(<HqBroadcastSourcePicker mode="duplicate" initialId="" onTemplate={async () => null} onBroadcast={() => {}} renderBroadcast={() => null} onClose={() => {}} />)
  expect(await screen.findByRole('radio', { name: '見本の配信' })).toBeTruthy()
  expect(screen.getByText('状態不明')).toBeTruthy()
})
