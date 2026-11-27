// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CommonActionResources, CommonActionStep } from '@/lib/api'
import BranchEditors from './branch-editor'
import { ACTION_LABELS, describeVersionChanges } from './version-diff'

afterEach(cleanup)
const resources = { tags: [], scenarios: [], templates: [], webhooks: [], richMenus: [], commonActions: [] } as CommonActionResources
it.each(['toString', 'constructor', '__proto__'])('未対応の処理と条件 %s を壊さず読み取り専用で残す', (type) => {
  const branch = { id: 'branch', type: 'branch', onFailure: 'stop', params: {
    condition: { operator: 'AND', rules: [{ type, value: '保持する値' }] },
    then: [{ id: 'child', type, params: { preserved: '保持する値' }, onFailure: 'stop' }], else: [],
  } } as unknown as CommonActionStep
  render(<BranchEditors steps={[branch]} resources={resources} onUpdate={vi.fn()} onRemove={vi.fn()} />)
  expect(screen.getByText(`条件1（${type}。ここでは変えられません）`)).toBeTruthy()
  expect(screen.getByText(`「${type}」`)).toBeTruthy()
  expect(ACTION_LABELS[type] ?? '処理').toBe('処理')
})

it.each(['toString', 'constructor', '__proto__'])('変更履歴で未対応の失敗時設定 %s は確認できないことを示す', (mode) => {
  const before = { id: 'step', type: 'add_tag', params: {}, onFailure: mode } as unknown as CommonActionStep
  const after = { ...before, onFailure: 'continue' } as CommonActionStep
  expect(describeVersionChanges([before], [after])).toEqual([`「タグを付ける」の失敗時を「動作を確認できません」から「次へ進む」にした`])
})
