// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FriendsSectionHead } from './head'
import type { FriendsTabKey } from './nav'

afterEach(cleanup)

describe('FriendsSectionHead defensive guards', () => {
  it('ignores Object.prototype keys like toString instead of mounting a broken PageExplanationBody', () => {
    const { container } = render(
      <FriendsSectionHead current={'toString' as unknown as FriendsTabKey} description="説明文" />,
    )
    expect(container.querySelector('[data-screen-explanation-body]')).toBeNull()
    expect(container.querySelector('button[aria-label="この画面の説明"]')).toBeNull()
  })

  it('keeps standard tab explanation note for valid FriendsTabKey values', () => {
    const { container } = render(
      <FriendsSectionHead current="duplicates" description="説明文" />,
    )
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="この画面の説明"]')
    expect(toggle).not.toBeNull()
    fireEvent.click(toggle!)
    expect(document.body.textContent).toContain('重複検出：同じ人が2人に分かれていないかを探して')
  })
})
