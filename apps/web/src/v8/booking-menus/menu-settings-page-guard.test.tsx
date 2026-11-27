// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MenuSettingsPage from './menu-settings-page'
import { menuSettingsModel } from './menu-settings.fixture'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

afterEach(cleanup)

describe('MenuSettingsPage previewUrl safety guard', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//evil.example/booking',
    '/\\evil.example/booking',
    '//same.invalid/booking',
    '/\t/evil.example/booking',
    '   ',
  ])('omits unsafe or blank previewUrl %s and shows missing-URL note', (previewUrl) => {
    const { container } = render(
      <MenuSettingsPage {...menuSettingsModel(true)} previewUrl={previewUrl} />,
    )
    const links = [...container.querySelectorAll('a')].filter((a) =>
      a.textContent?.includes('お客さまに見える画面を確かめる'),
    )
    expect(links).toHaveLength(0)
    expect(container.textContent).toContain('このアカウントには予約画面のURLがまだありません')
  })

  it.each(['https://example.test/booking', '/liff/booking/acc-1'])('keeps safe previewUrl %s', (previewUrl) => {
    const { container } = render(
      <MenuSettingsPage {...menuSettingsModel(true)} previewUrl={previewUrl} />,
    )
    const links = [...container.querySelectorAll('a')].filter((a) =>
      a.textContent?.includes('お客さまに見える画面を確かめる'),
    )
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link.getAttribute('href')).toBe(previewUrl)
    }
    expect(container.textContent).not.toContain('このアカウントには予約画面のURLがまだありません')
  })
})
