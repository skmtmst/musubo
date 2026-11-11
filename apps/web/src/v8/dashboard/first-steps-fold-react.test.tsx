// @vitest-environment happy-dom
/*
 * はじめにやることは「閉じる」ではなく畳める（オーナー 2026-10-08・絵 r3X34 の「畳む ⌃」、畳んだ形は DIHFx A9uRGq）。
 * 畳む→頭の1行だけ・開く→手順が戻る・アカウントごとに覚える・前の「閉じる」は畳んだ形で出す、を見張る。
 */
import { act, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FirstStepsCard, firstStepsLegacyDismissedKey, firstStepsStorageKey, readFirstStepsFolded, summarizeFirstSteps } from './first-steps'

import { buildStepsFromApi } from '@/v8/settings/getting-started/steps'
import type { StepResult } from '@/v8/settings/public/getting-started-steps/index'
import ListState from '@/components/shared/list-state'
import { SetupTasks } from '@/v8/onboarding/public/setup-card/index'
import type { SetupSummary } from '@/v8/onboarding/model'
const summary = summarizeFirstSteps(buildStepsFromApi([
  { key: 'accounts', state: 'done', href: '/accounts', reason: null },
  { key: 'featureSet', state: 'done', href: '/settings', reason: null },
  { key: 'attributes', state: 'unknown', href: '/tags?tab=tags', reason: '設定を読み込めていません' },
  { key: 'firstMessage', state: 'todo', href: '/getting-started#first-message', reason: null },
]))

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => store.clear(),
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Host({ initial = false }: { initial?: boolean }) {
  const [folded, setFolded] = useState(initial)
  return <FirstStepsCard summary={summary} folded={folded} onToggle={() => setFolded((current) => !current)} />
}

describe('はじめにやることを畳む', () => {
  it('設定画面と同じスタイル別の3〜5段目を表示し、状態を保つ', () => {
    const steps: StepResult[] = ['attributes', 'friendAdd', 'scenario'].map((key, index) => ({
      key: key as StepResult['key'], ordinal: String(index + 3), title: ['友だちの分け方を決める', '友だち追加時の配信を作る', 'シナリオを作る'][index], sub: key, state: 'stalled',
      condition: 'condition', next: 'next', action: { label: 'same secondary action', href: '/' }, blockedReason: null,
    }))
    const cases = [
      ['restaurant', ['卓と席を登録する', '営業時間を設定する', 'コースとメニューを登録する', '予約枠と在庫を設定する', 'LINE来店フォローを確認する']],
      ['salon', ['メニューを登録する', '営業時間を設定する', '担当者を登録する', '予約の受付を確認する']],
      ['consult', ['面談の枠を作る', '営業時間を設定する', '面談の URL を用意する', '面談の受付を確認する']],
      ['lesson', ['クラスを作る', '営業時間を設定する', '会員を登録する', 'クラスの予約を受け付ける']],
      ['ec', ['ストアをつなぐ', '営業時間を設定する', 'ストアの商品を確認する', '注文の受付を確認する']],
      ['standard', ['友だちの分け方を決める', '営業時間を設定する', '友だち追加時の配信を作る', 'シナリオを作る']],
    ] as const
    for (const [style, labels] of cases) {
      const result = summarizeFirstSteps(steps, style)
      expect(result.steps.map((step) => step.label)).toEqual(labels)
      expect(result.steps.map((step) => step.state)).toEqual(labels.map(label => style === 'standard' && label !== '営業時間を設定する' ? 'stalled' : 'unknown'))
    }
  })


  it('「畳む」で手順が隠れて「開く」に替わり、もう一度押すと戻る。閉じるの文字は無い', async () => {
    await act(async () => { render(<Host />) })
    expect(screen.queryByRole('button', { name: '閉じる' })).toBeNull()
    const fold = screen.getByRole('button', { name: '畳む' })
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('LINE アカウントをつなぐ')).toBeTruthy()
    const actions = summary.steps.filter(step => !step.done && step.href)
    expect(screen.getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(actions.map(step => step.href))
    expect(screen.getByRole('button', { name: '友だちの分け方を決めるの未確認の理由' })).toBeTruthy()
    await act(async () => { fireEvent.click(fold) })
    const open = screen.getByRole('button', { name: '開く' })
    expect(open.getAttribute('aria-expanded')).toBe('false')
    expect((document.getElementById('first-steps-list') as HTMLElement).hidden).toBe(true)
    // 畳んでも頭の1行（題・数・進み）は残る。
    expect(screen.getByRole('heading', { name: 'はじめにやること' })).toBeTruthy()
    expect(screen.getByText('2 / 6 済み')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'はじめにやることの進み' })).toBeTruthy()
    await act(async () => { fireEvent.click(open) })
    expect((document.getElementById('first-steps-list') as HTMLElement).hidden).toBe(false)
  })

  it('畳んだかはアカウントごとに覚え、前に「閉じる」を押した人は畳んだ形で出す', () => {
    expect(readFirstStepsFolded('acc-1')).toBe(false)
    window.localStorage.setItem(firstStepsLegacyDismissedKey('acc-1'), '1')
    expect(readFirstStepsFolded('acc-1')).toBe(true)
    // 一度「開く」を押したら、前の印より新しい印を優先する。
    window.localStorage.setItem(firstStepsStorageKey('acc-1'), '0')
    expect(readFirstStepsFolded('acc-1')).toBe(false)
    window.localStorage.setItem(firstStepsStorageKey('acc-2'), '1')
    expect(readFirstStepsFolded('acc-2')).toBe(true)
    expect(readFirstStepsFolded('acc-3')).toBe(false)
    expect(readFirstStepsFolded(null)).toBe(false)
  })
})

