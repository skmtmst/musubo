// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GuideSharedProvider, type SharedGuide } from '@/v8/onboarding/public/guide-shared/index'
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
