// @vitest-environment happy-dom
/*
 * 一斉配信の作成フォームにあるテスト送信を、本物の React で確かめる(#986)。
 *
 * 見る筋書き:
 *   1. 送信先を読み込んだだけでは実行履歴は0件。固定の日付や「成功」は出ない。
 *   2. APIは宛先を受け取らず登録済み全員へ送るので、画面も全員を同じ見た目で
 *      「N名全員へ送信」と示す（選ぶ操作も、名前から推定した役職も出さない）。
 *   3. HTTPの成功と配信の成功は別。0成功2失敗=エラー、1成功1失敗=要対応、
 *      2成功0失敗=成功で、文言と色が分かれる。
 *   4. テスト送信もLINE公式アカウントの送信枠を使うと説明する。
 */
import { setTextControlValue } from '@/test-utils/text-control'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const capturedTest = vi.hoisted(() => ({ send: undefined as undefined | (() => Promise<boolean | void>), close: undefined as undefined | ((value: boolean) => void) }))
vi.mock('./broadcast-editor-dialogs', async original => {
  const actual = await original<typeof import('./broadcast-editor-dialogs')>()
  return { ...actual, renderBroadcastEditorDialogs: (props: Parameters<typeof actual.renderBroadcastEditorDialogs>[0]) => {
    if (props.testDialogOpen) { capturedTest.send = props.handleTestSend; capturedTest.close = props.setTestDialogOpen }
    return actual.renderBroadcastEditorDialogs(props)
  } }
})

const sendApi = vi.hoisted(() => vi.fn())
const createApi = vi.hoisted(() => vi.fn())
const recipientsApi = vi.hoisted(() => vi.fn())
const account = vi.hoisted(() => ({ id: 'acc-1' }))

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
        testSend: sendApi,
        // 2回目以降のテスト送信は同じ下書きを版付きで更新する。
        update: vi.fn(async (_id: string, payload: Record<string, unknown>) => ({
          success: true,
          data: { id: 'fake-draft', version: Number(payload.expectedVersion) + 1 },
        })),
        get: vi.fn(),
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
      accountSettings: { getTestRecipients: recipientsApi },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/broadcasts/new',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, loading: false }),
}))

import BroadcastForm from './broadcast-form'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    for (let step = 0; step < 10; step += 1) await Promise.resolve()
  })
}

async function renderForm() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<BroadcastForm tags={[]} onSuccess={() => {}} onCancel={() => {}} />)
  })
  await flush()
}

function unmount() {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  setTextControlValue(element, value)
}

async function fillMinimum() {
  const title = container.querySelector('input[placeholder="例：8月キャンペーンのお知らせ"]') as HTMLInputElement | null
  expect(title).not.toBeNull()
  const body = container.querySelector('[role="textbox"][placeholder="テキストを入力"]') as HTMLTextAreaElement | null
  expect(body).not.toBeNull()
  await act(async () => {
    setNativeValue(title!, '検証配信用の題')
    setNativeValue(body!, '検証配信用の本文')
  })
  await flush()
}

function dialog(): HTMLElement {
  const el = document.querySelector('[role="dialog"]')
  expect(el).not.toBeNull()
  return el as HTMLElement
}

async function openTestDialog() {
  await renderForm()
  await fillMinimum()
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'テストを送る')
  expect(button).toBeDefined()
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

it('A/B有効時のテスト送信はA案だけと窓に示す', async () => {
  await renderForm()
  await fillMinimum()
  const add = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'B 案を追加')!
  await act(async () => { add.click() }); await flush()
  const send = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'テストを送る')!
  await act(async () => { send.click() }); await flush()
  expect(dialog().textContent).toContain('テスト送信は A案で送ります')
})

