// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import MediaSlot, { type MediaSlotProps } from './media-slot'

afterEach(cleanup)
const title = '画像を追加'
const reason = '閲覧のみのため画像を変えられません'
const png = () => new File(['x'], 'a.png', { type: 'image/png' })
const frame = () => screen.getByRole('group', { name: title })
const input = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement
function choose(container: HTMLElement) { fireEvent.change(input(container), { target: { files: [png()] } }) }
function drop() { fireEvent.drop(frame(), { dataTransfer: { files: [png()] } }) }
function paste() { const file = png(); fireEvent.paste(frame(), { clipboardData: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] } }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }

it('権限の時も選ぶ口を残し、焦点とホバーで理由を出す。クリック・Enter・Spaceは拒む', () => {
  const onFile = vi.fn(), parent = vi.fn()
  const { container } = render(<div onClick={parent}><MediaSlot title={title} onFile={onFile} lockedReason={reason} /></div>)
  const button = screen.getByRole('button', { name: /画像を追加/ }) as HTMLButtonElement
  const open = vi.spyOn(input(container), 'click')
  expect(button.disabled).toBe(false)
  expect(button.tabIndex).toBe(0)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(button)
  expect(screen.getByRole('tooltip').textContent).toBe(reason)
  fireEvent.blur(button)
  fireEvent.pointerEnter(button, { pointerType: 'mouse' })
  expect(screen.getByRole('tooltip').textContent).toBe(reason)
  fireEvent.click(button)
  expect(fireEvent.keyDown(button, { key: 'Enter' })).toBe(false)
  expect(fireEvent.keyDown(button, { key: ' ' })).toBe(false)
  fireEvent.click(frame())
  expect(open).not.toHaveBeenCalled()
  expect(onFile).not.toHaveBeenCalled()
  expect(parent).toHaveBeenCalledTimes(1)
})

it.each(['input', 'drop', 'paste'] as const)('権限の時は%sからもファイルを渡さない', (entry) => {
  const upload = vi.fn(), onFiles = vi.fn(), onFile = vi.fn()
  const { container } = render(<MediaSlot title={title} acceptPaste lockedReason={reason} upload={upload} onFiles={onFiles} onFile={onFile} />)
  if (entry === 'input') choose(container)
  if (entry === 'drop') drop()
  if (entry === 'paste') paste()
  expect(upload).not.toHaveBeenCalled()
  expect(onFiles).not.toHaveBeenCalled()
  expect(onFile).not.toHaveBeenCalled()
})

it('本人未確定の時は普通のdisabledで、権限の印・説明を出さずAPIを呼ばない', () => {
  const onFile = vi.fn()
  const { container } = render(<MediaSlot title={title} canChangeNow={() => false} onFile={onFile} acceptPaste />)
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
  expect(container.querySelector('[data-permission-locked]')).toBeNull()
  choose(container); drop(); paste()
  expect(onFile).not.toHaveBeenCalled()
})

it('既存画像と差し替え・消去・URL・登録メディアの口を残し、全操作を理由付きで拒む', () => {
  const onChange = vi.fn(), onRemove = vi.fn(), onUrl = vi.fn(), onMediaPick = vi.fn()
  const { container } = render(<MediaSlot title={title} value="https://cdn.test/old.png" onFile={vi.fn()} onChange={onChange} onRemove={onRemove} onUrl={onUrl} onMediaPick={onMediaPick} controlsBelow lockedReason={reason} />)
  const open = vi.spyOn(input(container), 'click')
  expect(screen.getByRole('img').getAttribute('src')).toBe('https://cdn.test/old.png')
  for (const name of ['差し替える', '消す', 'URL で入れる', '登録メディアから選択する']) {
    const button = screen.getByRole('button', { name }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.tabIndex).toBe(0)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.focus(button)
    expect(screen.getAllByRole('tooltip').at(-1)?.textContent).toBe(reason)
    fireEvent.click(button)
    fireEvent.blur(button)
  }
  expect(open).not.toHaveBeenCalled()
  for (const fn of [onChange, onRemove, onUrl, onMediaPick]) expect(fn).not.toHaveBeenCalled()
})

