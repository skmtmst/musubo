// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/api/helpers/gap1', () => ({ bookingCalendarApi: { getMenuUrl: mocks.get } }))
import { MeetingModeCard, useMenuMeeting } from './meeting-mode'

function Example({ readOnly = false }: { readOnly?: boolean }) {
  const state = useMenuMeeting('account', 'menu', 'online')
  return <MeetingModeCard state={state} readOnly={readOnly} />
}
afterEach(() => { cleanup(); vi.resetAllMocks() })

it.each([false, true])('会議 URL の取得失敗を知らせ、読み直しで復旧する（閲覧のみ: %s）', async (readOnly) => {
  mocks.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: { url: 'https://example.com/meeting', version: 1 } })
  render(<Example readOnly={readOnly} />)
  await screen.findByText('会議の URL を読み込めませんでした。')
  fireEvent.click(screen.getByRole('button', { name: '会議の URL を読み直す' }))
  if (readOnly) await screen.findByText(/https:\/\/example.com\/meeting/)
  else expect((await screen.findByLabelText('メニューの固定の URL') as HTMLInputElement).value).toBe('https://example.com/meeting')
  expect(screen.queryByText('会議の URL を読み込めませんでした。')).toBeNull()
})

it('アカウントを読み込み中は失敗や読み直しを表示しない', () => {
  function Pending() {
    const state = useMenuMeeting(null, 'menu', 'online')
    return <MeetingModeCard state={state} readOnly={false} />
  }
  render(<Pending />)
  expect(screen.getByText('会議の URL を読み込んでいます。')).toBeTruthy()
  expect(screen.queryByText('会議の URL を読み込めませんでした。')).toBeNull()
  expect(screen.queryByRole('button', { name: '会議の URL を読み直す' })).toBeNull()
  expect(mocks.get).not.toHaveBeenCalled()
})
