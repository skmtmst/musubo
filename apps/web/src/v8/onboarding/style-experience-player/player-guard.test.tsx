// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setTestReducedMotion } from '@/test-utils/reduced-motion'
import { StyleExperiencePlayer } from './player'
import { STYLE_EXPERIENCE_SCRIPT } from './script'
import type { StyleExperienceScript } from './script-types'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  setTestReducedMotion(false)
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('StyleExperiencePlayer タブ選択値と空場面の防御', () => {
  it('複数スタイルを持つタブで先頭スタイルが全部版の対象外でも、2番目のスタイル表示中にそのタブが選択状態になる', () => {
    const customScript: StyleExperienceScript = {
      ...STYLE_EXPERIENCE_SCRIPT,
      tabs: [
        { label: '飲食店', styles: ['restaurant'] },
        // 先頭の lesson は board 無しのため全部版 rotation から外れ、salon のみ残る
        { label: '教室・サロン', styles: ['lesson', 'salon'] },
      ],
    }

    render(
      <StyleExperiencePlayer
        script={customScript}
        style="salon"
        switcher="segmented"
        variant="full"
        data="sample"
      />,
    )

    const tabButton = screen.getByRole('button', { name: '教室・サロン' })
    expect(tabButton.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '飲食店' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('scenes が空配列のスタイルは全部版のタブ・ローテーションに含めない', () => {
    const customScript: StyleExperienceScript = {
      ...STYLE_EXPERIENCE_SCRIPT,
      styles: {
        ...STYLE_EXPERIENCE_SCRIPT.styles,
        lesson: {
          ...STYLE_EXPERIENCE_SCRIPT.styles.lesson,
          scenes: [],
        },
      },
    }

    render(
      <StyleExperiencePlayer
        script={customScript}
        switcher="segmented"
        variant="full"
        data="sample"
      />,
    )

    expect(screen.queryByRole('button', { name: '教室・レッスン' })).toBeNull()
    expect(screen.getByRole('button', { name: '飲食店' }).getAttribute('aria-pressed')).toBe('true')
  })
})
