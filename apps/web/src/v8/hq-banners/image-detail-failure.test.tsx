// @vitest-environment happy-dom
/*
 * 監査 WEB204：画像の受け渡し・一覧から外すが失敗したら、選んだアカウントを消さず、
 * 確認の窓も閉じない（親が失敗を飲み込んで成功の扱いにしない）。
 */
import React from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { BannerImageDetailV8 } from './image-detail'

afterEach(cleanup)

const image = {
  id: 'img-1', projectId: 'p1', sequence: 1, isFavorite: false, source: 'generated', createdAt: '2026-10-01T00:00:00+09:00',
  media: { id: 'm-1', filename: '1.png', mimeType: 'image/png', sizeBytes: 100, width: 1040, height: 1040, url: 'https://example.invalid/1.png' },
  generation: null, deliveredAccountIds: [],
}
const account = { id: 'a1', name: '銀座店', archivedAt: null, basicId: 'ginza', channelId: null, tags: [] }

test('渡すのに失敗したら、選んだアカウントを残す', async () => {
  const onDeliver = vi.fn(async () => false)
  render(<BannerImageDetailV8 image={image as never} presets={[]} accounts={[account] as never} canManage onClose={() => undefined} onToggleFavorite={() => undefined} onDeliver={onDeliver} onRemove={async () => false} />)
  await act(async () => { screen.getByRole('button', { name: '配るアカウント：選択する' }).click() })
  const dialog = await screen.findByRole('dialog', { name: '配るアカウントを選ぶ' })
  await act(async () => { within(dialog).getByRole('checkbox', { name: '銀座店' }).click() })
  await act(async () => { within(dialog).getByRole('button', { name: '選択する（1件）' }).click() })
  await act(async () => { screen.getByRole('button', { name: '1アカウントへ配る' }).click() })
  expect(onDeliver).toHaveBeenCalledWith(['a1'])
  expect(screen.getByRole('button', { name: '1アカウントへ配る' })).toBeTruthy()
  expect(screen.getByText('1 アカウント')).toBeTruthy()
})
