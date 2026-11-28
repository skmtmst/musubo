// @vitest-environment happy-dom
/*
 * 画像を入れる所（MediaSlot・Z7vd2）：空・ドラッグ中・取り込み中・入った・失敗、
 * 枠全体が押せる・制限を超えたら送らない・遅れた返事で上書きしない・読み取りのみ。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import MediaSlot, { formatNamesOf } from './media-slot'

afterEach(cleanup)

const png = (name = 'a.png', size = 10) => new File([new Uint8Array(size)], name, { type: 'image/png' })
const frameOf = () => screen.getByRole('group', { name: 'メイン画像を追加' })
const inputOf = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement
function choose(container: HTMLElement, file: File) {
  fireEvent.change(inputOf(container), { target: { files: [file] } })
}

it('空の形：題・説明・制限・文字リンク。［ファイルを選ぶ］ボタンは置かない', () => {
  render(
    <MediaSlot title="メイン画像を追加" accept="image/jpeg,image/png" maxBytes={10 * 1024 * 1024} onUrl={() => {}} onMediaPick={() => {}} />,
  )
  expect(frameOf().dataset.state).toBe('empty')
  expect(frameOf().dataset.designNode).toBe('Z7vd2')
  expect(screen.getByText('（PNG・JPEG・10MB まで）')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'URL で入れる' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '登録メディアから選択する' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'ファイルを選択する' })).toBeNull()
})

it('枠のどこを押してもファイルを選ぶ窓が開く。文字リンクは窓を開かない', () => {
  const onUrl = vi.fn()
  const { container } = render(<MediaSlot title="メイン画像を追加" onUrl={onUrl} onFile={() => {}} />)
  const click = vi.spyOn(inputOf(container), 'click')
  fireEvent.click(frameOf())
  expect(click).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'URL で入れる' }))
  expect(onUrl).toHaveBeenCalledTimes(1)
  expect(click).toHaveBeenCalledTimes(1)
})

it('送って返った URL を渡す。取り込み中は％を出す', async () => {
  let finish: (url: string) => void = () => {}
  let report: (n: number) => void = () => {}
  const onChange = vi.fn()
  const { container } = render(
    <MediaSlot
      title="メイン画像を追加"
      onChange={onChange}
      upload={(_file, progress) => { report = progress; return new Promise((resolve) => { finish = resolve }) }}
    />,
  )
  await act(async () => { choose(container, png()) })
  expect(frameOf().dataset.state).toBe('busy')
  act(() => report(62))
  expect(screen.getByText('アップロード中… 62%')).toBeTruthy()
  await act(async () => { finish('https://cdn.test/a.png') })
  expect(onChange).toHaveBeenCalledWith('https://cdn.test/a.png')
})

it('上限を超えたら送らず、赤い線と理由を出す', async () => {
  const upload = vi.fn()
  const { container } = render(<MediaSlot title="メイン画像を追加" maxBytes={1024} upload={upload} />)
  await act(async () => { choose(container, png('big.png', 2 * 1024 * 1024)) })
  expect(upload).not.toHaveBeenCalled()
  expect(frameOf().dataset.state).toBe('error')
  expect(screen.getByRole('alert').textContent).toBe('画像が大きすぎます（2MB）')
})

it('形式が違うものは送らない', async () => {
  const upload = vi.fn()
  const { container } = render(<MediaSlot title="メイン画像を追加" accept="image/jpeg,image/png" upload={upload} />)
  await act(async () => { choose(container, new File(['x'], 'a.gif', { type: 'image/gif' })) })
  expect(upload).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toContain('PNG・JPEG')
})

it('入った形：画像を出し、［差し替える］［消す］。消すと null', () => {
  const onChange = vi.fn()
  const { container } = render(<MediaSlot title="メイン画像を追加" value="https://cdn.test/x.png" onChange={onChange} onFile={() => {}} />)
  expect(frameOf().dataset.state).toBe('filled')
  expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.test/x.png')
  const click = vi.spyOn(inputOf(container), 'click')
  fireEvent.click(screen.getByRole('button', { name: '差し替える' }))
  expect(click).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '消す' }))
  expect(onChange).toHaveBeenCalledWith(null)
})

it('先に選んだ画像の返事が後から来ても、あとで選んだ画像のままにする', async () => {
  const resolvers: Array<(url: string) => void> = []
  const onChange = vi.fn()
  const { container } = render(
    <MediaSlot title="メイン画像を追加" acceptPaste onChange={onChange} upload={() => new Promise((resolve) => { resolvers.push(resolve) })} />,
  )
  const paste = (file: File) => fireEvent.paste(frameOf(), { clipboardData: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] } })
  await act(async () => { paste(png('1.png')) })
  await act(async () => { paste(png('2.png')) })
  await act(async () => { resolvers[1]('https://cdn.test/2.png') })
  await act(async () => { resolvers[0]('https://cdn.test/1.png') })
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onChange).toHaveBeenLastCalledWith('https://cdn.test/2.png')
  void container
})

it('場所が変わったあとに返った画像は反映しない', async () => {
  let finish: (url: string) => void = () => {}
  const onChange = vi.fn()
  const upload = () => new Promise<string>((resolve) => { finish = resolve })
  const { container, rerender } = render(<MediaSlot title="メイン画像を追加" scope="card-1" onChange={onChange} upload={upload} />)
  await act(async () => { choose(container, png()) })
  rerender(<MediaSlot title="メイン画像を追加" scope="card-2" onChange={onChange} upload={upload} />)
  await act(async () => { finish('https://cdn.test/late.png') })
  expect(onChange).not.toHaveBeenCalled()
})

it('ドラッグ中は青い形', () => {
  render(<MediaSlot title="メイン画像を追加" accept="image/png" onFile={() => {}} />)
  const file = png()
  fireEvent.dragEnter(frameOf(), { dataTransfer: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], files: [file] } })
  expect(frameOf().dataset.state).toBe('drag')
  fireEvent.dragLeave(frameOf(), { dataTransfer: { items: [], files: [] } })
  expect(frameOf().dataset.state).toBe('empty')
})

it('読み取りのみ：押せる口を出さない', () => {
  const { container } = render(<MediaSlot title="メイン画像を追加" readOnly value="https://cdn.test/x.png" onUrl={() => {}} />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(inputOf(container).disabled).toBe(true)
})

it('小さい所は文字を減らす', () => {
  render(<MediaSlot title="画像を追加" size="compact" accept="image/png,image/jpeg" maxBytes={10 * 1024 * 1024} onFile={() => {}} />)
  expect(screen.getByText('PNG・JPEG・10MB まで')).toBeTruthy()
  expect(screen.queryByText(/ファイルをアップロード/)).toBeNull()
  // 案内は狭い枠でも1行のまま省略し、全文は title で見せる。
  expect(screen.getByTitle('ドラッグ＆ドロップ またはクリック').textContent).toBe('ドラッグ＆ドロップまたはクリック')
})

it('形式の名前', () => {
  expect(formatNamesOf('image/jpeg,image/png')).toBe('PNG・JPEG')
  expect(formatNamesOf('video/mp4')).toBe('MP4')
})

it('「URL で入れる」で枠の下に URL の欄を開く', () => {
  const onChange = vi.fn()
  render(<MediaSlot title="音声を追加" kind="audio" onFile={() => {}} urlEntry={{ id: 'audio-url', value: '', onChange, label: '音声の URL' }} />)
  expect(screen.queryByRole('textbox', { name: '音声の URL' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'URL で入れる' }))
  expect(screen.getByRole('textbox', { name: '音声の URL' }).id).toBe('audio-url')
  fireEvent.change(screen.getByRole('textbox', { name: '音声の URL' }), { target: { value: 'https://cdn.test/a.m4a' } })
  expect(onChange).toHaveBeenCalledWith('https://cdn.test/a.m4a')
})

it('ファイルを受け取る口が無いときは、枠を押しても窓を開かず URL だけ出す', () => {
  const { container } = render(<MediaSlot title="音声を追加" kind="audio" urlEntry={{ value: '', onChange: () => {}, label: '音声の URL' }} />)
  const click = vi.spyOn(inputOf(container), 'click')
  fireEvent.click(screen.getByRole('group', { name: '音声を追加' }))
  expect(click).not.toHaveBeenCalled()
  expect(screen.queryByText(/ドラッグ＆ドロップ/)).toBeNull()
  expect(screen.getByRole('button', { name: 'URL で入れる' })).toBeTruthy()
})

it('外せないもの（removable=false）は［差し替える］だけを出し、［消す］は出さない', () => {
  render(<MediaSlot title="メイン画像を追加" value="https://cdn.example/a.png" removable={false} onFile={() => {}} />)
  expect(screen.getByRole('button', { name: '差し替える' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '消す' })).toBeNull()
})


it.each(['regular', 'compact'] as const)('補足は%sの枠の外に置き、開いてもファイルを選ばずEscで焦点を戻す', size => {
  const { container } = render(<MediaSlot title="メイン画像を追加" size={size} help="1029 × 1029px" onFile={vi.fn()} />)
  const frame = frameOf()
  const help = screen.getByRole('button', { name: 'メイン画像を追加の補足' })
  expect(frame.contains(help)).toBe(false)
  const chooseFile = vi.spyOn(inputOf(container), 'click')
  fireEvent.click(help)
  expect(screen.getByRole('note').textContent).toBe('1029 × 1029px')
  expect(chooseFile).not.toHaveBeenCalled()
  fireEvent.keyDown(help, { key: 'Escape' })
  expect(screen.queryByRole('note')).toBeNull()
  expect(document.activeElement).toBe(help)
  fireEvent.click(frame)
  expect(chooseFile).toHaveBeenCalledTimes(1)
})

it('URL と登録メディアの口は共通の文字ボタンで、枠のファイル選択へ伝わらない', () => {
 const onFile=vi.fn(),onMediaPick=vi.fn()
 render(<MediaSlot title="画像を追加" onFile={onFile} onMediaPick={onMediaPick} urlEntry={{value:'',onChange:()=>{},label:'画像URL'}} />)
 for(const name of ['URL で入れる','登録メディアから選択する']){
  const button=screen.getByRole('button',{name})
  expect(button.hasAttribute('data-shared-button')).toBe(true)
  expect(button.getAttribute('data-variant')).toBe('text')
  fireEvent.click(button)
 }
 expect(screen.getByRole('textbox',{name:'画像URL'})).toBeTruthy()
 expect(onMediaPick).toHaveBeenCalledTimes(1);expect(onFile).not.toHaveBeenCalled()
})
