// @vitest-environment happy-dom
/*
 * 条件の足し口（m22c）。15個の札を並べっぱなしにしない。
 * 検索できる共通の選ぶ窓で足す。札に戻すと赤くなる。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

import ConditionBuilder from './condition-builder'

afterEach(() => cleanup())

function renderBuilder(onChange: (value: unknown) => void = () => {}) {
  return render(<ConditionBuilder value={null} onChange={onChange} />)
}

describe('条件の足し口（m22c）', () => {
  it('15個の札ボタンは並べず、窓への足し口が1つある', () => {
    renderBuilder()
    // 最初は「すべて」の足し口だけ。OR追加後も、各かたまりに1つ。
    expect(screen.getAllByRole('button', { name: '追加する条件を選択する' })).toHaveLength(1)
    // 札ボタンに戻っていたら赤：15種の名前がボタンとして並ぶ。
    for (const label of ['メモ', 'ステータスメッセージ', '友だち登録日', '対応マーク', '行動スコア']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
  })

  it('窓でタグを探し、確定でだけ条件を足す', async () => {
    const seen: unknown[] = []
    renderBuilder((next) => {
      seen.push(next)
    })
    fireEvent.click(screen.getByRole('button', { name: '追加する条件を選択する' }))
    const dialog = screen.getByRole('dialog', { name: '条件を選ぶ' })
    expect(dialog.textContent).toContain('タグ・記入欄')
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'タグ' } })
    await waitFor(() => expect(within(dialog).queryByRole('radio', { name: '名前' })).toBeNull())
    fireEvent.click(within(dialog).getByRole('radio', { name: 'タグ' }))
    expect(seen).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: '条件を足す' }))
    expect(seen).toHaveLength(1)
    expect(JSON.stringify(seen[0])).toContain('tag_exists')
    // 確定後は窓を閉じ、続けてもう1つ足せる。
    expect(screen.queryByRole('dialog', { name: '条件を選ぶ' })).toBeNull()
  })
})

it('条件の選ぶ窓を取り消すと、条件も保存口も変わらない', () => {
  const onChange = vi.fn()
  renderBuilder(onChange)
  fireEvent.click(screen.getByRole('button', { name: '追加する条件を選択する' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: '条件を選ぶ' })).getByRole('button', { name: 'キャンセル' }))
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog', { name: '条件を選ぶ' })).toBeNull()
})
