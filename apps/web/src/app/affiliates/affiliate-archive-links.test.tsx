// @vitest-environment happy-dom
/*
 * R291: 停止前の確認リンクが、対象の成果や紹介リンクを開く。
 * قياس: 確認窓の「ここを開く」が対象紹介者つきの明細へ向くこと、承認側で
 * 紹介者絞りが効いて件数が一致し、絞りを外して戻れること。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'

const fixture = vi.hoisted(() => ({
  approvalsImpl: null as null | ((params: unknown) => Promise<unknown>),
  archiveImpact: vi.fn(),
  archive: vi.fn(),
}))

vi.mock('next/navigation', async () => (await import('@/test-utils/affiliate-navigation-mock')).affiliateNavigationMock())

vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(),
  api: {
    affiliates: {
      get: async () => ({ success: true, data: { lineAccountId: 'account-a' } }),
      archiveImpact: fixture.archiveImpact,
      archive: fixture.archive,
    },
    conversionApprovals: {
      list: (params: unknown) => fixture.approvalsImpl!(params),
    },
    lineAccounts: {
      list: async () => ({ success: true, data: [] }),
    },
  },
}))

const { AffiliateArchiveDialog } = await import('@/v8/affiliates/dialogs')
const { ApprovalQueue } = await import('@/test-utils/affiliate-tabs')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  fixture.archiveImpact.mockReset().mockResolvedValue({ success: true, data: { activeLinks: 1, unsettledReward: 5000, pendingConversions: 2 } })
  fixture.archive.mockReset().mockResolvedValue({ success: true, data: {} })
})

afterEach(() => {
  cleanup()
})

function approvalItem(eventId: string, affiliateId: string, affiliateName: string, friendName: string) {
  return {
    eventId,
    createdAt: '2026-09-10T00:00:00+09:00',
    friendId: `friend-${eventId}`,
    friendName,
    affiliateId,
    affiliateName,
    offerId: null,
    offerName: null,
    offerRewardMiles: null,
    conversionPointName: null,
    value: 1000,
    approvalStatus: 'pending',
    duplicateFlag: false,
    offerActionsIncomplete: false,
    lineAccountId: null,
    lineAccountName: null,
    orderNumber: null,
    orderStatus: null,
    sameOrderDuplicate: false,
    rewardAmount: null,
    rewardEntryStatus: null,
  }
}

describe('R291 停止前の確認は対象の明細を開く', () => {
  test('承認待ちとリンクの「ここを開く」は対象紹介者つきの明細へ向く', async () => {
    render(
      <AffiliateArchiveDialog
        target={{ id: 'aff-a', name: '候補A' }}
        onClose={() => {}}
        onChanged={() => {}}
      />,
    )
    const links = await screen.findAllByRole('link', { name: 'ここを開く' })
    expect(links).toHaveLength(3)
    const hrefs = links.map((link) => (link as HTMLAnchorElement).getAttribute('href'))
    // 承認待ちは成果承認タブ＋対象紹介者。成果地点へ迷い込まない。
    expect(hrefs).toContain('/affiliates?tab=approvals&affiliate=aff-a')
    // リンクは対象紹介者の内訳。案件一覧へ迷い込まない。
    expect(hrefs).toContain('/affiliates?affiliate=aff-a')
    for (const href of hrefs) {
      expect(href ?? '').not.toBe('/conversions')
    }
  })

  test('成果承認は紹介者で絞られ、絞りを外して戻れる', async () => {
    fixture.approvalsImpl = async (params: unknown) => {
      const status = (params as { status: string }).status
      if (status !== 'pending') return { success: true, data: [] }
      return {
        success: true,
        data: [
          approvalItem('ev-a1', 'aff-a', '候補A', '田中'),
          approvalItem('ev-a2', 'aff-a', '候補A', '鈴木'),
          approvalItem('ev-b1', 'aff-b', '候補B', '佐藤'),
        ],
      }
    }
    render(<ApprovalQueue focusAffiliateId="aff-a" />)

    // 紹介者の札が出て、対象の2件だけが見える。
    await screen.findByText('紹介者：候補A')
    await waitFor(() => expect(screen.queryByText('田中')).not.toBeNull())
    expect(screen.queryByText('鈴木')).not.toBeNull()
    expect(screen.queryByText('佐藤')).toBeNull()

    // 札を押すと絞りが外れて、3件に戻れる。
    await act(async () => {
      fireEvent.click(screen.getByText('紹介者：候補A'))
    })
    await waitFor(() => expect(screen.queryByText('佐藤')).not.toBeNull())
    expect(screen.queryByText('田中')).not.toBeNull()
  })

  test('アーカイブは対象者名を説明し、名前が一致するまで確定できない', async () => {
    const onChanged = vi.fn()
    render(<AffiliateArchiveDialog target={{ id: 'aff-a', name: '候補A' }} onClose={() => {}} onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('radio', { name: /このままアーカイブする/ }))
    expect(fixture.archiveImpact).toHaveBeenCalledWith('aff-a')
    expect(screen.getByText(/過去の成果・報酬・支払いの記録は消えません/)).toBeTruthy()
    const confirm = screen.getByRole('button', { name: 'アーカイブする' }) as HTMLButtonElement
    const input = screen.getByRole('textbox', { name: '確認のため「候補A」と打ってください' })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '別の人' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '候補A' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(fixture.archive).toHaveBeenCalledWith('aff-a', { mode: 'archive', confirmationName: '候補A' })
  })
})


test('影響の読込・空・失敗を分け、失敗後に読み直せる', async () => {
  let resolve!: (value: unknown) => void
  fixture.archiveImpact.mockReturnValueOnce(new Promise(done => { resolve = done }))
  const view = render(<AffiliateArchiveDialog target={{ id: 'aff-a', name: '候補A' }} onClose={() => {}} onChanged={() => {}} />)
  expect(document.querySelector('[data-list-state="loading"]')?.getAttribute('aria-label')).toBe('使われている場所を確認しています')
  await act(async () => { resolve({ success: true, data: null }) })
  expect(await screen.findByText('確認できる情報がありません')).toBeTruthy()
  view.unmount()
  fixture.archiveImpact.mockRejectedValueOnce(new Error('private error'))
  render(<AffiliateArchiveDialog target={{ id: 'aff-a', name: '候補A' }} onClose={() => {}} onChanged={() => {}} />)
  expect(await screen.findByText('使われている場所を確認できませんでした')).toBeTruthy()
  expect(screen.queryByText('private error')).toBeNull()
  fixture.archiveImpact.mockResolvedValueOnce({ success: true, data: { activeLinks: 1, unsettledReward: 5000, pendingConversions: 2 } })
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByText('発行ずみの紹介リンク')).toBeTruthy()
})
