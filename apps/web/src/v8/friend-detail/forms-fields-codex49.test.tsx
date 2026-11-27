// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import FormsTab from './forms-tab'
import type { FriendDetailState } from './use-friend-detail'

afterEach(() => cleanup())
const renderSubmission = (fields: unknown[], data: unknown) => render(<FormsTab data={{
  submissionsStatus: 'ready', submissions: [{ id: 'sample', formName: '見本のフォーム', createdAt: '2026-11-27', fields, data }],
} as unknown as FriendDetailState} />)

it.each([{}, null])('回答していない特殊な名前の質問を回答済みとして表示しない (%s)', answers => {
  renderSubmission([{ name: 'toString', label: '見本の未回答' }], answers)
  expect(screen.getByText('見本のフォーム')).toBeTruthy()
  expect(screen.queryByText('見本の未回答')).toBeNull()
})

it('同じ質問の定義が複数あっても回答を重複表示しない', () => {
  renderSubmission([{ name: 'choice', label: '見本の質問' }, { name: 'choice', label: '見本の質問' }], { choice: '見本の回答' })
  expect(screen.getAllByText('見本の質問')).toHaveLength(1)
  expect(screen.getAllByText('見本の回答')).toHaveLength(1)
})

it('特殊な名前でも実際にある回答は表示する', () => {
  renderSubmission([{ name: '__proto__', label: '見本の項目' }], JSON.parse('{"__proto__":"見本の値"}'))
  expect(screen.getByText('見本の項目')).toBeTruthy()
  expect(screen.getByText('見本の値')).toBeTruthy()
})
