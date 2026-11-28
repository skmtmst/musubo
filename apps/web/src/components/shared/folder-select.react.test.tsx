// @vitest-environment happy-dom
/*
 * ★V8 フォルダを選ぶ欄（dLffh「作れる」・iBuZH「名前を入れる」。オーナー 2026-10-08）。
 * 作って選ばれる・失敗で名前が残る・変換中の Enter で作らない・権限なしで出ない、を見張る。
 */
import { act, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
import FolderSelect, { FolderCreateError, folderCreateResult, type FolderSelectCreate, type FolderSelectFolder } from './folder-select'
import { ApiError } from '@/lib/api'
import FolderPanel from './folder-panel'
import { FolderDotName, folderDisplayColor } from './folder-dot'
import { folderById, folderByName } from './folder-select'
import { FOLDER_SELECT_COLORS } from '@line-crm/shared'

const FOLDERS: FolderSelectFolder[] = [
  { value: 'f-1', label: 'お問い合わせ', color: '#3b82f6' },
  { value: 'f-2', label: '予約', color: '#16a34a' },
]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.documentElement.dataset.theme = 'v8'
})
afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
})

function Host({ onCreate, onChange }: { onCreate?: FolderSelectCreate; onChange?: (value: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <FolderSelect
      aria-label="所属フォルダ"
      folders={FOLDERS}
      value={value}
      onChange={(next) => { setValue(next); onChange?.(next) }}
      onCreate={onCreate}
    />
  )
}

async function openMenu(props: { onCreate?: FolderSelectCreate; onChange?: (value: string) => void }) {
  await act(async () => { render(<Host {...props} />) })
  const button = screen.getByRole('button', { name: '所属フォルダ' })
  await act(async () => { fireEvent.click(button) })
  return button
}

const createRow = () => screen.queryByRole('button', { name: '新しいフォルダを作る' })

async function startCreate() {
  await act(async () => { fireEvent.click(createRow()!) })
  return screen.getByRole('textbox', { name: '新しいフォルダの名前' }) as HTMLInputElement
}

describe('開いた中身（dLffh）', () => {
  it('各行の前にフォルダの色の点、一番下に区切りと「＋ 新しいフォルダを作る」', async () => {
    await openMenu({ onCreate: vi.fn() })
    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['未分類', 'お問い合わせ', '予約'])
    const dots = options.map((option) => option.querySelector('[data-folder-dot]') as HTMLElement | null)
    expect(dots.every(Boolean)).toBe(true)
    expect(dots[1]!.style.backgroundColor).toBeTruthy()
    expect(createRow()).toBeTruthy()
    // 絵どおり、上の小さな見出しは「フォルダ」。閉じたボタンには頭を付けない。
    expect(document.querySelector('[data-select-menu]')!.textContent?.startsWith('フォルダ')).toBe(true)
    expect(screen.getByRole('button', { name: '所属フォルダ' }).textContent).toBe('未分類')
  })

  it('作る受け口が無い（閲覧のみ・権限なし）ときは「＋ 新しいフォルダを作る」を出さない', async () => {
    await openMenu({})
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(createRow()).toBeNull()
  })

  it('キーボードで一番下の「＋」まで動いて Enter で名前を入れる板に替わる', async () => {
    const button = await openMenu({ onCreate: vi.fn() })
    for (let i = 0; i < 3; i += 1) await act(async () => { fireEvent.keyDown(button, { key: 'ArrowDown' }) })
    expect(createRow()!.getAttribute('data-active')).toBe('true')
    await act(async () => { fireEvent.keyDown(button, { key: 'Enter' }) })
    expect(screen.getByRole('textbox', { name: '新しいフォルダの名前' })).toBeTruthy()
  })
})

