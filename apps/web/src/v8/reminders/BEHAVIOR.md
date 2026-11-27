> 文書：リマインダの作る②〜⑤・完了・詳細（V8）の動き｜区分：今の説明｜最終確認：2026-10-20（日本時間）

# リマインダの作る②〜⑤・完了・詳細（V8）の動き

入口：
- `app/reminders/edit/page.tsx`：`src/v8/reminders/edit.tsx` に固定。
- `app/reminders/detail/page.tsx`：`src/v8/reminders/detail.tsx` に固定。
- 作る①（`/reminders/new`・絵 `VE1u5`）は合格済みの [現役の入口・本体](README.md) のまま。

絵：手順1の直し・競合 `k32cn` / 対象者と止める条件 `YChR6` / 通知の中身 `p5YuP`（1152 は `r1l0bT`）/
配信予定 `T0nis` / 確認 `ltAaq` / 有効にした `hjNpJ` / 詳細の概要 `rbAig` / 登録者 `loVfW` / 一時停止の窓 `RwVo5`。

## 受け付ける URL と指定（今の画面と同じ名前・同じ意味）
- `/reminders/edit?id=<id>&stage=<段>`：`basics`＝手順1の直し、`target`＝手順2、（なし）＝手順3、
  `preview`（`schedule` も可）＝手順4、`confirm`・`test`＝手順5、`done`＝完了。`id` が無いときは入口が「指定されていません」を出す。
- `/reminders/detail?id=<id>&tab=<タブ>&runStatus=permanent_failed`：`tab` は `overview`（既定）・`schedule`・`runs`・`registrants`。
  `runStatus=permanent_failed` は実行結果タブを「失敗」で絞って開く。

## 呼ぶ口（今の画面と同じ）
- 下書き：`api.reminders.getDraft(id)` / `saveDraft(id, settings, { expectedVersionId, expectedUpdatedAt })`（409 は競合の帯）
- 公開前チェック：`validateDraft(id)`（手順2・5・完了）、配信予定：`previewDraft(id)`（手順4・5・完了）
- 対象者の数え直し・顔ぶれ：`audience(id, 条件)`、テスト送信：`useReminderTestRecipient` / `useReminderTestSend`、有効にする：`publishDraft(id)`
- 差し込みの友だち情報：`friendFields.list(accountId)`、確認のフォルダ名：`folders.list('reminder')`
- 一覧のフォルダ件数：`useManagedFolders('reminder', accountId)` で一覧と同じ店舗から読む。店舗切替時に前の件数を捨て、古い応答では上書きしない。
- 詳細：`reminders.runs(id, { limit: 5 })`・`reminders.get(id)`・配信予定 `runs(id, { status: 'planned' })`・
  一時停止／再開 `reminders.update(id, { isActive })`・複製 `getDraft`→`createDraft`・削除 `reminders.delete(id)`・
  再試行 `retryRun(runId, 冪等キー)`・CSV（100件ずつ、5,000件まで）・
  登録者 `registrants.list / updateTargetDate / cancel / resume`（版番号で競合を止める）
- 保存先（localStorage）は使わない。

## 今の画面と違うところ
- 枠は型（作る＝CreatePage、完了・詳細＝PageFrame）。手順の帯・設定内容・LINE の見え方・下の帯は型の位置。
- 競合（409）の帯は頭の下・板の幅いっぱい（絵 k32cn）。文は「ほかの人が先に…を保存しました」（保存した人の名前は API に無い）。
- 通知の時刻の単位（日・時間・分）を選べる。日 → 時間・分にすると時刻を外して分で持ち、逆は 9:00 を入れる（今の作りで保存できる2つの形の切り替え）。
- 1152 の板では、通知の中身の右の列は「LINEでの見え方を見る」（横から出す）と届く日時の例だけ。
- 詳細の一時停止は確かめの窓（RwVo5）を通す。窓に「今後24時間で送る予定の N通」を出す（配信予定から数える。取り切れないときは「以上」）。再開はそのまま。
- 詳細の「最近の実行」は送った・送れなかった物だけ（配信予定・処理中は配信予定タブ）。
- 詳細の登録者タブでは右の列のスマホを出さない（絵 loVfW）。表示件数は 10・20・50件。
- 閲覧のみの人には、一時停止・再開・編集・複製・削除・登録者の取り消す／再開する／基準日を保存を置かない（CSV の書き出しは残す）。
- 共通の LINE の見え方は題が「LINEでの見え方」に決まっているため、詳細の右の列の題は絵の「届き方」ではない（共通部品に題を渡す口が要る）。

- WEB-014（2026-10-09 オーナー決定）：一覧の並べ替えは手動順だけ。自動順にはつまみを出さない。一斉配信には手動並べ替えを置かない。

## 一覧の右の詳細パネル
- 本文は項目名と中身の段。下の帯は「詳細を見る」と「編集する」、複製・削除は左の「…」。確認と失敗時の扱いは変わらない。
- 閲覧のみは詳細への移動を使える。編集・複製・削除は隠さず灰色＋理由、本人未確認は通常のdisabled。上の非表示の記述は詳細パネルには適用しない。

- 閲覧のみの人にも作成の入口を表示し、操作できない理由を示す。
