// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TemplateEditFrame } from './frame'
import type { TemplateEditHost } from './host'

vi.mock('@/components/shared/drawer', () => ({
  default: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function makeHost(overrides: Partial<TemplateEditHost['composer']> = {}): TemplateEditHost {
  return {
    composer: { index: 0, accountId: 'acc-1', canSaveTemplate: true, ...overrides },
    description: '',
    folders: [],
    folder: '',
    onFolderChange: vi.fn(),
    busy: false,
    onSave: vi.fn(),
    onCancel: vi.fn(),
  }
}

describe('吹き出し編集枠のテンプレート同時保存トグル初期化', () => {
  it('テンプレート保存不可へ切り替わったときや別の吹き出しへ移ったときに前回のON状態を引き継がない', () => {
    const insert = vi.fn()
    const baseProps = {
      boardId: 'test',
      title: '本文',
      description: '',
      side: null,
      onComposerInsert: insert,
      children: <p>入力</p>,
    }

    const view = render(<TemplateEditFrame {...baseProps} composerHost={makeHost({ index: 0, canSaveTemplate: true })} />)

    const toggle = screen.getByRole('switch', { name: 'テンプレートとしても保存する' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'この吹き出しに入れる' }))
    expect(insert).toHaveBeenLastCalledWith(true)

    // 同じ吹き出しでテンプレート保存不可へ変わったら false で挿入される
    view.rerender(<TemplateEditFrame {...baseProps} composerHost={makeHost({ index: 0, canSaveTemplate: false })} />)
    expect(screen.queryByRole('switch', { name: 'テンプレートとしても保存する' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'この吹き出しに入れる' }))
    expect(insert).toHaveBeenLastCalledWith(false)

    // もう一度 ON にしてから別の吹き出し番号へ移ると OFF に戻る
    view.rerender(<TemplateEditFrame {...baseProps} composerHost={makeHost({ index: 0, canSaveTemplate: true })} />)
    fireEvent.click(screen.getByRole('switch', { name: 'テンプレートとしても保存する' }))
    expect(screen.getByRole('switch', { name: 'テンプレートとしても保存する' }).getAttribute('aria-checked')).toBe('true')

    view.rerender(<TemplateEditFrame {...baseProps} composerHost={makeHost({ index: 1, canSaveTemplate: true })} />)
    expect(screen.getByRole('switch', { name: 'テンプレートとしても保存する' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'この吹き出しに入れる' }))
    expect(insert).toHaveBeenLastCalledWith(false)
  })
})
