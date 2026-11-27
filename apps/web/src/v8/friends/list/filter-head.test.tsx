// @vitest-environment happy-dom
/*
 * 10：絞り込み欄の閉じた姿は「頭：すべて」（既定は灰・選択で黒太字＋緑枠）。
 * valuePrefix を外すと、選んだ値に頭が付かなくなるので赤くなる。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search), usePathname: () => '/friends' }))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'A', loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn() }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ enabled: () => false }) }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
vi.mock('@/lib/operators-cache', () => ({ loadOperators: async () => ({ success: true, data: [{ id: 'u1', name: 'Kenta' }] }) }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      friends: { list: async () => ({ success: true, data: { items: [], total: 0 } }) },
      friendStats: { get: async () => ({ success: false }) },
      tags: { list: async () => ({ success: true, data: [{ id: 't1', name: 'VIP' }] }) },
      scenarios: { list: async () => ({ success: true, data: [{ id: 's1', name: 'あいさつ' }] }) },
    },
  }
})

import List from './list'

afterEach(() => { cleanup(); sessionStorage.clear(); window.history.replaceState(null, '', '/friends') })

function fieldOf(buttonName: string): HTMLElement {
  const button = screen.getByRole('button', { name: buttonName })
  const field = button.closest('[data-entity-picker-field]') as HTMLElement | null
  expect(field, `絞り込み欄「${buttonName}」`).toBeTruthy()
  return field!
}

async function pick(buttonName: string, optionName: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: buttonName }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('radio', { name: optionName }))
  fireEvent.click(within(dialog).getByRole('button', { name: '選択する' }))
  return fieldOf(buttonName)
}

// URL指定の2本を先に置く：選ぶ操作はURLの保留状態を書き、後のURL指定が読めなくなるため。
function expectActiveHead(field: HTMLElement, head: string, value: string) {
  expect(field.querySelector('[data-select-head]')?.textContent).toBe(head)
  expect(field.querySelector('[data-select-current]')?.textContent).toBe(value)
  expect(field.querySelector('[data-select-current]')?.getAttribute('data-filter-state')).toBe('active')
}

test('担当者を選ぶと「担当者：Kenta」を選択中で出す', async () => {
  window.history.replaceState(null, '', '/friends?operatorId=u1')
  render(<List />)
  fireEvent.click(screen.getByRole('button', { name: /絞り込み/ }))
  await screen.findByText('Kenta')
  expectActiveHead(fieldOf('担当で絞り込む'), '担当者：', 'Kenta')
})

test('シナリオを選ぶと「シナリオ：あいさつ」を選択中で出す', async () => {
  window.history.replaceState(null, '', '/friends?scenarioId=s1')
  render(<List />)
  fireEvent.click(screen.getByRole('button', { name: /絞り込み/ }))
  await screen.findByText('あいさつ')
  expectActiveHead(fieldOf('シナリオで絞り込む'), 'シナリオ：', 'あいさつ')
})

test('タグを選ぶと「タグ：VIP」を選択中（黒太字＋緑枠）で出す', async () => {
  render(<List />)
  expectActiveHead(await pick('タグで絞り込む', 'VIP'), 'タグ：', 'VIP')
})
