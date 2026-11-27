// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import HqAutoReplyActions from './auto-reply-actions'
afterEach(cleanup)
it('未知のタグ操作はタグ追加と表示せず、保存済みの設定として残す', () => {
  const change=vi.fn()
  render(<HqAutoReplyActions value={[{actionType:'tag',config:{op:'unknown',tagIds:['t']},onFailure:'stop'}]} references={[]} canEdit busy={false} onChange={change} />)
  expect(screen.getByText('保存済みの後処理')).toBeTruthy()
  expect(screen.queryByText('タグを付ける')).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:/保存済みの後処理/}))
  expect(screen.getByText('この種類の設定はここでは変えられません。保存済みの内容を引き継ぎます。')).toBeTruthy()
  expect(screen.queryByRole('button',{name:'対象を選び直す'})).toBeNull()
  expect(change).not.toHaveBeenCalled()
})
it('操作の指定がない従来のタグ設定は引き続き表示できる', () => {
  render(<HqAutoReplyActions value={[{actionType:'tag',config:{tagIds:['t']}}]} references={[]} canEdit busy={false} onChange={() => {}} />)
  expect(screen.getByText('タグを付ける')).toBeTruthy()
})
