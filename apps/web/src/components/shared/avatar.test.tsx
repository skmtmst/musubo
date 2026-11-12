
import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import styles from './avatar.module.css'
import { contrastRatio, installSharedStyles } from './shared-style-test-support'
import Avatar, { avatarInitials, avatarToneIndex } from './avatar'
// @vitest-environment happy-dom
/*
 * 友だちの顔（★管理画面 `KXDhj`）。画像が読み込めない時も空白にしない。
 */

let removeStyles: () => void
beforeAll(async () => { removeStyles = await installSharedStyles([['avatar', styles]]) })
afterAll(() => removeStyles?.())
afterEach(() => cleanup())

describe("友だちの顔", () => {
  it('画像の読み込みに失敗したら頭文字に替わる', () => {
    const { container } = render(<Avatar name="Kyohei Yamamoto" src="https://example.invalid/a.jpg" />)
    const root = container.firstElementChild as HTMLElement
    expect(root.dataset.avatar).toBe('image')
    fireEvent.error(container.querySelector('img')!)
    expect(root.dataset.avatar).toBe('initials')
    expect(root.textContent).toBe('K')
  })

  it('頭文字はいつも1字（英字は頭の1字・日本語は最初の1字）', () => {
    expect(avatarInitials('Kyohei Yamamoto')).toBe('K')
    expect(avatarInitials('Masato.S')).toBe('M')
    expect(avatarInitials('見本 15')).toBe('見')
  })

  it('会社名は法人格と記号を飛ばしてから1字（アカウントのアイコンも同じ）', () => {
    expect([
      avatarInitials('株式会社 然'),
      avatarInitials('（株）然-NEN-'),
      avatarInitials('Shed Products株式会社'),
      avatarInitials('一般社団法人 日本〇〇協会'),
      avatarInitials(' ・ 株式会社 むすび'),
      avatarInitials('株式会社'),
    ]).toEqual(['然', '然', 'S', '日', 'む', '株'])
  })

  it('名前も無い時は人の印', () => {
    const { container } = render(<Avatar name="  " />)
    expect((container.firstElementChild as HTMLElement).dataset.avatar).toBe('icon')
  })

  it('アカウント・会社の印は、画像が無いと緑の地に白の1文字', () => {
    const { container } = render(<Avatar name="株式会社 然" shape="rounded" />)
    const root = container.firstElementChild as HTMLElement
    expect(root.dataset.avatar).toBe('initials')
    expect(root.dataset.avatarTone).toBe('account')
    expect(root.textContent).toBe('然')
  })

  it('人の顔（丸）は今までどおり薄い地のまま', () => {
    const { container } = render(<Avatar name="見本 15" />)
    const root = container.firstElementChild as HTMLElement
    expect(root.dataset.avatar).toBe('initials')
    expect(root.dataset.avatarTone).toBeUndefined()
  })

  it('同じ名前はいつも同じ色', () => {
    expect(avatarToneIndex('見本 15')).toBe(avatarToneIndex('見本 15'))
    expect(avatarToneIndex('')).toBeGreaterThanOrEqual(0)
  })

  it.each([
    ...Array.from({ length: 6 }, (_, i) => ({ name: String.fromCharCode(65 + i), shape: 'circle' as const, tone: 'neutral' as const })),
    { name: '株式会社 然', shape: 'rounded' as const, tone: 'neutral' as const },
    { name: '見本 15', shape: 'circle' as const, tone: 'soft' as const },
  ])('頭文字の実効色は4.5:1以上（$name・$shape・$tone）', props => {
    const { container } = render(<Avatar {...props} />)
    const style = getComputedStyle(container.firstElementChild!)
    expect(contrastRatio(style.color, style.backgroundColor)).toBeGreaterThanOrEqual(4.5)
  })
})
