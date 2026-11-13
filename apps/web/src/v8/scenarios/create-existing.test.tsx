import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * ★V8 シナリオを作る①（create.tsx）の、作りかけの下書き（id あり）を開いたときの動きの試験。
 * - 読み込み中・失敗のあいだは「作りました」と言わず、方式の確定を止める
 * - 読み込み失敗は1枚の案内に読み直しの口を付け、読み直すとシナリオを取り直す
 * - フォルダはシナリオの所属アカウントで取り、取れないときは未分類と決めつけず変更を止める
 * - 方式の保存・下書きで続けるは、保存が通ったときだけ1通目へ進む。API の内部の文は出さない
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const push = vi.hoisted(() => vi.fn())
const readScenario = vi.hoisted(() => vi.fn())
const update = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn())
const folderList = vi.hoisted(() => vi.fn())
const nav = vi.hoisted(() => ({ search: 'id=sc-1' }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(nav.search),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner' }
})
vi.mock('@/components/scenarios/scenario-reference-data', () => ({
  scenarioReferenceData: { scenario: readScenario, invalidateScenario: () => {} },
}))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const api = (actual as unknown as { api: Record<string, object> }).api
  return {
    ...actual,
    api: {
      ...api,
      folders: { ...api.folders, list: folderList },
      scenarios: { ...api.scenarios, update, create },
      scenarioDrafts: {
        get: async () => { throw new actual.ApiError(404, 'not_found', 'not_found') },
        save: async () => ({ success: true, data: null }),
        delete: async () => ({ success: true }),
      },
    },
  }
})

import ScenarioCreateV8 from './create'
import { ApiError } from '@/lib/api'

const scenario = {
  id: 'sc-1', name: '春のフォロー', description: null, triggerType: 'friend_add', triggerTagId: null,
  isActive: true, deliveryMode: 'elapsed', allowConcurrent: true, displayOrder: 0, folderId: 'sf-1',
  lineAccountId: 'account-b', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
}
const folders = [{ id: 'sf-1', kind: 'scenario', name: '初回案内', parentId: null, displayOrder: 0 }]
const defer = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const saveButton = () => screen.getByRole('button', { name: /この方式で保存する/ }) as HTMLButtonElement
const draftButton = () => getPageAction({ name: /あとで決める/ }) as HTMLButtonElement
const nameField = () => screen.getByRole('textbox', { name: 'シナリオ名' }) as HTMLInputElement

beforeEach(() => {
  verifiedStaffRole('owner')
  nav.search = 'id=sc-1'
  push.mockReset()
  readScenario.mockReset()
  readScenario.mockResolvedValue({ success: true, data: scenario })
  update.mockReset()
  update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ success: true, data: { ...scenario, ...patch } }))
  create.mockReset()
  folderList.mockReset()
  folderList.mockResolvedValue({ success: true, data: folders })
  document.documentElement.dataset.theme = 'v8'
})
afterEach(() => { cleanup(); forgetStaffIdentity() })

