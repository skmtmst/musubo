// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import MediaUploadDialog from './media-upload-dialog'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
afterEach(cleanup)

it.each(['constructor', '__proto__'])('未知の形式 %s を選んでも、登録できない理由を表示する', (type) => {
  const { container } = render(<MediaUploadDialog open accountId="account-a" folders={[]} initialFolderId="" onClose={vi.fn()} onComplete={vi.fn()} />)
  const input = container.querySelector<HTMLInputElement>('input[type="file"]') ?? document.querySelector<HTMLInputElement>('input[type="file"]')!
  const file = new File(['x'], 'unknown.bin', { type })
  fireEvent.change(input, { target: { files: [file] } })
  expect(screen.getByText('この形式は登録できません')).toBeTruthy()
})
