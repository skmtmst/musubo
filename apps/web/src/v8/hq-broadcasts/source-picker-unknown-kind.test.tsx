// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/hq-templates-api', () => ({ hqTemplatesApi: { listByKind: async () => [{ id: 'unknown', name: '新しい種類', kind: 'future', folder_id: null }], folders: { list: async () => [] }, get: vi.fn() } }))
vi.mock('@/lib/hq-broadcasts-api', () => ({ hqBroadcastsApi: {} }))
import HqBroadcastSourcePicker from './source-picker'

afterEach(cleanup)
it('未対応のひな形の種類を、メッセージと決めつけずに表示する', async () => {
  render(<HqBroadcastSourcePicker mode="template" initialId="" onTemplate={async () => null} onBroadcast={() => {}} renderBroadcast={() => null} onClose={() => {}} />)
  expect(await screen.findByRole('radio', { name: '新しい種類' })).toBeTruthy()
  expect(screen.getByText('種類不明')).toBeTruthy()
})