describe('読み込み中と読み込み失敗', () => {
  test('読み込み中は「作りました」と言わず、方式の確定も下書きも押せない', async () => {
    const slow = defer<unknown>()
    readScenario.mockReturnValue(slow.promise)
    render(<ScenarioCreateV8 />)
    expect(screen.getByText('シナリオを読み込んでいます。')).toBeTruthy()
    expect(screen.queryByText(/の下書きを作りました/)).toBeNull()
    expect(saveButton().disabled).toBe(true)
    expect(draftButton().disabled).toBe(true)
    fireEvent.click(saveButton())
    expect(update).not.toHaveBeenCalled()
    slow.resolve({ success: true, data: scenario })
    await screen.findByText('「春のフォロー」の下書きを作りました。続けて配信方式を選んでください。')
    expect(saveButton().disabled).toBe(false)
  })

  test('失敗は1枚の案内に「保存できません」と読み直しの口を出し、読み直すと取り直す', async () => {
    readScenario.mockRejectedValueOnce(new Error('offline'))
    render(<ScenarioCreateV8 />)
    await screen.findByText('シナリオを読み込めませんでした')
    expect(screen.getByText(/^配信方式の選択・保存はできません。/)).toBeTruthy()
    expect(screen.queryByText(/の下書きを作りました/)).toBeNull()
    expect(saveButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await screen.findByText('「春のフォロー」の下書きを作りました。続けて配信方式を選んでください。')
    expect(readScenario).toHaveBeenCalledTimes(2)
    expect(saveButton().disabled).toBe(false)
  })

  test('403 は共通の権限の1枚に切り替え、方式の確定を止める（生の応答は出さない）', async () => {
    readScenario.mockRejectedValueOnce(new ApiError(403, 'forbidden'))
    render(<ScenarioCreateV8 />)
    await screen.findByText('シナリオを見る権限がありません')
    expect(screen.queryByText('シナリオを読み込めませんでした')).toBeNull()
    expect(saveButton().disabled).toBe(true)
    expect(document.body.textContent).not.toContain('forbidden')
  })

  test('429 は「混み合っています」にし、画面の「保存できません」を頭に付けて読み直しの口を残す', async () => {
    readScenario.mockRejectedValueOnce(new ApiError(429, 'rate_limited'))
    render(<ScenarioCreateV8 />)
    await screen.findByText('混み合っています')
    expect(screen.getByText(/^配信方式の選択・保存はできません。/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await screen.findByText(/の下書きを作りました/)
    expect(document.body.textContent).not.toContain('rate_limited')
  })
})

describe('フォルダ', () => {
  test('シナリオの所属アカウントのフォルダを読み、保存済みのフォルダを選んでおく', async () => {
    render(<ScenarioCreateV8 />)
    await screen.findByText(/の下書きを作りました/)
    await waitFor(() => expect(folderList).toHaveBeenLastCalledWith('scenario', 'account-b'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'シナリオのフォルダ' }).textContent).toContain('初回案内'))
  })

  test('フォルダを取れないときは未分類と言わず、変更を止めて理由を出す', async () => {
    folderList.mockResolvedValue({ success: false, error: 'down' })
    render(<ScenarioCreateV8 />)
    await screen.findByText('フォルダを確認できないため、いまは変更できません。')
    expect((screen.getByRole('button', { name: 'シナリオのフォルダ' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('フォルダの読み込み中も変更を止める', async () => {
    folderList.mockReturnValue(new Promise(() => {}))
    render(<ScenarioCreateV8 />)
    await screen.findByText(/の下書きを作りました/)
    expect(screen.getByText('フォルダを読み込んでいます。')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'シナリオのフォルダ' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('方式を保存して3段目へ', () => {
  test('名前・フォルダ・方式を同じ受け口で保存してから1通目へ進む', async () => {
    render(<ScenarioCreateV8 />)
    await screen.findByText(/の下書きを作りました/)
    fireEvent.click(screen.getByRole('radio', { name: /時刻で指定/ }))
    let pushedAfterSave = false
    push.mockImplementation(() => { pushedAfterSave = update.mock.calls.length > 0 })
    fireEvent.click(saveButton())
    await waitFor(() => expect(push).toHaveBeenCalledWith('/scenarios/first-step?id=sc-1'))
    expect(update).toHaveBeenCalledWith('sc-1', { name: '春のフォロー', folderId: 'sf-1', deliveryMode: 'absolute_time' })
    expect(pushedAfterSave).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  test('保存が通らなければ進まず、決まった言葉で断る（API の文は出さない）', async () => {
    update.mockResolvedValueOnce({ success: false, error: 'D1_ERROR: constraint failed' })
    render(<ScenarioCreateV8 />)
    await screen.findByText(/の下書きを作りました/)
    fireEvent.click(saveButton())
    await screen.findByText('配信方式を保存できませんでした。時間をおいてもう一度お試しください。')
    expect(push).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('D1_ERROR')
    expect(saveButton().disabled).toBe(false)
  })

  test('保存の例外（500）も決まった言葉で断る', async () => {
    update.mockRejectedValueOnce(new ApiError(500, 'API error: 500'))
    render(<ScenarioCreateV8 />)
    await screen.findByText(/の下書きを作りました/)
    fireEvent.click(saveButton())
    await screen.findByText('配信方式を保存できませんでした。時間をおいてもう一度お試しください。')
    expect(push).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('API error')
  })
})

describe('下書きで続ける', () => {
  test('変えた名前を保存できたときだけ1通目へ進む', async () => {
    render(<ScenarioCreateV8 />)
    await screen.findByText(/の下書きを作りました/)
    fireEvent.change(nameField(), { target: { value: '夏のフォロー' } })
    fireEvent.click(draftButton())
    await waitFor(() => expect(push).toHaveBeenCalledWith('/scenarios/first-step?id=sc-1'))
    expect(update).toHaveBeenCalledWith('sc-1', { name: '夏のフォロー', folderId: 'sf-1' })
  })

  test('名前の保存に失敗したら進まず、決まった言葉で断る', async () => {
    update.mockResolvedValueOnce({ success: false, error: 'D1_ERROR' })
    render(<ScenarioCreateV8 />)
    await screen.findByText(/の下書きを作りました/)
    fireEvent.change(nameField(), { target: { value: '夏のフォロー' } })
    fireEvent.click(draftButton())
    await screen.findByText('シナリオ情報を保存できませんでした。時間をおいてもう一度お試しください。')
    expect(push).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('D1_ERROR')
  })

  test('名前を空にしたら入力不足のdisabledと理由で止まり、書かずにその場に残る', async () => {
    render(<ScenarioCreateV8 />)
    await screen.findByText(/の下書きを作りました/)
    fireEvent.change(nameField(), { target: { value: '' } })
    fireEvent.click(draftButton())
    const save = saveButton() as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(save.hasAttribute('data-permission-locked')).toBe(false)
    expect(save.getAttribute('aria-description')).toBe('シナリオ名を入力してください')
    expect(document.querySelector('[data-template-region="footer"] [role="status"]')?.textContent).toBe('シナリオ名を入力してください')
    expect(push).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('新規（id なし）は確定したときに初めて作る', () => {
  test('開いただけでは作らず、方式を確定すると名前・方式・置き場をまとめて1回で作る', async () => {
    nav.search = ''
    create.mockResolvedValue({ success: true, data: { id: 'new-1' } })
    render(<ScenarioCreateV8 />)
    expect(screen.getByText('シナリオ名と配信方式を決めると作られます。途中で閉じても一覧には残りません。')).toBeTruthy()
    expect(create).not.toHaveBeenCalled()
    fireEvent.change(nameField(), { target: { value: '秋のフォロー' } })
    fireEvent.click(screen.getByRole('radio', { name: /経過時間で指定/ }))
    fireEvent.click(saveButton())
    await waitFor(() => expect(push).toHaveBeenCalledWith('/scenarios/first-step?id=new-1'))
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: '秋のフォロー', deliveryMode: 'elapsed', folderId: null, lineAccountId: 'account-a',
    }))
    expect(update).not.toHaveBeenCalled()
  })

  test('「あとで決める」も確定の操作で、暫定の「時刻で指定」で作る', async () => {
    nav.search = ''
    create.mockResolvedValue({ success: true, data: { id: 'new-2' } })
    render(<ScenarioCreateV8 />)
    fireEvent.change(nameField(), { target: { value: '秋のフォロー' } })
    fireEvent.click(draftButton())
    await waitFor(() => expect(push).toHaveBeenCalledWith('/scenarios/first-step?id=new-2'))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: '秋のフォロー', deliveryMode: 'absolute_time' }))
  })

  test('作れなかったら API の文を出さず、1通目へ進まない', async () => {
    nav.search = ''
    create.mockResolvedValue({ success: false, error: 'D1_ERROR' })
    render(<ScenarioCreateV8 />)
    fireEvent.change(nameField(), { target: { value: '秋のフォロー' } })
    fireEvent.click(saveButton())
    await screen.findByText('シナリオを作成できませんでした。時間をおいてもう一度お試しください。')
    expect(push).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('D1_ERROR')
  })
})

test('シナリオ名は一覧の名前変更と同じ60文字までで、文字数を表示する', async () => {
  render(<ScenarioCreateV8 />)
  await waitFor(() => expect(nameField().value).toBe('春のフォロー'))
  expect(nameField().maxLength).toBe(60)
  fireEvent.focus(nameField())
  fireEvent.change(nameField(), { target: { value: '新しい名前' } })
  await waitFor(() => expect(document.body.textContent).toContain('5/60'))
})

test('既存の長い名前を変えない方式保存では、その名前を勝手に整形しない', async () => {
  const name = ` ${'長い名前'.repeat(18)} `
  readScenario.mockResolvedValue({ success: true, data: { ...scenario, name } })
  render(<ScenarioCreateV8 />)
  await waitFor(() => expect(nameField().value).toBe(name))
  fireEvent.click(saveButton())
  await waitFor(() => expect(update).toHaveBeenCalledWith('sc-1', expect.objectContaining({ name })))
})
