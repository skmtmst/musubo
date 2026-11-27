// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { HqTemplateReceivedVersion } from '@line-crm/shared'
import DistributionAccountPicker from './distribution-account-picker'

afterEach(cleanup)
const folders = { folders: [], failed: false, membership: new Map([['a', { folderId: null, folder: null }]]) }
function show(received: unknown) {
  render(<DistributionAccountPicker accounts={[{ id: 'a', name: '本店' }]} folders={folders} selected={[]} onChange={vi.fn()} filter="all" onFilter={vi.fn()} received={received as HqTemplateReceivedVersion[]} busy={false} />)
}

it('配布状況の行が不正なら未配布と扱わず確認できないと示す', () => {
  show([null])
  expect(screen.getByText('配布状況を確認できません')).toBeTruthy()
  expect(screen.queryByText('未配布')).toBeNull()
})

it('配布した版が不正なら画面を落とさず確認できないと示す', () => {
  show([{ accountId: 'a', targetVersion: { version: 'unknown' } }])
  expect(screen.getByText('配布状況を確認できません')).toBeTruthy()
  expect(screen.queryByText(/を配布済み/)).toBeNull()
})