describe('名前を入れる（iBuZH）', () => {
  it('押すと同じ板が「新しいフォルダ」に替わり、名前の欄に焦点・横の色ボタンを押すと9色', async () => {
    await openMenu({ onCreate: vi.fn() })
    const input = await startCreate()
    expect(document.activeElement).toBe(input)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'フォルダの色：青' })) })
    expect(screen.getAllByRole('radio')).toHaveLength(9)
    expect(screen.getByRole('button', { name: '作って選択する' })).toBeTruthy()
  })

  it('作ると受け口に名前と色を渡し、一覧に足してそのフォルダを選んだ状態で閉じる', async () => {
    const onCreate = vi.fn<FolderSelectCreate>().mockResolvedValue({ value: 'f-new', label: '新規', color: '#ef4444' })
    const onChange = vi.fn()
    const button = await openMenu({ onCreate, onChange })
    const input = await startCreate()
    await act(async () => { fireEvent.change(input, { target: { value: ' 新規 ' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'フォルダの色：青' })) })
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: '赤' })) })
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'フォルダの色：赤' }).getAttribute('aria-expanded')).toBe('false')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '作って選択する' })) })
    expect(onCreate).toHaveBeenCalledWith('新規', '#ef4444')
    expect(onChange).toHaveBeenCalledWith('f-new')
    expect(screen.queryByRole('group', { name: '新しいフォルダ' })).toBeNull()
    expect(button.textContent).toContain('新規')
    await act(async () => { fireEvent.click(button) })
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toContain('新規')
  })

  it('作っている間は押せない（2回押しても1回だけ作る）', async () => {
    let resolve: (folder: FolderSelectFolder) => void = () => {}
    const onCreate = vi.fn<FolderSelectCreate>().mockImplementation(() => new Promise((done) => { resolve = done }))
    await openMenu({ onCreate })
    const input = await startCreate()
    await act(async () => { fireEvent.change(input, { target: { value: '新規' } }) })
    const primary = screen.getByRole('button', { name: '作って選択する' })
    await act(async () => { fireEvent.click(primary) })
    expect((screen.getByRole('button', { name: '作っています…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'やめる' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(onCreate).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({ value: 'f-new', label: '新規' }) })
  })

  it('失敗したら板の中に理由と［もう一度試す］、入れた名前は残る', async () => {
    const onCreate = vi.fn<FolderSelectCreate>()
      .mockRejectedValueOnce(new ApiError(409, '同じ名前のフォルダがあります'))
      .mockResolvedValueOnce({ value: 'f-new', label: '新規' })
    const onChange = vi.fn()
    await openMenu({ onCreate, onChange })
    const input = await startCreate()
    await act(async () => { fireEvent.change(input, { target: { value: '新規' } }) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(screen.getByRole('alert').textContent).toBe('同じ名前のフォルダがあります')
    expect((screen.getByRole('textbox', { name: '新しいフォルダの名前' }) as HTMLInputElement).value).toBe('新規')
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'もう一度試す' })) })
    expect(onCreate).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledWith('f-new')
  })

  it('日本語の変換中の Enter では作らない', async () => {
    const onCreate = vi.fn<FolderSelectCreate>()
    await openMenu({ onCreate })
    const input = await startCreate()
    await act(async () => { fireEvent.change(input, { target: { value: 'しんき' } }) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 }) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter', isComposing: true }) })
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: '新しいフォルダの名前' })).toBeTruthy()
  })

  it('色の小窓は矢印キーで選べ、Esc は小窓だけを閉じて色ボタンへ戻る', async () => {
    await openMenu({ onCreate: vi.fn() })
    const input = await startCreate()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'フォルダの色：青' })) })
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: '青' }))
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' }) })
    expect(screen.getByRole('radio', { name: '緑' }).getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: '緑' }))
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: 'Escape' }) })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByRole('textbox', { name: '新しいフォルダの名前' })).toBe(input)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'フォルダの色：緑' }))
  })

  it('名前が空なら作れない', async () => {
    const onCreate = vi.fn<FolderSelectCreate>()
    await openMenu({ onCreate })
    const input = await startCreate()
    expect((screen.getByRole('button', { name: '作って選択する' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('Esc・［やめる］で一覧へ戻る（閉じない）', async () => {
    await openMenu({ onCreate: vi.fn() })
    await startCreate()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.getByRole('listbox')).toBeTruthy()
    await startCreate()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'やめる' })) })
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('名前の欄の Esc は一覧へ戻るだけで、後ろの聞き手（窓を閉じるなど）へ渡さない', async () => {
    const behind = vi.fn()
    document.addEventListener('keydown', behind)
    try {
      await openMenu({ onCreate: vi.fn() })
      const input = await startCreate()
      await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }) })
      expect(screen.getByRole('listbox')).toBeTruthy()
      expect(behind).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', behind)
    }
  })

  it('変換をやめる Esc では一覧へ戻らない', async () => {
    await openMenu({ onCreate: vi.fn() })
    await startCreate()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape', keyCode: 229 }) })
    expect(screen.getByRole('textbox', { name: '新しいフォルダの名前' })).toBeTruthy()
  })

  it('作っている途中で外を押して閉じ、開き直して別のフォルダを選んだら、遅れて届いた完了で上書きしない', async () => {
    let resolve: (folder: FolderSelectFolder) => void = () => {}
    const onCreate = vi.fn<FolderSelectCreate>().mockImplementation(() => new Promise((done) => { resolve = done }))
    const onChange = vi.fn()
    const button = await openMenu({ onCreate, onChange })
    const input = await startCreate()
    await act(async () => { fireEvent.change(input, { target: { value: '新規' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '作って選択する' })) })
    await act(async () => { fireEvent.pointerDown(document.body) })
    expect(screen.queryByRole('listbox')).toBeNull()
    await act(async () => { fireEvent.click(button) })
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: '予約' }).querySelector('button')!) })
    expect(onChange).toHaveBeenLastCalledWith('f-2')
    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()
    try {
      await act(async () => { resolve({ value: 'f-new', label: '新規' }) })
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(button.textContent).toContain('予約')
      expect(document.activeElement).toBe(other)
      // 作ったフォルダそのものは一覧に残る（選ばないだけ）。
      await act(async () => { fireEvent.click(button) })
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toContain('新規')
    } finally {
      other.remove()
    }
  })

  it('一覧へ戻って作り直した後、前の回の失敗は新しい板に理由を出さない', async () => {
    let reject: (error: Error) => void = () => {}
    const onCreate = vi.fn<FolderSelectCreate>().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    await openMenu({ onCreate })
    const input = await startCreate()
    await act(async () => { fireEvent.change(input, { target: { value: '古い' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '作って選択する' })) })
    await act(async () => { fireEvent.pointerDown(document.body) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '所属フォルダ' })) })
    const fresh = await startCreate()
    await act(async () => { reject(new Error('作れませんでした')) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fresh.value).toBe('')
  })

  it('色を受け取らない受け口（colors={false}）は見本を出さず null を渡す', async () => {
    const onCreate = vi.fn<FolderSelectCreate>().mockResolvedValue({ value: 'h-1', label: '本部' })
    await act(async () => {
      render(<FolderSelect aria-label="フォルダ" folders={[]} value="" onChange={vi.fn()} onCreate={onCreate} colors={false} />)
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'フォルダ' })) })
    const input = await startCreate()
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    await act(async () => { fireEvent.change(input, { target: { value: '本部' } }) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(onCreate).toHaveBeenCalledWith('本部', null)
  })
})

