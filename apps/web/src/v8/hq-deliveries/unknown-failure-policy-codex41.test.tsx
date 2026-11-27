// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import HqAutoReplyActions from './auto-reply-actions'
afterEach(cleanup)
it('未知の失敗時の動きは止めると決めつけず、保存済みの設定として残す', () => {
  const change=vi.fn()
  render(<HqAutoReplyActions value={[{actionType:'scenario',config:{op:'start',scenarioId:'s'},onFailure:'unknown'}]} references={[]} canEdit busy={false} onChange={change} />)
  expect(screen.getByText('保存済みの後処理')).toBeTruthy()
  expect(screen.queryByText('シナリオを始める')).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:/保存済みの後処理/}))
  expect(screen.getByText('この種類の設定はここでは変えられません。保存済みの内容を引き継ぎます。')).toBeTruthy()
  expect(screen.queryByLabelText('1つ目の行うことに失敗したとき')).toBeNull()
  expect(change).not.toHaveBeenCalled()
})
it('従来の失敗時設定がないシナリオは引き続き表示できる', () => {
  render(<HqAutoReplyActions value={[{actionType:'scenario',config:{op:'start',scenarioId:'s'}}]} references={[]} canEdit busy={false} onChange={() => {}} />)
  expect(screen.getByText('シナリオを始める')).toBeTruthy()
})
