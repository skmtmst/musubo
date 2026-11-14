// @vitest-environment happy-dom
/*
 * R598: `GET /api/duplicates/stats` だけ503でも、取得済みの候補一覧は残す。
 * 集計欄に取得失敗と再試行が出て、回復後は集計が戻る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  stats: vi.fn(),
  list: vi.fn(),
  detect: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: () => undefined }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...(actual.api as unknown as Record<string, unknown>),
      duplicates: { stats: fixture.stats },
      identityCandidates: {
        list: fixture.list,
        detectFriendDuplicates: fixture.detect,
      },
    },
  }
})

import { ApiError } from '@/lib/api'
import DuplicatesPage from './page'

function statsData() {
  return {
    totalFollowing: 100,
    uniquePeople: 90,
    friendDups: 10,
    duplicateGroups: 5,
    wastedPerBroadcastYen: 500,
    msgUnitYen: 50,
    perAccount: [
      { accountId: 'a1', accountName: '然 本店', friends: 60, dups: 6, dupRate: 0.1 },
      { accountId: 'a2', accountName: '然 支店', friends: 40, dups: 4, dupRate: 0.1 },
    ],
    pairwiseOverlap: [{ fromAccountId: 'a1', toAccountId: 'a2', overlap: 3 }],
    computedAt: '2026-09-27T00:00:00.000Z',
  }
}

function candidate() {
  const subject = (id: string, label: string) => ({
    kind: 'friend' as const,
    id,
    label,
    detail: null,
    lineAccountId: 'a1',
    lineAccountName: '然 本店',
    shopKey: null,
    attributes: [],
  })
  return {
    id: 'cand-1',
    kind: 'friend_duplicate' as const,
    status: 'pending' as const,
    version: 1,
    confidence: { score: 90, label: 'high' as const },
    left: subject('f1', '田中太郎'),
    right: subject('f2', '田中たろう'),
    evidenceSummary: ['メールが一致'],
    detectedAt: '2026-09-27T00:00:00.000Z',
    reviewedAt: null,
  }
}

function listData(items: ReturnType<typeof candidate>[]) {
  return {
    items,
    total: items.length,
    limit: 50,
    offset: 0,
    statusCounts: { pending: items.length },
    lowConfidenceCount: 0,
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  fixture.stats.mockReset()
  fixture.list.mockReset()
  fixture.detect.mockReset()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
})

async function renderPage() {
  await act(async () => { root.render(<DuplicatesPage />) })
  // マウント直後の2つの取得（集計・候補）を流す。
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {})
  }
}

function retryButton(label: string): HTMLButtonElement {
  const buttons = Array.from(host.querySelectorAll('button'))
  const found = buttons.find((b) => b.textContent === label)
  if (!found) throw new Error(`ボタン「${label}」が見つかりません: ${host.innerHTML.slice(0, 500)}`)
  return found as HTMLButtonElement
}

describe('集計失敗でも候補一覧を残す（R598）', () => {
  it('集計だけ503：候補一覧を残し、集計欄に失敗と再試行を出す', async () => {
    fixture.stats.mockRejectedValue(new ApiError(503))
    fixture.list.mockResolvedValue({ success: true, data: listData([candidate()]) })
    await renderPage()

    // 候補は残る。
    expect(host.textContent).toContain('田中太郎')
    // 集計欄の失敗と再試行が出る。
    expect(host.textContent).toContain('表示できませんでした')
    expect(host.textContent).toContain('候補一覧は取得済みの内容を表示しています')
    retryButton('もう一度')
    // 両方失敗の1枚（登録した内容は消えていません）は出さない。
    expect(host.textContent).not.toContain('登録した内容は消えていません')
    // 集計の数値は「—」にし、0とは言わない。
    expect(host.textContent).toContain('1配信あたりの無駄')
    const missing = within(host).getByText('重複配信の削減').closest<HTMLElement>('[data-kpi-presentation]')!
    expect(within(missing).getByText('—')).toBeTruthy()
    expect(within(missing).getByText('配信実績の接続を待っています')).toBeTruthy()
    await act(async () => { fireEvent.click(within(missing).getByRole('button', { name: '重複配信の削減の説明' })) })
    expect(within(document.body).getByText('配信前プレビューの実績を接続したあと、重複分を除いた削減の見込みをここに表示します。')).toBeTruthy()
  })

  it('集計503×statusCounts省略（旧Worker）：0組と誤案内せず総数と内訳不明を分けて出す', async () => {
    fixture.stats.mockRejectedValue(new ApiError(503))
    fixture.list.mockResolvedValue({
      success: true,
      // 旧Workerとの互換で statusCounts / lowConfidenceCount を省く。
      // 一覧の total（18）は確実に分かる。
      data: { items: [candidate()], total: 18, limit: 50, offset: 0 },
    })
    await renderPage()

    // 候補一覧は残り、一覧の総数は見える。
    expect(host.textContent).toContain('田中太郎')
    expect(host.textContent).toContain('18組')
    // 件数矛盾：未取得のカードを「0組」と誤案内しない。
    expect(host.textContent).not.toContain('0組')
    // 総数が確実な重複候補は一覧の total、内訳不明は「—」+理由。
    expect(host.textContent).toContain('18組')
    expect(host.textContent).toContain('読み込めませんでした')
  })

  it('集計だけ403：権限の案内にし、再試行は出さず候補は残す', async () => {
    fixture.stats.mockRejectedValue(new ApiError(403))
    fixture.list.mockResolvedValue({ success: true, data: listData([candidate()]) })
    await renderPage()

    expect(host.textContent).toContain('田中太郎')
    expect(host.textContent).toContain('集計を見る権限がありません')
    expect(host.textContent).not.toContain('登録した内容は消えていません')
  })

  it('再試行で回復：集計が戻り、失敗の1行が消える', async () => {
    fixture.stats.mockRejectedValueOnce(new ApiError(503))
    fixture.stats.mockResolvedValue({ success: true, data: statsData() })
    fixture.list.mockResolvedValue({ success: true, data: listData([candidate()]) })
    await renderPage()
    expect(host.textContent).toContain('候補一覧は取得済みの内容を表示しています')

    await act(async () => { retryButton('もう一度').click() })
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {})
    }

    expect(host.textContent).toContain('然 本店')
    expect(host.textContent).toContain('アカウントごとの重なり')
    expect(host.textContent).not.toContain('候補一覧は取得済みの内容を表示しています')
  })

  it('正常：集計・候補・内訳が出る', async () => {
    fixture.stats.mockResolvedValue({ success: true, data: statsData() })
    fixture.list.mockResolvedValue({ success: true, data: listData([candidate()]) })
    await renderPage()

    expect(host.textContent).toContain('田中太郎')
    expect(host.textContent).toContain('1配信あたりの無駄')
    expect(host.textContent).toContain('アカウントごとの重なり')
    expect(host.textContent).not.toContain('候補一覧は取得済みの内容を表示しています')
  })

  it('空：0件を失敗と区別する', async () => {
    fixture.stats.mockResolvedValue({ success: true, data: statsData() })
    fixture.list.mockResolvedValue({ success: true, data: listData([]) })
    await renderPage()

    expect(host.textContent).toContain('重複の候補はありません')
    expect(host.textContent).toContain('0組')
    expect(host.textContent).not.toContain('候補一覧を読み込めませんでした')
  })

  it('両方失敗：1枚の失敗にして再試行で両方読み直す', async () => {
    fixture.stats.mockRejectedValue(new ApiError(503))
    fixture.list.mockRejectedValue(new ApiError(503))
    await renderPage()

    expect(host.textContent).toContain('重複の候補を読み込めませんでした')

    fixture.stats.mockResolvedValue({ success: true, data: statsData() })
    fixture.list.mockResolvedValue({ success: true, data: listData([candidate()]) })
    await act(async () => { retryButton('もう一度試す').click() })
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {})
    }

    expect(host.textContent).toContain('田中太郎')
    expect(host.textContent).not.toContain('登録した内容は消えていません')
  })
})

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

describe('読み込み中の数の帯', () => {
  it('集計を読み込んでいる間は「読み込めませんでした」と言わず、4つのマスを読み込み中にする', async () => {
    fixture.stats.mockReturnValue(new Promise(() => {}))
    fixture.list.mockReturnValue(new Promise(() => {}))
    await act(async () => { root.render(<DuplicatesPage />) })
    const band = host.querySelector('[data-design-node="G9C4Uw"]')!
    expect(band.textContent).not.toContain('読み込めませんでした')
    expect(band.querySelectorAll('[aria-busy="true"]').length).toBe(4)
  })
})
