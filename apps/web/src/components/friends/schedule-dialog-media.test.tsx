// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import ScheduleDialog from './schedule-dialog'

const apiMock = vi.hoisted(() => ({ schedule: vi.fn(), list: vi.fn() }))
const media = vi.hoisted(() => ({ item: { id: 'image-1', filename: '案内.png', kind: 'image', mimeType: 'image/png', sizeBytes: 1000, url: 'https://media.example/guide.png' } }))
vi.mock('@/lib/api', () => ({ api: { chats: { schedule: apiMock.schedule }, templates: { list: apiMock.list } } }))
vi.mock('@/components/shared/media-picker-dialog', () => ({ default: ({ onSelect }: { onSelect: (item: unknown) => void }) => <button onClick={() => onSelect(media.item)}>案内を選ぶ</button> }))
afterEach(() => { cleanup(); vi.resetAllMocks(); Object.assign(media.item, { kind: 'image', mimeType: 'image/png', sizeBytes: 1000, url: 'https://media.example/guide.png' }) })

function setup() {
  apiMock.list.mockResolvedValue({ success: true, data: [] })
  const onClose = vi.fn(), onReserved = vi.fn()
  render(<ScheduleDialog friendId="friend-1" friendName="ソラ" accountId="account-1" onClose={onClose} onReserved={onReserved} />)
  return { onClose, onReserved }
}
async function chooseImage() {
  fireEvent.click(screen.getByRole('button', { name: '画像', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '案内を選ぶ' }))
  await screen.findByAltText('案内.png')
}
const reserve = () => screen.getByRole('button', { name: /に予約$/ })

test.each([{ kind: 'video' }, { mimeType: 'image/webp' }, { sizeBytes: 1024 * 1024 + 1 }, { url: '' }])('予約できないメディアは入口を保って理由を示し、修正後に選べる: %j', async invalid => {
  setup()
  Object.assign(media.item, invalid)
  fireEvent.click(screen.getByRole('button', { name: '画像', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '案内を選ぶ' }))
  expect(await screen.findByText(/の画像を選んでください。/)).toBeTruthy()
  expect(apiMock.schedule).not.toHaveBeenCalled()
  expect(screen.queryByAltText('案内.png')).toBeNull()
  Object.assign(media.item, { kind: 'image', mimeType: 'image/png', sizeBytes: 1024 * 1024, url: 'https://media.example/guide.png' })
  fireEvent.click(screen.getByRole('button', { name: '案内を選ぶ' }))
  expect(await screen.findByAltText('案内.png')).toBeTruthy()
})

test('本文なしでも画像を日時・冪等キーと予約でき、主操作には時計の印を渡す', async () => {
  apiMock.schedule.mockResolvedValue({ success: true })
  const { onReserved } = setup()
  await chooseImage()
  expect(reserve().querySelector('svg.lucide-clock-3')).toBeTruthy()
  fireEvent.click(reserve())
  await waitFor(() => expect(onReserved).toHaveBeenCalledTimes(1))
  expect(apiMock.schedule).toHaveBeenCalledTimes(1)
  const [friend, input, key] = apiMock.schedule.mock.calls[0]
  expect(friend).toBe('friend-1')
  expect(input.messageType).toBe('image')
  expect(JSON.parse(input.content)).toEqual({ originalContentUrl: 'https://media.example/guide.png', previewImageUrl: 'https://media.example/guide.png' })
  expect(input.scheduledAt).toMatch(/T09:00:00\+09:00$/)
  expect(key).toBeTruthy()
})

test('画像の成功後に本文だけ失敗すると窓を保ち、再試行は同じキーの本文だけ', async () => {
  apiMock.schedule.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false, error: '本文の予約に失敗しました' }).mockResolvedValue({ success: true })
  const { onReserved, onClose } = setup()
  fireEvent.change(screen.getByRole('textbox', { name: '送るもの' }), { target: { value: '明日のご案内' } })
  await chooseImage()
  fireEvent.click(reserve())
  await screen.findByText('本文の予約に失敗しました')
  expect(onClose).not.toHaveBeenCalled()
  expect(onReserved).not.toHaveBeenCalled()
  expect(screen.queryByAltText('案内.png')).toBeNull()
  expect((screen.getByRole('textbox', { name: '送るもの' }) as HTMLTextAreaElement).value).toBe('明日のご案内')
  fireEvent.click(reserve())
  await waitFor(() => expect(onReserved).toHaveBeenCalledTimes(1))
  expect(apiMock.schedule.mock.calls.map(call => call[1].messageType ?? 'text')).toEqual(['image', 'text', 'text'])
  expect(apiMock.schedule.mock.calls[1][2]).toBe(apiMock.schedule.mock.calls[2][2])
})

test('通信結果が不明なら画像を保持して同じキーで再試行し、二度押しは送らない', async () => {
  let reject!: (error: Error) => void
  apiMock.schedule.mockImplementationOnce(() => new Promise((_, no) => { reject = no })).mockResolvedValue({ success: true })
  setup()
  await chooseImage()
  const button = reserve()
  fireEvent.click(button); fireEvent.click(button)
  expect(apiMock.schedule).toHaveBeenCalledTimes(1)
  reject(new Error('network'))
  await screen.findByText('予約できませんでした。通信状態を確認して、もう一度お試しください。')
  expect(screen.getByAltText('案内.png')).toBeTruthy()
  fireEvent.click(reserve())
  await waitFor(() => expect(apiMock.schedule).toHaveBeenCalledTimes(2))
  expect(apiMock.schedule.mock.calls[0][2]).toBe(apiMock.schedule.mock.calls[1][2])
})

test('画像の予約中にアカウントが変わったら残りの本文を予約しない', async () => {
  let resolve!: (value: { success: boolean }) => void
  apiMock.list.mockResolvedValue({ success: true, data: [] })
  apiMock.schedule.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const onClose = vi.fn(), onReserved = vi.fn()
  const props = { friendId: 'friend-1', friendName: 'ソラ', accountId: 'account-1', onClose, onReserved }
  const view = render(<ScheduleDialog {...props} />)
  fireEvent.change(screen.getByRole('textbox', { name: '送るもの' }), { target: { value: '明日のご案内' } })
  await chooseImage()
  fireEvent.click(reserve())
  expect(apiMock.schedule).toHaveBeenCalledTimes(1)
  view.rerender(<ScheduleDialog {...props} accountId="account-2" />)
  resolve({ success: true })
  await waitFor(() => expect(apiMock.schedule).toHaveBeenCalledTimes(1))
  await new Promise(done => setTimeout(done, 0))
  expect(apiMock.schedule).toHaveBeenCalledTimes(1)
  expect(onReserved).not.toHaveBeenCalled()
})