async function confirmTestSend() {
  const button = [...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'テストを送る')
  expect(button).toBeDefined()
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

function resultBanner(): HTMLElement {
  const el = [...dialog().querySelectorAll('[data-design-part="notice"]')].find((p) =>
    /テスト送信(?:できませんでした|済み|に失敗)|一部を送信できませんでした/.test(p.textContent ?? ''),
  )
  expect(el, '結果の表示がない').toBeDefined()
  return el as HTMLElement
}

beforeEach(() => {
  account.id = 'acc-1'
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network is blocked in this test') }))
  createApi.mockResolvedValue({ success: true, data: { id: 'fake-draft', version: 1 } })
  recipientsApi.mockResolvedValue({
    success: true,
    data: [
      { id: 'r1', displayName: '架空担当A', pictureUrl: null },
      { id: 'r2', displayName: '架空担当B', pictureUrl: null },
    ],
  })
})
afterEach(() => {
  unmount()
  vi.unstubAllGlobals()
})

describe('一斉配信のテスト送信（#986）', () => {
  it('確認窓ごとにテスト送信の操作を限定する', async () => {
    sendApi.mockResolvedValue({ success: true, sent: 2, failed: 0 })
    await openTestDialog()
    const oldSend = capturedTest.send!, oldClose = capturedTest.close!
    expect(oldSend).toBeTypeOf('function')
    const cancel = [...dialog().querySelectorAll('button')].find(b => b.textContent?.trim() === 'キャンセル')!
    await act(async () => { cancel.click() }); await flush()
    await act(async () => { await oldSend() }); await flush()
    expect(sendApi).not.toHaveBeenCalled()
    const reopen = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'テストを送る')!
    await act(async () => { reopen.click() }); await flush()
    act(() => oldClose(false))
    expect(dialog()).toBeTruthy()
    await act(async () => { await oldSend() }); await flush()
    expect(sendApi).not.toHaveBeenCalled()
    await confirmTestSend()
    expect(sendApi).toHaveBeenCalledTimes(1)
  })

  it('テスト送信の確認にLINEアカウントと環境を出す', async () => {
    await openTestDialog()
    expect(dialog().textContent).toContain('LINEアカウント')
    expect(dialog().textContent).toContain('環境')
  })
  it('下書き保存中にアカウントが変わったらテスト送信へ進まない', async () => {
    let finish!: (value: unknown) => void
    createApi.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await openTestDialog()
    const button = [...dialog().querySelectorAll('button')].find(b => b.textContent?.trim() === 'テストを送る')!
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(createApi).toHaveBeenCalled()
    account.id = 'acc-2'
    await act(async () => { root.render(<BroadcastForm tags={[]} onSuccess={() => {}} onCancel={() => {}} />) })
    await act(async () => { finish({ success: true, data: { id: 'fake-draft', version: 1 } }); await Promise.resolve() })
    expect(sendApi).not.toHaveBeenCalled()
  })
  it('送信先を読み込んだだけでは実行履歴は0件で、固定の成功・日時を出さない', async () => {
    await openTestDialog()
    expect(sendApi).not.toHaveBeenCalled()
    const text = dialog().textContent ?? ''
    expect(text).toContain('架空担当A')
    expect(text).toContain('架空担当B')
    expect(text).not.toContain('2026/08/23')
    expect(text).not.toContain('成功')
    // 画面のどこにも、実装と違う「送信枠を消費しない」説明を残さない。
    expect(document.body.textContent).not.toContain('送信枠を消費しません')
    expect(document.body.textContent).toContain('LINE公式アカウントの送信枠を使用します')
  })

  it('宛先は選ばせず、登録済み全員を同じ見た目で「N名全員へ送信」と示す', async () => {
    await openTestDialog()
    const el = dialog()
    expect(el.textContent).toContain('登録済みのテスト送信先 2名全員へ送信します')
    // ラジオ風の丸や選択入力は置かない（APIは宛先を受け取らず全員へ送る）。
    expect(el.querySelectorAll('input[type=radio],input[type=checkbox],[role=radio],[role=checkbox]')).toHaveLength(0)
    // 名前から推定した役職は出さない。
    expect(el.textContent).not.toContain('開発担当')
    expect(el.textContent).not.toContain('管理者')
    // 先頭だけ色を変えた「選ばれている風」の行がない。
    expect(el.querySelectorAll('.bg-accent-soft, .border-accent')).toHaveLength(0)
  })

  it('0成功2失敗はエラーとして知らせ、成功扱いにしない', async () => {
    sendApi.mockResolvedValue({ success: true, sent: 0, failed: 2 })
    await openTestDialog()
    await confirmTestSend()
    expect(sendApi).toHaveBeenCalledWith('fake-draft')
    const banner = resultBanner()
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain('2名')
    expect(dialog().textContent).not.toContain('テスト送信しました（0件）')
    expect(dialog().textContent).not.toContain('成功')
  })

  it('1成功1失敗は要対応として出す', async () => {
    sendApi.mockResolvedValue({ success: true, sent: 1, failed: 1 })
    await openTestDialog()
    await confirmTestSend()
    const banner = resultBanner()
    expect(banner.textContent).toContain('一部を送信できませんでした')
    expect(banner.textContent).toContain('1名成功')
    expect(banner.textContent).toContain('1名失敗')
  })

  it('2成功0失敗だけ成功として知らせる', async () => {
    sendApi.mockResolvedValue({ success: true, sent: 2, failed: 0 })
    await openTestDialog()
    await confirmTestSend()
    const banner = resultBanner()
    expect(banner.textContent).toContain('テスト送信済み')
    expect(banner.textContent).not.toContain('失敗')
    expect(banner.textContent).toContain('2名成功')
  })

  it('実行した分だけ履歴に残り、API失敗も履歴へ入る', async () => {
    sendApi
      .mockResolvedValueOnce({ success: true, sent: 0, failed: 2 })
      .mockResolvedValueOnce({ success: true, sent: 2, failed: 0 })
    await openTestDialog()
    await confirmTestSend()
    // The acknowledged send is complete. Close its result and explicitly start the next test.
    const close = dialog().querySelector('button[aria-label="閉じる"]')!
    await act(async () => { close.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const send = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'テストを送る')!
    await act(async () => { send.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    await confirmTestSend()
    expect(sendApi).toHaveBeenCalledTimes(2)
    const el = dialog()
    // 直近の結果は見出し側に、1つ前の結果は履歴側に残る。
    expect(el.textContent).toContain('これ以前の実行履歴')
    expect(el.textContent).toContain('届きませんでした')
    expect(el.textContent).toContain('2名成功')
  })
})
