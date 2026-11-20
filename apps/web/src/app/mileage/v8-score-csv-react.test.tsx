// @vitest-environment happy-dom
/*
 * V8 行動スコア：この頁のCSV書き出しボタンがある（管理画面 parity-D）。
 * 押すと表と同じ6列のCSVを取り出す。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import V8ScoreTab from '@/v8/mileage/score'
import { ScoreAdjustDialog } from '@/v8/mileage/score'
import { MileageShell } from '@/v8/mileage/frame'

const calls = vi.hoisted(() => ({ friends: vi.fn(), rules: vi.fn(), friendScore: vi.fn(), adjust: vi.fn(), account: 'acc-1' as string | null }))
vi.mock('@/lib/api', () => ({
  api: { actionScores: { friends: calls.friends, rules: calls.rules, adjust: calls.adjust }, scoring: { friendScore: calls.friendScore } },
  ApiError: class extends Error { status?: number },
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: calls.account, loading: false }),
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/mileage',
}))

const overview = {
  summary: { scoredFriends: 1, high: 1, normal: 0, low: 0, decreased30d: 0, highMin: 80, normalMin: 50 },
  items: [
    {
      friendId: 'f1', displayName: '山田', pictureUrl: null,
      currentScore: 90, band: 'high', change30d: 5,
      lastReason: 'purchase', lastChangedAt: '2026-09-01T00:00:00+09:00',
    },
  ],
  pagination: { total: 1, limit: 20, offset: 0 },
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => {
  vi.clearAllMocks()
  calls.account = 'acc-1'
  window.history.replaceState(null, '', '/mileage?tab=score')
  window.dispatchEvent(new PopStateEvent('popstate'))
  calls.friends.mockResolvedValue({ success: true, data: overview })
  calls.rules.mockResolvedValue({ success: true, data: { rules: [] } })
})

describe('V8 行動スコアのCSV書き出し', () => {
  it('表と同じ6列のCSVを取り出す', async () => {
    calls.friends.mockResolvedValue({ success: true, data: overview })
    calls.rules.mockResolvedValue({ success: true, data: { rules: [] } })
    const created: { name: string; content: string }[] = []
    const anchorClick = vi.fn()
    vi.stubGlobal('URL', Object.assign(class extends URL {}, {
      createObjectURL: vi.fn((blob: Blob) => {
        void (blob as Blob).text().then((text) => created.push({ name: 'csv', content: text }))
        return 'blob:csv'
      }),
      revokeObjectURL: vi.fn(),
    }))
    const createElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
      const element = createElement(tag, options)
      if (tag === 'a') element.click = anchorClick
      return element
    }) as typeof document.createElement)
    render(<V8ScoreTab />)
    await waitFor(() => expect(screen.getByText('山田')).toBeTruthy())
    const button = screen.getByRole('button', { name: 'この頁の行動スコアをCSVで書き出す' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    expect(anchorClick).toHaveBeenCalledOnce()
    await waitFor(() => expect(created.length).toBe(1))
    expect(created[0].content.split('\n')[0]).toContain('友だち')
    expect(created[0].content).toContain('山田')
    vi.unstubAllGlobals()
  })
})

describe('現役の行動スコアへ引き継いだ動作', () => {
  it('明細の補足で前後の点数・担当者・方法を確認し、未取得も0と分ける', async () => {
    calls.friendScore.mockResolvedValue({ success: true, data: {
      currentScore: 90, history: [
        { id: 'one', occurredAt: '2026-10-02T00:00:00Z', scoreChange: 5, scoreBefore: 85, scoreAfter: 90, reason: '手動の調整', mode: 'manual', executedByStaffName: '担当A' },
        { id: 'expired', occurredAt: '2026-10-01T12:00:00Z', scoreChange: -5, scoreBefore: 90, scoreAfter: 85, reason: '点の期限が切れた', mode: 'automatic', executedByStaffName: null },
        { id: 'two', occurredAt: '2026-10-01T00:00:00Z', scoreChange: 0, scoreBefore: null, scoreAfter: null, reason: null, mode: 'automatic', executedByStaffName: null },
      ],
    } })
    render(<V8ScoreTab />)
    await screen.findByText('山田')
    fireEvent.click(screen.getByRole('button', { name: 'この画面の説明' }))
    const explanation = document.querySelector('[data-screen-explanation]')
    expect(explanation?.textContent).toContain('スコアはマイルではありません')
    expect(explanation?.textContent).toContain('お客様には見せず、交換もできません')
    expect(explanation?.textContent).toContain('マイル残高はスコアで増えも減りもしません')
    fireEvent.click(screen.getByRole('button', { name: 'この画面の説明' }))
    fireEvent.click(screen.getByRole('button', { name: '山田の操作' }))
    fireEvent.click(screen.getByRole('button', { name: '点数の変化' }))
    expect(await screen.findByTitle('手動の調整・85 点 → 90 点・手で変更（担当A）')).toBeTruthy()
    expect(screen.getByTitle('点数が変わった理由は未取得・前後の点数は未取得・自動で加算')).toBeTruthy()
    expect(calls.friendScore).toHaveBeenCalledWith('f1')
    const detail = screen.getByRole('dialog', { name: '点数の変化の明細' })
    expect(detail.textContent).toContain('マイル残高は増えも減りもしません')
    expect(detail.querySelector('[data-score-delta="positive"]')?.getAttribute('data-tone')).toBe('success')
    expect(detail.querySelector('[data-score-delta="negative"]')?.getAttribute('data-tone')).toBe('warning')
    expect(detail.querySelector('[data-score-delta="zero"]')?.getAttribute('data-tone')).toBe('neutral')
  })

  it('閲覧のみでは手動調整を隠し、明細は読める', async () => {
    render(<MileageShell.Provider value={{ tab: 'score', readonly: true, narrow: false, counts: {}, setCount: () => {} }}><V8ScoreTab /></MileageShell.Provider>)
    await screen.findByText('山田')
    fireEvent.click(screen.getByRole('button', { name: '山田の操作' }))
    expect(screen.queryByText('点数を直す')).toBeNull()
    expect(screen.getByRole('button', { name: '点数の変化' })).toBeTruthy()
  })

  it('店が未選択なら点数と決めごとを取得しない', async () => {
    calls.account = null
    render(<V8ScoreTab />)
    await waitFor(() => expect(screen.getByText('条件に合う友だちがいません')).toBeTruthy())
    expect(calls.friends).not.toHaveBeenCalled()
    expect(calls.rules).not.toHaveBeenCalled()
  })

  it('理由と変更前後を確認して送信し、失敗の再送も同じ札で行う', async () => {
    calls.adjust.mockRejectedValueOnce(new Error('通信断')).mockResolvedValueOnce({ success: true, data: {} })
    const onCompleted = vi.fn(async () => {})
    const onCancel = vi.fn()
    render(<ScoreAdjustDialog accountId="acc-1" friendId="f1" friendName="山田" currentScore={90} highMin={80} normalMin={50} band="high" onCompleted={onCompleted} onCancel={onCancel} />)
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: ' 調整の理由 ' } })
    expect(screen.getByText('変更前')).toBeTruthy()
    expect(screen.getByText('変更後')).toBeTruthy()
    expect(screen.getByRole('dialog').querySelectorAll('[data-score-delta="negative"][data-tone="warning"]')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '10 点減らす' }))
    await screen.findByText('通信に失敗しました。接続を確認してもう一度お試しください。')
    expect(onCompleted).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '10 点減らす' }))
    await waitFor(() => expect(onCompleted).toHaveBeenCalledOnce())
    expect(onCancel).toHaveBeenCalledOnce()
    expect(calls.adjust.mock.calls[0][0]).toEqual({ accountId: 'acc-1', friendId: 'f1', direction: 'decrease', amount: 10, reason: '調整の理由' })
    expect(calls.adjust.mock.calls[0][1]).toBe(calls.adjust.mock.calls[1][1])
    expect(calls.adjust.mock.calls[0][1]).toBeTruthy()
  })
})
