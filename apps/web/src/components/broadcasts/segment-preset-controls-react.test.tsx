// @vitest-environment happy-dom
/*
 * 一斉配信で保存した対象条件（設計 `cPk8A`・`sqFXf`）を、本物の部品で押して確かめる。
 *
 * 見る筋書き:
 *   1. 読むのも保存するのも segment_v1 の口（api.segmentPresets）だけ。
 *   2. 読み込み中・0件・失敗を分けて出す。
 *   3. アカウントを切り替えたら、前のアカウントの一覧や応答を持ち込まない。
 *   4. 取れない数は 0 や作り値で埋めず「—」と理由を出す。
 *   5. 押せない理由を吹き出しだけに置かない。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedSegmentPreset } from '@line-crm/shared'
import type { SegmentCondition } from '@/lib/segment-condition'

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return { ...actual, api: { ...actual.api, segmentPresets: { list: mocks.list, create: mocks.create } } }
})

import SegmentPresetControls from './segment-preset-controls'

const condition: SegmentCondition = {
  operator: 'AND',
  rules: [{ type: 'tag_exists', value: 'tag-vip' }],
}

function preset(overrides: Partial<SavedSegmentPreset> = {}): SavedSegmentPreset {
  return {
    id: 'preset-1',
    name: '反応した友だち',
    scope: 'friends',
    conditionFormat: 'segment_v1',
    conditions: { version: 1, condition: { operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-saved' }], groups: [] } },
    createdBy: 'staff-1',
    lineAccountId: 'acc-1',
    isShared: true,
    displayOrder: 0,
    createdAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  } as SavedSegmentPreset
}

async function flush() {
  await act(async () => {
    for (let step = 0; step < 8; step += 1) await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement {
  const found = screen.getAllByRole('button').find((item) => item.textContent?.trim() === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found as HTMLButtonElement
}

async function openChooser() {
  await act(async () => { fireEvent.click(button('保存した条件から選択する')) })
  await flush()
}

beforeEach(() => {
  mocks.list.mockResolvedValue({ success: true, data: [preset()] })
  mocks.create.mockImplementation(async (input: { name: string }) => ({ success: true, data: preset({ id: 'preset-new', name: input.name }) }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('保存した対象条件を読む・保存する', () => {
  it('選ぶ窓を開くと今のアカウントの条件を読み、選ぶと詳細条件へ読み込む', async () => {
    const onApply = vi.fn()
    render(<SegmentPresetControls accountId="acc-1" value={condition} onApply={onApply} />)
    await openChooser()
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith('acc-1')
    // 押し口は設計 cPk8A、選ぶ窓の中身は設計 sqFXf の形。
    expect(document.querySelector('[data-design-node="cPk8A"]')?.textContent).toContain('保存した条件から選択する')
    expect(document.querySelector('[role="dialog"] [data-design-node="sqFXf"]')).not.toBeNull()
    expect(document.body.textContent).toContain('反応した友だち')

    await act(async () => { fireEvent.click(button('この条件を使う')) })
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-saved' }], groups: [] })
  })

  it('名前を付けて保存すると、今の条件をアカウントに付けて1回だけ送る', async () => {
    render(<SegmentPresetControls accountId="acc-1" value={condition} onApply={() => {}} />)
    await act(async () => { fireEvent.click(button('この条件を保存する')) })
    fireEvent.change(screen.getByPlaceholderText('例：この30日で反応した友だち'), { target: { value: 'VIPだけ' } })
    await act(async () => { fireEvent.click(button('保存する')) })
    await flush()
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      name: 'VIPだけ',
      accountId: 'acc-1',
      condition: expect.objectContaining({ operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-vip' }] }),
      isShared: true,
    })
  })
})

describe('読み込みの状態を分けて出す', () => {
  it('読み込み中は待ちの形を出し、一覧も0件も出さない', async () => {
    mocks.list.mockImplementation(() => new Promise(() => {}))
    render(<SegmentPresetControls accountId="acc-1" value={condition} onApply={() => {}} />)
    await openChooser()
    expect(document.querySelector('[data-list-state="loading"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('保存した条件はまだありません')
  })

  it('本当の0件は「まだありません」と作り方を出す', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [] })
    render(<SegmentPresetControls accountId="acc-1" value={condition} onApply={() => {}} />)
    await openChooser()
    expect(document.querySelector('[data-list-state="empty"]')?.textContent).toContain('保存した条件はまだありません')
  })

  it('読めなかったときは0件と言わず、失敗とやり直しを出す', async () => {
    mocks.list.mockResolvedValue({ success: false, error: '500' })
    render(<SegmentPresetControls accountId="acc-1" value={condition} onApply={() => {}} />)
    await openChooser()
    expect(document.querySelector('[data-list-state="error"]')?.textContent).toContain('読み込めませんでした')
    expect(document.querySelector('[data-list-state="empty"]')).toBeNull()
  })
})

describe('アカウントを切り替えたとき', () => {
  it('前のアカウントの遅れた一覧を新しいアカウントで出さない', async () => {
    let resolveOld!: (value: unknown) => void
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    const view = render(<SegmentPresetControls accountId="acc-1" value={condition} onApply={() => {}} />)
    await openChooser()
    view.rerender(<SegmentPresetControls accountId="acc-2" value={condition} onApply={() => {}} />)
    mocks.list.mockResolvedValueOnce({ success: true, data: [] })
    await openChooser()
    expect(mocks.list).toHaveBeenLastCalledWith('acc-2')
    await act(async () => { resolveOld({ success: true, data: [preset({ name: '前のアカウントの条件' })] }) })
    await flush()
    expect(document.body.textContent).not.toContain('前のアカウントの条件')
    expect(document.querySelector('[data-list-state="empty"]')).not.toBeNull()
  })

  it('前のアカウントの保存の応答で、新しいアカウントの窓を閉じたり完了扱いにしない', async () => {
    let resolveSave!: (value: unknown) => void
    mocks.create.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve }))
    const view = render(<SegmentPresetControls accountId="acc-1" value={condition} onApply={() => {}} />)
    await act(async () => { fireEvent.click(button('この条件を保存する')) })
    fireEvent.change(screen.getByPlaceholderText('例：この30日で反応した友だち'), { target: { value: '古い保存' } })
    await act(async () => { fireEvent.click(button('保存する')) })
    view.rerender(<SegmentPresetControls accountId="acc-2" value={condition} onApply={() => {}} />)
    await act(async () => { fireEvent.click(button('この条件を保存する')) })
    await act(async () => { resolveSave({ success: true, data: preset({ id: 'old', name: '古い保存' }) }) })
    await flush()
    expect(screen.getByPlaceholderText('例：この30日で反応した友だち')).not.toBeNull()
    expect(document.body.textContent).not.toContain('「古い保存」として保存しました。')
  })

  it('別アカウントの条件は使わせず、読み直しを頼む', async () => {
    const onApply = vi.fn()
    mocks.list.mockResolvedValue({ success: true, data: [preset({ lineAccountId: 'acc-other' })] })
    render(<SegmentPresetControls accountId="acc-1" value={condition} onApply={onApply} />)
    await openChooser()
    await act(async () => { fireEvent.click(button('この条件を使う')) })
    expect(onApply).not.toHaveBeenCalled()
    expect(document.querySelector('[data-list-state="error"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('反応した友だち')
  })
})

describe('保存した対象条件の数（sqFXf）', () => {
  it('3つの数は「—」と、それぞれ取れない理由を添える。0は置かない', async () => {
    render(<SegmentPresetControls accountId="acc-1" value={condition} onApply={() => {}} />)
    await openChooser()
    const labels = [...document.querySelectorAll('dt')].map((item) => item.textContent)
    expect(labels).toEqual(['いま当てはまる人数', 'この条件を使っている配信', '最後に使った日'])
    const values = [...document.querySelectorAll('dl > div')].map((item) => item.querySelector('dd')?.textContent)
    expect(values).toEqual(['—', '—', '—'])
    expect(document.querySelectorAll('[data-not-connected]')).toHaveLength(3)
  })
})

describe('押せない理由を本文に出す', () => {
  it('アカウントが無いときは保存も選ぶも押せず、理由を文字で出す', () => {
    render(<SegmentPresetControls accountId={null} value={condition} onApply={() => {}} />)
    expect(button('この条件を保存する').disabled).toBe(true)
    expect(button('保存した条件から選択する').disabled).toBe(true)
    expect(document.body.textContent).toContain('先にLINEアカウントを選ぶと、この条件を保存できます。')
  })

  it('詳細条件が空のときは保存を押せず、理由を文字で出す', () => {
    render(<SegmentPresetControls accountId="acc-1" value={null} onApply={() => {}} />)
    expect(button('この条件を保存する').disabled).toBe(true)
    expect(button('保存した条件から選択する').disabled).toBe(false)
    expect(document.body.textContent).toContain('詳細条件を1つ以上入力すると、この条件を保存できます。')
  })
})
