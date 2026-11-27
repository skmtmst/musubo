import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { describe, expect, it } from 'vitest'
import { ruleEventLabel } from './earning-rule-view'

const PAGE = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
const NEW_PAGE = readFileSync(new URL('./earning-rules/new/v8-earning-rule-new.tsx', import.meta.url), 'utf8')
const EDIT_PAGE = readFileSync(new URL('./earning-rules/edit/page.tsx', import.meta.url), 'utf8')

describe("管理画面 たまる決めごと（N46cQ）の見せ方", () => {
  it('未知の行動は内部語を出さず、運用者の言葉にする', () => {
    expect(ruleEventLabel('message_received', { message_received: 'メッセージ' })).toBe('メッセージ')
    expect(ruleEventLabel('internal_new_event', {})).toBe('その他の行動')
  })
})

describe("管理画面 たまる決めごと（N46cQ）の画面", () => {
  it('並び順は一括口へまとめて保存する(N-243)', () => {
    // 1件ずつPATCHすると途中失敗で一部だけ反映されるため、全順序を1回で送る。
    expect(PAGE).toContain('api.mileage.saveEarningRulesOrder')
    expect(PAGE).toContain('ids: ruleOrder')
    expect(PAGE).toContain('busy={savingOrder} busyLabel="保存しています"')
    const orderBody = readFileSync(new URL('../../v8/mileage/earning-rules.tsx', import.meta.url), 'utf8').split('const saveOrder = async')[1]?.split('const toggleRule')[0] ?? ''
    expect(orderBody).toContain('saveEarningRulesOrder')
    expect(orderBody).not.toContain('saveEarningRuleDraft')
  })

  it('R296: 一覧から下書きの編集画面へ行け、未公開だけ削除できる', () => {
    // 編集の入口。別画面へ行く項目には external の印を付ける。
    expect(PAGE).toContain("label: '編集'")
    expect(PAGE).toContain('/mileage/earning-rules/edit?id=')
    // 消せるのは公開前の下書きだけ。履歴のある運用済みは口が409で断り、
    // 画面は確認窓に理由を残す（一覧を消さない）。
    expect(PAGE).toContain('rule.publishedVersion == null')
    expect(PAGE).toContain('この決めごとを削除する')
    expect(PAGE).toContain('api.mileage.deleteRule')
    expect(PAGE).toContain('を削除しますか？')
    expect(PAGE).toContain('取り消せません')
    expect(PAGE).toContain('deleteError')
  })

  it('R296: 編集画面は下書きだけを版つきで保存し、動いている内容に触れない', () => {
    // 保存は下書き口へ。読んだ版を渡すので、開いている間の他人の直しを
    // 黙って上書きしない（ずれていたら口が409で断る）。
    expect(EDIT_PAGE).toContain('api.mileage.saveEarningRuleDraft')
    expect(EDIT_PAGE).toContain('expectedVersion: rule.draftVersion')
    // 公開・停止・並び順はこの画面の仕事ではない（一覧の操作へ残す）。
    expect(EDIT_PAGE).not.toContain('publishEarningRule')
    expect(EDIT_PAGE).not.toContain('saveEarningRulesOrder')
    // 動いている内容が変わらないことを画面の言葉で伝える。
    expect(EDIT_PAGE).toContain('動いている内容は変わりません')
    // 新規作成と同じ選択肢を使う（直しが片方だけに残らないように）。
    expect(EDIT_PAGE).toContain("from '../rule-fields'")
    expect(NEW_PAGE).toContain("from './rule-fields'")
    // 見つからない・読み込めないを言い分ける（★管理画面 共通部品その2）。
    expect(EDIT_PAGE).toContain('この決めごとが見つかりません')
    expect(EDIT_PAGE).toContain('たまる決めごとを読み込めませんでした')
  })

  it("管理画面の30日集計・版・失効条件を表示する", () => {
    expect(PAGE).toContain('api.mileage.earningRulesV6')
    expect(PAGE).toContain('api.mileage.history')
    expect(PAGE).toContain('api.mileage.friendsV6')
    expect(PAGE).toContain('title="直近30日 付けたマイル"')
    expect(PAGE).toContain('title="残高の合計"')
    expect(PAGE).toContain('setGrantedMiles(grant?.amount ?? 0)')
    expect(PAGE).toContain('balanceTotal / averageDenominator')
    expect(PAGE).toContain('grantedMiles30d(rule)')
    // R53: 決めごと行の30日額は台帳の実額。回数×今の下書き金額にしない。
    expect(PAGE).toContain('rule.metrics30d.grantedMiles')
    expect(PAGE).not.toContain('rule.metrics30d.granted * rule.draft.amount')
  })

  it('平均の分母と説明文の人数は同じ値を使う（MILEAGE-05）', () => {
    // 計算は「残高のある人」で割っているのに、説明が別の口の人数
    // （全員の数）を出すと、運用者が違う分母で読んでしまう。
    expect(PAGE).toContain('setAverageDenominator(friendsRes.data.summary.withBalanceCount)')
    expect(PAGE).toContain('formatMileageNumber(averageDenominator)')
    expect(PAGE).not.toContain('formatMileageNumber(tabCounts.balances')
    // 残高0の人を含めるか除くかを明記する
    expect(PAGE).toContain('残高0の人は除き')
    // 割れる人がいないときは「計算していません」と言う（0とは言わない）
    expect(PAGE).toContain('残高がある人がいないため計算していません')
    expect(PAGE).toContain('rule.metrics30d.granted')
    expect(PAGE).toContain('rule.metrics30d.excluded')
    expect(PAGE).toContain('rule.draftVersion')
    expect(PAGE).toContain('rule.draft.expiresAfterDays')
  })

  it('停止・再開の失敗は一覧を消さず元へ戻し、再試行できる通知を出す', () => {
    const body = PAGE.split('const toggleRule = async')[1]?.split('const publishRule')[0] ?? ''
    expect(body).toContain('setStatus(before)')
    expect(body).toContain('notifyToast(')
    expect(body).toContain("tone: 'error'")
    expect(body).toContain("actionLabel: 'もう一度'")
    expect(body).not.toContain('setLoadError(')
  })

  it('読込中・取得失敗・空を言い分ける', () => {
    expect(PAGE).toContain('title="たまる決めごとを読み込んでいます"')
    expect(PAGE).toContain('title="たまる決めごとを読み込めませんでした"')
    expect(PAGE).toContain('title="まだたまる決めごとがありません"')
    expect(PAGE).toContain('<EmptyList')
  })
})

describe("管理画面 たまる決めごとをつくる（BmoGY）の対象条件", () => {
  it("共通の条件部品で15軸を組み合わせ、管理画面下書きへ保存する", () => {
    expect(NEW_PAGE).toContain("import ConditionBuilder, {")
    expect(NEW_PAGE).toContain('<ConditionBuilder')
    expect(NEW_PAGE).toContain('value={targetConditions}')
    expect(NEW_PAGE).toContain('targetConditions: pruneCondition(targetConditions)')
  })
})
