// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock() }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle() {}, usePageCrumbs() {} }))
import FieldEditor from './field-editor'
afterEach(cleanup)
it('選択式以外では追加できない理由を示し、選択式なら追加できる', () => {
  render(<FieldEditor mode="create" folders={[]} foldersState="ready" siblings={[]} siblingsReady saving={false} backHref="/tags" onCancel={vi.fn()} onSubmit={vi.fn()} />)
  expect(screen.getByText('種類が選択肢の項目のときに追加できます。')).toBeTruthy()
  expect((screen.getByRole('button', { name: '選択肢を足す' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: '1つ選ぶ' }))
  expect(screen.queryByText('種類が選択肢の項目のときに追加できます。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '選択肢を足す' }))
  expect(screen.getByLabelText('選択肢 4')).toBeTruthy()
})
