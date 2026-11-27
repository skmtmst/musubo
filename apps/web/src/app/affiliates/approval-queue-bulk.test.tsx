// @vitest-environment happy-dom
/*
 * 成果承認キューの一括確認・結果表示(N-213)。
 *
 * 実物の React をマウントして操作する。ソース文字列の検査では次が固定できない。
 *   - 押す前に確認が出て、並んだ顔ぶれが実行対象と一致すること（確認なし即実行の抑止）
 *   - 確認前には保存 request が1本も出ないこと
 *   - 結果が成功/競合/拒否/失敗に分かれて出て、途中失敗を全成功と表示しないこと
 *   - 残りの選び直し再試行ができること
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const fixture = vi.hoisted(() => ({
  listImpl: null as null | ((params?: unknown) => Promise<unknown>),
  bulkDecideImpl: null as null | ((items: unknown) => Promise<unknown>),
  approveImpl: null as null | ((eventId: string, expectedStatus: string) => Promise<unknown>),
  accountsImpl: null as null | ((includeStats?: boolean) => Promise<unknown>),
  approveCalls: [] as Array<{ eventId: string; expectedStatus: string }>,
  bulkDecideCalls: [] as unknown[],
  listCalls: [] as Array<{ status?: string; limit?: number; offset?: number }>,
}))

vi.mock('next/navigation', async () => (await import('@/test-utils/affiliate-navigation-mock')).affiliateNavigationMock())

vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(),
  api: {
    conversionApprovals: {
      list: (params?: unknown) => {
        fixture.listCalls.push((params ?? {}) as { status?: string; limit?: number; offset?: number })
        return fixture.listImpl!(params)
      },
      approve: (eventId: string, expectedStatus: string) => {
        fixture.approveCalls.push({ eventId, expectedStatus })
        return fixture.approveImpl!(eventId, expectedStatus)
      },
      reject: vi.fn(),
      bulkDecide: (items: unknown) => {
        fixture.bulkDecideCalls.push(items)
        return fixture.bulkDecideImpl!(items)
      },
    },
    lineAccounts: {
      list: (includeStats?: boolean) => fixture.accountsImpl!(includeStats),
    },
  },
}))

const { ApprovalQueue } = await import('@/test-utils/affiliate-tabs')

function item(eventId: string, friendName: string) {
  return {
    eventId,
    createdAt: '2026-09-01T10:00:00.000+09:00',
    friendId: `fr-${eventId}`,
    friendName,
    affiliateId: 'aff-1',
    affiliateName: '紹介者1',
    offerId: 'off-1',
    offerName: '案件A',
    offerRewardMiles: null,
    conversionPointName: '購入',
    value: 1000,
    approvalStatus: 'pending',
    duplicateFlag: false,
    offerActionsIncomplete: false,
    lineAccountId: null,
    lineAccountName: null,
  }
}

beforeEach(() => {
  fixture.bulkDecideCalls = []
  fixture.approveCalls = []
  fixture.listCalls = []
  fixture.accountsImpl = async () => ({ success: true, data: [] })
  fixture.approveImpl = async () => ({ success: true, data: { id: 'x', approvalStatus: 'approved' } })
  let decided = false
  fixture.listImpl = async (params?: unknown) => {
    const status = (params as { status?: string } | undefined)?.status
    if (status === 'pending') {
      // 一括の実行後はev-1だけ承認ずみとして返す（読み直し後の最新状態）。
      return {
        success: true,
        data: decided
          ? [item('ev-2', '利用者2')]
          : [item('ev-1', '利用者1'), item('ev-2', '利用者2')],
      }
    }
    if (status === 'approved') {
      return { success: true, data: decided ? [{ ...item('ev-1', '利用者1'), approvalStatus: 'approved' }] : [] }
    }
    return { success: true, data: [] }
  }
  fixture.bulkDecideImpl = async () => {
    decided = true
    return {
      success: true,
      data: {
        succeeded: ['ev-1'],
        conflicted: [{ id: 'ev-2', currentStatus: 'approved' }],
        denied: [],
        failed: [],
      },
    }
  }
})

afterEach(() => {
  cleanup()
})

async function openBulkConfirm() {
  render(<ApprovalQueue />)
  await waitFor(() => {
    expect(screen.getByLabelText('利用者1の成果を選ぶ')).toBeTruthy()
  })
  await act(async () => {
    fireEvent.click(screen.getByLabelText('利用者1の成果を選ぶ'))
    fireEvent.click(screen.getByLabelText('利用者2の成果を選ぶ'))
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '操作を選択する' }))
  })
}

async function bulkConfirmation() {
  const dialog = await screen.findByRole('dialog')
  const next = within(dialog).queryByRole('button', { name: '実行内容を確認' })
  if (!next) return dialog
  await act(async () => { fireEvent.click(next) })
  return screen.findByRole('dialog', { name: /選んだ.*件を認めますか/ })
}

async function openRowMenu(name = '利用者1') {
  await act(async () => { fireEvent.click(await screen.findByRole('button', { name: `${name}の成果の操作` })) })
}

async function retryAction() {
  await openRowMenu()
  return screen.findByRole('menuitem', { name: /^付帯動作をやり直す/ })
}

describe('一括承認の確認と結果表示', () => {
  test('確認に出る顔ぶれが実行対象と一致し、確認前はrequestが出ない', async () => {
    await openBulkConfirm()
    const dialog = await bulkConfirmation()
    expect(within(dialog).getByText('利用者1／紹介者1／案件A')).toBeTruthy()
    expect(within(dialog).getByText('利用者2／紹介者1／案件A')).toBeTruthy()
    expect(fixture.bulkDecideCalls).toHaveLength(0)
    expect(new Set(fixture.listCalls.map(call => call.status))).toEqual(new Set(['pending', 'approved', 'rejected']))
  })

  test('キャンセルではrequestが出ず、確定で1本だけ出る', async () => {
    await openBulkConfirm()
    const dialog = await bulkConfirmation()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    })
    expect(fixture.bulkDecideCalls).toHaveLength(0)
    // 開き直して確定する。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '操作を選択する' }))
    })
    const reopened = await bulkConfirmation()
    await act(async () => {
      fireEvent.click(within(reopened).getByRole('button', { name: '認める' }))
    })
    expect(fixture.bulkDecideCalls).toHaveLength(1)
    expect(fixture.bulkDecideCalls[0]).toEqual([
      { id: 'ev-1', status: 'approved', expectedStatus: 'pending' },
      { id: 'ev-2', status: 'approved', expectedStatus: 'pending' },
    ])
  })

  test('結果は成功と競合に分かれ、全成功とは表示しない', async () => {
    await openBulkConfirm()
    const dialog = await bulkConfirmation()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '認める' }))
    })
    const failure = await within(dialog).findByRole('alert')
    expect(failure.textContent).toMatch(/1 件を保存しました。1 件は保存できませんでした/)
    expect(within(dialog).getByRole('button', { name: 'もう一度' }).hasAttribute('disabled')).toBe(true)
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' })) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const result = await screen.findByRole('status')
    expect(within(result).getByText(/成功 1\s*件/)).toBeTruthy()
    expect(within(result).getByText(/ほかの人が先に判断 1\s*件/)).toBeTruthy()
    expect(within(result).getByText(/先に判断されました：利用者2/)).toBeTruthy()
    expect(within(result).queryByText(/全.*成功/)).toBeNull()
  })

  test('残りの選び直し再試行ができる', async () => {
    await openBulkConfirm()
    const dialog = await bulkConfirmation()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '認める' }))
    })
    const failure = await within(dialog).findByRole('alert')
    expect(failure.textContent).toMatch(/1 件を保存しました。1 件は保存できませんでした/)
    expect(within(dialog).getByRole('button', { name: 'もう一度' }).hasAttribute('disabled')).toBe(true)
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' })) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const result = await screen.findByRole('status')
    // 再試行では競合で状態が変わった利用者2だけが選ばれ直す。
    await act(async () => {
      fireEvent.click(within(result).getByRole('button', { name: '残りを選び直して再試行' }))
    })
    const reopened = await bulkConfirmation()
    expect(within(reopened).queryByText('利用者1／紹介者1／案件A')).toBeNull()
    expect(within(reopened).getByText('利用者2／紹介者1／案件A')).toBeTruthy()
  })
})

/*
 * 付帯動作のやり直し(N-212)。
 * 承認は済んでいて案件のタグ付与・シナリオ開始だけ未完の行に
 * 「付帯動作をやり直す」を出す。押下は既存の承認PATCHの already_set
 * 経路を使い、成功したら一覧を読み直す。
 */
