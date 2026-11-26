// @vitest-environment happy-dom
/*
 * 一斉配信の書きかけを守る試験（★管理画面 sTJsh §5）。
 *
 * 見る筋書き:
 *   1. 通せる形で入力が2秒止まると、下書きへ静かに保存し「下書き保存済み」と出す。
 *      続けて直しても同じ下書きを更新するだけで、新しい下書きは増えない。
 *   2. まだ通せない形（本文なし）では自動で保存しない。
 *   3. 書きかけのまま「一覧に戻る」を押すと確認が出て、
 *      「保存して移る」は保存が通ったときだけ離れる。
 */
import { setTextControlValue } from '@/test-utils/text-control'
import React, { act, StrictMode, Suspense } from 'react'
import { waitFor } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createApi = vi.hoisted(() => vi.fn())
const updateApi = vi.hoisted(() => vi.fn())
const getApi = vi.hoisted(() => vi.fn())
const onCancelSpy = vi.hoisted(() => vi.fn())
const onDraftSavedSpy = vi.hoisted(() => vi.fn())
const pushSpy = vi.hoisted(() => vi.fn())
const testAccount = vi.hoisted(() => ({ id: 'acc-1' }))

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const emptyList = async () => ({ success: true, data: [] })
  return {
    ...actual,
    api: {
      ...actual.api,
      broadcasts: {
        ...actual.api.broadcasts,
        create: createApi,
        update: updateApi,
        get: getApi,
        list: async () => ({ success: true, data: [] }),
        preflight: async () => ({ success: true, data: { audienceCount: 10 } }),
        previewCount: async () => ({ success: true, data: { count: 10 } }),
      },
      folders: { list: emptyList },
      scenarios: { list: emptyList },
      commonVars: { list: emptyList },
      friendFields: { list: emptyList },
      broadcastMessageAssets: { list: emptyList, upload: emptyList },
      templates: { list: emptyList },
      commonActions: { resources: async () => ({ success: true, data: [] }) },
      accountSettings: { getTestRecipients: async () => ({ success: true, data: [] }) },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushSpy, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/broadcasts/new',
  useSearchParams: () => new URLSearchParams(''),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: testAccount.id, accounts: [testAccount], loading: false }),
}))

import BroadcastForm from './broadcast-form'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'

function UnsavedBubble() {
  useUnsavedGuard({ dirty: true, subject: '吹き出しの作成内容' })
  return <p>吹き出しを編集中</p>
}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    for (let step = 0; step < 12; step += 1) await Promise.resolve()
  })
}

async function renderForm(strictSuspense = false) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    const form = <BroadcastForm tags={[]} onSuccess={() => {}} onCancel={onCancelSpy} />
    root.render(strictSuspense ? <StrictMode><Suspense fallback={null}>{form}</Suspense></StrictMode> : form)
  })
  await flush()
}

function unmount() {
  act(() => {
    root.unmount()
  })
  container.remove()
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  setTextControlValue(el, value)
}

function titleInput(): HTMLInputElement {
  return container.querySelector('input[placeholder="例：8月キャンペーンのお知らせ"]') as HTMLInputElement
}

function messageInput(): HTMLTextAreaElement {
  return container.querySelector('[role="textbox"][placeholder="テキストを入力"]') as HTMLTextAreaElement
}

function clickButton(label: string) {
  // 確認の窓はポータルで body 直下に出るので、container ではなく文書全体から探す。
  const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
  if (!button) throw new Error(`ボタンが見つからない: ${label}`)
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

async function waitForDebounce() {
  // 自動保存の間合いは2秒。余裕を持って2.6秒ぶん、偽の時計で進める（本物の時間を待たない）。
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2600)
  })
  await flush()
}

