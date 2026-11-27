// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Webinar, WebinarEditor } from '@/lib/api'
import { WizardSteps } from './chrome'
import { webinarStepSummaries } from './wizard-summaries'

afterEach(cleanup)
const webinar = { title: '見本', videoPrefix: 'video', schedule: [] } as unknown as Webinar
const editor = { publicPage: { form: null }, notificationMessages: { dayBefore: '通知' } } as unknown as WebinarEditor
function draw(edit: WebinarEditor, count: number) {
  const onSelect = vi.fn()
  render(<WizardSteps current="basic" stateOf={key => key === 'basic' ? 'current' : 'done'} onSelect={onSelect} summaries={webinarStepSummaries(webinar, edit, count)} />)
  return onSelect
}

it('不正な案内ボタンの件数を正しい件数として表示しない', () => {
  const onSelect = draw(editor, -1)
  expect(screen.getByText(/案内ボタン —/)).toBeTruthy()
  expect(screen.queryByText(/案内ボタン -1件/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '案内ボタン・フォームに戻る' }))
  expect(onSelect).toHaveBeenCalledWith('cta')
})

it('通知文が不正な形でも画面を表示して未取得と示す', () => {
  const onSelect = draw({ ...editor, notificationMessages: { dayBefore: null } } as unknown as WebinarEditor, 1)
  expect(screen.getByText(/通知文を確認できません/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '通知に戻る' }))
  expect(onSelect).toHaveBeenCalledWith('notifications')
})
