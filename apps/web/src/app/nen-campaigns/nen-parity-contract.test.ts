import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const OVERVIEW = fs.readFileSync(path.join(__dirname, '../../v8/nen-campaigns/list.tsx'), 'utf8')
const PAGE = fs.readFileSync(path.join(__dirname, 'page.tsx'), 'utf8')
const PREVIEW = fs.readFileSync(path.join(__dirname, '../../v8/nen-campaigns/preview.tsx'), 'utf8')
const NEW_COLUMN = fs.readFileSync(path.join(__dirname, '../../v8/nen-campaigns/column-new.tsx'), 'utf8')
const EDIT = fs.readFileSync(path.join(__dirname, '../../v8/nen-campaigns/column-intros.tsx'), 'utf8')

/*
 * ★管理画面 37-6（`z4q1K`）自動配信／37-6-A（`u66A0`）コラム の画面契約。
 * 設計の骨組み（タブ・数値カード・案内帯・一覧操作・表・右パネル・下部追従バー）と、
 * 点検 #512／#727／#733 で決めた振る舞いが残っていることを見る。
 */
describe('V8 NEN配信の取得と操作の契約', () => {
  it('現在の数の帯と補足に今月・先月・開封・注文・届かなかった数を残す', () => {
    for (const label of ['今月送った', '先月', '開封', '配信からの注文', '届かなかった', '友だち解除']) {
      expect(OVERVIEW).toContain(label)
    }
    // 今月・先月は端末の時差ではなく日本時間の月の範囲で取る。
    expect(PAGE).toContain('jstMonthRange(now)')
    expect(PAGE).toContain('jstMonthRange(now, -1)')
    expect(PAGE).toContain('from: thisMonth.from, to: thisMonth.to')
    // 自動配信の開封は LINE から取れない。取れない理由を隠さない。
    // （自動配信の表の開封列を外したため、理由は数値カードの説明と表の注記に残す）
    expect(OVERVIEW).toContain('LINE から一人ずつの開封を取れません')
    expect(OVERVIEW).toContain('自動配信は開封を取れません')
  })

  it('コラムは一覧と選択中の操作と見本を実際の取得・予約へつなぐ', () => {
    for (const label of ['LINE に届くカード', '送る相手・時刻', '送る相手', '送る日時', '今すぐ', '日時を予約', '自分にテストを送る', '配信を予約する']) {
      expect(OVERVIEW).toContain(label)
    }
    expect(OVERVIEW).toContain('<SelectedColumn')
    expect(OVERVIEW).toContain('ColumnPreview')
    // 差し込みは実送信と同じ「大切なご家族」で見せる（コラムはペット情報を持たない）。
    expect(PREVIEW).toContain("COLUMN_PET_NAME_FALLBACK = '大切なご家族'")
    // 送る相手の人数は実口 columns-preview から。
    expect(PAGE).toContain('api.nenCampaigns.columnAudience(')
    // ヘッダーは ★管理画面 37-6-A どおり「ECのコラムを取り込む」（未割り当てのECコラムを割り当てる実口）。
    expect(PAGE).toContain('ECのコラムを取り込む')
    expect(PAGE).toContain('api.nenCampaigns.importColumns(')
    // LINE配信の状態は日本語で（内部値をそのまま出さない）。
    expect(OVERVIEW).toContain('送っていない')
    expect(OVERVIEW).toContain('送信済み')
    expect(OVERVIEW).toContain('columnBadge(column, metric?.sent ?? null)')
    expect(OVERVIEW).toContain('metric?.articleOpened.value')
  })

  it('読込失敗と空状態を共通状態部品で示す', () => {
    expect(PAGE).toContain('kind="loading"')
    // ★管理画面 `x63W5x`：読み直す口は一覧の場所の1枚（`onRetryTab`）が持つ。帯は出さない。
    expect(OVERVIEW).toContain('kind="error"')
    expect(OVERVIEW).toContain('onRetryTab')
    expect(OVERVIEW).toContain('kind="empty"')
    expect(OVERVIEW).toContain('コラムは外部サイトの記事へつなぐカードです。')
  })

  it('タブごとに取り、失敗はそのタブの一覧の場所の1枚で示す(点検 #512 の中3)', () => {
    expect(PAGE).toContain('loadTab')
    expect(PAGE).toContain('tabErrors')
    // ★管理画面 `x63W5x`：同じ失敗は1画面に1つ。ページ上の帯は出さない。
    expect(PAGE).not.toContain('tone="danger"')
    expect(OVERVIEW).toContain('tabError')
    expect(OVERVIEW).toContain('onRetryTab')
    expect(PAGE).not.toContain('loadError')
    // 操作後は関係するタブだけ読み直す。
    expect(PAGE).toContain("await loadTab('columns')")
    expect(PAGE).toContain("await loadTab('history')")
    expect(PAGE).not.toContain('await load()')
  })

  it('コラム作成で対象・予約・読了後の操作を実APIへ接続する', () => {
    expect(NEW_COLUMN).toContain('boardId="yRDwW"')
    expect(NEW_COLUMN).toContain('前のコラムを下敷きにする')
    expect(NEW_COLUMN).toContain('columnAudience')
    expect(NEW_COLUMN).toContain('配信日時（日本時間）')
    expect(NEW_COLUMN).toContain('読了イベント名')
    expect(NEW_COLUMN).toContain('読了後に付けるタグ')
  })

  it('一覧側の配信日時も新規作成と同じく日本時間で送る(点検 #512 の中5)', () => {
    // 端末の時差で解釈する new Date(...).toISOString を使わない。
    expect(OVERVIEW).toContain('publishedAtIso(plan.scheduledAt)')
    expect(OVERVIEW).not.toContain('new Date(event.target.value).toISOString()')
  })

  it('コラム作成のタグ候補はこのアカウントのものだけ(点検 #512 の中4)', () => {
    expect(NEW_COLUMN).toContain('visibleAccountTags')
    expect(NEW_COLUMN).toContain('accountTags')
  })

  it('今すぐ送る件数は口と同じ決めごとの数を使う(点検 #512 の中2)', () => {
    // 一覧の窓付き集計(summary.pending)を送ると、変わっていないのに409になる。
    expect(PAGE).toContain('overviewRes.data.jobs.pending')
    expect(PAGE).not.toContain('deliveryList.summary.pending')
  })

  it('再送理由は口の上限500字を超えて送れない(点検 #512 の軽6)', () => {
    expect(OVERVIEW).toContain('maxLength={500}')
    expect(OVERVIEW).toContain('500文字まで')
  })

  it('紹介文の上限は一覧側と編集画面で1500字にそろえる(点検 #512 の軽7)', () => {
    expect(OVERVIEW).toContain('maxLength={1500}')
    expect(EDIT).toContain('maxLength={1500}')
  })

  it('クーポン数値は口の範囲の前に具体的な直し方を出す(点検 #512 の軽5)', () => {
    expect(PAGE).toContain('割引の額は1〜100,000円の整数で入力してください')
    expect(PAGE).toContain('使える日数は1〜365日の整数で入力してください')
    expect(PAGE).toContain('savingCoupon')
    // クーポンの決めごとは誕生日配信の行から右パネルで開く。
    expect(OVERVIEW).toContain("label: 'クーポンの決めごと'")
    expect(OVERVIEW).toContain('誕生日は3日前の10:00に送ります')
  })

  it('配信予約は確認ダイアログを挟む(点検 #512 の中9)', () => {
    expect(OVERVIEW).toContain('ConfirmDialog')
    expect(OVERVIEW).toContain('setConfirm')
    expect(OVERVIEW).toContain('を配信予約しますか？')
    // ボタン直結のワンクリック実行は残さない。
    expect(OVERVIEW).not.toContain('onClick={() => onDeliver(column)}')
  })

  it('送った履歴は新しい取得結果と状態の日本語を使う', () => {
    expect(OVERVIEW).toContain('delivery.lineAccountName')
    expect(OVERVIEW).toContain('deliveryTriggerLabel(delivery.campaignKey)')
    expect(OVERVIEW).toContain('delivery.reaction.reason')
    expect(OVERVIEW).toContain('props.onShowDelivery(delivery.id)')
    expect(OVERVIEW).toContain('取得不可')
    expect(OVERVIEW).not.toContain('12pt')
  })
})
