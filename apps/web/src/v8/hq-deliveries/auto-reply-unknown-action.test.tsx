// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import HqAutoReplyActions from './auto-reply-actions'

afterEach(cleanup)
function show(action: unknown) {
  const onChange = vi.fn()
  render(<HqAutoReplyActions value={[action]} references={[]} canEdit busy={false} onChange={onChange} />)
  return onChange
}

it('未知の失敗時の動きは「止める」と決めつけず変更できない設定として残す', () => {
  const changed = show({ actionType: 'scenario', config: { op: 'start', scenarioId: 's1' }, onFailure: 'later' })
  fireEvent.click(screen.getByRole('button', { name: /保存済みの後処理/ }))
  expect(screen.getByText(/この種類の設定はここでは変えられません/)).toBeTruthy()
  expect(screen.queryByLabelText(/失敗したとき/)).toBeNull()
  expect(changed).not.toHaveBeenCalled()
})

it('未知のタグ操作は通常のタグ操作に見せず保存済みのまま残す', () => {
  const changed = show({ actionType: 'tag', config: { op: 'future', tagIds: ['t1'] }, onFailure: 'stop' })
  fireEvent.click(screen.getByRole('button', { name: /保存済みの後処理/ }))
  expect(screen.getByText(/この種類の設定はここでは変えられません/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: '対象を選び直す' })).toBeNull()
  expect(changed).not.toHaveBeenCalled()
})

it('操作が未指定のタグ設定は未完成として、実行される操作に見せない', () => {
  const changed = show({ actionType: 'tag', config: { tagIds: ['t1'] }, onFailure: 'stop' })
  fireEvent.click(screen.getByRole('button', { name: /保存済みの後処理/ }))
  expect(screen.getByText(/この種類の設定はここでは変えられません/)).toBeTruthy()
  expect(changed).not.toHaveBeenCalled()
})

it('他の設定を削除しても未知の設定はそのまま残す', () => {
  const unknown = { actionType: 'tag', config: { op: 'future', tagIds: ['t1'] }, onFailure: 'stop' }
  const changed = vi.fn()
  render(<HqAutoReplyActions value={[unknown, { actionType: 'tag', config: { op: 'add', tagIds: ['t2'] }, onFailure: 'stop' }]} references={[]} canEdit busy={false} onChange={changed} />)
  fireEvent.click(screen.getByRole('button', { name: /2つ目の行うこと.*操作/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: '「行うこと」を削除しますか？' })).getByRole('button', { name: '削除する' }))
  expect(changed.mock.calls[0][0]).toEqual([unknown])
})

it('古い未指定の失敗時設定は実行どおり「次へ進む」と表示する', () => {
  const changed = show({ actionType: 'tag', config: { op: 'add', tagIds: ['t1'] } })
  fireEvent.click(screen.getByRole('button', { name: /タグを付ける/ }))
  expect(screen.getByLabelText('1つ目の行うことに失敗したとき').textContent).toContain('次へ進む')
  expect(changed).not.toHaveBeenCalled()
})


it('別の行を削除しても未指定の失敗時設定を変更しない', () => {
  const legacy = { actionType: 'tag', config: { op: 'add', tagIds: ['t1'] } }
  const changed = vi.fn()
  render(<HqAutoReplyActions value={[legacy, { actionType: 'tag', config: { op: 'add', tagIds: ['t2'] }, onFailure: 'stop' }]} references={[]} canEdit busy={false} onChange={changed} />)
  fireEvent.click(screen.getByRole('button', { name: /2つ目の行うこと.*操作/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: '「行うこと」を削除しますか？' })).getByRole('button', { name: '削除する' }))
  expect(changed.mock.calls[0][0]).toEqual([legacy])
})