describe('全画面で共用する作成失敗の理由', () => {
  it.each([
    [new ApiError(401), 'ログインし直し'],
    [new ApiError(403), '権限がありません'],
    [new ApiError(409), '同じ名前のフォルダ'],
    [new ApiError(409, '同じ名前のフォルダがあります'), '同じ名前のフォルダがあります'],
    [new ApiError(422, 'フォルダ名は1〜60文字で入力してください'), '1〜60文字'],
    [new ApiError(429, undefined, undefined, undefined, undefined, 30), '30秒'],
    [new ApiError(500, undefined, undefined, undefined, 'fixture-incident-500'), '追跡番号 fixture-incident-500'],
    [new ApiError(503), 'サーバー側'],
    [new FolderCreateError('入力内容を確認してください。D1_ERROR: SELECT secret FROM private_table'), 'フォルダの作成に失敗'],
  ])('%s は通信のせいにせず回復の理由を出し、名前と色を残して再試行する', async (failure, expected) => {
    const onCreate = vi.fn<FolderSelectCreate>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ value: 'created', label: '挨拶', color: '#3b82f6' })
    const onChange = vi.fn()
    await openMenu({ onCreate, onChange })
    const input = await startCreate()
    await act(async () => { fireEvent.change(input, { target: { value: '挨拶' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '作って選択する' })) })
    const message = screen.getByRole('alert').textContent
    expect(message).toContain(expected)
    expect(message).not.toMatch(/API error:|D1_ERROR|SELECT|private_table|通信を確かめて/)
    if (failure instanceof ApiError && failure.status >= 500 && !failure.trackingId) expect(message).not.toContain('追跡番号')
    expect(input.value).toBe('挨拶')
    expect(screen.getByRole('button', { name: 'フォルダの色：青' })).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'もう一度試す' })) })
    expect(onCreate.mock.calls).toEqual([['挨拶', '#3b82f6'], ['挨拶', '#3b82f6']])
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith('created')
  })

  it('作成中にもう一度押しても呼び出しを重ねない', async () => {
    let finish: (folder: FolderSelectFolder) => void = () => {}
    const onCreate = vi.fn<FolderSelectCreate>().mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const onChange = vi.fn()
    await openMenu({ onCreate, onChange })
    const input = await startCreate()
    await act(async () => { fireEvent.change(input, { target: { value: '挨拶' } }) })
    const button = screen.getByRole('button', { name: '作って選択する' })
    await act(async () => { fireEvent.click(button); fireEvent.click(button) })
    expect(onCreate).toHaveBeenCalledOnce()
    await act(async () => { finish({ value: 'created', label: '挨拶' }) })
    expect(onChange).toHaveBeenCalledOnce()
  })
})

