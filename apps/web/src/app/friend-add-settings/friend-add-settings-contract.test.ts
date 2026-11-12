import { readUiSource } from '../../../scripts/test-ui-source.mjs'
import { readApiSource } from '../../../scripts/test-api-source.mjs'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const LIST_PAGE = fs.readFileSync(new URL('../../v8/friend-add/list.tsx', import.meta.url), 'utf8')
const EDITOR = readUiSource(path.join(__dirname, '../../v8/friend-add/editor.tsx'), 'utf8')
const API = readApiSource(path.join(__dirname, '../../lib/api.ts'), 'utf8')

const ENTRY = fs.readFileSync(path.join(__dirname, 'page.tsx'), 'utf8')

describe("管理画面 友だち追加時配信 7画面の契約", () => {
  it('一覧から新規作成と編集へ遷移できる', () => {
    expect(LIST_PAGE).toContain('href="/friend-add-settings?view=new"')
    expect(LIST_PAGE).toContain("href={editHref(rule.id)}")
    expect(ENTRY).toContain("view === 'new'")
    expect(ENTRY).toContain('ruleId={params.get(')
  })

  it('モック固定値ではなく友だち追加時配信APIで読み書きする', () => {
    expect(LIST_PAGE).toContain('api.friendAddRules.list(selectedAccountId, kind, {')
    expect(LIST_PAGE).toContain('api.friendAddRules.createFolder(selectedAccountId, name, folderKey.current, folderColor)')
    expect(EDITOR).toContain('api.friendAddRules.createDraft(payload, saveIdempotencyKey.current)')
    expect(EDITOR).toContain('api.friendAddRules.saveDraft(ruleId, payload, saveIdempotencyKey.current)')
    // R262: テストは試す流入リンク・想定日時・友だちを実行側の判定へ渡す。
    expect(EDITOR).toContain('api.friendAddRules.test(selectedAccountId, activeId, testInput)')
    expect(API).toContain("'/api/friend-add-rules/drafts'")
    expect(API).toContain("'/api/friend-add-rules/test'")
    expect(API).toContain('friendId: input?.friendId')
  })

  it('読込中・空・失敗と再読込を用意する', () => {
    expect(LIST_PAGE).toContain("onClick={() => load()}")
  })

  it('未接続の見せかけアクションを選択肢に出さない', () => {
    expect(EDITOR).toContain("type: 'add_tag'")
    expect(EDITOR).toContain("type: 'remove_tag'")
    expect(EDITOR).toContain("type: 'start_scenario'")
    expect(EDITOR).not.toContain("type: 'send_message'")
    expect(EDITOR).not.toContain("type: 'send_webhook'")
  })

  it('テスト実行後だけ本番データを変更しないことを運用者へ伝える', () => {
    expect(EDITOR).toContain('stateChanged: false')
  })
})

describe("管理画面 友だち追加時配信の運用者向け表示", () => {

  it('画面にDB名やマイグレーション番号を出さない', () => {
    const screens = `${LIST_PAGE}\n${EDITOR}`
    expect(screens).not.toContain('friend_add_rules')
    expect(screens).not.toContain('definition_snapshot')
    expect(screens).not.toMatch(/マイグレーション\s*\d+/)
  })

  it('曜日・時間帯・友だち条件・再送制限を保存済み契約で編集する', () => {
    expect(EDITOR).toContain("weekdays: [0, 1, 2, 3, 4, 5, 6]")
    expect(EDITOR).toContain("timeWindows: [{ start: '08:00', end: '21:00' }]")
    expect(EDITOR).toContain('resendSuppressionHours')
    expect(EDITOR).toContain('unknownRouteAction')
    expect(EDITOR).toContain('matchedLast28Days')
  })

  it('確認画面は経路・初回案内・付く属性・次の配信を実設定から順に説明する(IDEA-09)', () => {
    // 固定の例示（テキスト＋画像＋ボタン／新規友だち）ではなく、
    // 保存済み定義から組み立てる。再追加で動く／動かない処理も示す。
    expect(EDITOR).toContain('friendAddFlowSteps({')
    expect(EDITOR).toContain('friendAddReaddLines({')
    expect(EDITOR).toContain('isFallback: rule.isFallback')
    expect(EDITOR).toContain('friendKind: rule.friendKind')
    expect(EDITOR).toContain('status: rule.status')
  })
})

