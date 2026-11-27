// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/transport/errors'
import type { Webinar } from '@/lib/api'
const mocks = vi.hoisted(() => ({ detail: vi.fn() }))
vi.mock('@/lib/api', async () => ({ ApiError: (await import('@/lib/api/transport/errors')).ApiError, api: { media: { detail: mocks.detail } } }))
import VideoMetadata from './video-metadata'
const webinar = { videoMediaId: 'video-a', accountId: 'account-a', durationSeconds: 60 } as Webinar
afterEach(() => { cleanup(); vi.resetAllMocks() })
it.each([NaN, null])('再生時間 %s が不正なら確定した長さを表示しない', async duration => {
  mocks.detail.mockResolvedValue({ success: true, data: { item: { filename: '動画.mp4', kind: 'video' } } })
  render(<VideoMetadata webinar={{ ...webinar, durationSeconds: duration as number }} />)
  await screen.findByText('動画.mp4')
  expect(screen.getByText(/再生時間を確認できません/)).toBeTruthy()
  expect(document.body.textContent).not.toContain('NaN')
})
it('未知のメディア種類は確認できないと表示する', async () => {
  mocks.detail.mockResolvedValue({ success: true, data: { item: { filename: '動画.mp4', kind: 'toString' } } })
  render(<VideoMetadata webinar={webinar} />)
  const name = await screen.findByText('動画.mp4')
  expect(name.getAttribute('title')).toContain('種類を確認できません')
  expect(name.getAttribute('title')).not.toContain('function')
  expect(screen.getByText(/1分・16:9/)).toBeTruthy()
})
