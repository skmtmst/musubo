// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { TemplateQuestion } from '@/lib/api'
import LineBubbleThumb from './line-bubble-thumb'
import { bubbleThumbOf } from './line-bubble-thumb-model'

afterEach(cleanup)

it('壊れた質問の選択肢を0件と表示しない', () => {
  const question = { text: '質問', choices: null } as unknown as TemplateQuestion
  render(<LineBubbleThumb thumb={bubbleThumbOf({ messageType: 'flex', content: '{}', question })} />)
  expect(screen.getByText('見え方を出せません')).toBeTruthy()
})

it('壊れたカルーセルの枚数を正常な枚数として表示しない', () => {
  render(<LineBubbleThumb thumb={bubbleThumbOf({ messageType: 'carousel', content: '[{"title":"有効"},null]', question: null })} />)
  expect(screen.getByText('見え方を出せません')).toBeTruthy()
})