describe("管理画面 友だち追加時配信の点検・中の再発防止", () => {
  it('一覧の検索とフォルダ絞りをサーバ側へ送り、件数は全ページの合計で出す', () => {
    expect(LIST_PAGE).toContain('q: appliedSearch.trim() || undefined')
    expect(LIST_PAGE).toContain('folder: folder ?? undefined')
    expect(LIST_PAGE).toContain('folderCounts')
    expect(LIST_PAGE).toContain("activeId={folder ?? ''}")
    expect(LIST_PAGE).toContain('onSelect={(id) => selectFolder(id || null)}')
    expect(LIST_PAGE).not.toContain('toLocaleLowerCase')
  })

  it('新規作成の優先順位は競合一覧の最大+1にする', () => {
    // 一覧は既定20件のため、件数+1では21件を超えると重複する。
    expect(EDITOR).toContain("api.friendAddRules.conflicts(request.accountId, 'first_time')")
    expect(EDITOR).toContain('conflictRes.data.rules.reduce')
  })

  it('再追加の「何も配信しない」を選べ、シナリオなしで保存できる', () => {
    expect(EDITOR).toContain("friendKind === 'returning' && definition.returningMode === 'none'")
  })

  it('実際に配信するシナリオを編集画面で選べる(FRIENDADD-01)', () => {
    expect(EDITOR).toContain('value={definition.scenarioId ??')
    expect(EDITOR).toContain('scenarioId: value || null')
    expect(EDITOR).toContain('<EntityKindField kind="scenario"')
    expect(EDITOR).toContain('options={scenarios}')
  })

  it('フォルダは表にあるものから選び、自由入力で増やさない', () => {
    expect(EDITOR).toContain('options.folders')
  })

  it('テストの失敗時も理由を捨てず、確認面へ渡す', () => {
    expect(EDITOR).toContain("if ('data' in response && response.data) setTestResult({ ...testedMeta, ...response.data })")
  })

  it('アカウント切替で遅れて返る応答が切替先を上書きしない(FRIENDADD-02)', () => {
    // 読込ごとに対象アカウント・ルール・世代を持ち、一致する応答だけ採用する。
    expect(EDITOR).toContain('loadRequestRef')
    expect(EDITOR).toContain('isCurrentRequest()')
    expect(EDITOR).toContain('setLoadedAccountId(request.accountId)')
    // 表示中の設定と保存先アカウントが一致するときだけ保存・テストする。
    expect(EDITOR).toContain('loadedAccountId !== selectedAccountId')
  })

  it('設定を変えたあとは前のテスト結果を今の設定の判定として出さない(FRIENDADD-03)', () => {
    // 結果は実行時のアカウント・ルール・保存済みスナップショットと結び付ける。
    expect(EDITOR).toContain('testedMeta')
    expect(EDITOR).toContain('testResult.snapshot === editorSnapshot(rule, definition)')
    expect(EDITOR).toContain('testResult.accountId === selectedAccountId')
  })

  it('時間帯は複数件を表示・編集し、先頭以外を消さない(FRIENDADD-05)', () => {
    // 以前は先頭だけを表示し配列全体を1件で置き換えていた。
    expect(EDITOR).toContain('updateTimeWindow(current.timeWindows, index')
    expect(EDITOR).toContain('removeTimeWindow(current.timeWindows, index')
    expect(EDITOR).toContain('addTimeWindow(current.timeWindows)')
    expect(EDITOR).not.toContain('timeWindows: [{ ...window')
  })

  it('設定画面は旧振り分け口を参照しない', () => {
    // 旧口は webhook の実行経路が使う旧互換。新契約が正本。
    expect(`${LIST_PAGE}\n${EDITOR}`).not.toContain('friendAddRouting')
    expect(API).toContain('@deprecated 旧互換')
  })
})

describe("管理画面 友だち追加時配信の保存の取りこぼし防止", () => {
  it('保存が通るたびに冪等キーを回す', () => {
    expect(EDITOR).toContain('saveIdempotencyKey.current = crypto.randomUUID()')
  })

  it('応答の版番号を手元へ反映する', () => {
    expect(EDITOR).toContain('const savedVersion = (response.data as { version?: number }).version')
    expect(EDITOR).toContain('setRule((current) => ({ ...current, version: savedVersion }))')
  })
})

describe("管理画面 友だち追加時配信の監査修正", () => {
  it('N-107: 「その他操作」は実画面へつなぐメニューを開く', () => {
    // 押しても何も起きないボタンにしない。テスト・有効化・実行結果は実在する画面。
    // ★管理画面 `Xn1Mz`（行の「…」統一）：手書きの開閉（setOpenMenuId＋ActionMenu直置き）
    // ではなく共通 RowActions の menuItems へそろえた。行き先の守りは残す。
    expect(LIST_PAGE).toContain("<RowMenu")
    expect(LIST_PAGE).toContain("items={")
    expect(LIST_PAGE).toContain('locked({')
    expect(LIST_PAGE).toContain('step=preview')
    expect(LIST_PAGE).toContain('/friend-add-settings/publish?id=')
  })

  it('N-107: 確認段のサマリーにも行き先のないボタンを置かない', () => {
    expect(EDITOR).not.toContain('friend-add-editor-previewActions')
  })

  it('N-108: テスト確認面に固定の人名・方法を出さない', () => {
    expect(EDITOR).not.toContain('Demo Person')
  })

  it('N-109: 「二重送信」は再送防止の設定値を出し、テスト実施状態と分ける', () => {
    expect(EDITOR).toContain('resendSuppressionText(definition.resendSuppressionHours)')
  })

  it('N-110: 画面遷移は実在するクエリ付きルートだけを使う', () => {
    // 静的エクスポートではパス型の {id} ルートを持てないため、
    // 作成・編集・テストはクエリ付きの同一ページで切り替える。
    // 要件書(管理画面-09)のルート表の整合は司令塔所有領域のため別PRで実施する。
    const screens = `${LIST_PAGE}\n${EDITOR}`
    expect(LIST_PAGE).toContain('href="/friend-add-settings?view=new"')
    expect(LIST_PAGE).toContain('view=edit&id=')
    expect(LIST_PAGE).toContain('step=preview')
    expect(LIST_PAGE).toContain('/friend-add-settings/publish?id=')
    expect(LIST_PAGE).toContain('/friend-add-settings/runs?rule_id=')
    expect(screens).not.toContain('/friend-add-settings/new')
    expect(screens).not.toContain('/friend-add-settings/conflicts')
    expect(screens).not.toContain('/friend-add-settings/test')
  })
  it('初回と再追加を分け、経路不明の扱いを説明する', () => {
    expect(LIST_PAGE).toContain('はじめて友だち追加した人')
    expect(LIST_PAGE).toContain('以前からの友だち・ブロック解除した人')
    expect(LIST_PAGE).toContain('経路が分からなかった人')
    expect(LIST_PAGE).toContain('いちばん最後に動く・消せない')
  })

})
