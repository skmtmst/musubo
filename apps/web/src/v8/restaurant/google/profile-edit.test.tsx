import { beforeEach as seedIdentity } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import { ProfileEditScreen } from './profile-edit'

const mocks = vi.hoisted(() => ({ profile: vi.fn(), photos: vi.fn(), proposeProfile: vi.fn(), sendChange: vi.fn(), media: vi.fn(), role: 'owner' }))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: mocks }))
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), api: { media: { list: mocks.media } } }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => mocks.role, canManageRole: (role: string) => role === 'owner' }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
const data = { store: { name: '対象店舗' }, closed: false, profile: { title: '前の名前', address: { postalCode: '150-0001', administrativeArea: '東京都', locality: '渋谷区', addressLines: ['1-2-3'] }, phone: '03-0000-0000', websiteUri: 'https://example.com', description: '紹介文' } }
const media = { id: 'media-1', filename: '追加する写真.jpg', url: 'https://example.com/new.jpg', kind: 'image', lineAccountId: 'account-1' }
const go = vi.fn()
beforeEach(() => {
  vi.clearAllMocks(); document.documentElement.dataset.theme = 'v8'; mocks.role = 'owner'
  mocks.profile.mockResolvedValue(data)
  mocks.photos.mockResolvedValue({ photos: [{ name: 'photos/old', thumbnailUrl: 'https://example.com/old.jpg', googleUrl: null }] })
  mocks.media.mockResolvedValue({ success: true, data: { items: [media] } })
  mocks.proposeProfile.mockImplementation(async () => ({ change: { id: `proposal-${mocks.proposeProfile.mock.calls.length}` } }))
})
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme })
async function open() { render(<ProfileEditScreen accountId="account-1" go={go} />); await screen.findByRole('textbox', { name: '店舗名' }) }
function edit(name: string, value: string) { fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } }) }

