// @vitest-environment happy-dom
/**
 * 板 ：札（しまったファイル・確かめ中・戻した）に実データの件数を出し、
 * 押すと絞り込みが切り替わる。
 */
import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FileScanItem } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1' }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => '/settings/file-scan',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchApi: vi.fn(async () => ({ data: { identityRetentionDays: 90 } })),
    api: {
      ...actual.api,
      staff: {
        ...actual.api.staff,
        me: async () => ({ success: true, data: { role: 'owner' } }),
      },
      fileScan: {
        ...actual.api.fileScan,
        list: mocks.list,
        getConfig: async () => ({ success: true, data: { config: null } }),
      },
    },
  }
})

import FileScanV8 from '@/v8/settings/file-scan/screen'

afterEach(() => cleanup())

const scanOf = (overrides: Partial<FileScanItem> = {}): FileScanItem => ({
  id: 'scan-1',
  lineAccountId: 'acc-1',
  subjectKind: 'media',
  subjectId: 'md-1',
  mediaId: 'md-1',
  filename: 'invoice.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 220000,
  status: 'quarantined',
  reasonCode: 'pdf_active_content',
  reasonLabel: '危険な仕掛けが見つかりました',
  uploaderLabel: '見本',
  attempts: 0,
  nextRetryAt: null,
  scannedAt: '2026-09-25T10:00:00+09:00',
  quarantinedAt: '2026-09-25T10:00:00+09:00',
  releasedAt: null,
  releaseReason: null,
  createdAt: '2026-09-25T10:00:00+09:00',
  updatedAt: '2026-09-25T10:00:00+09:00',
  ...overrides,
})

function listFor(status: string, total: number, items: FileScanItem[] = []) {
  return { success: true, data: { items, total, limit: 50, offset: 0 }, status }
}

describe('PfA4o 状態の札', () => {
  test('3つの札に件数が出て、押すと絞り込まれる', async () => {
    mocks.list.mockImplementation(async (_accountId: string, params?: { status?: string }) => {
      if (params?.status === 'pending') return listFor('pending', 0)
      if (params?.status === 'released') return listFor('released', 1, [scanOf({ id: 'scan-9', status: 'clean' })])
      return listFor('quarantined', 2, [scanOf(), scanOf({ id: 'scan-2', filename: 'photo_03.jpg' })])
    })
    render(<FileScanV8 />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /しまったファイル/ })).toBeTruthy()
    })
    expect(screen.getByRole('button', { name: /しまったファイル/ }).textContent).toContain('2')
    expect(screen.getByRole('button', { name: /確かめ中/ }).textContent).toContain('0')
    expect(screen.getByRole('button', { name: /戻した/ })).toBeTruthy()
    expect(screen.getByText('invoice.pdf')).toBeTruthy()
    // 決まり2: いつも同じ説明は帯にせず、題の横の「？」へ入れる。
    expect(screen.queryByText(/確かめ終わるまで、上げたファイルは配信・公開・審査に出せません/)).toBeNull()
    const toggle = screen.getByRole('button', { name: 'この画面の説明' })
    fireEvent.click(toggle)
    const safetyText = await screen.findByText(/確かめ終わるまで、上げたファイルは配信・公開・審査に出せません/)
    expect(safetyText.closest('[data-design-part="notice"]')).toBeNull()
    const settings = screen.getByRole('button', { name: /設定を編集/ })
    expect(settings.querySelector('svg.lucide-sliders-horizontal')).not.toBeNull()
    fireEvent.click(settings)
    expect(screen.getByRole('textbox', { name: /提供元/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '設定を閉じる' }))

    fireEvent.click(screen.getByRole('button', { name: /戻した/ }))
    await waitFor(() => {
      expect(mocks.list).toHaveBeenCalledWith('acc-1', expect.objectContaining({ status: 'released' }))
    })
  })
})
