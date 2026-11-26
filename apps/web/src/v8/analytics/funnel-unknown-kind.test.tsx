// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }))
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), api: {
  conversions: { definitions: async () => ({ success: true, data: { items: [] } }) },
  tags: { list: async () => ({ success: true, data: [] }) },
  forms: { list: async () => ({ success: true, data: [] }) },
  analytics: { v6Funnels: { create: vi.fn(), createVersion: vi.fn(), get: vi.fn() } },
} }))
import FunnelFormV8 from './funnel-form'
afterEach(cleanup)

it('未知の条件名が継承名でも編集画面を開き、ほかの条件を選べる', async () => {
  render(<FunnelFormV8 accountId="sample" edit={{ funnelId: 'sample', name: '見本', windowDays: '30', steps: [
    { label: '入口', kind: 'friend_add', value: '', match: {} },
    { label: '条件', kind: 'constructor', value: '', match: {} },
  ], segment: null, comparisonGroups: [], expectedVersionNumber: 1 }} onCancel={() => undefined} onCreated={() => undefined} />)
  expect(screen.getByText('未対応の条件')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '2段目で何をしたら進むか' }))
  const choice = await screen.findByRole('radio', { name: 'ほかの条件' })
  fireEvent.click(choice)
  fireEvent.click(within(choice.closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: '選ぶ' }))
  expect((await screen.findByLabelText('追加の指定はありません')).tagName).toBe('INPUT')
  expect(screen.getByLabelText('段2の名前')).toHaveProperty('value', '条件')
})
