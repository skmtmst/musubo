// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { STYLE_EXPERIENCE_SCRIPT } from './index'
import { PhonePane, relativeIso } from './scenes'

afterEach(cleanup)

describe('onboarding/style-experience-player/scenes の不正日時ガード', () => {
  it('relativeIso は不正な基準日・非有限の日数・壊れた時刻でも例外を投げず空文字を返す', () => {
    const validBase = new Date('2026-10-06T00:00:00Z')
    expect(relativeIso({ day: 0, time: '18:30' }, validBase)).toBe('2026-10-06T09:30:00.000Z')
    expect(relativeIso({ day: Number.NaN, time: '18:30' }, validBase)).toBe('')
    expect(relativeIso({ day: 0, time: 'bad' }, validBase)).toBe('')
    expect(relativeIso({ day: 0, time: '25:00' }, validBase)).toBe('')
    expect(relativeIso({ day: 0, time: '18:30' }, new Date('invalid'))).toBe('')
  })

  it('PhonePane の確認表示は壊れた時刻でも落ちずに未確定の案内を表示する', () => {
    const look = { ...STYLE_EXPERIENCE_SCRIPT.styles.restaurant, account: '検証商店' }
    render(
      <PhonePane
        style="restaurant"
        look={look}
        base={new Date('2026-10-06T00:00:00Z')}
        phone={{
          part: 'booking-facts',
          title: '予約の確認',
          step: 2,
          steps: ['日時', '確認'],
          data: {
            done: true,
            heading: '予約を受け付けました',
            facts: [{ label: '日時', at: { day: 1, time: 'invalid' } }],
          },
        }}
      />,
    )

    expect(screen.getByText('日時を確認できません')).toBeTruthy()
  })
})