describe('folderCreateResult', () => {
  it('失敗の答えは理由の Error、成功はフォルダに直す', () => {
    expect(() => folderCreateResult({ success: false, error: '同じ名前があります' }, () => ({ value: '', label: '' }))).toThrow(FolderCreateError)
    try { folderCreateResult({ success: false, error: '同じ名前があります' }, () => ({ value: '', label: '' })) } catch (caught) { expect((caught as FolderCreateError).reason).toBe('同じ名前があります') }
    // 英語・内部の文は理由に出さない（板は「作れませんでした」の案内にする）。
    expect(new FolderCreateError('Internal server error').reason).toBe('')
    expect(folderCreateResult({ success: true, data: { id: 'x', name: 'A' } }, (folder) => ({ value: folder.id, label: folder.name }))).toEqual({ value: 'x', label: 'A' })
  })
})


describe('左の列のフォルダアイコンと、選ぶ欄・表の丸の色をそろえる', () => {
  it.each([null, undefined, '', '#123456'])('色 %s のフォルダは名前からの色か保存色を全箇所へ出す', async (color) => {
    const folder = { id: 'folder-test', name: 'テスト', color }
    function ColorHost() {
      const [value, setValue] = useState('')
      return <>
        <FolderPanel rows={[{ id: folder.id, kind: 'folder', label: folder.name, color, count: 1 }]} activeId={folder.id} onSelect={() => {}} />
        <FolderSelect aria-label="所属フォルダ" folders={[folderById(folder)]} value={value} onChange={setValue} />
        <div data-testid="table-name"><FolderDotName folder={folder}>行の名前</FolderDotName></div>
      </>
    }
    render(<ColorHost />)
    const readDot = (element: Element) => element.querySelector<HTMLElement>('[data-folder-dot]')!
    const rail = screen.getByRole('navigation').querySelector<SVGElement>('svg.lucide-folder')!
    const row = readDot(screen.getByTestId('table-name'))
    expect(rail.style.color).toBe(row.style.backgroundColor)
    if (!color) {
      const probe = document.createElement('span')
      probe.style.backgroundColor = folderDisplayColor(folder)
      expect(FOLDER_SELECT_COLORS.map((entry) => entry.value)).toContain(folderDisplayColor(folder))
      expect(rail.style.color).toBe(probe.style.backgroundColor)
    } else {
      const probe = document.createElement('span')
      probe.style.backgroundColor = color
      expect(rail.style.color).toBe(probe.style.backgroundColor)
    }
    const trigger = screen.getByRole('button', { name: '所属フォルダ' })
    fireEvent.click(trigger)
    const options = screen.getAllByRole('option')
    expect(readDot(options[0]).dataset.folderDot).toBe('unfiled')
    expect(readDot(options[0]).className).toContain('unfiled')
    expect(readDot(options[0]).style.backgroundColor).toBe('')
    expect(readDot(options[1]).style.backgroundColor).toBe(rail.style.color)
    fireEvent.click(options[1].querySelector('button')!)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(readDot(trigger).style.backgroundColor).toBe(rail.style.color)
    fireEvent.click(trigger)
    fireEvent.click(screen.getAllByRole('option')[0].querySelector('button')!)
    expect(readDot(trigger).dataset.folderDot).toBe('unfiled')
    expect(readDot(trigger).className).toContain('unfiled')
    expect(readDot(trigger).style.backgroundColor).toBe('')
  })

  it('未分類の値と名前を変えても輪を保ち、同じ名前のフォルダはID保存と名前保存で同じ色', () => {
    const folder = { id: 'other-id', name: 'テスト1', color: null }
    const view = render(<FolderSelect aria-label="所属フォルダ" folders={[folderById(folder)]} value={folder.id} onChange={vi.fn()} />)
    const color = screen.getByRole('button', { name: '所属フォルダ' }).querySelector<HTMLElement>('[data-folder-dot]')!.style.backgroundColor
    view.rerender(<FolderSelect aria-label="所属フォルダ" folders={[folderByName(folder)]} value={folder.name} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: '所属フォルダ' }).querySelector<HTMLElement>('[data-folder-dot]')!.style.backgroundColor).toBe(color)
    view.rerender(<FolderSelect aria-label="所属フォルダ" folders={[]} value="none" unfiled={{ value: 'none', label: '分けない' }} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: '所属フォルダ' }).querySelector<HTMLElement>('[data-folder-dot]')!.dataset.folderDot).toBe('unfiled')
  })
})