describe('付帯動作のやり直し', () => {
  function useApprovedList(flagged: { current: boolean }) {
    fixture.listImpl = async (params?: unknown) => {
      const status = (params as { status?: string } | undefined)?.status
      if (status === 'approved') {
        return {
          success: true,
          data: [
            { ...item('ev-1', '利用者1'), approvalStatus: 'approved', offerActionsIncomplete: flagged.current },
            { ...item('ev-2', '利用者2'), approvalStatus: 'approved', offerActionsIncomplete: false },
          ],
        }
      }
      return { success: true, data: [] }
    }
  }

  async function openApprovedTab() {
    render(<ApprovalQueue />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /認めた/ })).toBeTruthy()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /認めた/ }))
    })
  }

  test('未完の行にだけボタンが出て、クリックで既存approveが呼ばれ、成功後に再読込で消える', async () => {
    const flagged = { current: true }
    useApprovedList(flagged)
    fixture.approveImpl = async () => {
      flagged.current = false
      return { success: true, data: { id: 'ev-1', approvalStatus: 'approved' } }
    }

    await openApprovedTab()
    // flag が立った行にだけ出る（ev-2 には出ない）。
    await openRowMenu('利用者2')
    expect(screen.queryByRole('menuitem', { name: '付帯動作をやり直す' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    const retry = await retryAction()

    await act(async () => {
      fireEvent.click(retry)
    })
    expect(fixture.approveCalls).toEqual([{ eventId: 'ev-1', expectedStatus: 'approved' }])
    // 成功で読み直し → flag が下りると列ごと消える。
    await waitFor(() => {
      expect(screen.queryByText('付帯動作が未完')).toBeNull()
    })
    await openRowMenu()
    expect(screen.queryByRole('menuitem', { name: '付帯動作をやり直す' })).toBeNull()
  })

  test('失敗は一覧のエラー領域に理由が出る', async () => {
    useApprovedList({ current: true })
    fixture.approveImpl = async () => {
      throw new Error('タグ付与後の処理が残っています')
    }

    await openApprovedTab()
    const retry = await retryAction()
    await act(async () => { fireEvent.click(retry) })
    await waitFor(() => {
      expect(screen.getByText('タグ付与後の処理が残っています')).toBeTruthy()
    })
  })

  test('実行中はボタンが無効になり二重にrequestが出ない', async () => {
    useApprovedList({ current: true })
    let resolveApprove!: (value: unknown) => void
    fixture.approveImpl = () => new Promise((resolve) => { resolveApprove = resolve })

    await openApprovedTab()
    const retry = await retryAction()
    await act(async () => { fireEvent.click(retry) })
    const busyRetry = await retryAction()
    expect(busyRetry).toHaveProperty('disabled', true)
    fireEvent.click(busyRetry)
    expect(fixture.approveCalls).toHaveLength(1)
    await act(async () => {
      resolveApprove({ success: true, data: { id: 'ev-1', approvalStatus: 'approved' } })
    })
  })

  test('未承認・却下タブにはボタンを出さない', async () => {
    // 既定のlistImpl（pending 2件・approved/rejected 0件）のまま。
    render(<ApprovalQueue />)
    await waitFor(() => {
      expect(screen.getByLabelText('利用者1の成果を選ぶ')).toBeTruthy()
    })
    await openRowMenu()
    expect(screen.queryByRole('menuitem', { name: '付帯動作をやり直す' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /認めなかった/ }))
    })
    await waitFor(() => {
      expect(screen.getByText('条件に合うものはありません')).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: '付帯動作をやり直す' })).toBeNull()
  })
})

