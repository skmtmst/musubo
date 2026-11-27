// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Tag } from '@line-crm/shared'

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
import TagsList from '@/v8/tags/list'

const tag = { id: 'tag-1', name: '登録日を確認するタグ', color: '#3B82F6', groupId: null, friendCount: 0, createdAt: '2026-01-10T15:00:00.000Z', lineAccountId: 'account-a', status: 'active', cleanupReasons: [] } as Tag
const originalTz = process.env.TZ
afterEach(() => { cleanup(); if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz })

it.each(['UTC', 'Pacific/Honolulu'])('端末が%sでも登録日は日本時間で表示する', async timezone => {
  process.env.TZ = timezone
  window.history.replaceState({}, '', '/tags')
  render(<TagsList accountId="account-a" fixture={{ items: [tag], groups: [] }} />)
  fireEvent.click(document.querySelector('[data-reorder-id="tag-1"]')!)
  await waitFor(() => expect(screen.getByText('登録日').nextElementSibling?.textContent).toBe('1月11日（日）'))
})
