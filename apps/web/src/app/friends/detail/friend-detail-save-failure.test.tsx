// @vitest-environment happy-dom
/**
 * M012：対応状況の保存・シナリオ登録の失敗で内部文（`API error: 403`）を出さない。
 * 画面は共通の `describeSaveFailure`（状態別の日本語案内）を出す。
 * 読み込み 403 は権限不足として区別する（面の出し分けは friend-detail-load-states-m012 が描いて見る）。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const fx = vi.hoisted(() => ({
  chatGet: vi.fn(),
  chatUpdate: vi.fn(),
  scenarioList: vi.fn(),
  scenarioEnroll: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      chats: { ...actual.api.chats, get: fx.chatGet, update: fx.chatUpdate },
      scenarios: { ...actual.api.scenarios, list: fx.scenarioList, enroll: fx.scenarioEnroll },
    },
  }
})
vi.mock('@/lib/operators-cache', () => ({ loadOperators: async () => ({ success: true, data: [] }) }))

import { ApiError } from '@/lib/api'
import { loadFailureKind } from '@/v8/friend-detail/use-friend-detail'
import { useScenarioPicker, useSupportEditor } from '@/v8/friend-detail/dialogs'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
const done = vi.fn()

function Support() {
  const editor = useSupportEditor('friend-1', done, done, 'account-a')
  return <><button type="button" onClick={() => void editor.openEditor()}>対応を開く</button>{editor.dialog}</>
}

function Picker() {
  const picker = useScenarioPicker('friend-1', '見本 143', 'account-a', done)
  return <><button type="button" onClick={() => void picker.openPicker()}>シナリオを開く</button>{picker.dialog}</>
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const button = (name: string) => [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === name) as HTMLButtonElement

beforeEach(() => {
  done.mockReset()
  fx.chatGet.mockReset().mockResolvedValue({ success: true, data: { id: 'chat-1', friendId: 'friend-1', status: 'in_progress', operatorId: null, revision: 3 } })
  fx.chatUpdate.mockReset()
  fx.scenarioList.mockReset().mockResolvedValue({ success: true, data: [{ id: 'sc-1', name: '7日間フォロー', isActive: true, lineAccountId: 'account-a' }] })
  fx.scenarioEnroll.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('M012 友だち詳細の失敗表示', () => {
  it('読み込み失敗の種類を権限不足とそれ以外に分ける', () => {
    expect(loadFailureKind(new ApiError(403, 'API error: 403'))).toBe('forbidden')
    expect(loadFailureKind(new ApiError(500, 'API error: 500'))).toBe('error')
    expect(loadFailureKind(new TypeError('Failed to fetch'))).toBe('error')
    expect(loadFailureKind(null)).toBe('error')
  })

  it('対応状況の保存失敗は内部文を出さず、状態別の案内を出して窓を残す', async () => {
    fx.chatUpdate.mockRejectedValue(new ApiError(500, 'API error: 500'))
    await act(async () => root.render(<Support />))
    await act(async () => { button('対応を開く').click() })
    await settle()
    await act(async () => { button('保存する').click() })
    await settle()
    const dialog = document.querySelector('[data-support-editor]')?.closest('[role="dialog"], [role="alertdialog"]')
    expect(dialog?.textContent).toContain('サーバー側で保存できませんでした')
    expect(document.body.textContent).not.toContain('API error')
    expect(done).not.toHaveBeenCalled()
  })

  it('シナリオ登録の失敗は内部文を出さず、状態別の案内を出す', async () => {
    fx.scenarioEnroll.mockRejectedValue(new ApiError(429, 'API error: 429'))
    await act(async () => root.render(<Picker />))
    await act(async () => { button('シナリオを開く').click() })
    await settle()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="登録するシナリオ：選ぶ"]')!.click()
    })
    const pickerDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!
    await act(async () => {
      pickerDialog.querySelector<HTMLInputElement>('input[type="radio"][aria-label="7日間フォロー"]')!.click()
    })
    await act(async () => {
      [...pickerDialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '選ぶ')!.click()
    })
    await settle()
    await act(async () => { button('このシナリオに登録する').click() })
    await settle()
    expect(fx.scenarioEnroll).toHaveBeenCalledWith('sc-1', 'friend-1')
    expect(document.body.textContent).toContain('短い時間に操作が集中しました')
    expect(document.body.textContent).not.toContain('API error')
    expect(done).not.toHaveBeenCalled()
  })
})
