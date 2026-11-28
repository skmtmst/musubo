// @vitest-environment happy-dom
/*
 * S4-OR（条件窓の証明）: シナリオの配信条件の窓で、空の or かたまりは
 * 下書きとして残り、そのまま反映すると案内が出て送られない。
 * 中身を入れたかたまり・条件なし（null）は送れる。
 */
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConditionDialog } from './scenario-dialogs'
import type { SegmentCondition } from '@/lib/segment-condition'

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', accounts: [] }),
}))

vi.mock('@/lib/use-feature-visibility', () => ({
  useFeatureVisibility: () => ({ status: 'ready' as const, features: {}, enabled: () => true }),
}))

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    tags: { list: async () => ({ success: true as const, data: [] }) },
    friendFields: { list: async () => ({ success: true as const, data: [] }) },
    supportMarks: { list: async () => ({ success: true as const, data: [] }) },
    scenarios: { list: async () => ({ success: true as const, data: [] }) },
    segments: { count: async () => ({ success: true as const, data: { count: 0 } }) },
  },
}))

afterEach(() => cleanup())

function renderDialog({
  value = null,
  onSave = async () => {},
  onClose = () => {},
}: {
  value?: SegmentCondition | null
  onSave?: (next: SegmentCondition | null) => Promise<void>
  onClose?: () => void
} = {}) {
  render(
    <ConditionDialog
      title="この通の配信対象"
      description="条件に合わない人には、この通だけ送りません。"
      value={value}
      onSave={onSave}
      onClose={onClose}
    />,
  )
}

/*
 * 詳しい条件の編集器は折りたたみの中。閉じていても hidden 付きで
 * 探して押せる（happy-dom の開閉に依存しない）。
 */
function orAddButton() {
  return screen.getByRole('button', { name: 'いずれか条件のかたまりを足す', hidden: true })
}

function groupRemovers() {
  return screen.queryAllByRole('button', { name: 'このかたまりを外す', hidden: true })
}

function kindPickers() {
  return screen.getAllByRole('button', { name: '追加する条件を選択する', hidden: true })
}

function pickKind(field: HTMLElement, query: string) {
  fireEvent.click(field)
  const dialog = screen.getByRole('dialog', { name: '条件を選ぶ', hidden: true })
  fireEvent.click(within(dialog).getByRole('radio', { name: query, hidden: true }))
  fireEvent.click(within(dialog).getByRole('button', { name: '条件を足す', hidden: true }))
}

async function reflect() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'この条件を反映' }))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

describe('S4-OR 条件窓は空のかたまりを黙って落とさない', () => {
  it('空の or かたまりのまま反映すると案内が出て、送られない', async () => {
    const onSave = vi.fn(async (_next: SegmentCondition | null) => {})
    renderDialog({ onSave })
    await act(async () => {
      fireEvent.click(orAddButton())
    })
    // 空でも消えない。下書きとして残っている。
    expect(groupRemovers()).toHaveLength(1)
    expect(kindPickers()).toHaveLength(2)

    await reflect()

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/空の「いずれか」の条件のかたまりがあります/)).toBeTruthy()
  })

  it('かたまりに条件を入れると反映でき、かたまりごと送られる', async () => {
    const onSave = vi.fn(async (_next: SegmentCondition | null) => {})
    renderDialog({ onSave })
    await act(async () => {
      fireEvent.click(orAddButton())
    })
    pickKind(kindPickers()[1], '行動スコア')
    await reflect()

    expect(onSave).toHaveBeenCalledTimes(1)
    const sent = onSave.mock.calls[0][0]
    expect(sent?.groups).toHaveLength(1)
    expect(sent?.groups?.[0].rules[0].type).toBe('score_range')
  })

  it('条件なしのまま反映すると null が送られる（全員対象の意味は保つ）', async () => {
    const onSave = vi.fn(async (_next: SegmentCondition | null) => {})
    renderDialog({ value: null, onSave })
    await reflect()

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toBeNull()
  })

  it('上の一覧でroot条件だけ消しても、残すべき空ORは残る', async () => {
    const onSave = vi.fn(async (_next: SegmentCondition | null) => {})
    renderDialog({
      value: {
        operator: 'AND',
        rules: [{ type: 'tag_exists', value: 'tag-1' }],
        groups: [{ operator: 'OR', rules: [] }],
      },
      onSave,
    })
    // 上の一覧の「削除する」は条件行→かたまり行の順。最初の1つがroot条件。
    const removers = screen.getAllByText('削除する')
    expect(removers.length).toBeGreaterThanOrEqual(2)
    await act(async () => {
      fireEvent.click(removers[0])
    })

    // 削除対象のroot条件だけ消え、空ORのかたまりは下書きとして残る。
    expect(screen.queryByText('条件 1')).toBeNull()
    expect(groupRemovers()).toHaveLength(1)
    expect(kindPickers()).toHaveLength(2)

    // 空のまま反映すると送らずに案内する。
    await reflect()
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/空の「いずれか」の条件のかたまりがあります/)).toBeTruthy()
  })

  it('取り消すと送らずに閉じる（下書きは残さない）', async () => {
    const onSave = vi.fn(async (_next: SegmentCondition | null) => {})
    const onClose = vi.fn(() => {})
    renderDialog({ onSave, onClose })
    await act(async () => {
      fireEvent.click(orAddButton())
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    })

    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