describe('Googleプロフィールを現在の共通部品で編集する', () => {
  it('保存先の入力検査は該当欄へ理由を返し、入力を残して修正・再試行できる', async () => {
    await open(); edit('店舗名', '書きかけ')
    mocks.proposeProfile.mockRejectedValueOnce(new ApiError(422, '入力を確認してください', undefined, undefined, undefined, undefined, { title: '店舗名を短くしてください' }))
    fireEvent.click(screen.getByRole('button', { name: '変更内容を確認する' }))
    const name = screen.getByRole('textbox', { name: '店舗名' })
    await screen.findByText('店舗名を短くしてください')
    expect(name).toHaveProperty('value', '書きかけ')
    expect(name.getAttribute('aria-invalid')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(go).not.toHaveBeenCalled()
    edit('店舗名', '短い名前')
    expect(screen.queryByText('店舗名を短くしてください')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '変更内容を確認する' }))
    await waitFor(() => expect(go).toHaveBeenCalledWith({ tab: 'profile', view: 'confirm', id: 'proposal-2' }))
  })
  it('変更した項目と住所・写真の追加/削除だけを変更案にし、確認へ移るまでGoogleへ送らない', async () => {
    await open()
    edit('店舗名', ' 新しい名前 '); edit('番地・建物', '1-2-4 / 二階')
    fireEvent.click(screen.getByRole('button', { name: '写真1を削除' }))
    fireEvent.click(screen.getByRole('button', { name: '登録メディアから追加する' }))
    fireEvent.click(await screen.findByRole('button', { name: '追加する写真.jpg を追加' }))
    fireEvent.click(screen.getByRole('button', { name: '変更内容を確認する' }))
    await waitFor(() => expect(go).toHaveBeenCalledWith({ tab: 'profile', view: 'confirm', id: 'proposal-1,proposal-2,proposal-3,proposal-4' }))
    expect(mocks.proposeProfile.mock.calls).toEqual([
      ['account-1', { field: 'title', value: '新しい名前' }],
      ['account-1', { field: 'address', value: { postalCode: '150-0001', administrativeArea: '東京都', locality: '渋谷区', addressLines: ['1-2-4', '二階'] } }],
      ['account-1', { field: 'photo', action: 'add', mediaId: 'media-1' }],
      ['account-1', { field: 'photo', action: 'delete', mediaName: 'photos/old' }],
    ])
    expect(mocks.sendChange).not.toHaveBeenCalled()
  })
  it('途中で作成が失敗したら作成済みの件数を知らせ、入力と写真の変更を保つ', async () => {
    await open(); edit('店舗名', '新しい名前'); edit('電話番号', '03-0000-5678')
    mocks.proposeProfile.mockResolvedValueOnce({ change: { id: 'created-1' } }).mockRejectedValueOnce(new ApiError(500, '変更案の作成に失敗しました'))
    fireEvent.click(screen.getByRole('button', { name: '変更内容を確認する' }))
    await screen.findByText(/1件は作成済みです。変更履歴から確認できます/)
    expect(screen.getByRole('textbox', { name: '店舗名' })).toHaveProperty('value', '新しい名前')
    expect(screen.getByRole('textbox', { name: '電話番号' })).toHaveProperty('value', '03-0000-5678')
    expect(go).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '変更内容を確認する' })).toHaveProperty('disabled', false)
  })
  it('連打は同じ変更案を重複して作らず、保存成功後は未保存の確認を出さない', async () => {
    let finish!: (value: unknown) => void
    mocks.proposeProfile.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await open(); edit('店舗名', '新しい名前')
    const button = screen.getByRole('button', { name: '変更内容を確認する' })
    act(() => { button.click(); button.click() })
    expect(mocks.proposeProfile).toHaveBeenCalledTimes(1)
    await act(async () => { finish({ change: { id: 'proposal-1' } }) })
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(false)
  })
  it('書きかけを戻る時に確認し、続けるなら入力を保ち、破棄して戻れる', async () => {
    await open(); edit('店舗名', '書きかけ')
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    // ページの中の［戻る］は置かない。タブ・パンくずなど他の入口から離れようとしても確認を通る。
    act(() => requestUnsavedAction(() => go({ tab: 'profile' })))
    await screen.findByRole('dialog')
    expect(go).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /編集を続ける/ }))
    expect(screen.getByRole('textbox', { name: '店舗名' })).toHaveProperty('value', '書きかけ')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    act(() => requestUnsavedAction(() => go({ tab: 'profile' })))
    fireEvent.click(await screen.findByRole('button', { name: /保存せずに/ }))
    expect(go).toHaveBeenCalledWith({ tab: 'profile' })
  })
  it('休業中は入力と作成を止め、閲覧のみでは変更の操作を灰色にする', async () => {
    mocks.profile.mockResolvedValue({ ...data, closed: true })
    await open()
    expect(screen.getByRole('textbox', { name: '店舗名' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '変更内容を確認する' })).toHaveProperty('disabled', true)
    cleanup(); mocks.role = verifiedStaffRole('viewer'); mocks.profile.mockResolvedValue(data)
    await open()
    expect(screen.getByRole('textbox', { name: '店舗名' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '変更内容を確認する' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: '写真1を削除' }).getAttribute('aria-disabled')).toBe('true')
    expect(mocks.proposeProfile).not.toHaveBeenCalled()
  })
  it('写真の取消と入力クリアで変更が無くなれば変更案を作らない', async () => {
    await open(); edit('店舗名', '新しい名前')
    fireEvent.click(screen.getByRole('button', { name: '写真1を削除' }))
    fireEvent.click(screen.getByRole('button', { name: '削除をやめる' }))
    expect(screen.getByRole('button', { name: '写真1を削除' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '入力をクリア' }))
    expect(screen.getByRole('textbox', { name: '店舗名' })).toHaveProperty('value', '前の名前')
    expect(screen.getByRole('button', { name: '変更内容を確認する' })).toHaveProperty('disabled', true)
  })
  it('写真の取得/選択候補の失敗を示し、候補を再取得でき、閉じた後の古い応答を捨てる', async () => {
    mocks.photos.mockRejectedValue(new ApiError(500, '写真の取得に失敗しました'))
    mocks.media.mockRejectedValueOnce(new ApiError(500, '候補の取得に失敗しました'))
    await open(); await screen.findByText('写真を読み込めませんでした。')
    fireEvent.click(screen.getByRole('button', { name: '登録メディアから追加する' }))
    await screen.findByText('登録メディアを読み込めませんでした。')
    let finish!: (value: unknown) => void
    mocks.media.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: /もう一度/ }))
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    await act(async () => { finish({ success: true, data: { items: [media] } }) })
    expect(screen.queryByRole('group', { name: '登録メディアから写真を選ぶ' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '登録メディアから追加する' }))
    await screen.findByRole('button', { name: '追加する写真.jpg を追加' })
  })
})

seedIdentity(() => { verifiedStaffRole('owner') })
