// @vitest-environment happy-dom
/*
 * Issue #987（NEXT-01〜04）の回帰試験。
 *
 * - NEXT-01: 顧客を選んだテスト送信を「自分だけ」と説明していた。
 *   → 確認見出しは「選択した1名へ実際に送信」系で、アカウント・相手名・
 *     本人/テスト登録者/一般の区分を直前に固定表示する。
 * - NEXT-02: 確認チェックが最初から全ONで送信可否に結ばれていなかった。
 *   → 必要な確認だけ未チェック開始で送信可否に結び、対象変更でリセット。
 * - NEXT-03: 成功・失敗が「戻る」まで見えなかった。
 *   → 最終確認内に処理中/成功/一部失敗/失敗を表示し、成功後は完了へ。
 * - NEXT-04: 送る通・プレビュー・待機時間が固定の見本だった。
 *   → 選択した通・実本文・対象の差込値から組み立て、未計測時間は出さない。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestSendDialog } from './scenario-dialogs'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const send = vi.hoisted(() => vi.fn())
const runs = vi.hoisted(() => vi.fn())
const friendsList = vi.hoisted(() => vi.fn())
const preview = vi.hoisted(() => vi.fn())
const loginUsers = vi.hoisted(() => vi.fn())
const testRecipients = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({
  api: {
    friends: { list: friendsList },
    scenarios: { runs, testSend: send, testSendStep: send, preview },
    accountSettings: {
      getTestRecipientLoginUsers: loginUsers,
      getTestRecipients: testRecipients,
    },
  },
  ApiError: class extends Error {},
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'acc-1',
    accounts: [{ id: 'acc-1', name: '監査アカウント' }],
  }),
}))

vi.mock('@/components/shared/condition-builder', () => ({
  default: () => null,
  isEmptyCondition: () => true,
  pruneCondition: (v: unknown) => v,
}))

const FRIEND = { id: 'customer-1', displayName: '架空の顧客 太郎' }
const STEP3 = { id: 'step-3', stepOrder: 3, timing: '3日後', kind: 'テキスト' }
const ALL_STEPS = [
  { id: 'step-1', stepOrder: 1, timing: '即時', kind: 'テキスト' },
  { id: 'step-2', stepOrder: 2, timing: '1日後', kind: '画像' },
  STEP3,
]

beforeEach(() => {
  friendsList.mockResolvedValue({ success: true, data: { items: [FRIEND] } })
  runs.mockResolvedValue({ success: true, data: { testSends: [] } })
  send.mockResolvedValue({ success: true, data: { sent: 1 } })
  preview.mockResolvedValue({
    success: true,
    data: {
      startAt: '2026-09-21T00:00:00+09:00',
      steps: ALL_STEPS.map((s) => ({
        stepOrder: s.stepOrder,
        deliveryAt: '2026-09-21T00:00:00+09:00',
        deliveryAtLabel: `Day ${s.stepOrder - 1}`,
        messageType: s.stepOrder === 2 ? 'image' : 'text',
        messageContent: `{{name}}さんへの${s.stepOrder}通目本文`,
      })),
    },
  })
  loginUsers.mockResolvedValue({ success: true, data: [] })
  testRecipients.mockResolvedValue({ success: true, data: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

type Props = Parameters<typeof TestSendDialog>[0]

/** 友だちを選んで最終確認を開く。友だち一覧には300msのデバウンスがある。 */
const openConfirm = async (props: Partial<Props> = {}) => {
  const onClose = vi.fn()
  render(
    <TestSendDialog
      scenarioId="sc-1"
      lineAccountId="acc-1"
      stepId="step-3"
      stepLabel="3通目"
      steps={[STEP3]}
      onClose={onClose}
      {...props}
    />,
  )
  fireEvent.click(await screen.findByText(FRIEND.displayName))
  fireEvent.click(screen.getByText('内容を確認'))
  // 本文の読み込みを流し切り、区分の解決（別のPromise）も待つ。
  await screen.findByText('架空の顧客 太郎さんへの表示例。名前などの差し込みは送信時に実値へ置き換わります。')
  await act(async () => {})
  return { onClose }
}

