import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(join(HERE, 'page.tsx'), 'utf8')
const LEGACY = readFileSync(join(HERE, '..', 'scoring', 'page.tsx'), 'utf8')
const LEGACY_NEW = readFileSync(join(HERE, '..', 'scoring', 'new', 'page.tsx'), 'utf8')
const NEW_RULE = readFileSync(join(HERE, 'earning-rules', 'new', 'v8-earning-rule-new.tsx'), 'utf8')
const RULE_FIELDS = readFileSync(join(HERE, 'earning-rules', 'rule-fields.ts'), 'utf8')
const HISTORY = readFileSync(join(HERE, '../../v8/mileage/history.tsx'), 'utf8')
const FRIEND_DETAIL = readFileSync(join(HERE, 'friends', 'detail', 'page.tsx'), 'utf8')
const ADJUSTMENT = readFileSync(join(HERE, '..', '..', 'v8', 'mileage', 'adjust-dialog.tsx'), 'utf8')
const ACTION_SCORE = readFileSync(join(HERE, '../../v8/mileage/score.tsx'), 'utf8')
const BROADCAST_NEW = readFileSync(join(HERE, '..', 'broadcasts', 'new', 'page.tsx'), 'utf8')
const SEGMENT = readFileSync(join(HERE, '..', '..', 'lib', 'segment-condition.ts'), 'utf8')
const API = readFileSync(join(HERE, '..', '..', 'lib', 'api.ts'), 'utf8')
const MENU = readFileSync(join(HERE, '..', '..', 'lib', 'menu.ts'), 'utf8')

