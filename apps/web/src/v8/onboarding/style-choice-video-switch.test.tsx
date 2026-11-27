// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setTestReducedMotion } from '@/test-utils/reduced-motion'
import StyleChoiceVideo from './style-choice-video'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('StyleChoiceVideo の業種切り替え時の状態分離', () => {
  it('ある業種の動画読み込みが失敗しても、別の業種へ切り替えたら見本に固まらず新しい動画を試す', () => {
    setTestReducedMotion(true)
    const view = render(<StyleChoiceVideo style="restaurant" fallback={<p>静的な見本</p>} />)
    const firstVideo = view.container.querySelector('video')!
    expect(firstVideo.getAttribute('src')).toContain('restaurant.mp4')

    fireEvent.error(firstVideo)
    expect(screen.getByText('静的な見本')).toBeTruthy()
    expect(view.container.querySelector('video')).toBeNull()

    view.rerender(<StyleChoiceVideo style="salon" fallback={<p>静的な見本</p>} />)
    const secondVideo = view.container.querySelector('video')
    expect(secondVideo).not.toBeNull()
    expect(secondVideo?.getAttribute('src')).toContain('salon.mp4')
    expect(screen.queryByText('静的な見本')).toBeNull()
  })

  it('前の業種で自動再生が拒まれた状態を、切り替えた別の業種へ持ち越さない', async () => {
    setTestReducedMotion(false)
    let salonPlayed = false
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      const src = this.getAttribute('src') ?? ''
      if (src.includes('restaurant.mp4')) {
        return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }))
      }
      salonPlayed = true
      return Promise.resolve()
    })

    const view = render(<StyleChoiceVideo style="restaurant" fallback={<p>静的な見本</p>} />)
    await screen.findByRole('button', { name: '動画を再生' })

    view.rerender(<StyleChoiceVideo style="salon" fallback={<p>静的な見本</p>} />)
    await waitFor(() => expect(salonPlayed).toBe(true))
    expect(screen.queryByRole('button', { name: '動画を再生' })).toBeNull()
  })

  it('前の業種で手動再生を押したあとに遅れて返った再生失敗で、切替先の業種を止めない', async () => {
    setTestReducedMotion(false)
    let restaurantCalls = 0
    let salonPlayed = false
    let rejectLateManualPlay!: (reason?: unknown) => void
    const lateManualPlay = new Promise<void>((_, reject) => { rejectLateManualPlay = reject })

    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      const src = this.getAttribute('src') ?? ''
      if (src.includes('restaurant.mp4')) {
        restaurantCalls += 1
        if (restaurantCalls === 1) {
          return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }))
        }
        return lateManualPlay
      }
      salonPlayed = true
      return Promise.resolve()
    })

    const view = render(<StyleChoiceVideo style="restaurant" fallback={<p>静的な見本</p>} />)
    const playButton = await screen.findByRole('button', { name: '動画を再生' })

    fireEvent.click(playButton)
    view.rerender(<StyleChoiceVideo style="salon" fallback={<p>静的な見本</p>} />)
    await waitFor(() => expect(salonPlayed).toBe(true))

    await act(async () => {
      rejectLateManualPlay(Object.assign(new Error('late reject'), { name: 'NotAllowedError' }))
      await Promise.resolve()
    })

    expect(screen.queryByRole('button', { name: '動画を再生' })).toBeNull()
  })
})
