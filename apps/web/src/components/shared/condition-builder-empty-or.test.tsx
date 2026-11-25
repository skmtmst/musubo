// @vitest-environment happy-dom
/*
 * S4-OR: 初期値 null から「or条件を追加」しても、空のかたまりが消えない。
 *
 * 以前は update が isEmptyCondition で即 null へ戻していたため、
 * 足したばかりの空の OR かたまりが親へ届かず、入力欄が増えなかった。
 * 空のかたまりは下書きとして残し、保存のときに案内する（R243）。
 */
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConditionBuilder from './condition-builder'
import {
  findConditionDraftIssue,
  pruneCondition,
  type SegmentCondition,
} from '@/lib/segment-condition'

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-1' }),
}))

vi.mock('@/lib/use-feature-visibility', () => ({
  useFeatureVisibility: () => ({ status: 'ready' as const, features: {}, enabled: () => true }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    tags: { list: async () => ({ success: true as const, data: [] }) },
    friendFields: { list: async () => ({ success: true as const, data: [] }) },
    supportMarks: { list: async () => ({ success: true as const, data: [] }) },
    scenarios: { list: async () => ({ success: true as const, data: [] }) },
    segments: { count: async () => ({ success: true as const, data: { count: 0 } }) },
  },
}))

afterEach(() => cleanup())

/*
 * 実際の使い方と同じ、値を親が持つ制御型の親。
 * 「下書きを捨てる」は取り消し・初期化、「外から条件を入れる」は
 * 別画面からの同期など、親側の変更を表す。
 */
function Harness({
  initial = null,
  seen,
}: {
  initial?: SegmentCondition | null
  seen: unknown[]
}) {
  const [value, setValue] = useState<SegmentCondition | null>(initial)
  return (
    <div>
      <ConditionBuilder
        value={value}
        onChange={(next) => {
          seen.push(next)
          setValue(next)
        }}
      />
      <button type="button" onClick={() => setValue(null)}>
        下書きを捨てる
      </button>
      <button
        type="button"
        onClick={() => setValue({ operator: 'AND', rules: [{ type: 'is_hidden', value: false }] })}
      >
        外から条件を入れる
      </button>
    </div>
  )
}

function pickers() {
  return screen.getAllByRole('button', { name: '追加する条件を選択する' })
}

function groupRemovers() {
  return screen.queryAllByRole('button', { name: 'このかたまりを外す' })
}

function pickKind(field: HTMLElement, query: string) {
  fireEvent.click(field)
  const dialog = screen.getByRole('dialog', { name: '条件を選ぶ', hidden: true })
  fireEvent.click(within(dialog).getByRole('radio', { name: query, hidden: true }))
  fireEvent.click(within(dialog).getByRole('button', { name: '条件を足す', hidden: true }))
}

function addOrGroup() {
  fireEvent.click(screen.getByRole('button', { name: 'いずれか条件のかたまりを足す' }))
}

describe('S4-OR 空の or かたまりは下書きとして残る', () => {
  it('null から or条件を追加すると空のかたまりが残り、入力欄が1→2になる', () => {
    const seen: unknown[] = []
    render(<Harness seen={seen} />)
    expect(groupRemovers()).toHaveLength(0)
    expect(pickers()).toHaveLength(1)

    addOrGroup()

    // 空でも消えない。or かたまりの入力欄が増える。
    expect(groupRemovers()).toHaveLength(1)
    expect(pickers()).toHaveLength(2)
    const last = seen[seen.length - 1] as SegmentCondition
    expect(last).not.toBeNull()
    expect(last.groups).toHaveLength(1)
    expect(last.groups?.[0].rules).toHaveLength(0)
    // 実質空なので保存・数え上げの意味は「絞り込みなし」のまま。
    expect(pruneCondition(last)).toBeNull()
  })

  it('空のかたまりに行動スコアを足せる。値は保たれる', () => {
    const seen: unknown[] = []
    render(<Harness seen={seen} />)
    addOrGroup()
    pickKind(pickers()[1], '行動スコア')

    expect((screen.getByRole('spinbutton', { name: '行動スコアの下限' }) as HTMLInputElement).value).toBe('30')
    expect((screen.getByRole('spinbutton', { name: '行動スコアの上限' }) as HTMLInputElement).value).toBe('69')
    const last = seen[seen.length - 1] as SegmentCondition
    expect(findConditionDraftIssue(last)).toBeNull()
    // 中身が入ったかたまりは保存対象として残る（広い一致に落ちない）。
    expect(pruneCondition(last)?.groups).toHaveLength(1)
  })

  it('かたまりの中の行を全部外しても、空のかたまりは残る', () => {
    const seen: unknown[] = []
    render(<Harness seen={seen} />)
    addOrGroup()
    pickKind(pickers()[1], '行動スコア')
    fireEvent.click(screen.getByRole('button', { name: 'この条件を外す' }))

    // 行は消えるが、かたまり自体は下書きとして残る。
    expect(groupRemovers()).toHaveLength(1)
    expect(pickers()).toHaveLength(2)
    const last = seen[seen.length - 1] as SegmentCondition
    expect(last.groups).toHaveLength(1)
    expect(last.groups?.[0].rules).toHaveLength(0)
    expect(findConditionDraftIssue(last)).toContain('空の')
  })

  it('かたまりを外すと null へ戻る（実質空の後片付けはする）', () => {
    const seen: unknown[] = []
    render(<Harness seen={seen} />)
    addOrGroup()
    fireEvent.click(screen.getByRole('button', { name: 'このかたまりを外す' }))

    expect(groupRemovers()).toHaveLength(0)
    expect(pickers()).toHaveLength(1)
    expect(seen[seen.length - 1]).toBeNull()
    expect(screen.getByText('絞り込みなし')).toBeTruthy()
  })

  it('取り消し・外からの変更が編集中の下書きへ正しく反映される', () => {
    const seen: unknown[] = []
    render(<Harness seen={seen} />)
    addOrGroup()
    expect(groupRemovers()).toHaveLength(1)

    // 取り消し（親が null に戻す）と空のかたまりは消える。
    fireEvent.click(screen.getByRole('button', { name: '下書きを捨てる' }))
    expect(groupRemovers()).toHaveLength(0)
    expect(screen.getByText('絞り込みなし')).toBeTruthy()

    // 外から入った条件は残したまま、or かたまりを足せる。
    fireEvent.click(screen.getByRole('button', { name: '外から条件を入れる' }))
    expect(screen.getByText('表示状態')).toBeTruthy()
    addOrGroup()
    expect(screen.getByText('表示状態')).toBeTruthy()
    expect(groupRemovers()).toHaveLength(1)
    expect(pickers()).toHaveLength(2)
  })
})