it('使い方の質問も同じ手順カードの操作から開き、進捗の数を増やさない', async () => {
  const configure = vi.fn()
  await act(async () => { render(<FirstStepsCard summary={summary} folded={false} onToggle={() => {}} onConfigure={configure} />) })
  expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '使い方の設定を開く' })) })
  expect(configure).toHaveBeenCalledTimes(1)
})

const deferredSetup: SetupSummary = {
  style: 'restaurant', done: 1, total: 3, doneNames: ['使い方'], nextStep: 1,
  rows: [{ key: 'image', title: '見た目を決める', note: 'あとで決める設定です', badge: { tone: 'neutral', label: 'あとで' }, action: { label: '決める', step: 'image' } }],
}

it('基本の手順が未取得でも、既知の設定の行と操作・再試行を残す', async () => {
  const retry = vi.fn(), openStep = vi.fn(), configure = vi.fn()
  await act(async () => { render(<FirstStepsCard summary={null} folded={false} onToggle={() => {}} onConfigure={configure}
    setupTasks={<SetupTasks heading summary={deferredSetup} onOpenStep={openStep} />}
    feedback={<ListState kind="error" title="はじめの設定の状態を確認できませんでした" error={new Error('unavailable')} onRetry={retry} />} />) })
  expect(screen.queryByRole('progressbar', { name: 'はじめにやることの進み' })).toBeNull()
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.getByRole('heading', { name: '選んだ機能の設定' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '畳む', exact: true })).toBeNull()
  expect(screen.getByText('見た目を決める')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '決める', exact: true }))
  expect(openStep).toHaveBeenCalledWith('image')
  fireEvent.click(screen.getByRole('button', { name: '使い方の設定を開く', exact: true }))
  expect(configure).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む', exact: true }))
  expect(retry).toHaveBeenCalledTimes(1)
})

it('基本の進みだけを示し、畳んでも設定行と入口を残す', async () => {
  const allDone = { ...summary, done: summary.total, steps: summary.steps.map(step => ({ ...step, done: true, state: 'done' as const })) }
  function SetupHost() {
    const [folded, setFolded] = useState(false)
    return <FirstStepsCard summary={allDone} folded={folded} onToggle={() => setFolded(value => !value)} onConfigure={() => {}}
      setupTasks={<SetupTasks heading summary={deferredSetup} onOpenStep={() => {}} />} />
  }
  await act(async () => { render(<SetupHost />) })
  expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  expect(screen.getByRole('button', { name: '決める', exact: true })).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '畳む', exact: true })) })
  expect(screen.getByRole('button', { name: '決める', exact: true })).toBeTruthy()
  expect(screen.getByRole('button', { name: '使い方の設定を開く', exact: true })).toBeTruthy()
  expect((document.getElementById('first-steps-list') as HTMLElement).hidden).toBe(true)
  expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '開く', exact: true })) })
  expect(screen.getByRole('button', { name: '決める', exact: true })).toBeTruthy()
})


it('権限のない段の入口も灰色のボタンで残す', () => {
  const forbidden = summarizeFirstSteps(buildStepsFromApi([{ key: 'attributes', state: 'forbidden', href: null, reason: '管理者に頼んでください' }]))
  render(<FirstStepsCard summary={forbidden} folded={false} onToggle={() => {}} />)
  const button = screen.getByRole('button', { name: '開く', exact: true })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.hasAttribute('disabled')).toBe(false)
  expect(button.hasAttribute('href')).toBe(false)
  fireEvent.click(button)
})

it('設定の許可が渡されても閲覧のみでは質問の入口を押せず理由を残す', () => {
  const configure = vi.fn()
  render(<FirstStepsCard summary={summary} folded={false} onToggle={() => {}} readOnly configureAllowed onConfigure={configure} />)
  const button = screen.getByRole('button', { name: '使い方の設定を開く' })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(button)
  expect(configure).not.toHaveBeenCalled()
  expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toContain('管理者')
})