it.each(['<script>', '番号 with space', 'a'.repeat(129), ''])('使えない追跡番号は表示せず、作成の失敗と入力を残す: %s', async trackingId => {
  const onCreate = vi.fn().mockRejectedValue(new ApiError(500, undefined, undefined, undefined, trackingId))
  await openMenu({ onCreate })
  const input = await startCreate()
  fireEvent.change(input, { target: { value: '挨拶' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '作って選択する' })) })
  const text = screen.getByRole('alert').textContent
  expect(text).toContain('サーバー側')
  expect(text).not.toContain('追跡番号')
  expect(input.value).toBe('挨拶')
  expect(onCreate).toHaveBeenCalledTimes(1)
})

it('フォルダ名の入力中に外へ焦点が移っても、開き直せば入力を保つ', async () => {
  await openMenu({ onCreate: vi.fn() })
  const input = await startCreate()
  await act(async () => { fireEvent.change(input, { target: { value: '確認中の分類' } }) })
  const outside = document.createElement('button'); outside.textContent = '外側'; document.body.append(outside)
  await act(async () => { fireEvent.blur(input, { relatedTarget: outside }) })
  expect(screen.getByText('作りかけのフォルダ名があります。')).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'フォルダの入力を確認' })) })
  const restored = screen.getByRole('textbox', { name: '新しいフォルダの名前' }) as HTMLInputElement
  expect(restored.value).toBe('確認中の分類')
  outside.remove()
})


it('フォルダ名を破棄するときは確認し、編集を続けるなら入力を保持する', async () => {
  const button = await openMenu({ onCreate: vi.fn() })
  const input = await startCreate()
  await act(async () => { fireEvent.change(input, { target: { value: '新しい分類' } }) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'やめる' })) })
  expect(screen.getByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '編集を続ける' })) })
  if (!screen.queryByRole('textbox', { name: '新しいフォルダの名前' })) {
    await act(async () => { fireEvent.click(button) })
    await startCreate()
  }
  expect((screen.getByRole('textbox', { name: '新しいフォルダの名前' }) as HTMLInputElement).value).toBe('新しい分類')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'やめる' })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存せずに移る' })) })
  if (!createRow()) await act(async () => { fireEvent.click(button) })
  expect((await startCreate()).value).toBe('')
})


it('フォルダ名だけが未保存でも画面移動を確認する', async () => {
  window.history.replaceState(null, '', '/forms')
  await act(async () => { render(<><Host onCreate={vi.fn()} /><a href="/events">イベントへ</a></>) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '所属フォルダ' })) })
  const input = await startCreate()
  await act(async () => { fireEvent.change(input, { target: { value: '未保存' } }) })
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'イベントへ' })) })
  expect(screen.getByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
})

it('作成通信中に選択欄が外れたら親の処理中を解除する', async () => {
  const creating = vi.fn()
  const view = render(<FolderSelect aria-label="所属フォルダ" folders={FOLDERS} value="" onChange={() => {}} onCreatingChange={creating} onCreate={() => new Promise(() => {})} />)
  fireEvent.click(screen.getByRole('button', { name: '所属フォルダ' }))
  fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '作成中' } })
  fireEvent.click(screen.getByRole('button', { name: '作って選択する' }))
  expect(creating).toHaveBeenLastCalledWith(true)
  view.unmount()
  expect(creating).toHaveBeenLastCalledWith(false)
})
