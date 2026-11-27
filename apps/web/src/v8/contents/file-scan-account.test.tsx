// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import FileScanStoppedBanner from './file-scan-stopped-banner'

const fixtures = vi.hoisted(() => ({ health: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { fileScan: { health: fixtures.health } } }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('アカウントを切り替えると前の安全確認の状態を出さない', async () => {
  let resolveNext!: (value: { success: true; data: { stopped: boolean } }) => void
  fixtures.health.mockResolvedValueOnce({ success: true, data: { stopped: true } })
    .mockReturnValueOnce(new Promise(resolve => { resolveNext = resolve }))
  const view = render(<FileScanStoppedBanner accountId="first" />)
  await screen.findByText(/ファイルの安全確認が止まっています/)
  view.rerender(<FileScanStoppedBanner accountId="second" />)
  expect(screen.queryByText(/ファイルの安全確認が止まっています/)).toBeNull()
  resolveNext({ success: true, data: { stopped: false } })
  await waitFor(() => expect(fixtures.health).toHaveBeenCalledTimes(2))
  expect(screen.queryByText(/ファイルの安全確認が止まっています/)).toBeNull()
})
