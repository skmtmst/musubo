// @vitest-environment happy-dom
/*
 * ★管理画面 仕上げ §2「一括バー」。表で1件でも選ぶと下端から出る帯。
 * 0件では出さない・件数は濃い緑の太字・操作は白地ボタン。
 */
import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Button from './button'
import BulkBar from './bulk-bar'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('一括バー（★管理画面 z97zZN §2）', () => {
  it('0件では出さない', () => {
    const { container } = render(<BulkBar count={0} />)
    expect(container.firstChild).toBeNull()
  })

  it('1件でも選ぶと「N件を選択中」と操作を出す', () => {
    const { container } = render(
      <BulkBar count={2}>
        <Button variant="secondary">タグを付ける</Button>
      </BulkBar>,
    )
    expect(container.textContent).toContain('2件を選択中')
    expect(container.textContent).toContain('タグを付ける')
  })

  it('単位は変えられる（人・枚）', () => {
    const { container } = render(<BulkBar count={3} unit="人" />)
    expect(container.textContent).toContain('3人を選択中')
  })

  it.each(['人', '枚', '件'])('全件を選ぶ操作にも単位「%s」を使う', (unit) => {
    const view = render(<BulkBar count={3} total={12} unit={unit} onSelectAll={() => {}} />)
    expect(view.getByRole('button', { name: `条件に合う12${unit}すべてを選択する` })).toBeTruthy()
  })

  it('0件へ戻ると少し待ってから消える（下がって消える）', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(<BulkBar count={2} />)
    expect(container.firstChild).not.toBeNull()
    rerender(<BulkBar count={0} />)
    // すぐには消えない（退場の動きの分だけ残る）
    expect(container.firstChild).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(container.firstChild).toBeNull()
  })
})

it('このページを選んだ後に、条件に合う全件を選べる', async () => {
  const selectAll = vi.fn()
  const view = render(<BulkBar count={20} total={78} onSelectAll={selectAll} />)
  const button = view.getByRole('button', { name: '条件に合う78件すべてを選択する' })
  await act(async () => { button.click() })
  expect(selectAll).toHaveBeenCalledTimes(1)
  view.rerender(<BulkBar count={78} total={78} onSelectAll={selectAll} />)
  expect(view.queryByRole('button', { name: '条件に合う78件すべてを選択する' })).toBeNull()
})

it('条件に合う全件の選択と選択解除を明示し、それぞれの操作を呼ぶ', async () => {
  const selectAll = vi.fn()
  const clear = vi.fn()
  const view = render(<BulkBar count={2} total={10} unit="人" onSelectAll={selectAll} onClear={clear} />)
  await act(async () => { fireEvent.click(view.getByRole('button', { name: '条件に合う10人すべてを選択する' })) })
  fireEvent.click(view.getByRole('button', { name: '選択するのをやめる' }))
  expect(selectAll).toHaveBeenCalledTimes(1)
  expect(clear).toHaveBeenCalledTimes(1)
})