describe("管理画面 マイルの正本URLと概念分離", () => {
  it('マイルの正本を /mileage にし、旧URLを恒久転送する', () => {
    expect(MENU).toContain("{ href: '/mileage', label: 'マイル'")
    expect(LEGACY).toContain("permanentRedirect('/mileage')")
    expect(LEGACY_NEW).toContain("permanentRedirect('/mileage/earning-rules/new')")
  })

  it('履歴と友だち別明細を現役の画面とAPIへ接続する', () => {
    expect(HISTORY).toContain('<MileageFrame')
    expect(HISTORY).toContain("key: 'history', label: '履歴', board: 'oRbJi'")
    expect(HISTORY).toContain('api.mileage.history')
    expect(HISTORY).toContain('tone="error"')
    expect(FRIEND_DETAIL).toMatch(/(?:data-design-node|boardId)="R6kIG"/)
    expect(FRIEND_DETAIL).toContain('api.friends.mileage')
    expect(FRIEND_DETAIL).toContain('api.mileage.friendsV6')
    expect(FRIEND_DETAIL).toContain('api.mileage.history')
    // V6R-CX-e: 名前で探して100件から拾うと同名が多いとこぼれる。友だちIDで取り、絞り込みはサーバに任せる。
    expect(FRIEND_DETAIL).toMatch(/api\.mileage\.friendsV6\(\{[\s\S]{0,80}friendId,/)
    expect(FRIEND_DETAIL).toMatch(/api\.mileage\.history\(\{[\s\S]{0,80}friendId,/)
    expect(FRIEND_DETAIL).not.toContain('search: friendResponse.data.displayName')
    expect(FRIEND_DETAIL).toContain('displayedHistory')
    expect(FRIEND_DETAIL).toContain('v6Friend?.expiringMiles30d')
    expect(FRIEND_DETAIL).toContain('usePageTitle')
    expect(FRIEND_DETAIL).not.toContain('準備中')
  })

  it('APIの入れ子が欠けても画面を落とさず、0件とも書かない', () => {
    expect(HISTORY).toContain('mileagePaginationTotal(result)')
    expect(HISTORY).not.toContain('result?.pagination.total')
    expect(PAGE).toContain('mileagePaginationTotal(overview)')
    expect(readFileSync(join(HERE, '../../v8/mileage/score.tsx'), 'utf8')).not.toContain('overview?.pagination.total')
    expect(FRIEND_DETAIL).toContain('mileageRewardedActions(mileage.insights)')
    expect(FRIEND_DETAIL).toContain('mileageConnectedAccounts(mileage.connections)')
    expect(FRIEND_DETAIL).toContain('付与記録の回数は未取得')
    expect(FRIEND_DETAIL).toContain('接続先はありません')
  })

  it('残高は共通トップバーで選んだLINEアカウントだけを取得する', () => {
    expect(PAGE).toContain('selectedAccountId')
    expect(PAGE).toContain('accountId: accountAtRequest')
    expect(PAGE).toContain('accountAtRequest !== latestAccountRef.current')
    expect(PAGE).not.toContain('<option value="all">全アカウント横断</option>')
  })

  it("一覧の読込・空・失敗を言い分け、失効値を管理画面の口から表示する", () => {
    expect(PAGE).toContain('kind="loading"')
    expect(PAGE).toContain('kind="empty"')
    expect(PAGE).toContain('kind="error"')
    expect(PAGE).toContain('title="まだたまる決めごとがありません"')
    expect(PAGE).toContain('もうすぐ消えるマイル')
    expect(PAGE).toContain('summary?.expiringMiles30d')
    expect(PAGE).toContain('member.expiringMiles30d')
    expect(API).toContain('/api/mileage/friends?')
    expect(PAGE).not.toContain('該当するユーザーがいません')
  })

  it('残高一覧を設計の20件表示・絞り込み札・2操作にそろえる', () => {
    expect(PAGE).toContain("useListUrlValue('pageSize', 20)")
    for (const label of ['ゴールド', 'シルバー', 'ブロンズ', '消える予定', '残高が多い順']) {
      expect(PAGE).toContain(label)
    }
    expect(PAGE).toContain("rank === 'gold'")
    expect(PAGE).toContain('rankLabel(member.rank)')
    expect(PAGE).toContain("friend_added: '友だち追加'")
    expect(PAGE).toContain("broadcast_link_clicked: '配信リンククリック'")
    expect(PAGE).toContain("inflow_return: 'LINE帰還'")
    expect(PAGE).toContain('増減')
    expect(PAGE).toContain('&adjust=1')
    expect(FRIEND_DETAIL).toContain("searchParams.get('adjust') === '1'")
    expect(FRIEND_DETAIL).toContain('setAdjustmentOpen(true)')
  })

  it("管理画面の一覧契約を読み、既存の更新APIから停止と再開を操作できる", () => {
    expect(PAGE).toContain('api.mileage.earningRulesV6')
    expect(PAGE).toContain("updateRule(rule.id, { isActive: next === 'published' })")
    expect(PAGE).toContain("active ? '止める' : '再開する'")
    // 2026-09-02: 一覧をカード格子から設計の表へ移し、状態を共通Chipで出す。
    // 言い方は変えていない。
    expect(PAGE).toContain('動いています')
  })

  it('作成画面も mileage_rules のAPIと正本URLを使う', () => {
    expect(NEW_RULE).toContain('api.mileage.createRule')
    expect(NEW_RULE).toContain('api.mileage.saveEarningRuleDraft')
    // #532(#521): 旧口の作成は選択中のLINEアカウントに帰属させる。
    expect(NEW_RULE).toContain('lineAccountId: selectedAccountId!')
    expect(NEW_RULE).toMatch(/if \(!selectedAccountId\) \{\s*setSaveError\('LINEアカウントを選択してください'\)/)
    expect(API).toContain('lineAccountId: string\n      /** DRAFT-01: falseなら最初から停止中で作る。省略は従来どおり稼働。 */\n      isActive?: boolean\n    }, options?: { idempotencyKey?: string }) =>')
    expect(NEW_RULE).toContain('expiresAfterDays: expiryDays')
    expect(NEW_RULE).toContain('cancellationEventTypes:')
    expect(NEW_RULE).toContain('notification: {')
    expect(NEW_RULE).toContain('enabled: notifyFriend')
    // R296: 通知の既定文は作成・編集で共用の rule-fields.ts にまとめた。
    expect(RULE_FIELDS).toContain('{awardedMiles}')
    expect(NEW_RULE).toContain('EARNING_RULE_NOTIFY_TEMPLATE')
    expect(NEW_RULE).not.toContain('通知の送信口は未接続です')
    expect(NEW_RULE).toContain('<ConditionBuilder')
    expect(NEW_RULE).toContain('value={targetConditions}')
    expect(NEW_RULE).toContain('targetConditions: pruneCondition(targetConditions)')
    expect(NEW_RULE).toContain("const LIST_HREF = '/mileage?tab=earning-rules'")
    expect(NEW_RULE).toContain('href={LIST_HREF}')
    expect(NEW_RULE).not.toContain('api.scoring.create')
  })

  it('手動増減は現役の窓で変更前後を確認し、冪等キーを通して追記する', () => {
    expect(FRIEND_DETAIL).toContain('<MileageAdjustDialog')
    expect(ADJUSTMENT).toContain('designNode="M8zhjL"')
    expect(ADJUSTMENT).toContain("useState<'input' | 'requested' | 'completed'>('input')")
    expect(ADJUSTMENT).toContain('変更前')
    expect(ADJUSTMENT).toContain('変更量')
    expect(ADJUSTMENT).toContain('変更後')
    expect(ADJUSTMENT).toContain('crypto.randomUUID()')
    expect(ADJUSTMENT).toContain('reasonCategory')
    expect(ADJUSTMENT).toContain('sourceReferenceId')
    expect(ADJUSTMENT).toContain('setAdjustmentPolicy')
    expect(ADJUSTMENT).toContain('承認境界を保存する')
    expect(API).toContain("'Idempotency-Key': idempotencyKey")
    expect(API).toContain("'X-Confirm-Irreversible': 'mileage-adjustment'")
  })

  it('手動増減の通知と失効を実APIへ渡す', () => {
    expect(ADJUSTMENT).toContain('友だちに知らせる')
    expect(ADJUSTMENT).toContain('この分の有効期限')
    expect(ADJUSTMENT).toContain('expiresAt:')
    expect(ADJUSTMENT).toContain('notifyFriend,')
    expect(API).toContain('expiresAt?: string')
    expect(API).toContain('notifyFriend?: boolean')
    expect(ADJUSTMENT).toContain('利用可能な残高を超えて減らすことはできません')
    expect(ADJUSTMENT).not.toContain('API error:')
  })

  it('R: 確定待ちの確定・取消は理由を取って履歴の操作列から行う', () => {
    expect(HISTORY).toContain('確定する')
    expect(HISTORY).toContain('取り消す')
    expect(HISTORY).toContain('<Field label="理由" required>')
    expect(HISTORY).toContain('const reason = pendingReason.trim()')
    expect(HISTORY).toContain('理由を入力してください。')
    expect(HISTORY).toContain("api.mileage.confirmMileageEntry")
    expect(HISTORY).toContain("api.mileage.voidMileageEntry")
    expect(HISTORY).toContain("item.status === 'pending'")
    expect(API).toContain('/api/mileage/entries/')
    expect(API).toContain("'X-Confirm-Irreversible': 'mileage-entry-void'")
  })

  it('R: 高額調整は実行せず承認依頼へ回し、一覧から別オーナーが決める', () => {
    expect(ADJUSTMENT).toContain('承認を依頼')
    expect(ADJUSTMENT).toContain("'requested'")
    expect(PAGE).toContain('承認待ちのマイル変更')
    expect(PAGE).toContain('api.mileage.adjustmentApprovals')
    expect(PAGE).toContain('api.mileage.approveAdjustment')
    expect(PAGE).toContain('api.mileage.rejectAdjustment')
    expect(PAGE).toContain('差し戻す')
    expect(API).toContain('/api/mileage/adjustment-approvals')
  })

  it('R: 決めごとのテストは付与せず見通しだけを返す', () => {
    expect(PAGE).toContain('この内容をテスト')
    expect(PAGE).toContain('api.mileage.testEarningRule')
    expect(PAGE).toContain('実際には付与されず、履歴も増えません')
    expect(API).toContain('/api/mileage/earning-rules/test')
  })

  it('行動スコアを既存の現在値・履歴から選択アカウント単位で表示する', () => {
    expect(ACTION_SCORE).toContain("<MileageFrame")
    expect(ACTION_SCORE).toContain("key: 'score', label: '行動スコア', board: 'IRPw8'")
    expect(ACTION_SCORE).toContain('api.actionScores.friends')
    /* 断り文は下の「3つの言い方で断る」で見る。ここは口と印だけ。 */
    expect(ACTION_SCORE).toContain('kind="loading"')
    expect(ACTION_SCORE).toContain('title="条件に合う友だちがいません"')
    expect(ACTION_SCORE).toContain('tone="error"')
    expect(API).toContain('/api/action-scores/friends')
  })

  it('スコアの帯を友だち検索と配信の同じ共通条件へ渡す', () => {
    expect(ACTION_SCORE).toContain('/friends?')
    expect(ACTION_SCORE).toContain('/broadcasts/new?')
    expect(SEGMENT).toContain("case 'score_range'")
    expect(BROADCAST_NEW).toContain("type: 'score_range'")
    expect(BROADCAST_NEW).toContain('initialCondition={initialCondition}')
  })

  it('手動増減の失敗でAPI番号や内部文をそのまま出さない', () => {
    expect(ADJUSTMENT).toContain('mileageAdjustmentErrorMessage')
    expect(ADJUSTMENT).toContain("error.status === 405")
    expect(ADJUSTMENT).toContain('この環境ではマイル変更を実行できません。')
    expect(ADJUSTMENT).toContain('画面を読み直してからやり直してください。')
    expect(ADJUSTMENT).toContain("error.status === 428")
    expect(ADJUSTMENT).toContain('確認手順が完了していません。')
    expect(ADJUSTMENT).not.toContain("error instanceof ApiError || error instanceof Error ? error.message")
  })

})
