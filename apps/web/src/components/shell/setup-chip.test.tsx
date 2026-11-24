// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GuideSharedProvider, type SharedGuide } from '@/v8/onboarding/public/guide-shared/index'
import { publishSetupChip, SETUP_CHIP_REOPEN_EVENT } from '@/v8/onboarding/public/setup-chip/index'
import { SetupChip } from './setup-chip'

const guide: SharedGuide['guide'] = { phase:'idle', stepKey:null, procedureIndex:1, anchor:null, pausedAnchor:null, start:vi.fn(), pause:vi.fn(), resume:vi.fn(), reset:vi.fn(), advanceProcedure:vi.fn() }
const value = (done: number, total: number, dismissed: boolean | null): SharedGuide => ({ guide, dismissed, summary: { steps:[], done, total } })
afterEach(cleanup)

describe('開店準備の札', () => {
  it('残りの手順を表示し、設定の画面へ移る', () => {
    render(<GuideSharedProvider value={value(2, 6, false)}><SetupChip /></GuideSharedProvider>)
    const link = screen.getByRole('link', { name:'開店準備 2/6。はじめの設定を開く' })
    expect(link.getAttribute('href')).toBe('/getting-started')
  })
  it.each([[6,6,false],[2,6,true],[2,6,null],[0,0,false]] as const)('完了・非表示・未取得の札を出さない', (done, total, dismissed) => {
    render(<GuideSharedProvider value={value(done, total, dismissed)}><SetupChip /></GuideSharedProvider>)
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('初回ポップアップを出せる画面の札', () => {
  afterEach(() => publishSetupChip(null))
  it('閉じた初回ポップアップを札から開き直す', async () => {
    publishSetupChip({ accountId:'a', done:2, total:6 })
    const reopen = vi.fn()
    window.addEventListener(SETUP_CHIP_REOPEN_EVENT, reopen)
    try {
      render(<GuideSharedProvider value={value(2, 6, false)}><SetupChip /></GuideSharedProvider>)
      const button = await screen.findByRole('button', { name:'開店準備 2/6。はじめにやることを開く' })
      expect(screen.queryByRole('link')).toBeNull()
      fireEvent.click(button)
      expect(reopen).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(SETUP_CHIP_REOPEN_EVENT, reopen)
    }
  })
  it.each(['active', 'paused'] as const)('案内中・一時停止中はポップアップを重ねず、設定の画面へ移る（%s）', async (phase) => {
    publishSetupChip({ accountId:'a', done:2, total:6 })
    render(<GuideSharedProvider value={{ ...value(2, 6, false), guide: { ...guide, phase } }}><SetupChip /></GuideSharedProvider>)
    const link = await screen.findByRole('link', { name:'開店準備 2/6。はじめの設定を開く' })
    expect(link.getAttribute('href')).toBe('/getting-started')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
