// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BellPanel, { type BellPanelItem } from './bell-panel'
import type { NotificationTab } from './tabs'

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('BellPanel 未知タブ・原型名・非配列 items の防御', () => {
  it('tab に原型名や未知値、items に非配列が渡っても落ちずに空状態文言を出す', () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)

    const view = render(
      <BellPanel
        open
        onClose={vi.fn()}
        getAnchor={() => anchor}
        state="ready"
        items={null as unknown as BellPanelItem[]}
        unreadCount={0}
        tab={'toString' as NotificationTab}
        onTabChange={vi.fn()}
        onSelect={vi.fn()}
        onViewAll={vi.fn()}
      />,
    )

    expect(screen.getByText('通知はまだありません。')).toBeTruthy()
    expect(view.container.textContent).not.toContain('function toString')

    view.rerender(
      <BellPanel
        open
        onClose={vi.fn()}
        getAnchor={() => anchor}
        state="ready"
        items={[]}
        unreadCount={0}
        tab={'unknown_tab' as NotificationTab}
        onTabChange={vi.fn()}
        onSelect={vi.fn()}
        onViewAll={vi.fn()}
      />,
    )
    expect(screen.getByText('通知はまだありません。')).toBeTruthy()
    anchor.remove()
  })
})
