// @vitest-environment happy-dom
import React from 'react'
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'admin', canManageRole: () => true }))
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  routerPush: vi.fn(),
  back: null as string | null,
  fieldsList: vi.fn(),
  fieldsCreate: vi.fn(),
  foldersList: vi.fn(),
  foldersCreate: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/tags',
  useRouter: () => ({ push: fixture.routerPush }),
  useSearchParams: () => new URLSearchParams(fixture.back ? { back: fixture.back } : {}),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn(), usePageCrumbs: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-1' }),
}))
vi.mock('@/lib/use-feature-visibility', () => ({
  useFeatureVisibility: () => ({ status: 'ready' as const, features: null, enabled: () => true }),
}))
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    friendFields: { list: fixture.fieldsList, create: fixture.fieldsCreate },
    folders: { list: fixture.foldersList, create: fixture.foldersCreate },
    featureSettings: {
      visibility: () => Promise.resolve({ success: true, data: { features: {} } }),
    },
  },
  describeSaveFailure: () => '保存できませんでした。接続を確かめて、もう一度お試しください。',
}))

import NewFriendFieldPage from './page'

function createButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '項目を作る' }) as HTMLButtonElement
}

beforeEach(() => {
  fixture.back = null;
  fixture.fieldsList.mockResolvedValue({ success: true, data: [] })
  fixture.foldersList.mockResolvedValue({ success: true, data: [] })
  fixture.fieldsCreate.mockResolvedValue({ success: true, data: { id: 'ff-9' } })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('R514 既存項目の取得失敗を隠さず、読み直すまで保存しない', () => {
  it('失敗中は作成ボタンを押せず、再試行の成功で入力を残したまま進める', async () => {
    fixture.fieldsList.mockRejectedValueOnce(new Error('network down'))
    render(<NewFriendFieldPage />)
    await screen.findByText('既存の項目を読み込めませんでした')
    expect(createButton().disabled).toBe(true)
    expect(fixture.fieldsCreate).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText('例：愛犬のお名前'), { target: { value: '試す名前' } })
    fireEvent.change(screen.getByPlaceholderText('pet_name'), { target: { value: 'trial_name' } })

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await waitFor(() => expect(createButton().disabled).toBe(false))
    expect((screen.getByPlaceholderText('例：愛犬のお名前') as HTMLInputElement).value).toBe('試す名前')
    expect((screen.getByPlaceholderText('pet_name') as HTMLInputElement).value).toBe('trial_name')
    expect(fixture.fieldsCreate).not.toHaveBeenCalled()

    fireEvent.click(createButton())
    await waitFor(() => expect(fixture.fieldsCreate).toHaveBeenCalledTimes(1))
    expect(fixture.routerPush).toHaveBeenCalledWith('/tags?tab=fields&highlight=ff-9')
  })

  it('フォルダの取得失敗は隠さず、その場で読み直せる', async () => {
    fixture.foldersList.mockRejectedValueOnce(new Error('network down'))
    render(<NewFriendFieldPage />)
    await screen.findByText(/フォルダを読み込めませんでした/)
    // 既存項目は読めているので保存はできる（未分類に入ることを明示している）。
    expect(createButton().disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await waitFor(() => expect(screen.queryByText(/フォルダを読み込めませんでした/)).toBeNull())
  })
})

describe('R515 応答消失後の再試行は同じ要求キーで送る', () => {
  it('入力を変えない再試行は同じキーになる', async () => {
    render(<NewFriendFieldPage />)
    await waitFor(() => expect(createButton().disabled).toBe(false))
    fireEvent.change(screen.getByPlaceholderText('例：愛犬のお名前'), { target: { value: '試す名前' } })
    fireEvent.change(screen.getByPlaceholderText('pet_name'), { target: { value: 'trial_name' } })

    fixture.fieldsCreate.mockRejectedValueOnce(new Error('response lost'))
    fireEvent.click(createButton())
    await screen.findByText('保存できませんでした。接続を確かめて、もう一度お試しください。')
    expect(fixture.fieldsCreate).toHaveBeenCalledTimes(1)
    const firstKey = fixture.fieldsCreate.mock.calls[0][2] as string
    expect(typeof firstKey).toBe('string')
    expect(firstKey.length).toBeGreaterThan(0)

    fixture.fieldsCreate.mockResolvedValueOnce({ success: true, data: { id: 'ff-9' } })
    fireEvent.click(createButton())
    await waitFor(() => expect(fixture.routerPush).toHaveBeenCalledWith('/tags?tab=fields&highlight=ff-9'))
    const secondKey = fixture.fieldsCreate.mock.calls[1][2] as string
    expect(secondKey).toBe(firstKey)
  })
})


it.each(['https://evil.example/login', 'javascript:alert(1)', '/\\evil.example'])('F19: cancel with unsafe back=%s stays on the field list', async back => {
  fixture.back = back
  render(<NewFriendFieldPage />)
  await waitFor(() => expect(createButton().disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル', exact: true }))
  expect(fixture.routerPush).toHaveBeenCalledWith('/tags?tab=fields')
})

it('フォルダ名だけが未保存のとき、キャンセルで確認する', async () => {
  render(<NewFriendFieldPage />)
  await waitFor(() => expect(createButton().disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '友だち情報欄のフォルダ' }))
  fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '作成途中' } })
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(screen.getByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  expect(fixture.routerPush).not.toHaveBeenCalled()
})

it('フォルダ名が未保存のとき、情報欄の保存前に確認する', async () => {
  render(<React.StrictMode><NewFriendFieldPage /></React.StrictMode>)
  await waitFor(() => expect(createButton().disabled).toBe(false))
  fireEvent.change(screen.getByPlaceholderText('例：愛犬のお名前'), { target: { value: '試す名前' } })
  fireEvent.change(screen.getByPlaceholderText('pet_name'), { target: { value: 'trial_name' } })
  fireEvent.click(screen.getByRole('button', { name: '友だち情報欄のフォルダ' }))
  fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '作成途中' } })
  fireEvent.pointerDown(document.body)
  fireEvent.click(createButton())
  expect(screen.getByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  expect(fixture.fieldsCreate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを破棄して保存' }))
  await waitFor(() => expect(fixture.fieldsCreate).toHaveBeenCalledTimes(1))
  expect(fixture.fieldsCreate.mock.calls[0][1]).toMatchObject({ name: '試す名前', fieldKey: 'trial_name' })
})

