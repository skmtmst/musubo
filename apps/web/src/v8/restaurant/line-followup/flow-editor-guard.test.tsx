// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BroadcastBubble } from '@line-crm/shared'

vi.mock('@/components/shared/message-composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/shared/message-composer')>()
  return {
    ...actual,
    default: ({
      bubbles,
      onMove,
      onDelete,
      onChange,
    }: {
      bubbles: BroadcastBubble[]
      onMove: (index: number, direction: -1 | 1) => void
      onDelete: (index: number) => void
      onChange: (index: number, bubble: BroadcastBubble) => void
    }) => (
      <div>
        <button type="button" onClick={() => onMove(0, 1)}>移動テスト</button>
        <button type="button" onClick={() => onDelete(0)}>削除テスト</button>
        <button type="button" onClick={() => onChange(0, { ...bubbles[0]!, content: { text: '変更後' } })}>本文変更テスト</button>
      </div>
    ),
  }
})

import { StepEditor, StepPreview } from './flow-editor'

afterEach(cleanup)

const twoBubbles: BroadcastBubble[] = [
  { id: 'b1', type: 'text', content: { text: '1通目' } },
  { id: 'b2', type: 'text', content: { text: '2通目' } },
]

describe('StepEditor と StepPreview の守り', () => {
  it('処理中は移動・削除・本文変更を止め、通常時は並べ替えと削除を反映する', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <StepEditor name="お礼" bubbles={twoBubbles} readOnly={false} busy={true} onChange={onChange} />,
    )

    fireEvent.click(screen.getByRole('button', { name: '移動テスト' }))
    fireEvent.click(screen.getByRole('button', { name: '削除テスト' }))
    fireEvent.click(screen.getByRole('button', { name: '本文変更テスト' }))
    expect(onChange).not.toHaveBeenCalled()

    rerender(
      <StepEditor name="お礼" bubbles={twoBubbles} readOnly={false} busy={false} onChange={onChange} />,
    )

    fireEvent.click(screen.getByRole('button', { name: '移動テスト' }))
    expect(onChange).toHaveBeenNthCalledWith(1, [twoBubbles[1], twoBubbles[0]])

    fireEvent.click(screen.getByRole('button', { name: '削除テスト' }))
    expect(onChange).toHaveBeenNthCalledWith(2, [twoBubbles[1]])
  })

  it('閲覧のみのときは読み取り専用の本文だけを表示し、移動・削除の操作を出さない', () => {
    const onChange = vi.fn()
    render(
      <StepEditor name="お礼" bubbles={twoBubbles} readOnly={true} busy={false} onChange={onChange} />,
    )

    const textarea = screen.getByRole('textbox', { name: '本文' }) as HTMLTextAreaElement
    expect(textarea.readOnly).toBe(true)
    expect(textarea.value).toBe('1通目\n\n2通目')
    expect(screen.queryByRole('button', { name: '移動テスト' })).toBeNull()
    expect(screen.queryByRole('button', { name: '削除テスト' })).toBeNull()
  })

  it('アカウント名が空や空白だけでもアイコンの頭文字と名前が空にならない', () => {
    const { container, rerender } = render(<StepPreview bubbles={[twoBubbles[0]]} accountName="   " />)

    expect(container.textContent).toContain('公式アカウント')
    const avatarBlank = container.querySelector('[class*="senderAvatar"]')
    expect(avatarBlank?.textContent).toBe('公')

    rerender(<StepPreview bubbles={[twoBubbles[0]]} accountName="  焼肉 花火  " />)
    const avatarTrimmed = container.querySelector('[class*="senderAvatar"]')
    expect(avatarTrimmed?.textContent).toBe('焼')
    expect(container.textContent).toContain('焼肉 花火')
  })
})
