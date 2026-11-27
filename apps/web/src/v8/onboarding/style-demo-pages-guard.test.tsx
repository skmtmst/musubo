// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StyleDemoPages from './style-demo-pages'

afterEach(cleanup)

describe('StyleDemoPages のページ範囲と操作無効ガード', () => {
  it('ページ番号が範囲外や非数でも見出しとページ表示を安全に丸める', () => {
    const first = render(
      <StyleDemoPages
        accountName="テスト店"
        viewing="standard"
        page={99}
        onPage={vi.fn()}
        chosen={null}
        onChoose={vi.fn()}
        disabled={false}
      />,
    )
    expect(screen.getByText('5 / 5')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('使い方に合う見本から始められる')
    first.unmount()

    render(
      <StyleDemoPages
        accountName="テスト店"
        viewing="standard"
        page={Number.NaN}
        onPage={vi.fn()}
        chosen={null}
        onChoose={vi.fn()}
        disabled={false}
      />,
    )
    expect(screen.getByText('1 / 5')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('問い合わせとお知らせを、ひとつに')
  })

  it('操作無効のあいだはデモの手順を押してもページ切り替えを実行しない', () => {
    const onPage = vi.fn()
    render(
      <StyleDemoPages
        accountName="テスト店"
        viewing="standard"
        page={1}
        onPage={onPage}
        chosen={null}
        onChoose={vi.fn()}
        disabled
      />,
    )

    const buttons = screen.getAllByRole('button')
    for (const button of buttons) {
      fireEvent.click(button)
    }
    expect(onPage).not.toHaveBeenCalled()
  })
})
