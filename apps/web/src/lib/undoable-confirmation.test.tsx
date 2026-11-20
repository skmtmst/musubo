// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runUndoable } from './undoable'

const { notify } = vi.hoisted(() => ({ notify: vi.fn(() => vi.fn()) }))
vi.mock('@/components/shared/toast', () => ({ notifyToast: notify }))
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('確認を指定しない失敗は復元後に通知の理由を読み、復元で得られた状態を使う', async () => {
  let restored = false
  runUndoable({ message: '移動しました', commit: vi.fn().mockRejectedValue(new Error('offline')),
    undo: () => { restored = true },
    get failureMessage() { return restored ? '元の表示へ戻しました。' : '復元前の状態です。' },
  })
  await vi.advanceTimersByTimeAsync(5000)
  expect(restored).toBe(true)
  expect(notify).toHaveBeenLastCalledWith('元の表示へ戻しました。', { tone: 'error' })
})

it('確認を指定しない操作は保存後に取り消し操作のない知らせを出す', async () => {
  const commit = vi.fn().mockResolvedValue(undefined), undo = vi.fn()
  expect(runUndoable({ message: '移動しました', commit, undo })).toBeUndefined()
  await vi.advanceTimersByTimeAsync(0)
  expect(commit).toHaveBeenCalledTimes(1)
  expect(notify).toHaveBeenCalledWith('移動しました')
  expect(undo).not.toHaveBeenCalled()
})

it('確認の窓の取り消しは送信0、通知に同じ操作を重ねず、二度目は何もしない', async () => {
  const commit = vi.fn(), undo = vi.fn()
  const handle = runUndoable({ confirmation: true, message: '移動しました', commit, undo })
  await vi.advanceTimersByTimeAsync(2000)
  handle.undo(); handle.undo()
  await expect(handle.finished).resolves.toEqual({ status: 'undone' })
  await vi.advanceTimersByTimeAsync(10000)
  expect(commit).not.toHaveBeenCalled()
  expect(undo).toHaveBeenCalledTimes(1)
  expect(notify).not.toHaveBeenCalled()
})

it('焦点とマウスの両方を離すまで期限は止まり、残り時間の後に一度だけ送る', async () => {
  const commit = vi.fn().mockResolvedValue(undefined)
  const handle = runUndoable({ confirmation: true, message: '移動しました', commit, undo: vi.fn() })
  await vi.advanceTimersByTimeAsync(2000)
  handle.pause('focus'); handle.pause('pointer')
  await vi.advanceTimersByTimeAsync(10000)
  handle.resume('pointer')
  await vi.advanceTimersByTimeAsync(10000)
  expect(commit).not.toHaveBeenCalled()
  handle.resume('focus')
  await vi.advanceTimersByTimeAsync(2999)
  expect(commit).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(commit).toHaveBeenCalledTimes(1)
  await expect(handle.finished).resolves.toEqual({ status: 'committed' })
})

it('失敗は復元し理由を窓へ返す。終わった取り消しを再送に使わない', async () => {
  const error = new Error('受け付けられませんでした'), commit = vi.fn().mockRejectedValue(error), undo = vi.fn()
  const handle = runUndoable({ confirmation: true, message: '移動しました', commit, undo, failureMessage: '移動できませんでした。' })
  await vi.advanceTimersByTimeAsync(5000)
  await expect(handle.finished).resolves.toEqual({ status: 'failed', error, message: '移動できませんでした。' })
  expect(undo).toHaveBeenCalledTimes(1)
  handle.undo(); await vi.advanceTimersByTimeAsync(5000)
  expect(commit).toHaveBeenCalledTimes(1)
  expect(undo).toHaveBeenCalledTimes(1)
  expect(notify).not.toHaveBeenCalled()
})

it('保存済みの後の読直しが例外でも、保存失敗として巻き戻さない', async () => {
  const undo = vi.fn(), commit = vi.fn().mockResolvedValue(undefined)
  const handle = runUndoable({ confirmation: true, message: '移動しました', commit, undo, onCommitted: () => { throw new Error('read failed') } })
  await vi.advanceTimersByTimeAsync(5000)
  await expect(handle.finished).resolves.toEqual({ status: 'committed' })
  expect(commit).toHaveBeenCalledTimes(1)
  expect(undo).not.toHaveBeenCalled()
})

it('取り消しの復元が例外でも、送信せず必ず決着する', async () => {
  const commit = vi.fn()
  const handle = runUndoable({ confirmation: true, message: '移動', commit, undo: () => { throw new Error('restore failed') } })
  expect(() => handle.undo()).not.toThrow()
  await expect(handle.finished).resolves.toEqual({ status: 'undone' })
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('操作は取り消しました'), { tone: 'error' })
  await vi.advanceTimersByTimeAsync(10000)
  expect(commit).not.toHaveBeenCalled()
})

it('送信失敗後の復元が例外でも、失敗の結果を必ず窓へ返す', async () => {
  const handle = runUndoable({ confirmation: true, message: '移動', failureMessage: '移せませんでした。',
    commit: async () => { throw new Error('request failed') }, undo: vi.fn(), onCommitError: () => { throw new Error('restore failed') } })
  await vi.advanceTimersByTimeAsync(5000)
  await expect(handle.finished).resolves.toMatchObject({ status: 'failed', message: '移せませんでした。' })
})


it('固有の失敗文がない時は例外をそのまま窓へ渡し、具体的な理由を失わない', async () => {
  const error = new Error('名前を入力してください。')
  const handle = runUndoable({ confirmation: true, message: '移動', commit: async () => { throw error }, undo: vi.fn() })
  await vi.advanceTimersByTimeAsync(5000)
  await expect(handle.finished).resolves.toMatchObject({ status: 'failed', error, message: undefined })
})


it('送信を始めたら、応答を待つ間も取消の入口を終了する', async () => {
  let acknowledge!: () => void
  const commit = vi.fn(() => new Promise<void>(resolve => { acknowledge = resolve }))
  const undo = vi.fn(), closed = vi.fn(), finished = vi.fn()
  const handle = runUndoable({ confirmation: true, message: '移動', commit, undo })
  void handle.undoWindowClosed.then(closed)
  void handle.finished.then(finished)
  await vi.advanceTimersByTimeAsync(5000)
  expect(closed).toHaveBeenCalledTimes(1)
  expect(finished).not.toHaveBeenCalled()
  handle.undo()
  expect(undo).not.toHaveBeenCalled()
  acknowledge()
  await expect(handle.finished).resolves.toEqual({ status: 'committed' })
})