it('URLの欄を開いた後に拒否へ替わっても欄と値を保ち、書き換えない', () => {
  const onChange = vi.fn()
  const props: MediaSlotProps = { title, urlEntry: { value: 'https://cdn.test/old.png', onChange, label: '画像のURL' } }
  const view = render(<MediaSlot {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'URL で入れる' }))
  view.rerender(<MediaSlot {...props} lockedReason={reason} />)
  const field = screen.getByRole('textbox') as HTMLInputElement
  expect(field.value).toBe('https://cdn.test/old.png')
  expect(field.disabled).toBe(true)
  fireEvent.change(field, { target: { value: 'https://cdn.test/new.png' } })
  expect(onChange).not.toHaveBeenCalled()
})

it('再描画なしで実行直前に権限を失っても、保持した選択と入力・drop・pasteを止める', () => {
  let allowed = true, chooseHeld = () => {}
  const onFiles = vi.fn(), onFile = vi.fn()
  const { container } = render(<MediaSlot title={title} canChangeNow={() => allowed} onFiles={onFiles} onFile={onFile} renderTrigger={(open) => { chooseHeld = open; return <button onClick={open}>選ぶ</button> }} />)
  const open = vi.spyOn(input(container), 'click')
  allowed = false
  chooseHeld(); choose(container)
  expect(open).not.toHaveBeenCalled()
  expect(onFiles).not.toHaveBeenCalled()
  expect(onFile).not.toHaveBeenCalled()
})

it.each(['drop', 'paste'] as const)('再描画前の権限変更も%sの時点で確かめる', (entry) => {
  let allowed = true
  const onFiles = vi.fn(), onFile = vi.fn()
  render(<MediaSlot title={title} canChangeNow={() => allowed} onFiles={onFiles} onFile={onFile} acceptPaste />)
  allowed = false
  if (entry === 'drop') drop(); else paste()
  expect(onFiles).not.toHaveBeenCalled()
  expect(onFile).not.toHaveBeenCalled()
})

it('非同期の検査中に拒否へ替わったらuploadを始めない。権限が戻っても古い処理は再開しない', async () => {
  const checked = deferred<string>(), upload = vi.fn(), onChange = vi.fn()
  const props = { title, validate: () => checked.promise, upload, onChange, canChangeNow: () => true }
  const view = render(<MediaSlot {...props} />)
  choose(view.container)
  view.rerender(<MediaSlot {...props} lockedReason={reason} />)
  view.rerender(<MediaSlot {...props} />)
  await act(async () => checked.resolve(''))
  expect(upload).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
})

it('非同期検査のあとにも最新の権限callbackを確かめる', async () => {
  const checked = deferred<string>(), onFile = vi.fn()
  const view = render(<MediaSlot title={title} validate={() => checked.promise} canChangeNow={() => true} onFile={onFile} />)
  choose(view.container)
  view.rerender(<MediaSlot title={title} validate={() => checked.promise} canChangeNow={() => false} onFile={onFile} />)
  await act(async () => checked.resolve(''))
  expect(onFile).not.toHaveBeenCalled()
})

it('取り込み中の役割切替は古い返事を反映しない。復帰後に新しく選んだ画像は反映する', async () => {
  const first = deferred<string>(), second = deferred<string>(), onChange = vi.fn()
  const upload = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const props = { title, upload, onChange, canChangeNow: () => true }
  const view = render(<MediaSlot {...props} />)
  choose(view.container)
  expect(upload).toHaveBeenCalledTimes(1)
  view.rerender(<MediaSlot {...props} lockedReason={reason} />)
  view.rerender(<MediaSlot {...props} />)
  await act(async () => first.resolve('https://cdn.test/old.png'))
  expect(onChange).not.toHaveBeenCalled()
  choose(view.container)
  await act(async () => second.resolve('https://cdn.test/new.png'))
  expect(upload).toHaveBeenCalledTimes(2)
  expect(onChange).toHaveBeenCalledExactlyOnceWith('https://cdn.test/new.png')
})