const checkboxes = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[type=checkbox]'))

const sendButton = () => screen.getByText('テストを送る').closest('button')!

describe('NEXT-01: 実際の送信先を正直に説明する', () => {
  it('一般の友だちを選んでもアカウント・相手名・区分が正しく出る', async () => {
    await openConfirm()
    expect(document.body.textContent).toContain('選択した1名へ実際に送信')
    expect(document.body.textContent).toContain('監査アカウント')
    expect(document.body.textContent).toContain(FRIEND.displayName)
    expect(document.body.textContent).toContain('一般の友だち')
  })

  it('「自分のLINE」「本番の友だちへは届きません」等の虚偽を出さない', async () => {
    await openConfirm()
    for (const lie of ['自分のLINE', '本番の友だちへは届きません', 'Demo Person']) {
      expect(document.body.textContent).not.toContain(lie)
    }
  })

  it('テスト受信者を選ぶと区分がテスト受信者になる', async () => {
    testRecipients.mockResolvedValue({
      success: true,
      data: [{ id: FRIEND.id, displayName: FRIEND.displayName, pictureUrl: null }],
    })
    await openConfirm()
    // 「一般の友だち」は出ず「テスト受信者」が出る。
    expect(screen.queryByText('一般の友だち')).toBeNull()
    expect(screen.getAllByText('テスト受信者').length).toBeGreaterThan(0)
  })

  it('スタッフ連携の友だちはスタッフとして出る', async () => {
    loginUsers.mockResolvedValue({
      success: true,
      data: [
        {
          id: FRIEND.id,
          displayName: FRIEND.displayName,
          pictureUrl: null,
          staffName: '運用 花子',
          sameAccount: true,
        },
      ],
    })
    await openConfirm()
    expect(document.body.textContent).toContain('スタッフ連携のLINE（運用 花子）')
  })
})

describe('NEXT-02: 確認チェックが送信可否に結ばれる', () => {
  it('全OFF・一部ONでは送れず、全部付けたときだけ送れる', async () => {
    await openConfirm()
    const checks = checkboxes()
    expect(checks.length).toBe(2)
    expect(checks.every((c) => !c.checked)).toBe(true)
    expect(sendButton().disabled).toBe(true)

    // 一部ONでも送れない
    fireEvent.click(checks[0])
    expect(sendButton().disabled).toBe(true)

    // 全部ONで初めて送れる
    fireEvent.click(checks[1])
    expect(sendButton().disabled).toBe(false)
    await act(async () => {
      fireEvent.click(sendButton())
    })
    expect(send).toHaveBeenCalledWith('sc-1', 'step-3', 'customer-1')
  })

  it('送信先を選び直すと確認はリセットされる', async () => {
    await openConfirm()
    for (const c of checkboxes()) fireEvent.click(c)
    expect(sendButton().disabled).toBe(false)

    // 戻って選び直すと、確認は外れている。
    fireEvent.click(screen.getByText('戻る'))
    fireEvent.click(await screen.findByText(FRIEND.displayName))
    fireEvent.click(screen.getByText('内容を確認'))
    await screen.findAllByText('一般の友だち')
    await act(async () => {})
    expect(checkboxes().every((c) => !c.checked)).toBe(true)
    expect(sendButton().disabled).toBe(true)
  })
})

