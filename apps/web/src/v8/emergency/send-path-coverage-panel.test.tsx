// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendPaths = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({
  api: {
    operations: {
      sendPaths,
    },
  },
}))

import { SendPathCoveragePanel } from './send-path-coverage-panel'

const SAMPLE_RESPONSE = {
  success: true as const,
  data: {
    evaluatedAt: '2026-10-01T05:00:00.000Z',
    capabilities: ['auto_delivery'],
    paths: [
      {
        id: 'p1',
        capability: 'auto_delivery',
        kind: 'auto',
        label: 'シナリオ配信',
        state: 'running',
        note: '通常稼働中',
        excludedReason: null,
      },
    ],
    problems: [],
  },
}

beforeEach(() => {
  sendPaths.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('SendPathCoveragePanel の読み込み失敗時再読み込み', () => {
  it('送信経路の台帳読み込みに失敗してもページ全体を開き直さずその場でもう一度読み込める', async () => {
    sendPaths
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(SAMPLE_RESPONSE)

    render(<SendPathCoveragePanel accountId="acc-1" revision={1} />)

    await screen.findByText(/送信経路の台帳を読み込めませんでした/)
    const retry = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retry)

    await screen.findByText('停止が届く送信経路')
    expect(screen.getByText('シナリオ配信')).toBeTruthy()
    expect(sendPaths).toHaveBeenCalledTimes(2)
  })
})
