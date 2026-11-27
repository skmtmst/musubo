// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { PostEditor } from '@/v8/restaurant/google/posts'
import { extractMediaMetadata, mediaAcceptForKind, putMediaFile, validateMediaFile } from '@/app/contents/media-direct-upload'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/api', () => ({ api: {
  media: { list: vi.fn().mockResolvedValue({ success: true, data: { items: [], total: 0, limit: 60, offset: 0 } }) },
  instagram: { connection: vi.fn().mockResolvedValue({ success: true, data: { state: 'unconfigured', connection: null } }) },
} }))
afterEach(cleanup)
beforeEach(() => { verifiedStaffRole('owner') })

it.each(['constructor', '__proto__'])('未知の画像形式 %s を選んだら理由を表示する', (type) => {
  const { container } = render(<PostEditor accountId="account-a" kind="standard" postId={null} go={() => {}} mediaUpload={{ accept: mediaAcceptForKind('image'), extractMetadata: extractMediaMetadata, validate: validateMediaFile, put: putMediaFile }} />)
  const input = container.querySelector<HTMLInputElement>('input[type=file]')!
  fireEvent.change(input, { target: { files: [new File(['x'], 'unknown.png', { type })] } })
  expect(screen.getByText('この形式は登録できません')).toBeTruthy()
})