/*
 * 200件打切り(N-207)。
 * 以前は各状態を limit:200 で1回だけ取り、201件目以降は画面に出ず操作も
 * できなかった。全ページ読むことを「offset を送ったrequest」と
 * 「201件目の行を探して選べること」で固定する。
 */
describe('200件を超える成果の読み込みと操作', () => {
  function usePagedPendingList(total: number) {
    const all = Array.from({ length: total }, (_, i) =>
      item(`ev-${i + 1}`, `利用者${i + 1}`),
    )
    fixture.listImpl = async (params?: unknown) => {
      const p = (params ?? {}) as { status?: string; limit?: number; offset?: number }
      if (p.status === 'pending') {
        const offset = p.offset ?? 0
        return { success: true, data: all.slice(offset, offset + (p.limit ?? 200)) }
      }
      return { success: true, data: [] }
    }
  }

  test('pending が200件で切れないとき offset を進めて次ページも読む', async () => {
    usePagedPendingList(201)
    render(<ApprovalQueue />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /承認待ち 201/ })).toBeTruthy()
    })
    // 1ページ目(offset 0)と2ページ目(offset 200)の両方がpendingで出ている。
    const pendingCalls = fixture.listCalls.filter((c) => c.status === 'pending')
    expect(pendingCalls.map((c) => c.offset)).toEqual([0, 200])
    expect(pendingCalls.map((c) => c.limit)).toEqual([200, 200])
  })

  test('201件目以降の成果も探して選び、まとめて認められる', async () => {
    usePagedPendingList(201)
    render(<ApprovalQueue />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /承認待ち 201/ })).toBeTruthy()
    })
    // 201件目は末尾のページにいるので、検索で絞って選ぶ。
    await act(async () => {
      fireEvent.change(screen.getByLabelText('名前・注文番号で探す'), { target: { value: '利用者201' } })
    })
    const checkbox = await screen.findByLabelText('利用者201の成果を選ぶ')
    await act(async () => {
      fireEvent.click(checkbox)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '操作を選択する' }))
    })
    const dialog = await bulkConfirmation()
    expect(within(dialog).getByText('利用者201／紹介者1／案件A')).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '認める' }))
    })
    expect(fixture.bulkDecideCalls[0]).toEqual([
      { id: 'ev-201', status: 'approved', expectedStatus: 'pending' },
    ])
  })

  test('5000件で止まるときは続きを読むボタンを出し、続きを読める', async () => {
    usePagedPendingList(5001)
    render(<ApprovalQueue />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /承認待ち 5,000/ })).toBeTruthy()
    })
    const more = await screen.findByRole('button', { name: /さらに読み込む/ })
    await act(async () => {
      fireEvent.click(more)
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /承認待ち 5,001/ })).toBeTruthy()
    })
    const pendingCalls = fixture.listCalls.filter((c) => c.status === 'pending')
    expect(pendingCalls[pendingCalls.length - 1].offset).toBe(5000)
  })
})