it('情報欄とフォルダの両方が未保存でもキャンセル確認は1枚で、編集継続なら両方残る', async () => {
  render(<NewFriendFieldPage />)
  await waitFor(() => expect(createButton().disabled).toBe(false))
  fireEvent.change(screen.getByPlaceholderText('例：愛犬のお名前'), { target: { value: '試す名前' } })
  fireEvent.click(screen.getByRole('button', { name: '友だち情報欄のフォルダ' }))
  fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '作成途中' } })
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(screen.getAllByRole('dialog', { name: '保存していない変更があります' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
  expect((screen.getByPlaceholderText('例：愛犬のお名前') as HTMLInputElement).value).toBe('試す名前')
  if (!screen.queryByRole('textbox', { name: '新しいフォルダの名前' })) {
    fireEvent.click(screen.getByRole('button', { name: '友だち情報欄のフォルダ' }))
    fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' }))
  }
  expect((screen.getByRole('textbox', { name: '新しいフォルダの名前' }) as HTMLInputElement).value).toBe('作成途中')
})


it('フォルダ作成中は情報欄の保存を止め、理由を表示する', async () => {
  fixture.foldersCreate.mockImplementation(() => new Promise(() => {}))
  render(<NewFriendFieldPage />)
  await waitFor(() => expect(createButton().disabled).toBe(false))
  fireEvent.change(screen.getByPlaceholderText('例：愛犬のお名前'), { target: { value: '試す名前' } })
  fireEvent.change(screen.getByPlaceholderText('pet_name'), { target: { value: 'trial_name' } })
  fireEvent.click(screen.getByRole('button', { name: '友だち情報欄のフォルダ' }))
  fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '作成途中' } })
  fireEvent.click(screen.getByRole('button', { name: '作って選択する' }))
  expect(createButton().disabled).toBe(true)
  expect(screen.getByText('フォルダを作成中です。完了するまでお待ちください。')).toBeTruthy()
  expect(fixture.fieldsCreate).not.toHaveBeenCalled()
})
