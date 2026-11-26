// @vitest-environment happy-dom
import React, { act, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ConfirmDialog from './confirm-dialog'
import * as toast from './toast'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const base = { title: '移動しますか？', description: '移動先を確認してください。', confirmLabel: '移動する' }

it('失敗は窓と入力・選択を保ち、再実行は同じ内容を一度だけ送って成功時に閉じる', async () => {
  let settle!: (value: boolean) => void
  const send = vi.fn((_payload: { name: string; selected: boolean }) => new Promise<boolean>(resolve => { settle = resolve }))
  const closed = vi.fn()
  function Fixture() {
    const [open, setOpen] = useState(true), [name, setName] = useState('問合せ'), [selected, setSelected] = useState(true)
    return <ConfirmDialog {...base} open={open} onCancel={() => {}} onSuccess={() => { closed(); setOpen(false) }} onConfirm={() => send({ name, selected })}>
      <input aria-label="移動先" value={name} onChange={event => setName(event.target.value)} />
      <input aria-label="選んだ行" type="checkbox" checked={selected} onChange={event => setSelected(event.target.checked)} />
    </ConfirmDialog>
  }
  render(<Fixture />)
  const field = screen.getByRole('textbox', { name: '移動先' }), selected = screen.getByRole('checkbox', { name: '選んだ行' })
  fireEvent.change(field, { target: { value: '再確認' } })
  const confirm = screen.getByRole('button', { name: '移動する' })
  fireEvent.click(confirm); fireEvent.click(confirm)
  expect(send).toHaveBeenCalledTimes(1)
  expect(closed).not.toHaveBeenCalled()
  await act(async () => { settle(false); await Promise.resolve() })
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('実行できませんでした')
  expect(screen.getByRole('textbox', { name: '移動先' })).toBe(field)
  expect(field).toHaveProperty('value', '再確認')
  expect(selected).toHaveProperty('checked', true)
  const retry = screen.getByRole('button', { name: 'もう一度' })
  fireEvent.click(retry); fireEvent.click(retry)
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls).toEqual([[{ name: '再確認', selected: true }], [{ name: '再確認', selected: true }]])
  await act(async () => { settle(true); await Promise.resolve() })
  expect(closed).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('非同期の例外は窓内の日本語へ寄せ、もう一度でも元の危険な操作の色を保つ', async () => {
  const request = vi.fn().mockRejectedValue(new Error('API error: 500'))
  render(<ConfirmDialog {...base} title="削除しますか？" confirmLabel="削除する" destructive open onCancel={() => {}} onSuccess={vi.fn()} onConfirm={request} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '削除する' })); await Promise.resolve() })
  expect(screen.getByRole('alert').textContent).not.toContain('API error')
  const retry = screen.getByRole('button', { name: 'もう一度' })
  const cancel = screen.getByRole('button', { name: 'キャンセル' })
  expect(retry.getAttribute('data-variant')).toBe('danger')
  expect(retry.className).toContain('standard')
  expect(cancel.className).toContain('standard')
  await act(async () => { fireEvent.click(retry); await Promise.resolve() })
  expect(request).toHaveBeenCalledTimes(2)
})

it('閉じた窓から遅れて届く成功で、別の確認を終了しない', async () => {
  let finish!: (value: boolean) => void
  const done = vi.fn(), confirm = () => new Promise<boolean>(resolve => { finish = resolve })
  const props = { ...base, onCancel: () => {}, onSuccess: done, onConfirm: confirm }
  const view = render(<ConfirmDialog {...props} open />)
  fireEvent.click(screen.getByRole('button', { name: '移動する' }))
  view.rerender(<ConfirmDialog {...props} open={false} />)
  view.rerender(<ConfirmDialog {...props} open />)
  await act(async () => { finish(true); await Promise.resolve() })
  expect(done).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '移動する' })).toHaveProperty('disabled', false)
})

it('新しい口を渡さない確認は、返事が来ても親の閉じ方をそのまま使う', async () => {
  const request = vi.fn().mockResolvedValue(undefined), cancel = vi.fn()
  render(<ConfirmDialog {...base} open onConfirm={request} onCancel={cancel} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '移動する' })); await Promise.resolve() })
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: '移動する' })).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('確認前の理由は隠さず、中止では再試行に変えず、明示の失敗だけを再試行にする', async () => {
  const send = vi.fn().mockReturnValueOnce(undefined).mockReturnValueOnce(false)
  render(<ConfirmDialog {...base} open error="人数を確認できませんでした。" onSuccess={vi.fn()} onConfirm={send} onCancel={() => {}} />)
  expect(screen.getByRole('alert').textContent).toContain('人数を確認できませんでした')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '移動する' })); await Promise.resolve() })
  expect(screen.queryByRole('button', { name: 'もう一度' })).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '移動する' })); await Promise.resolve() })
  expect(screen.getByRole('button', { name: 'もう一度' })).toBeTruthy()
})