describe('NEXT-03: 結果は画面を戻さず確認できる', () => {
  const confirmAll = async () => {
    for (const c of checkboxes()) fireEvent.click(c)
    await act(async () => {})
  }

  it('成功すると確認画面の中に結果が出て、完了へ切り替わる', async () => {
    send.mockResolvedValue({ success: true, data: { sent: 1 } })
    await openConfirm()
    await confirmAll()
    await act(async () => {
      fireEvent.click(sendButton())
    })
    expect(document.body.textContent).toContain('送信が完了しました')
    expect(document.body.textContent).toContain('1 件のメッセージを送りました。')
    // 完了へ切り替わり、開始ボタンは消える。
    expect(screen.getByText('閉じる')).toBeTruthy()
    expect(screen.queryByText('テストを送る')).toBeNull()
    expect(screen.queryByText('もう一度送る')).toBeNull()
  })

  it('失敗すると原因と再試行条件がその場に出る', async () => {
    send.mockResolvedValue({ success: false, error: '監査用の送信失敗' })
    await openConfirm()
    await confirmAll()
    await act(async () => {
      fireEvent.click(sendButton())
    })
    expect(document.body.textContent).toContain('送信できませんでした')
    expect(document.body.textContent).toContain('監査用の送信失敗')
    expect(document.body.textContent).toContain('原因を解決してから、もう一度実行してください')
    // 再試行は同じ画面からできる。
    expect(screen.getByText('もう一度送る')).toBeTruthy()
  })

  it('送信中は二重押下できない', async () => {
    let resolveSend: (v: { success: boolean; data: { sent: number } }) => void = () => {}
    send.mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve }),
    )
    await openConfirm()
    await confirmAll()
    fireEvent.click(sendButton())
    expect(document.body.textContent).toContain('送信中です')
    expect(screen.getByText('送信中…').closest('button')!.disabled).toBe(true)
    await act(async () => {
      resolveSend({ success: true, data: { sent: 1 } })
    })
    expect(document.body.textContent).toContain('送信が完了しました')
  })
})

describe('NEXT-04: 確認は選択した通・実本文・差込値から組み立てる', () => {
  it('3通目だけ選ぶと3通目だけが出る。固定の見本は出ない', async () => {
    await openConfirm()
    expect(document.body.textContent).toContain('3通目')
    expect(document.body.textContent).toContain('この1通だけを送信します。')
    for (const lie of ['ステップ1から', '約2分', '10秒', '［テスト］ご登録ありがとうございます。']) {
      expect(document.body.textContent).not.toContain(lie)
    }
    // 実本文に相手の名前を差し込んだ表示例が出る。
    expect(document.body.textContent).toContain('架空の顧客 太郎さんへの3通目本文')
    expect(document.body.textContent).toContain('表示例')
  })

  it('全通を選ぶと全通が並び、APIへ渡す対象と一致する', async () => {
    await openConfirm({ stepId: null, stepLabel: '全通', steps: ALL_STEPS })
    for (const label of ['1通目', '2通目', '3通目']) {
      expect(document.body.textContent).toContain(label)
    }
    expect(document.body.textContent).toContain('選択した3通を、通と通のあいだの待機を省略して順番に送信します。')
    for (const c of checkboxes()) fireEvent.click(c)
    await act(async () => {
      fireEvent.click(sendButton())
    })
    // 全通送信の口が呼ばれる（1通用ではない）。
    expect(send).toHaveBeenCalledWith('sc-1', 'customer-1')
  })

  it('画像の通は本文を捏造せず種類で示す', async () => {
    await openConfirm({ stepId: 'step-2', stepLabel: '2通目', steps: [ALL_STEPS[1]] })
    expect(document.body.textContent).toContain('画像（登録済みの内容をそのまま送ります）')
  })
})

it('WEB269: 実本文の取得が失敗したらチェックを入れても送信できない', async () => {
  preview.mockRejectedValue(new Error('offline'))
  render(<TestSendDialog scenarioId="sc-1" lineAccountId="acc-1" stepId="step-3" stepLabel="3通目" steps={[STEP3]} onClose={() => {}} />)
  fireEvent.click(await screen.findByText(FRIEND.displayName))
  fireEvent.click(screen.getByText('内容を確認'))
  await act(async () => {})
  for (const check of checkboxes()) fireEvent.click(check)
  expect(sendButton().disabled).toBe(true)
  fireEvent.click(sendButton())
  expect(send).not.toHaveBeenCalled()
})
