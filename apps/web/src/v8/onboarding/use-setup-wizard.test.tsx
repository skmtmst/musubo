// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StyleState } from './model'
import { useSetupWizard } from './use-setup-wizard'

const fixture = vi.hoisted(() => ({ search: '', replace: vi.fn(), changed: vi.fn() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(fixture.search) }))
vi.mock('@/components/shared/list-navigation', () => ({ useListNavigationRouter: () => ({ replace: fixture.replace }) }))
vi.mock('./wizard', () => ({ default: ({ accountId, initialStep, onClose }: { accountId: string; initialStep: string | number; onClose: (changed: boolean) => void }) => <div role="dialog" aria-label="質問" data-account={accountId} data-step={initialStep}><button onClick={() => onClose(false)}>閉じる</button><button onClick={() => onClose(true)}>保存を知らせる</button></div> }))

const state: StyleState = { style: 'restaurant', styleSelected: true, version: 1, answers: {} }
function Host({ account = 'a', role = 'owner', data = state }: { account?: string | null; role?: string | null; data?: StyleState | null }) {
  const wizard = useSetupWizard(account, data, role, fixture.changed)
  return wizard.dialog
}
beforeEach(() => { fixture.search = ''; vi.clearAllMocks() })
afterEach(cleanup)

it.each(['0', 'summary', '1'])('旧URLの段%sでは旧画面を開かず、期間指定を保つ', step => {
  fixture.search = `setup=${step}&range=week&view=calendar`
  render(<Host />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(fixture.replace).toHaveBeenCalledWith(`/?range=week&view=calendar${step === '1' ? '&guide=richMenu' : ''}`)
})

it.each(['viewer', 'staff', null])('役割%sは設定からのURLでも質問を開かない', role => {
  fixture.search = 'setup=0&setupReturn=accounts'
  render(<Host role={role} />)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('他店へ切り替えた後に以前のアカウントを編集しない', async () => {
  fixture.search = 'setup=0&setupReturn=accounts'
  const view = render(<Host />)
  expect((await screen.findByRole('dialog')).getAttribute('data-account')).toBe('a')
  view.rerender(<Host account="b" data={null} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  view.rerender(<Host account="b" />)
  expect((await screen.findByRole('dialog')).getAttribute('data-account')).toBe('b')
})

it('未選択アカウントのホームで旧質問を自動起動しない', () => {
  render(<Host data={{ ...state, styleSelected: false, shouldPromptStyleSelection: true }} />)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['guide=richMenu', 'qr=base'])('実行中の%sに設定の窓を重ねない', query => {
  fixture.search = `setup=0&setupReturn=accounts&${query}`
  render(<Host />)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['閉じる', '保存を知らせる'])('設定から開いた質問を「%s」で閉じると設定へ戻る', async name => {
  fixture.search = 'setup=0&setupReturn=accounts'
  render(<Host />)
  expect((await screen.findByRole('dialog')).getAttribute('data-step')).toBe('0')
  fireEvent.click(screen.getByRole('button', { name }))
  expect(fixture.replace).toHaveBeenCalledWith('/accounts')
  expect(fixture.changed).toHaveBeenCalledTimes(name === '保存を知らせる' ? 1 : 0)
})

it('不明な戻り先の旧リンクは範囲だけを保つ', () => {
  fixture.search = 'setup=0&setupReturn=https%3A%2F%2Fevil.example&range=week'
  render(<Host />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(fixture.replace).toHaveBeenCalledWith('/?range=week')
})
