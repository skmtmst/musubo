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