it('保存後の表示処理が失敗しても、保存済みの操作を再送しない', async () => {
  const request = vi.fn().mockResolvedValue(true)
  render(<ConfirmDialog {...base} open onCancel={() => {}} onConfirm={request} onSuccess={() => { throw new Error('render failed') }} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '移動する' })); await Promise.resolve() })
  expect(screen.queryByRole('button', { name: 'もう一度' })).toBeNull()
  const button = screen.getByRole('button', { name: '移動する' })
  expect(button).toHaveProperty('disabled', true)
  fireEvent.click(button)
  expect(request).toHaveBeenCalledTimes(1)
})

it('親が閉じて開き直しても、先の送信の決着までは重ねて送らない', async () => {
  let settle!: (value: boolean) => void
  const request = vi.fn(() => new Promise<boolean>(resolve => { settle = resolve }))
  const props = { ...base, onCancel: () => {}, onSuccess: vi.fn(), onConfirm: request }
  const view = render(<ConfirmDialog {...props} open />)
  fireEvent.click(screen.getByRole('button', { name: '移動する' }))
  view.rerender(<ConfirmDialog {...props} open={false} />)
  view.rerender(<ConfirmDialog {...props} open />)
  fireEvent.click(screen.getByRole('button', { name: '処理中…' }))
  expect(request).toHaveBeenCalledTimes(1)
  await act(async () => { settle(true); await Promise.resolve() })
  expect(props.onSuccess).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '移動する' })).toHaveProperty('disabled', false)
})

it('窓内の取り消しは成功と混ぜず、決着済の元に戻すを消して入力を保つ', async () => {
  type Result = import('@/lib/undoable').ConfirmedUndoResult
  let finish!: (value: Result) => void
  const finished = new Promise<Result>(resolve => { finish = resolve })
  const handle = { finished, undoWindowClosed: finished.then(() => {}), undo: vi.fn(() => finish({ status: 'undone' })), pause: vi.fn(), resume: vi.fn() }
  const saved = vi.fn(), undone = vi.fn()
  function Fixture() {
    const [pending, setPending] = useState<typeof handle | null>(null)
    return <ConfirmDialog {...base} open pendingUndo={pending} onSuccess={saved} onUndone={undone} onCancel={() => {}}
      onConfirm={() => { setPending(handle); return finished }}><input aria-label="移動先" defaultValue="保持する" /></ConfirmDialog>
  }
  const view = render(<Fixture />)
  fireEvent.click(screen.getByRole('button', { name: '移動する' }))
  const undo = screen.getByRole('button', { name: '元に戻す' })
  act(() => { undo.focus() })
  expect(handle.pause).toHaveBeenCalledWith('focus')
  await act(async () => { fireEvent.click(undo); await Promise.resolve() })
  expect(saved).not.toHaveBeenCalled()
  expect(undone).toHaveBeenCalledTimes(1)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'キャンセル' }))
  expect(screen.queryByRole('button', { name: '元に戻す' })).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('textbox', { name: '移動先' })).toHaveProperty('value', '保持する')
  view.unmount()
  expect(handle.resume).toHaveBeenCalledWith('pointer')
  expect(handle.resume).toHaveBeenCalledWith('focus')
})

it('取り消し待ちから届いた失敗の理由を窓の中に出す', async () => {
  render(<ConfirmDialog {...base} open onCancel={() => {}} onSuccess={vi.fn()}
    onConfirm={async () => ({ status: 'failed' as const, error: new Error('API error: 500'), message: '3件中1件を保存しました。残り2件を確認してください。' })} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '移動する' })); await Promise.resolve() })
  expect(screen.getByRole('alert').textContent).toContain('3件中1件を保存しました。残り2件')
  expect(screen.getByRole('button', { name: 'もう一度' })).toBeTruthy()
})


it('取消の口には成功の受け取りが必須である', () => {
  const finished = Promise.resolve({ status: 'undone' as const })
  const handle = { finished, undoWindowClosed: Promise.resolve(), undo: () => {}, pause: () => {}, resume: () => {} }
  // @ts-expect-error 確認中の取消結果を黙って捨てる組合せは許可しない。
  const invalid = <ConfirmDialog {...base} open pendingUndo={handle} onCancel={() => {}} />
  expect(invalid).toBeTruthy()
})


it('前の窓の失敗は新しい窓を汚さず、知らせで結果を伝える', async () => {
  const notify = vi.spyOn(toast, 'notifyToast').mockReturnValue(() => {})
  let reject!: (reason: Error) => void
  const request = () => new Promise<boolean>((_resolve, fail) => { reject = fail })
  const props = { ...base, onConfirm: request, onSuccess: vi.fn(), onCancel: () => {} }
  const view = render(<ConfirmDialog {...props} open />)
  fireEvent.click(screen.getByRole('button', { name: '移動する' }))
  view.rerender(<ConfirmDialog {...props} open={false} />)
  view.rerender(<ConfirmDialog {...props} open />)
  await act(async () => { reject(new Error('保存できませんでした。')); await Promise.resolve() })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('保存できませんでした'), { tone: 'error' })
})
