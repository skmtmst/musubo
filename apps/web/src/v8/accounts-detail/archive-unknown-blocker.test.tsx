// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { LineAccount } from '@line-crm/shared'

const fixture = vi.hoisted(() => ({ archive: vi.fn() }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, lineAccounts: { ...actual.api.lineAccounts, archive: fixture.archive } } }
})
vi.mock('@/lib/session-snapshot', async (original) => ({ ...await original<typeof import('@/lib/session-snapshot')>(), readSessionSnapshot: () => ({ stepUpMethod: 'none' }) }))
import { ApiError } from '@/lib/api'
import { ArchiveDialog } from './dialogs'

afterEach(() => { cleanup(); vi.resetAllMocks() })

it.each([
  { blockers: ['constructor'], expected: 'このアカウントはいまアーカイブできません。止まっているか、既定でないかを確かめてください。' },
  { blockers: ['constructor', 'default_account'], expected: '既定のアカウントです。先にほかのアカウントを既定にしてください' },
])('未知の理由を安全に扱い、既知の理由を知らせる: $blockers', async ({ blockers, expected }) => {
  fixture.archive.mockRejectedValue(new ApiError(409, 'blocked', 'LINE_ACCOUNT_ARCHIVE_BLOCKED', { blockers }))
  render(<ArchiveDialog account={{ id: 'sample', name: '見本' } as LineAccount} onClose={() => undefined} onDone={() => undefined} />)
  fireEvent.click(screen.getByRole('button', { name: 'アーカイブする' }))
  expect(await screen.findByText(expected)).toBeTruthy()
  expect(screen.queryByText(/function Object/)).toBeNull()
})
