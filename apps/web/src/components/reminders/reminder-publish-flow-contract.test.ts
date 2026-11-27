import { readUiSource } from '../../../scripts/test-ui-source.mjs'
import { readApiSource } from '../../../scripts/test-api-source.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readImplementationSource } from '../../../../worker/src/test-utils/implementation-source'

const ROOT = process.cwd()
const FLOW = readUiSource(join(ROOT, 'src/v8/reminders/edit.tsx'), 'utf8')
const NEW_PAGE = readFileSync(join(ROOT, 'src/v8/reminders/new/new.tsx'), 'utf8')
const STEP_EDITOR = readUiSource(join(ROOT, 'src/v8/reminders/edit.tsx'), 'utf8')
const EDIT_PAGE = readUiSource(join(ROOT, 'src/v8/reminders/edit.tsx'), 'utf8')
const DETAIL_PAGE = readFileSync(join(ROOT, 'src/v8/reminders/detail.tsx'), 'utf8')
const API = readApiSource(join(ROOT, 'src/lib/api.ts'), 'utf8')
const WORKER_ROUTE = readImplementationSource(join(ROOT, '../worker/src/routes/reminders.ts'))

describe('リマインダの公開フロー', () => {

  it('確認・テスト送信・公開を同じ版のAPIへ通す', () => {
    expect(API).toContain('/api/reminders/${id}/draft')
    expect(API).toContain('/api/reminders/${id}/preview')
    expect(API).toContain('/api/reminders/${id}/test-send')
    expect(API).toContain('/api/reminders/${id}/validate')
    expect(API).toContain('/api/reminders/${id}/publish')
    expect(FLOW).toContain("draft?.lastTestStatus !== 'succeeded'")
    expect(FLOW).toContain('!validation?.valid')
  })

  it('V8の配信予定は取得した予定と人数を使い、仮の日付を作らない', () => {
    expect(FLOW).toContain('api.reminders.previewDraft(reminderId)')
    expect(FLOW).toContain('preview?.items')
    expect(FLOW).toContain('preview.summary.audience')
    // 読み直し操作と処理中の制御は edit-schedule-guard.test.tsx で確認する。
  })

  it('押しても動かないボタンは描かない（出す＝使える）', () => {
    /*
     * 点検では disabled＋「準備中」も挙がったが、共通ルール §7-10 は
     * 「準備中 のボタンが1つも無い（出す＝使える）」、§5-5 は
     * 「隠すのではなく、そもそも描かない」を完了条件にしている。
     * 動くまで描かず、押せるのに何も起きない状態を作らない。
     */
    for (const label of ['条件を編集', '＋ アクションを追加する']) {
      expect(FLOW, `${label} が公開フローに描かれています`).not.toContain(`>${label}<`)
    }
    /* 「このひな形を使う」は #996 で実装済み（ひな形適用の入口）。押すと置き換え確認が出て実際に動く。 */
    for (const label of ['＋ フォルダを追加する', 'ひな形を管理']) {
      expect(NEW_PAGE, `${label} が新規作成に描かれています`).not.toContain(`>${label}<`)
    }
    /*
     * 追加・削除・並べ替えはN-066で実動作にした。描くのは問題なく、
     * 動作は reminder-step-editor.react.test.tsx が保証する。
     * まだ動かない「複製」「通知イメージを見る」は描かないままにする。
     */
    for (const label of ['この通知を複製', '通知イメージを見る', '＋ アクションを追加する']) {
      expect(STEP_EDITOR, `${label} が通知編集に描かれています`).not.toContain(`>${label}<`)
    }
  })

  it('固定の人数・日時・停止予定・架空の例値を残さない', () => {
    /*
     * N-071/N-079 で見つかった見せかけの値。APIの実値か明示的な未取得へ
     * 変えたあと、同じ固定値が戻らないよう名前で固定する。
     */
    const FIXED = [
      '71人', '82人', '2人が重複', '1,194通',
      'テスト済み 2026/09/06 18:00', '08:00〜21:00', '翌朝に繰り越す',
      'meet.google.com', '前日・1時間前・当日', '8/24（月）', '8/26 09:00',
      'Kentaさん', '>Kenta<',
    ]
    for (const literal of FIXED) {
      expect(FLOW, `${literal} が公開フローに残っています`).not.toContain(literal)
      expect(STEP_EDITOR, `${literal} が通知編集に残っています`).not.toContain(literal)
      expect(DETAIL_PAGE, `${literal} が詳細に残っています`).not.toContain(literal)
    }
  })

  it('実装の無いSlack通知を約束しない', () => {
    // Worker にリマインダからSlackへ送る経路は無い。画面だけの約束は撤去済み。
    expect(FLOW).not.toContain('Slack')
    expect(WORKER_ROUTE).not.toContain('slack')
  })

  it('押しても動かないボタンを残さない', () => {
    // 完了画面の主ボタンは詳細画面への実リンクを持つ。
    expect(FLOW).toContain('/reminders/detail?id=${encodeURIComponent(reminderId)}')
    expect(FLOW).toContain('配信予定を見る')
    // 絞り込みボタンは state を実際に切り替える。
    expect(FLOW).toContain('onChange={setRange}')
    // 「戻って修正」は編集画面への実遷移を持つ。
    expect(FLOW).not.toContain("secondary={{ label: '戻って修正' }}")
    // テスト段のフッターは固定日時ではなく下書きの記録を見る。
    expect(STEP_EDITOR).not.toContain('status="テスト済み')
    // 詳細の停止予定は固定の「—」ではなく公開版の実値を見る。
    expect(DETAIL_PAGE).not.toContain('label="停止予定" value="—"')
    expect(DETAIL_PAGE).toContain('reminderStopSummary')
    expect(WORKER_ROUTE).toContain('stopConditions: publishedSettings?.stopConditions ?? null')
  })

  it('使っていない二重実装を残さない', () => {
    expect(existsSync(join(ROOT, 'src/components/reminders/reminder-step-editor-v6.tsx'))).toBe(false)
    expect(EDIT_PAGE).not.toContain('LegacyReminderEditInner')
  })
})
