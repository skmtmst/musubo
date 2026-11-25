// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { setTestReducedMotion } from '@/test-utils/reduced-motion'
import StyleChoiceVideo from './style-choice-video'

afterEach(cleanup)
it('動きを減らすときは操作まで再生せず、失敗時は見本に戻る', () => {
  setTestReducedMotion(true)
  const { container } = render(<StyleChoiceVideo style="consult" fallback={<p>静的な見本</p>} />)
  const video = container.querySelector('video')!
  expect(video.getAttribute('aria-label')).toBe('面談・相談のデモ動画')
  expect(video.autoplay).toBe(false)
  expect(video.getAttribute('src')).toContain('consultation.mp4')
  expect(video.getAttribute('poster')).toContain('consultation.jpg')
  fireEvent.click(screen.getByRole('button', { name: '動画を再生' }))
  expect(video.autoplay).toBe(true)
  fireEvent.play(video)
  expect(screen.queryByRole('button', { name: '動画を再生' })).toBeNull()
  fireEvent.error(video)
  expect(screen.getByText('静的な見本')).toBeTruthy()
})
it('通常は無音で繰り返す', () => {
  setTestReducedMotion(false)
  const { container } = render(<StyleChoiceVideo style="salon" fallback={null} />)
  const video = container.querySelector('video')!
  expect(video.autoplay).toBe(true)
  expect(video.muted).toBe(true)
  expect(video.loop).toBe(true)
})
