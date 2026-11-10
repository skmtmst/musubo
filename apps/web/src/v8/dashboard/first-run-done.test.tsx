// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ progress: vi.fn(), dismiss: vi.fn(), starterSet: vi.fn(), starterItems: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { gettingStarted: { get: net.progress, dismiss: net.dismiss } } }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { starterSet: net.starterSet, starterItems: net.starterItems } }))
vi.mock('@/components/shared/list-navigation', async importOriginal => ({
  ...await importOriginal<typeof import('@/components/shared/list-navigation')>(),
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a>,
}))
import { setTestReducedMotion } from '@/test-utils/reduced-motion'
import { buildStepsFromApi } from '@/v8/settings/public/steps/index'
import { stepsForStyle } from '@/v8/settings/public/getting-started-steps/index'
import { FirstRunDoneDialog, doneRows, elapsedText } from './first-run-done'
import { useFirstMessageArrived, useFirstSteps, waitingForFirstMessage } from './first-steps'

const KEYS = ['accounts', 'featureSet', 'attributes', 'friendAdd', 'scenario', 'firstMessage'] as const
const steps = (states: Partial<Record<(typeof KEYS)[number], 'todo' | 'done'>>) =>
  buildStepsFromApi(KEYS.map((key) => ({ key, state: states[key] ?? 'done', href: `/${key}`, reason: null })))

beforeEach(() => {
  vi.clearAllMocks()
  setTestReducedMotion(true)
  document.documentElement.dataset.theme = 'v8'
})
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme })

describe('最初の1通が届いた時の窓', () => {
  it('「済み」に変わったのをその画面で見た時だけ開き、開いた時にもう済みなら開かない', () => {
    const { result, rerender } = renderHook(({ list, id }) => useFirstMessageArrived(id, list, true), { initialProps: { list: steps({ firstMessage: 'done' }), id: 'a' } })
    expect(result.current.arrived).toBe(false)
    rerender({ list: steps({ firstMessage: 'done' }), id: 'a' })
    expect(result.current.arrived).toBe(false)
    rerender({ list: steps({ firstMessage: 'todo' }), id: 'b' })
    rerender({ list: steps({ firstMessage: 'todo' }), id: 'b' })
    expect(result.current.arrived).toBe(false)
    rerender({ list: steps({ firstMessage: 'done' }), id: 'b' })
    expect(result.current.arrived).toBe(true)
    act(() => result.current.dismiss())
    expect(result.current.arrived).toBe(false)
  })

  it('別のアカウントへ移った時の「まだ→済み」は数えない', () => {
    const { result, rerender } = renderHook(({ list, id }) => useFirstMessageArrived(id, list, true), { initialProps: { list: steps({ firstMessage: 'todo' }), id: 'a' } })
    rerender({ list: steps({ firstMessage: 'done' }), id: 'b' })
    expect(result.current.arrived).toBe(false)
  })

  it('友だち追加の時の配信が済んで最初の1通がまだの時だけ「待っている」', () => {
    expect(waitingForFirstMessage(steps({ firstMessage: 'todo' }))).toBe(true)
    expect(waitingForFirstMessage(steps({ friendAdd: 'todo', firstMessage: 'todo' }))).toBe(false)
    expect(waitingForFirstMessage(steps({}))).toBe(false)
  })

  it('閲覧のみは状態を1回読み、自動の読み直しと窓を出さない', async () => {
    net.progress.mockResolvedValue({success:true,data:{steps:KEYS.map(key=>({key,state:key==='firstMessage'?'todo':'done',href:'/getting-started',reason:null})),firstRun:null,starter:null}})
    const timer = vi.spyOn(window,'setInterval')
    const { result } = renderHook(() => useFirstSteps('a', 'viewer', { qrOpen: true }))
    await waitFor(() => expect(result.current.summary).not.toBeNull())
    expect(net.progress).toHaveBeenCalledTimes(1)
    expect(timer.mock.calls.filter(([, delay]) => delay === 10_000)).toHaveLength(0)
    timer.mockRestore()
    expect(result.current.arrived).toBe(false)
  })

  it('入った物は種類ごとに 1 行で、動いている・止めている・入れなかったを分ける', () => {
    const rows = doneRows(
      [{ kind: 'template' }, { kind: 'friend_add_rule' }, { kind: 'rich_menu' }, { kind: 'automation' }, { kind: 'booking_menu' }, { kind: 'dashboard' }],
      [{ kind: 'template', status: null }, { kind: 'friend_add_rule', status: 'published' }, { kind: 'rich_menu', status: 'draft' }, { kind: 'automation', status: 'draft' }],
    )
    expect(rows.map((row) => [row.label, row.badge.text])).toEqual([
      ['リッチメニュー', '止めています'],
      ['テンプレート', '入っています'],
      ['オートメーション', '止めています'],
      ['予約メニュー', '入れなかった（あとで）'],
      ['友だち追加の決まり', '動いています'],
    ])
  })

  it('開始からの時間は Worker の分をそのまま使い、60 分を超えたら時間と分にする', () => {
    expect(elapsedText(8)).toBe('開始から 8 分')
    expect(elapsedText(60)).toBe('開始から 60 分')
    expect(elapsedText(75)).toBe('開始から 1 時間 15 分')
    expect(elapsedText(null)).toBeNull()
  })

  it('窓は入った物と次にやることを出し、閉じても帯の記憶（dismiss）は呼ばない', async () => {
    net.starterSet.mockResolvedValue({ success: true, data: { definition: { items: [{ key: 'menu', kind: 'rich_menu', name: 'メニュー' }] } } })
    net.starterItems.mockResolvedValue({ success: true, data: { items: [{ target_id: 'r1', key: 'menu', kind: 'rich_menu', status: 'draft', is_sample: 1, draftRevision: null, name: 'メニュー' }] } })
    const onClose = vi.fn()
    const list = steps({ attributes: 'todo', scenario: 'todo' })
    const progress = { style: 'restaurant' as const, steps: { attributes: { complete: false }, friendAdd: { complete: true }, scenario: { complete: false } } }
    const displayed = stepsForStyle(list, 'restaurant', progress)
    render(<FirstRunDoneDialog accountId="a" style="restaurant" minutes={8} steps={displayed} progress={progress} onClose={onClose} />)
    expect(screen.getByRole('dialog', { name: '最初の 1 通が届きました' })).toBeTruthy()
    expect(screen.getByText('開始から 8 分')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('止めています')).toBeTruthy())
    expect(screen.queryByText(/読まれ/)).toBeNull()
    const next = screen.getAllByRole('link', { name: '開く' }).map((link) => link.getAttribute('href'))
    expect(next).toEqual(['/restaurant-test/tables', '/restaurant-test/google?tab=hours', '/restaurant-test/inventory', '/restaurant-test/line-followup'])
    expect(screen.queryByText('コースとメニューを登録する')).toBeNull()
    expect(next).toHaveLength(4)
    for (const button of screen.getAllByRole('button', { name: '閉じる' })) fireEvent.click(button)
    expect(onClose).toHaveBeenCalled()
    expect(net.dismiss).not.toHaveBeenCalled()
  })
})