/*
 * アカウント絞り(N-218)。
 * 権限のあるアカウント一覧(= /api/line-accounts が返す範囲)で絞れて、
 * 一覧・件数・まとめて操作の対象が絞りに従うことを固定する。
 */
describe('アカウントでの絞り込み', () => {
  beforeEach(() => {
    fixture.accountsImpl = async () => ({
      success: true,
      data: [
        { id: 'acc-a', name: '本店' },
        { id: 'acc-b', name: '支店' },
      ],
    })
    fixture.listImpl = async (params?: unknown) => {
      const status = (params as { status?: string } | undefined)?.status
      if (status === 'pending') {
        return {
          success: true,
          data: [
            { ...item('ev-a', '利用者A'), lineAccountId: 'acc-a', lineAccountName: '本店' },
            { ...item('ev-b', '利用者B'), lineAccountId: 'acc-b', lineAccountName: '支店' },
          ],
        }
      }
      if (status === 'approved') {
        return {
          success: true,
          data: [{ ...item('ev-c', '利用者C'), approvalStatus: 'approved', lineAccountId: 'acc-b', lineAccountName: '支店' }],
        }
      }
      return { success: true, data: [] }
    }
  })

  test('絞ると一覧・件数・まとめて操作の対象がそのアカウントだけになる', async () => {
    const view = render(<ApprovalQueue />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /承認待ち 2/ })).toBeTruthy()
    })
    // 現役V8では、共通のアカウント選択がタブへ渡す値を切り替える。
    view.rerender(<ApprovalQueue accountId="acc-b" />)
    // 支店の行だけ残り、本店の行は消える。
    await waitFor(() => {
      expect(screen.getByLabelText('利用者Bの成果を選ぶ')).toBeTruthy()
      expect(screen.queryByLabelText('利用者Aの成果を選ぶ')).toBeNull()
    })
    // 件数も絞った顔ぶれで数える。
    expect(screen.getByRole('button', { name: /承認待ち 1/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /認めた 1/ })).toBeTruthy()
    // まとめて操作も支店の行だけが対象になる。
    await act(async () => {
      fireEvent.click(screen.getByLabelText('利用者Bの成果を選ぶ'))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '操作を選択する' }))
    })
    const dialog = await bulkConfirmation()
    expect(within(dialog).getByText('利用者B／紹介者1／案件A')).toBeTruthy()
    expect(within(dialog).queryByText('利用者A／紹介者1／案件A')).toBeNull()
  })

  test('アカウント列にアカウント名が出る', async () => {
    render(<ApprovalQueue />)
    await waitFor(() => {
      expect(screen.getByLabelText('利用者Aの成果を選ぶ')).toBeTruthy()
    })
    expect(screen.getByText('本店')).toBeTruthy()
    expect(screen.getByText('支店')).toBeTruthy()
  })
})