describe('一斉配信の下書き自動保存（★管理画面 sTJsh §5）', () => {
  beforeEach(() => {
    // 自動保存の2秒は入力した瞬間から数えるので、描く前から偽の時計にする。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })

  afterEach(() => {
    unmount()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('通せる形で入力が2秒止まると下書きへ保存し、続きは同じ下書きを更新する', async () => {
    createApi.mockResolvedValue({ success: true, data: { id: 'draft-auto', version: 1 } })
    updateApi.mockResolvedValue({ success: true, data: { id: 'draft-auto', version: 2 } })
    await renderForm()

    await act(async () => { setValue(titleInput(), '秋の案内') })
    await act(async () => { setValue(messageInput(), 'お知らせ本文') })
    await waitForDebounce()

    expect(createApi).toHaveBeenCalledTimes(1)
    expect(updateApi).not.toHaveBeenCalled()
    expect(container.textContent).toContain('下書き保存済み')

    // 続けて直しても新しい下書きは増えず、同じIDを更新する。
    await act(async () => { setValue(messageInput(), 'お知らせ本文（追記）') })
    await waitForDebounce()

    expect(createApi).toHaveBeenCalledTimes(1)
    expect(updateApi).toHaveBeenCalledTimes(1)
    expect(updateApi.mock.calls[0][0]).toBe('draft-auto')
  }, 15000)

  it('まだ通せない形では自動で保存せず、未保存であることを薄く出す', async () => {
    await renderForm()
    await act(async () => { setValue(titleInput(), 'タイトルだけ') })
    await waitForDebounce()

    expect(createApi).not.toHaveBeenCalled()
    expect(updateApi).not.toHaveBeenCalled()
    expect(container.textContent).toContain('下書きはまだ保存していません')
  }, 15000)

  it('書きかけのまま離れようとすると確認が出て、「保存して移る」は保存が通れば離れる', async () => {
    createApi.mockResolvedValue({ success: true, data: { id: 'draft-auto', version: 1 } })
    await renderForm()
    await act(async () => { setValue(titleInput(), '秋の案内') })
    await act(async () => { setValue(messageInput(), '本文') })

    await act(async () => { clickButton('キャンセル') })
    // 離れず、確認の窓が出ている
    expect(onCancelSpy).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('保存していない変更があります')

    await act(async () => { clickButton('保存して移る') })
    await flush()
    expect(createApi).toHaveBeenCalledTimes(1)
    expect(onCancelSpy).toHaveBeenCalledTimes(1)
  }, 15000)

  it('配信と吹き出しの同時編集では、配信だけ保存した際に消える内容を知らせる', async () => {
    createApi.mockResolvedValue({ success: true, data: { id: 'draft-auto', version: 1 } })
    await renderForm()
    await act(async () => { setValue(titleInput(), '秋の案内') })
    await act(async () => { setValue(messageInput(), '本文') })
    await act(async () => { root.render(<><BroadcastForm tags={[]} onSuccess={() => {}} onCancel={onCancelSpy} /><UnsavedBubble /></>) })
    await flush()
    await act(async () => { clickButton('キャンセル') })
    expect(document.body.textContent).toContain('吹き出しの作成内容は保存されず消えます')
    expect(onCancelSpy).not.toHaveBeenCalled()
    await act(async () => { clickButton('配信の変更だけ保存して移る') })
    await flush()
    expect(createApi).toHaveBeenCalledTimes(1)
    expect(onCancelSpy).toHaveBeenCalledTimes(1)
  }, 15000)

  it.each(['リッチメッセージ', 'カルーセル', 'リッチビデオ'])('%s をここで作ると編集画面が開く', async (kind) => {
    vi.useRealTimers()
    await renderForm(true)
    await act(async () => { setValue(titleInput(), '残したい配信名') })
    const tab = Array.from(container.querySelectorAll('[role="tab"]')).find(el => el.textContent?.trim() === kind) as HTMLElement
    await act(async () => { tab.click() })
    await act(async () => { clickButton('ここで作る') })
    await waitFor(() => expect(document.body.textContent).toContain('この吹き出しに入れる'), { timeout: 10000 })
    expect(titleInput().value).toBe('残したい配信名')
  }, 15000)

  it('編集中にアカウントを切り替えると編集画面を閉じる', async () => {
    vi.useRealTimers()
    await renderForm(true)
    const tab = Array.from(container.querySelectorAll('[role="tab"]')).find(el => el.textContent?.trim() === 'リッチメッセージ') as HTMLElement
    await act(async () => { tab.click(); })
    await act(async () => { clickButton('ここで作る') })
    await waitFor(() => expect(document.body.textContent).toContain('この吹き出しに入れる'), { timeout: 10000 })
    try {
      testAccount.id = 'acc-2'
      await act(async () => { root.render(<StrictMode><Suspense fallback={null}><BroadcastForm tags={[]} onSuccess={() => {}} onCancel={onCancelSpy} /></Suspense></StrictMode>) })
      await waitFor(() => expect(document.body.textContent).not.toContain('この吹き出しに入れる'))
    } finally { testAccount.id = 'acc-1' }
  }, 15000)

  it('B案で文字以外の入口は押せず、既存の文字以外は保存前に理由を示す', async () => {
    await renderForm()
    const tab = Array.from(container.querySelectorAll('[role="tab"]')).find(el => el.textContent?.trim() === 'リッチメッセージ') as HTMLElement
    await act(async () => { tab.click() })
    await act(async () => { clickButton('B 案を追加') })
    await flush()
    expect(container.textContent).toContain('B案は今は文字だけ送れます')
    const bSection = Array.from(container.querySelectorAll('[data-message-composer]'))[0]
    expect(bSection.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-disabled')).toBe('true')
    expect((Array.from(bSection.querySelectorAll('button')).find(button => button.textContent?.trim() === 'テンプレートから選択する') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { clickButton('下書きを保存する') })
    expect(document.body.textContent).toContain('B案の文字以外は保存されません。文字だけにしてから保存してください')
    expect(createApi).not.toHaveBeenCalled()
  })

  it('吹き出し側が先に確認する時も配信の変更が消えると示す', async () => {
    function FirstBubble() {
      const guard = useUnsavedGuard({ dirty: true, subject: '吹き出しの作成内容' })
      return <UnsavedLeaveDialog open={guard.leaveTarget !== null} subject="吹き出しの作成内容" onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} />
    }
    await renderForm()
    await act(async () => { root.render(<><FirstBubble /><BroadcastForm tags={[]} onSuccess={() => {}} onCancel={onCancelSpy} /></>) })
    await act(async () => { setValue(titleInput(), '秋の案内') })
    await act(async () => { clickButton('キャンセル') })
    expect(document.body.textContent).toContain('配信の変更は保存されず消えます')
  })

  it('B案と吹き出しが未保存なら、離脱時に両方を示して保存を押せない', async () => {
    await renderForm()
    await act(async () => { clickButton('B 案を追加') })
    await act(async () => { root.render(<><BroadcastForm tags={[]} onSuccess={() => {}} onCancel={onCancelSpy} /><UnsavedBubble /></>) })
    await act(async () => { clickButton('キャンセル') })
    expect(document.body.textContent).toContain('吹き出しの作成内容は保存されず消えます')
    expect(document.body.textContent).toContain('B案は下書きに保存できません')
    const save = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('配信の変更だけ保存して移る'))!
    expect(save.disabled).toBe(true)
    expect(createApi).not.toHaveBeenCalled()
  })

  it('B案がある間は入力が有効でも自動保存しない', async () => {
    await renderForm()
    await act(async () => { setValue(titleInput(), '秋の案内') })
    await act(async () => { setValue(messageInput(), 'A案の本文') })
    await act(async () => { clickButton('B 案を追加') })
    await waitForDebounce()
    expect(createApi).not.toHaveBeenCalled()
    expect(updateApi).not.toHaveBeenCalled()
  })

  it('B案のある単頁の下書き保存は下書きを保存できない理由を出す', async () => {
    await renderForm()
    await act(async () => { setValue(titleInput(), '秋の案内') })
    await act(async () => { setValue(messageInput(), '本文') })
    await act(async () => { clickButton('B 案を追加') })
    await act(async () => { clickButton('下書きを保存する') })
    expect(document.body.textContent).toContain('B案は下書きに保存できません')
    expect(createApi).not.toHaveBeenCalled()
  })

  it('B案がある状態でのアカウント切替は破棄の確認を通す', async () => {
    await renderForm()
    await act(async () => { clickButton('B 案を追加') })
    const changeAccount = vi.fn(() => { testAccount.id = 'acc-2'; root.render(<BroadcastForm tags={[]} onSuccess={() => {}} onCancel={onCancelSpy} />) })
    await act(async () => { requestUnsavedAction(changeAccount) })
    expect(changeAccount).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('保存していない変更があります')
    await act(async () => { clickButton('保存せずに移る') })
    expect(changeAccount).toHaveBeenCalledTimes(1)
    await flush()
    expect(container.textContent).toContain('B 案を追加')
    testAccount.id = 'acc-1'
  })

  it('B案を追加しただけでも離脱前に確認し、保存できないB案を黙って捨てない', async () => {
    await renderForm()
    await act(async () => { clickButton('B 案を追加') })
    await act(async () => { clickButton('キャンセル') })
    expect(document.body.textContent).toContain('保存していない変更があります')
    await act(async () => { clickButton('保存して移る') })
    expect(onCancelSpy).not.toHaveBeenCalled()
    expect(createApi).not.toHaveBeenCalled()
  })


  it('「保存して移る」で保存に失敗したら画面に留まる', async () => {
    createApi.mockResolvedValue({ success: false, error: '保存できませんでした' })
    await renderForm()
    await act(async () => { setValue(titleInput(), '秋の案内') })
    // 通せる形にするため本文も入れる（タイトルだけだと保存自体が検査で止まる）
    await act(async () => { setValue(messageInput(), '本文') })

    await act(async () => { clickButton('キャンセル') })
    expect(document.body.textContent).toContain('保存していない変更があります')

    await act(async () => { clickButton('保存して移る') })
    await flush()
    expect(createApi).toHaveBeenCalledTimes(1)
    // 保存が通らなかったので離れず、窓も閉じて画面へ戻る
    expect(onCancelSpy).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('保存していない変更があります')
    expect(container.textContent).toContain('保存できませんでした')
  }, 15000)
})

/*
 * 保存の競合（R625/R626/R627）。
 * 使い手の約束: 書いた文字を黙って捨てない・保存済みの表示は本当のことだけ言う。
 * 実API・DB・LINE送信は触らず、隔離した桩で確かめる。
 */
describe('自動保存の競合（R625/R626/R627）', () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  async function flushFake() {
    await act(async () => {
      for (let step = 0; step < 15; step += 1) await Promise.resolve()
    })
  }

  async function tick(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
    await flushFake()
  }

  async function renderWithDraftSaved(props: Record<string, unknown> = {}) {
    testAccount.id = 'acc-1'
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <BroadcastForm tags={[]} onSuccess={() => {}} onCancel={onCancelSpy} onDraftSaved={onDraftSavedSpy} {...props} />,
      )
    })
    await flushFake()
  }

  async function rerenderWithDraftSaved(props: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(
        <BroadcastForm tags={[]} onSuccess={() => {}} onCancel={onCancelSpy} onDraftSaved={onDraftSavedSpy} {...props} />,
      )
    })
    await flushFake()
  }

  async function enter(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    await act(async () => {
      setTextControlValue(el, value)
    })
    await flushFake()
  }

  async function click(label: string) {
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
    if (!button) throw new Error(`ボタンが見つからない: ${label}`)
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushFake()
  }

  async function validInput() {
    await enter(titleInput(), 'audit A')
    await enter(messageInput(), 'body A')
  }

  beforeEach(() => {
    testAccount.id = 'acc-1'
    vi.useFakeTimers()
    createApi.mockReset()
    updateApi.mockReset()
    getApi.mockReset()
    onDraftSavedSpy.mockReset()
    onCancelSpy.mockReset()
  })

  afterEach(() => {
    unmount()
    vi.clearAllTimers()
    vi.useRealTimers()
    testAccount.id = 'acc-1'
  })

  it('R625: 保存中に追記したら置き去りにせず追って自動保存する', async () => {
    await renderWithDraftSaved()
    const req = deferred<{ success: boolean; data: { id: string; version: number } }>()
    createApi.mockReturnValue(req.promise)
    updateApi.mockResolvedValue({ success: true, data: { id: 'a', version: 2 } })
    await validInput()
    await tick(2000)
    expect(createApi).toHaveBeenCalledTimes(1)

    await enter(messageInput(), 'body B during save')
    await tick(2500)
    // 保存中の間合いは捨てず、先行の応答を待っている。
    expect(updateApi).not.toHaveBeenCalled()

    await act(async () => {
      req.resolve({ success: true, data: { id: 'a', version: 1 } })
    })
    await flushFake()
    // 追記の分が2秒後にもう一度送られる。
    await tick(2500)
    expect(updateApi).toHaveBeenCalledTimes(1)
    expect(updateApi.mock.calls[0][0]).toBe('a')
    expect(updateApi.mock.calls[0][1].messageContent).toBe('body B during save')
    expect(messageInput().value).toBe('body B during save')
    expect(container.textContent).toContain('下書き保存済み')
  })

  it('R626: 別アカウントの応答で今の画面を保存済みにしない', async () => {
    await renderWithDraftSaved()
    const req = deferred<{ success: boolean; data: { id: string; version: number; lineAccountId: string } }>()
    createApi.mockReturnValueOnce(req.promise)
    createApi.mockResolvedValue({ success: true, data: { id: 'b-for-acc2', version: 1 } })
    await validInput()
    await tick(2000)
    expect(createApi.mock.calls[0][0].lineAccountId).toBe('acc-1')

    testAccount.id = 'acc-2'
    await rerenderWithDraftSaved()
    await act(async () => {
      req.resolve({ success: true, data: { id: 'a-for-acc1', version: 1, lineAccountId: 'acc-1' } })
    })
    await flushFake()
    await tick(1000)
    // 古い応答で保存済みにしない・守りを外さない・別IDを混ぜない。
    expect(container.textContent).toContain('下書きはまだ保存していません')
    expect(container.textContent).not.toContain('下書き保存済み')
    expect(onDraftSavedSpy).not.toHaveBeenCalled()
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)

    // 今のアカウントの分は新しく作り、古いIDの更新には流さない。
    await tick(2500)
    expect(createApi).toHaveBeenCalledTimes(2)
    expect(createApi.mock.calls[1][0].lineAccountId).toBe('acc-2')
    expect(updateApi).not.toHaveBeenCalledWith('a-for-acc1', expect.anything(), expect.anything())
  })

  it('R626: 別アカウントの失敗も今の画面へ混ぜない', async () => {
    await renderWithDraftSaved()
    const req = deferred<{ success: boolean; error: string }>()
    createApi.mockReturnValueOnce(req.promise)
    createApi.mockResolvedValue({ success: true, data: { id: 'b-for-acc2', version: 1 } })
    await validInput()
    await tick(2000)
    expect(createApi).toHaveBeenCalledTimes(1)

    testAccount.id = 'acc-2'
    await rerenderWithDraftSaved()
    await act(async () => {
      req.resolve({ success: false, error: 'old account failure' })
    })
    await flushFake()
    await tick(1000)
    // 古い失敗で今の文言・守り・通知を変えない。
    expect(container.textContent).toContain('下書きはまだ保存していません')
    expect(container.textContent).not.toContain('下書き保存済み')
    expect(container.textContent).not.toContain('old account failure')
    expect(container.textContent).not.toContain('下書きを保存しています')
    expect(onDraftSavedSpy).not.toHaveBeenCalled()
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)

    // 今のアカウントの分は新しく作り直せる。
    await tick(2500)
    expect(createApi).toHaveBeenCalledTimes(2)
    expect(createApi.mock.calls[1][0].lineAccountId).toBe('acc-2')
    expect(onDraftSavedSpy).toHaveBeenCalledTimes(1)
    expect((onDraftSavedSpy.mock.calls[0][0] as { id: string }).id).toBe('b-for-acc2')
    expect(container.textContent).toContain('下書き保存済み')
  })

  it('R625/R626: Aの保存中にBへ移って追記したらBが置き去りにならない', async () => {
    await renderWithDraftSaved()
    const req = deferred<{ success: boolean; data: { id: string; version: number; lineAccountId: string } }>()
    createApi.mockReturnValueOnce(req.promise)
    createApi.mockResolvedValue({ success: true, data: { id: 'b-for-acc2', version: 1 } })
    await validInput()
    await tick(2000)
    expect(createApi).toHaveBeenCalledTimes(1)

    // Bへ移って追記し、間合いが来ても先行の保存中は投げない。
    testAccount.id = 'acc-2'
    await rerenderWithDraftSaved()
    await enter(messageInput(), 'body B newest')
    await tick(2500)
    expect(createApi).toHaveBeenCalledTimes(1)

    await act(async () => {
      req.resolve({ success: true, data: { id: 'a-for-acc1', version: 1, lineAccountId: 'acc-1' } })
    })
    await flushFake()
    // Aの応答でBを保存済みにしない。
    expect(container.textContent).toContain('下書きはまだ保存していません')
    expect(container.textContent).not.toContain('下書き保存済み')
    expect(onDraftSavedSpy).not.toHaveBeenCalled()

    // 追記の分が自動で送られる。
    await tick(3000)
    expect(createApi).toHaveBeenCalledTimes(2)
    expect(createApi.mock.calls[1][0].lineAccountId).toBe('acc-2')
    expect(createApi.mock.calls[1][0].messageContent).toBe('body B newest')
    expect(onDraftSavedSpy).toHaveBeenCalledTimes(1)
    expect((onDraftSavedSpy.mock.calls[0][0] as { id: string }).id).toBe('b-for-acc2')
    expect(messageInput().value).toBe('body B newest')
    expect(container.textContent).toContain('下書き保存済み')
  })

  it('R627: 複数の待ちが最新の先行へ付け替わり作成は1回', async () => {
    await renderWithDraftSaved()
    const req = deferred<{ success: boolean; data: { id: string; version: number } }>()
    createApi.mockReturnValueOnce(req.promise)
    createApi.mockResolvedValue({ success: true, data: { id: 'unexpected-second-create', version: 1 } })
    updateApi.mockResolvedValue({ success: true, data: { id: 'first', version: 3 } })
    await validInput()
    await tick(2000)
    expect(createApi).toHaveBeenCalledTimes(1)

    // 手動は先行を待ち、その間に追記が入る。
    await click('下書きを保存する')
    expect(createApi).toHaveBeenCalledTimes(1)
    await enter(messageInput(), 'body C newest')

    await act(async () => {
      req.resolve({ success: true, data: { id: 'first', version: 1 } })
    })
    await flushFake()
    await tick(3000)
    await tick(3000)
    // 作成は1回。待ちは最新の入力で更新へ回り、追記を捨てない。
    expect(createApi).toHaveBeenCalledTimes(1)
    expect(updateApi.mock.calls.length).toBeGreaterThanOrEqual(1)
    const lastUpdate = updateApi.mock.calls[updateApi.mock.calls.length - 1]
    expect(lastUpdate[0]).toBe('first')
    expect(lastUpdate[1].messageContent).toBe('body C newest')
    expect(messageInput().value).toBe('body C newest')
    expect(container.textContent).toContain('下書き保存済み')
    const savedIds = onDraftSavedSpy.mock.calls.map((call) => (call[0] as { id: string }).id)
    expect(new Set(savedIds)).toEqual(new Set(['first']))
  })

  it('R627: 初回自動作成の保留中に手動保存しても作成は1回', async () => {
    await renderWithDraftSaved()
    const req = deferred<{ success: boolean; data: { id: string; version: number } }>()
    createApi.mockReturnValueOnce(req.promise)
    createApi.mockResolvedValue({ success: true, data: { id: 'unexpected-second-create', version: 1 } })
    updateApi.mockResolvedValue({ success: true, data: { id: 'first', version: 2 } })
    await validInput()
    await tick(2000)
    expect(createApi).toHaveBeenCalledTimes(1)

    await click('下書きを保存する')
    // 手動は先行を待つので、2つ目の作成は投げない。
    expect(createApi).toHaveBeenCalledTimes(1)

    await act(async () => {
      req.resolve({ success: true, data: { id: 'first', version: 1 } })
    })
    await flushFake()
    await tick(1000)
    expect(createApi).toHaveBeenCalledTimes(1)
    expect(updateApi).toHaveBeenCalledTimes(1)
    expect(updateApi.mock.calls[0][0]).toBe('first')
    const savedIds = onDraftSavedSpy.mock.calls.map((call) => (call[0] as { id: string }).id)
    expect(new Set(savedIds)).toEqual(new Set(['first']))
    expect(container.textContent).toContain('下書き保存済み')
  })

  it('R627: 段を移動しても初回作成は1回で最新の段で追いつく', async () => {
    let step: 'basic' | 'audience' | 'message' | 'schedule' | 'confirm' = 'basic'
    const renderStep = async () => {
      await act(async () => {
        root.render(
          <BroadcastForm
            tags={[]}
            onSuccess={() => {}}
            onCancel={onCancelSpy}
            onDraftSaved={onDraftSavedSpy}
            currentStep={step}
            onStepChange={(next) => {
              step = next
              void renderStep()
            }}
          />,
        )
      })
      await flushFake()
    }
    testAccount.id = 'acc-1'
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await renderStep()

    const req = deferred<{ success: boolean; data: { id: string; version: number } }>()
    createApi.mockReturnValueOnce(req.promise)
    createApi.mockResolvedValue({ success: true, data: { id: 'unexpected-second-create', version: 1 } })
    updateApi.mockResolvedValue({ success: true, data: { id: 'auto-first', version: 2 } })

    await enter(titleInput(), 'reachable title')
    await click('対象設定へ')
    expect(step).toBe('audience')
    await act(async () => { container.querySelector<HTMLInputElement>('input[name=broadcast-target-mode][value=scenario]')!.click() })
    await click('メッセージ設定へ')
    expect(step).toBe('message')
    await enter(messageInput(), 'reachable body')
    await click('送信設定へ')
    expect(step).toBe('schedule')
    await act(async () => { container.querySelector<HTMLInputElement>('input[name=broadcast-send-mode][value=now]')!.click() })
    await click('配信前チェックへ')
    expect(step).toBe('confirm')

    await tick(2000)
    expect(createApi).toHaveBeenCalledTimes(1)
    // 最後に入力した送信設定の段で送られる（移動だけでは指紋は変わらない）。
    expect(createApi.mock.calls[0][0].draftStep).toBe('schedule')

    await click('下書きを保存する')
    expect(createApi).toHaveBeenCalledTimes(1)

    await act(async () => {
      req.resolve({ success: true, data: { id: 'auto-first', version: 1 } })
    })
    await flushFake()
    await tick(1000)
    // 最新の段で更新に回り、作成は増えない。版・表示を混ぜない。
    expect(createApi).toHaveBeenCalledTimes(1)
    expect(updateApi).toHaveBeenCalledTimes(1)
    expect(updateApi.mock.calls[0][0]).toBe('auto-first')
    expect(updateApi.mock.calls[0][1].draftStep).toBe('confirm')
    expect(updateApi.mock.calls[0][1].expectedVersion).toBe(1)
    expect(messageInput().value).toBe('reachable body')
  })
})
