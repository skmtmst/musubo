// @vitest-environment happy-dom
import React, { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { ManualPublishAttempt } from '@/v8/rich-menus/edit/manual-publish-attempt'
import { publishMenuNow } from './create-publish-actions'
import type { Group } from './create-types'

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  persistDraft: vi.fn(),
  loadChecks: vi.fn(),
  reloadGroup: vi.fn(),
  capture: vi.fn(() => false),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      richMenuGroups: {
        ...actual.api.richMenuGroups,
        publish: mocks.publish,
      },
    },
  }
})

const sampleGroup: Group = {
  id: 'grp-1',
  accountId: 'acc-1',
  name: 'テストメニュー',
  chatBarText: 'メニュー',
  size: 'large',
  defaultPageId: 'p1',
  isDefaultForAll: true,
  status: 'draft',
  targetingCondition: null,
  targetingPriority: 1,
  targetingEnabled: false,
  folderId: null,
  defaultOpen: true,
  version: 2,
  publishingGeneration: 1,
  pages: [],
}

function Harness() {
  const publishAttempt = useRef(new ManualPublishAttempt())
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [, setDone] = useState<'scheduled' | 'published' | null>(null)

  const run = () => {
    void publishMenuNow({
      audience: 'all',
      group: sampleGroup,
      confirmedImages: [],
      loadChecks: mocks.loadChecks,
      persistDraft: mocks.persistDraft,
      publishAttempt,
      publishing,
      reloadGroup: mocks.reloadGroup,
      saveErrors: { capture: mocks.capture },
      saving: false,
      setDone,
      setError,
      setNotice,
      setPublishing,
    })
  }

  return (
    <div>
      <output data-testid="publishing">{String(publishing)}</output>
      <output data-testid="notice">{notice}</output>
      {error ? <div role="alert">{error}</div> : null}
      <button type="button" onClick={run}>公開する</button>
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.persistDraft.mockResolvedValue(undefined)
  mocks.loadChecks.mockResolvedValue(undefined)
  mocks.reloadGroup.mockResolvedValue(undefined)
  mocks.capture.mockReturnValue(false)
})

afterEach(() => {
  cleanup()
})

describe('publishMenuNow の権限/混雑エラー表示と再確認の未処理拒否防止', () => {
  it('公開 API が 403 を返したとき権限不足の案内を表示する', async () => {
    mocks.publish.mockRejectedValueOnce(new ApiError(403, 'Forbidden'))
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: '公開する' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('権限がありません')
    })
    expect(screen.getByTestId('publishing').textContent).toBe('false')
  })

  it('公開 API が 429 を返したとき混雑の待ち案内を表示する', async () => {
    mocks.publish.mockRejectedValueOnce(new ApiError(429, 'Too Many Requests'))
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: '公開する' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('混み合っています')
    })
    expect(screen.getByTestId('publishing').textContent).toBe('false')
  })

  it('失敗後の loadChecks が拒否されても未処理拒否にならない', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      mocks.publish.mockRejectedValueOnce(new ApiError(503, 'Unavailable'))
      mocks.loadChecks
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('checks offline'))
      render(<Harness />)

      fireEvent.click(screen.getByRole('button', { name: '公開する' }))

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain('LINEへ登録できませんでした')
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
