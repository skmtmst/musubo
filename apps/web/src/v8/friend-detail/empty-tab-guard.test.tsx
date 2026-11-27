// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EmptyTab, { type EmptyTabAction } from './empty-tab'

afterEach(cleanup)

describe('EmptyTab defensive guards', () => {
  it('omits unsafe href actions while keeping valid relative/https links and click actions', () => {
    const onClick = vi.fn()
    const actions: EmptyTabAction[] = [
      { label: '危険1', href: 'javascript:alert(1)' },
      { label: '危険2', href: '//evil.example/x' },
      { label: '危険3', href: '/\\evil.example/x' },
      { label: '危険4', href: '//same.invalid/x' },
      { label: '危険5', href: '/\t/evil.example/x' },
      { label: '空リンク', href: '   ' },
      { label: '安全相対', href: '/friends/detail?id=f1&tab=history' },
      { label: '安全外部', href: 'https://example.com/help' },
      { label: '操作', onClick },
    ]
    const { container } = render(
      <EmptyTab icon={null} title="まだ記録がありません" text="説明" actions={actions} />,
    )
    const links = [...container.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/friends/detail?id=f1&tab=history',
      'https://example.com/help',
    ])
    const button = container.querySelector('button')
    expect(button?.textContent).toContain('操作')
    button?.click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('handles null/malformed actions safely without throwing', () => {
    const { container } = render(
      <EmptyTab icon={null} title="空" text="説明" actions={null as unknown as EmptyTabAction[]} />,
    )
    expect(container.textContent).toContain('空')
  })
})
