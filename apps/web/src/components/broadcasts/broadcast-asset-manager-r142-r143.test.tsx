// @vitest-environment happy-dom
/*
 * 監査 R142・R143 を本物の React で確かめる。
 *
 * R142: 自作カルーセルを編集中にクーポンタブへ移ると、前の素材の編集欄が
 *       消え、保存要求が前の素材へ向かわない。
 * R143: 「もっと見る」の ON/OFF が保存の中身に反映され、開き直すと戻る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BroadcastAssetManager from './broadcast-asset-manager'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: scope.account, loading: false }),
}))

const scope = vi.hoisted(() => ({ account: 'acc-1' }))
const held = vi.hoisted(() => ({ confirm: null as null | (() => unknown), cancel: null as null | (() => void) }))
vi.mock('@/components/shared/confirm-dialog', async original => {
  const actual = await original<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && props.onConfirm) { held.confirm = props.onConfirm; held.cancel = props.onCancel }
    return <actual.default {...props} />
  } }
})
const { list, create, update, upload, remove } = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      broadcastMessageAssets: {
        list,
        create,
        update,
        delete: remove,
        upload,
      },
    },
  }
})

const cardAsset = {
  id: 'asset-card-1',
  lineAccountId: 'acc-1',
  kind: 'card_message',
  name: '夏カルーセル',
  payload: {
    cards: [{ id: 'p1', imageUrl: '', title: 'パネル1', description: '説明', actionLabel: '見る', actionUrl: 'https://example.com/a', template: 'product' }],
    moreCard: true,
  },
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
}

;Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement
let root: Root

function renderKind(kind: 'card_message' | 'coupon') {
  act(() => {
    root.render(<BroadcastAssetManager kind={kind} />)
  })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

function clickText(label: string) {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!el) throw new Error(`button not found: ${label}`)
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  scope.account = 'acc-1'
  upload.mockResolvedValue({ success: true, data: { url: 'https://example.com/a.png' } })
  list.mockImplementation(async ({ kind }: { kind: string }) => ({
    success: true,
    data: kind === 'card_message' ? [cardAsset] : [],
  }))
  create.mockImplementation(async () => ({ success: true, data: null }))
  update.mockImplementation(async () => ({ success: true, data: null }))
  remove.mockResolvedValue({ success: true, data: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('素材の種類を切り替える', () => {
  it('前の素材の編集欄が消える', async () => {
    renderKind('card_message')
    await flush()
    clickText('編集')
    expect(container.querySelector('input[value="夏カルーセル"]')).not.toBeNull()

    // クーポンタブへ移動（読み込み完了後も前の編集が残っていた）。
    renderKind('coupon')
    await flush()
    expect(container.querySelector('input[value="夏カルーセル"]')).toBeNull()
    expect(container.textContent).not.toContain('夏カルーセル')
  })
})

describe('「もっと見る」パネル', () => {
  it('OFF が保存の中身に反映される', async () => {
    list.mockImplementation(async () => ({ success: true, data: [] }))
    renderKind('card_message')
    await flush()
    clickText('カルーセルを作る')

    const checkbox = container.querySelector('[role="switch"]') as HTMLInputElement | null
    if (!checkbox) throw new Error('checkbox not found')
    expect((checkbox.getAttribute('aria-checked') === 'true')).toBe(true)
    act(() => {
      checkbox.click()
    })

    const setNativeValue = (el: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (!setter) throw new Error('no value setter')
      act(() => {
        setter.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const nameInput = container.querySelector('input[placeholder="カルーセルの管理名"]') as HTMLInputElement | null
    if (!nameInput) throw new Error('name input not found')
    setNativeValue(nameInput, '秋カルーセル')
    const titleInput = container.querySelector('input[placeholder="タイトル"]') as HTMLInputElement | null
    if (!titleInput) throw new Error('title input not found')
    setNativeValue(titleInput, 'パネル1')
    clickText('保存する')
    await flush()
    expect(create).toHaveBeenCalled()
    const payload = (create.mock.calls[0][0] as { payload: { moreCard: boolean } }).payload
    expect(payload.moreCard).toBe(false)
  })

  it('保存した OFF が開き直しに戻る', async () => {
    list.mockImplementation(async () => ({
      success: true,
      data: [{ ...cardAsset, payload: { ...cardAsset.payload, moreCard: false } }],
    }))
    renderKind('card_message')
    await flush()
    clickText('編集')
    const checkbox = container.querySelector('[role="switch"]') as HTMLInputElement | null
    if (!checkbox) throw new Error('checkbox not found')
    expect((checkbox.getAttribute('aria-checked') === 'true')).toBe(false)
  })
})

it('WEB254: 種類切替の遅い取得は前の素材を戻さず、失敗を空と表示しない', async () => {
  let complete!: (v: unknown) => void
  list.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  renderKind('card_message'); await flush()
  expect(container.textContent).not.toContain('まだカルーセルテンプレートがありません')
  list.mockRejectedValueOnce(new Error('offline'))
  renderKind('coupon'); await flush()
  expect(container.textContent).toContain('読み込めませんでした')
  await act(async () => complete({ success: true, data: [cardAsset] }))
  expect(container.textContent).not.toContain('夏カルーセル')
})
it('WEB255: 画像待ち中に前のカードを削除しても、選んだカードへ画像を入れる', async () => {
  const cards = ['A','B','C'].map(id => ({ ...cardAsset.payload.cards[0], id, title: id }))
  list.mockResolvedValue({ success: true, data: [{ ...cardAsset, payload: { cards, moreCard: false } }] })
  let complete!: (v: unknown) => void
  upload.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  renderKind('card_message'); await flush(); clickText('編集')
  const file = container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1]
  Object.defineProperty(file, 'files', { value: [new File(['image'], 'b.png', { type: 'image/png' })] })
  act(() => file.dispatchEvent(new Event('change', { bubbles: true })))
  clickText('削除する')
  await act(async () => complete({ success: true, data: { url: 'https://example.com/b.png' } }))
  clickText('保存する'); await flush()
  const result = update.mock.calls[0][1].payload.cards
  expect(result.map((c: { id: string; imageUrl: string }) => [c.id, c.imageUrl])).toEqual([['B', 'https://example.com/b.png'], ['C', '']])
})

it('削除確認には素材のアカウントを示し、切替後の古い確定を拒む', async () => {
  renderKind('card_message'); await flush(); clickText('削除する')
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('LINEアカウント')
  const confirm = [...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === '削除する')!
  const key = Object.keys(confirm).find(item => item.startsWith('__reactProps$'))!
  const oldConfirm = (confirm as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
  scope.account = 'acc-2'; renderKind('card_message'); await flush()
  scope.account = 'acc-1'; renderKind('card_message'); await flush()
  await act(async () => oldConfirm({ preventDefault() {}, stopPropagation() {} }))
  expect(remove).not.toHaveBeenCalled()
})

it('閉じた削除確認の確定は、同じ素材を再度開いても使えない', async () => {
  renderKind('card_message'); await flush(); clickText('削除する')
  const oldConfirm = held.confirm!
  const dialog = document.querySelector('[role="alertdialog"]')!
  const cancel = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === 'キャンセル')!
  act(() => cancel.click()); clickText('削除する')
  await act(async () => { await oldConfirm() })
  expect(remove).not.toHaveBeenCalled()
  const current = document.querySelector('[role="alertdialog"]')!
  const confirm = [...current.querySelectorAll('button')].find(button => button.textContent?.trim() === '削除する')!
  await act(async () => { confirm.click() })
  expect(remove).toHaveBeenCalledExactlyOnceWith('asset-card-1')
})

it('前の削除確認を閉じる操作で、新しい確認を閉じない', async () => {
  renderKind('card_message'); await flush(); clickText('削除する')
  const oldCancel = held.cancel!
  expect(oldCancel).toBeTypeOf('function')
  const dialog = document.querySelector('[role="alertdialog"]')!
  const cancel = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === 'キャンセル')!
  act(() => cancel.click()); clickText('削除する')
  act(() => oldCancel())
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('夏カルーセル')
  expect(remove).not.toHaveBeenCalled()
})

it('素材の名前を変更して閉じると、破棄する前に確認する', async () => {
  renderKind('card_message')
  await flush()
  clickText('編集')
  const name = container.querySelector('input[placeholder="カルーセルの管理名"]') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(name, '変更した素材'); name.dispatchEvent(new Event('input', { bubbles: true })) })
  clickText('キャンセル')
  expect(document.body.textContent).toContain('保存していない変更があります')
  expect(document.body.textContent).toContain('素材への変更')
  expect((container.querySelector('input[placeholder="カルーセルの管理名"]') as HTMLInputElement).value).toBe('変更した素材')
  const discard = [...document.body.querySelectorAll('button')].find(b => b.textContent === '保存せずに移る')!
  act(() => discard.click())
  expect(container.querySelector('input[placeholder="カルーセルの管理名"]')).toBeNull()
})

it('画像を読み込み中に閉じても、選んだ画像を破棄する前に確認する', async () => {
  let complete!: (v: unknown) => void
  upload.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  renderKind('card_message'); await flush(); clickText('編集')
  const file = container.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(file, 'files', { value: [new File(['image'], 'a.png', { type: 'image/png' })] })
  act(() => file.dispatchEvent(new Event('change', { bubbles: true })))
  clickText('キャンセル')
  expect(document.body.textContent).toContain('保存していない変更があります')
  await act(async () => complete({ success: true, data: { url: 'https://example.com/a.png' } }))
})

it('画像の同時選択で、後の選択を守る', async () => {
  let oldComplete!: (v: unknown) => void
  let newComplete!: (v: unknown) => void
  upload.mockImplementationOnce(() => new Promise(resolve => { oldComplete = resolve }))
    .mockImplementationOnce(() => new Promise(resolve => { newComplete = resolve }))
  renderKind('card_message'); await flush(); clickText('編集')
  const file = container.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(file, 'files', { configurable: true, value: [new File(['old'], 'old.png', { type: 'image/png' })] })
  act(() => file.dispatchEvent(new Event('change', { bubbles: true })))
  Object.defineProperty(file, 'files', { configurable: true, value: [new File(['new'], 'new.png', { type: 'image/png' })] })
  act(() => file.dispatchEvent(new Event('change', { bubbles: true })))
  await act(async () => oldComplete({ success: true, data: { url: 'https://example.com/old.png' } }))
  clickText('キャンセル')
  expect(document.body.textContent).toContain('保存していない変更があります')
  await act(async () => newComplete({ success: true, data: { url: 'https://example.com/new.png' } }))
})

it('素材編集中に別画面へ移ると、入力を残して確認する', async () => {
  window.history.replaceState(null, '', '/templates')
  renderKind('card_message')
  await flush()
  clickText('編集')
  const name = container.querySelector('input[placeholder="カルーセルの管理名"]') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(name, '変更した素材'); name.dispatchEvent(new Event('input', { bubbles: true })) })
  const link = document.createElement('a'); link.href = '/events'; document.body.appendChild(link)
  act(() => link.click())
  expect(document.body.textContent).toContain('保存していない変更があります')
  expect(name.value).toBe('変更した素材')
  link.remove()
})

it.each(['種類', 'アカウント'] as const)('素材の未保存入力がある%s切替は確認してから進む', async target => {
  const { requestUnsavedAction } = await import('@/lib/unsaved-action')
  renderKind('card_message'); await flush(); clickText('編集')
  const name = container.querySelector('input[placeholder="カルーセルの管理名"]') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(name, '変更した素材'); name.dispatchEvent(new Event('input', { bubbles: true })) })
  const changed = vi.fn(() => { if (target === 'アカウント') scope.account = 'acc-2'; root.render(<BroadcastAssetManager kind={target === '種類' ? 'coupon' : 'card_message'} />) })
  act(() => requestUnsavedAction(changed))
  expect(changed).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('素材への変更')
  const keep = [...document.body.querySelectorAll('button')].find(b => b.textContent === '編集を続ける')!
  act(() => keep.click())
  expect(name.value).toBe('変更した素材')
  act(() => requestUnsavedAction(changed))
  const discard = [...document.body.querySelectorAll('button')].find(b => b.textContent === '保存せずに移る')!
  act(() => discard.click())
  expect(changed).toHaveBeenCalledOnce()
  await flush()
  expect(container.querySelector('input[placeholder="カルーセルの管理名"]')).toBeNull()
})
it('素材の種類を変える親の操作も編集内容の確認を通す', async () => {
  let protect: ((action: () => void) => void) | null = null
  await act(async () => { root.render(<BroadcastAssetManager kind="card_message" onScopeGuardChange={value => { protect = value }} />) })
  await flush(); clickText('編集')
  const name = container.querySelector('input[placeholder="カルーセルの管理名"]') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(name, '変更した素材'); name.dispatchEvent(new Event('input', { bubbles: true })) })
  const switched = vi.fn()
  expect(protect).not.toBeNull()
  act(() => { protect!(switched) })
  expect(switched).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('素材への変更')
  const discard = [...document.body.querySelectorAll('button')].find(b => b.textContent === '保存せずに移る')!
  act(() => discard.click())
  expect(switched).toHaveBeenCalledOnce()
})