/*
 * IDEA-16: 同じ注文の重複候補と、返金・取り消し済みの注文に由来する成果は
 * 「要確認」にしてまとめて承認から外す。詳細では注文番号・注文の最新状態・
 * 確定報酬・支払い確定の状態を根拠として出す。未確定の額は確定額にしない。
 */
describe('IDEA-16: 注文根拠の表示と要確認の拡大', () => {
  function useOrderFlaggedList() {
    fixture.listImpl = async (params?: unknown) => {
      const status = (params as { status?: string } | undefined)?.status
      if (status === 'pending') {
        return {
          success: true,
          data: [
            { ...item('ev-1', '利用者1'), orderNumber: 'NEN-1001', orderStatus: 'current', sameOrderDuplicate: true, rewardAmount: null, rewardEntryStatus: null },
            { ...item('ev-2', '利用者2'), orderNumber: 'NEN-2002', orderStatus: 'refunded', sameOrderDuplicate: false, rewardAmount: null, rewardEntryStatus: null },
            { ...item('ev-3', '利用者3'), orderNumber: 'NEN-3003', orderStatus: 'current', sameOrderDuplicate: false, rewardAmount: 400, rewardEntryStatus: 'settled' },
          ],
        }
      }
      return { success: true, data: [] }
    }
  }

  test('同じ注文の重複候補と返金済み注文の成果は選べず、要確認になる', async () => {
    useOrderFlaggedList()
    render(<ApprovalQueue />)
    await waitFor(() => {
      expect(screen.getByLabelText('利用者1の成果を選ぶ')).toBeTruthy()
    })
    // 要確認の行はチェックを付けられない（まとめて承認から外れる）。
    expect((screen.getByLabelText('利用者1の成果を選ぶ') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByLabelText('利用者1の成果を選ぶ').getAttribute('title')).toBe('確認が必要な成果はまとめて認められません')
    expect((screen.getByLabelText('利用者2の成果を選ぶ') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('利用者3の成果を選ぶ') as HTMLInputElement).disabled).toBe(false)
    expect(screen.getAllByText('要確認')).toHaveLength(2)
  })

  test('注文番号で成果を探せる', async () => {
    useOrderFlaggedList()
    render(<ApprovalQueue />)
    await waitFor(() => {
      expect(screen.getByLabelText('利用者1の成果を選ぶ')).toBeTruthy()
    })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('名前・注文番号で探す'), { target: { value: 'NEN-2002' } })
    })
    await waitFor(() => {
      expect(screen.queryByLabelText('利用者1の成果を選ぶ')).toBeNull()
      expect(screen.getByLabelText('利用者2の成果を選ぶ')).toBeTruthy()
      expect(screen.queryByLabelText('利用者3の成果を選ぶ')).toBeNull()
    })
  })

  test('詳細は注文番号・注文の状態・確定報酬・支払い確定の状態を根拠として出す', async () => {
    useOrderFlaggedList()
    render(<ApprovalQueue />)
    await waitFor(() => {
      expect(screen.getByLabelText('利用者1の成果を選ぶ')).toBeTruthy()
    })
    await openRowMenu()
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '詳細と成果の付け方を見る' })) })
    const dialog = await screen.findByRole('dialog', { name: '成果の詳細' })
    expect(within(dialog).getByText(/NEN-1001/)).toBeTruthy()
    expect(within(dialog).getByText(/NEN-1001（有効）/)).toBeTruthy()
    expect(within(dialog).getByText(/同じ注文・同じ成果地点/)).toBeTruthy()
    // 承認前の成果は確定した報酬が無いので「未確定」と出す。
    expect(within(dialog).getByText('未確定')).toBeTruthy()
    expect(within(dialog).getByText('まだ確定していません')).toBeTruthy()
  })
})
