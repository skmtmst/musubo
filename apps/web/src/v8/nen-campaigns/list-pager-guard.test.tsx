// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

import { Pager } from './list'

afterEach(() => cleanup())

describe('NenCampaignsList Pager の不正ページ番号・件数ガード', () => {
  it('page が 0 以下・ページ数超過・size が 0 以下や NaN でも負の範囲や NaN を描画しない', () => {
    const onPage = vi.fn()
    const { container, rerender } = render(<Pager total={35} page={0} size={20} onPage={onPage} />)
    expect(container.textContent).toContain('35件中 1〜20件')
    expect(container.textContent).not.toContain('-19')
    expect(container.textContent).not.toContain('NaN')

    rerender(<Pager total={35} page={99} size={20} onPage={onPage} />)
    expect(container.textContent).toContain('21〜35件')
    expect(container.textContent).not.toContain('NaN')

    rerender(<Pager total={35} page={-3} size={0} onPage={onPage} />)
    expect(container.textContent).toContain('1〜20件')
    expect(container.textContent).not.toContain('Infinity')
    expect(container.textContent).not.toContain('NaN')

    rerender(<Pager total={-5} page={Number.NaN} size={Number.NaN} onPage={onPage} />)
    expect(container.textContent).not.toContain('-5')
    expect(container.textContent).not.toContain('NaN')
  })
})
