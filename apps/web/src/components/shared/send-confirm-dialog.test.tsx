// @vitest-environment happy-dom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import SendConfirmDialog, { describeExclusion, shiftedShort, shiftedWhen, shortWhen, type SendConfirmDialogProps } from './send-confirm-dialog'

const base: SendConfirmDialogProps = {
  open: true, subtitle: '新しい一斉配信', state: 'ready', recipients: 1272, purpose: 'marketing', whenLabel: '今すぐ送る',
  bodyHead: '本文の頭', bubbleCount: 2, primaryLabel: '1,272 人に送る', onConfirm: vi.fn(), onBack: vi.fn(),
}

afterEach(() => cleanup())

describe('夜の静かな時間の日時', () => {
  const now = new Date('2026-10-18T03:00:00Z')
  it('日本時間の明日なら「明日」を付け、主ボタン用は「明日 8:00」', () => {
    expect(shiftedWhen('2026-10-18T23:00:00.000Z', now)).toBe('明日 10/19（月）8:00')
    expect(shiftedShort('2026-10-18T23:00:00.000Z', now)).toBe('明日 8:00')
    expect(shiftedShort('2026-10-20T23:00:00.000Z', now)).toBe('10/21 8:00')
  })
})

describe('共通の「送る前の確かめ」窓（U1）', () => {
  it('人数・目的・日時・本文・取り消せない旨と「閉じても送りません」を出す', () => {
    render(<SendConfirmDialog {...base} />)
    expect(screen.getByText('1,272 人')).toBeTruthy()
    expect(screen.getByText('宣伝を止めている人には送りません')).toBeTruthy()
    expect(screen.getByText('送ったあとは取り消せません。')).toBeTruthy()
    expect(screen.getByText('閉じても送りません')).toBeTruthy()
    expect(document.body.textContent).not.toContain('元に戻す')
  })
  it('承認が不要な時も追加の確認欄を出し、未指定なら追加の欄を出さない', () => {
    const { rerender } = render(<SendConfirmDialog {...base} confirmationFields={<p>追加の確認事項</p>} />)
    expect(screen.getByText('追加の確認事項')).toBeTruthy()
    expect(screen.queryByText('承認する人')).toBeNull()
    rerender(<SendConfirmDialog {...base} />)
    expect(screen.queryByText('追加の確認事項')).toBeNull()
    expect((screen.getByRole('button', { name: '1,272 人に送る' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('数えられなかったとき・0 人のときは主ボタンを押せない', () => {
    const { rerender } = render(<SendConfirmDialog {...base} state="error" recipients={null} />)
    expect(screen.getByText('人数を数えられませんでした')).toBeTruthy()
    expect((screen.getByRole('button', { name: '送る' }) as HTMLButtonElement).disabled).toBe(true)
    rerender(<SendConfirmDialog {...base} recipients={0} />)
    expect(screen.getByText('送る相手が 0 人です')).toBeTruthy()
    expect((screen.getAllByRole('button', { name: '1,272 人に送る' })[0] as HTMLButtonElement).disabled).toBe(true)
  })
  it.each([null, -1, 1.5, NaN, Infinity])('人数が不正な %s のときは送信を止めて数え直せる', (recipients) => {
    const onConfirm = vi.fn()
    const onRetry = vi.fn()
    render(<SendConfirmDialog {...base} recipients={recipients} onConfirm={onConfirm} onRetry={onRetry} />)
    expect(screen.getByText('人数を数えられませんでした')).toBeTruthy()
    const button = screen.getByRole('button', { name: '送る' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'もう一度数える' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
  it.each([
    [[{ name: '店', recipients: 1272, stopped: NaN }]],
    [[{ name: '店', recipients: 1272, stopped: -1 }]],
    [[{ name: '店', recipients: 1.5, stopped: 0 }]],
    [[{ name: '店', recipients: 1, stopped: 0 }]],
  ])('店ごとの人数が不正または合計と違えば送信を止める', (perAccount) => {
    render(<SendConfirmDialog {...base} perAccount={perAccount} accountCount={1} />)
    expect(screen.getByText('人数を数えられませんでした')).toBeTruthy()
    expect((screen.getByRole('button', { name: '送る' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('承認が必要で人数を確認できないときは承認の依頼を押せない', () => {
    render(<SendConfirmDialog {...base} recipients={null} approval={{ note: '承認が必要です' }} primaryLabel="承認を依頼する" />)
    expect((screen.getByRole('button', { name: '承認を依頼する' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('予約時は予約する前の確認と表示する', () => {
    render(<SendConfirmDialog {...base} scheduled recipients={null} />)
    expect(screen.getByRole('dialog', { name: '予約する前の確かめ' })).toBeTruthy()
    expect((screen.getByRole('button', { name: '予約する' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('権限が無い・代理ログイン中は主ボタンを出さず理由を出す', () => {
    const { rerender } = render(<SendConfirmDialog {...base} block="no-permission" />)
    expect(screen.getByText('送るには権限が要ります（頼む先：管理者）。')).toBeTruthy()
    expect(screen.queryAllByRole('button', { name: '1,272 人に送る' })).toHaveLength(0)
    rerender(<SendConfirmDialog {...base} block="impersonation" />)
    expect(screen.getByText('代理ログイン中は送れません。')).toBeTruthy()
  })
  it('承認が要るときは、承認の文と承認する人の欄を窓の中に出し、選ぶまで主ボタンを押せない', () => {
    const props = { ...base, recipients: 1200, primaryLabel: '承認を依頼する', approval: { note: '1,000 人以上は承認が要る店です。承認されたら送ります' }, approvalFields: <select aria-label="承認をお願いする人" /> }
    const { rerender } = render(<SendConfirmDialog {...props} primaryDisabled />)
    expect(screen.getByText('1,200 人')).toBeTruthy()
    expect(screen.getByText('1,000 人以上は承認が要る店です。承認されたら送ります')).toBeTruthy()
    expect(screen.getByLabelText('承認をお願いする人')).toBeTruthy()
    expect((screen.getAllByRole('button', { name: '承認を依頼する' })[0] as HTMLButtonElement).disabled).toBe(true)
    rerender(<SendConfirmDialog {...props} />)
    expect((screen.getAllByRole('button', { name: '承認を依頼する' })[0] as HTMLButtonElement).disabled).toBe(false)
  })
  it('全員宛は途中で止められない旨を足し、主ボタンは二重に押しても 1 回だけ送る', async () => {
    let resolve!: () => void
    const onConfirm = vi.fn(() => new Promise<void>((r) => { resolve = r }))
    render(<SendConfirmDialog {...base} allRecipients onConfirm={onConfirm} />)
    expect(screen.getByText('全員への配信は、送り始めると途中で止められません。')).toBeTruthy()
    const button = screen.getAllByRole('button', { name: '1,272 人に送る' })[0]
    fireEvent.click(button); fireEvent.click(button)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    resolve()
  })
  it('日時と除外の言い方', () => {
    expect(shortWhen('2026-10-18T01:00:00.000Z')).toBe('10/18 10:00')
    expect(describeExclusion(1272, { blocked: 0, optedOut: 12, duplicate: 0 })).toBe('対象 1,284 人から除く 12 人：宣伝を止めている 12・ブロック 0・重複 0')
  })
})