it('取り込み中に再描画せず権限を失っても、成功の値も失敗の知らせも反映しない', async () => {
  let allowed = true
  const pending = deferred<string>(), onChange = vi.fn()
  const view = render(<MediaSlot title={title} canChangeNow={() => allowed} upload={() => pending.promise} onChange={onChange} />)
  choose(view.container)
  allowed = false
  await act(async () => pending.resolve('https://cdn.test/late.png'))
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('任意の口なしで始めた検査でも、途中で理由を足したらuploadを始めない', async () => {
  const checked = deferred<string>(), upload = vi.fn()
  const props = { title, validate: () => checked.promise, upload }
  const view = render(<MediaSlot {...props} />)
  choose(view.container)
  view.rerender(<MediaSlot {...props} lockedReason={reason} />)
  await act(async () => checked.resolve(''))
  expect(upload).not.toHaveBeenCalled()
})

it('口が未指定なら権限属性・余分な包み・Tabの変更を足さず、URL/登録メディア/消去も使える', () => {
  const onChange = vi.fn(), onUrl = vi.fn(), onMediaPick = vi.fn()
  const view = render(<MediaSlot title={title} value="https://cdn.test/a.png" onFile={vi.fn()} onChange={onChange} onUrl={onUrl} onMediaPick={onMediaPick} controlsBelow />)
  expect(view.container.childElementCount).toBe(1)
  expect(view.container.querySelector('[data-permission-locked], [hidden], [aria-disabled]')).toBeNull()
  const buttons = screen.getAllByRole('button') as HTMLButtonElement[]
  expect(buttons.map((button) => [button.textContent, button.disabled, button.tabIndex])).toEqual([
    ['差し替える', false, 0], ['消す', false, 0], ['URL で入れる', false, 0], ['登録メディアから選択する', false, 0],
  ])
  fireEvent.click(screen.getByRole('button', { name: 'URL で入れる' }))
  fireEvent.click(screen.getByRole('button', { name: '登録メディアから選択する' }))
  fireEvent.click(screen.getByRole('button', { name: '消す' }))
  expect(onUrl).toHaveBeenCalledExactlyOnceWith()
  expect(onMediaPick).toHaveBeenCalledExactlyOnceWith()
  expect(onChange).toHaveBeenCalledExactlyOnceWith(null)
})

it('非同期の検査を待つ間に再描画せず権限を失っても、ファイルを渡さない', async () => {
  let allowed = true
  const checked = deferred<string>(), onFile = vi.fn()
  const view = render(<MediaSlot title={title} validate={() => checked.promise} canChangeNow={() => allowed} onFile={onFile} />)
  choose(view.container)
  allowed = false
  await act(async () => checked.resolve(''))
  expect(onFile).not.toHaveBeenCalled()
})

it('権限を失った後の失敗応答を、今の画面の失敗として表示しない', async () => {
  let allowed = true, reject!: (reason: Error) => void
  const pending = new Promise<string>((_resolve, fail) => { reject = fail })
  const view = render(<MediaSlot title={title} canChangeNow={() => allowed} upload={() => pending} />)
  choose(view.container)
  allowed = false
  await act(async () => reject(new Error('画像を取り込めませんでした')))
  expect(screen.queryByRole('alert')).toBeNull()
})

it('拒否を経て復帰した時も古い選択操作は失効し、新しい選択だけが窓を開く', () => {
  const held: Array<() => void> = []
  const props = { title, onFile: vi.fn(), canChangeNow: () => true, renderTrigger: (open: () => void) => { held.push(open); return <button onClick={open}>選ぶ</button> } }
  const view = render(<MediaSlot {...props} />)
  const old = held[0], open = vi.spyOn(input(view.container), 'click')
  view.rerender(<MediaSlot {...props} lockedReason={reason} />)
  view.rerender(<MediaSlot {...props} />)
  old()
  expect(open).not.toHaveBeenCalled()
  held.at(-1)!()
  expect(open).toHaveBeenCalledTimes(1)
})
