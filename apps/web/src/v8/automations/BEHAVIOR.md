> 文書：オートメーション（V8）の動き（BEHAVIOR.md）｜区分：今の説明｜最終確認：2026-10-20（日本時間）

# オートメーション（V8）の動き（BEHAVIOR.md）

対象：src/v8/automations の画面。今までの V8（[現役の入口・本体](README.md)・`runs-v8.tsx`・
共通アクションの一覧・版の既存API）から動きを写し、
見た目だけを型（ListPage・DetailPage）で絵どおりに組み直した。一覧と見本の入口はV8へ固定し、旧一覧の本体を除去した。確認/取得/権限/失敗の契約は現役の一覧を検査する。

| 画面 | ファイル | 絵 | 入口 |
|---|---|---|---|
| ルール | `list.tsx` | 一覧 `LWQXd`・1152 `En14p`・閲覧のみ `nH9L8`・状態 `S3pdQ` | `app/automations/page.tsx`（`?tab=templates` 以外） |
| 動いた記録 | `runs.tsx` | `g98F9` | `app/automations/runs/page.tsx` |
| 共通アクション | `common-actions.tsx` | `LnGNw` | `app/common-actions/page.tsx` |
| 版と使われている場所 | `versions.tsx` | `ziSgL` | `app/common-actions/versions/page.tsx` |
| 見本 | `templates.tsx` | `c7dxp` | `app/automations/page.tsx`（`?tab=templates`） |
| 共通（頭・タブ・数の帯・閲覧のみの帯・権限） | `shell.tsx` | 上のすべて | — |

ルールを作る（`/automations/new`・`M4torY`・`tJqST`）は `create/create.tsx`。見本（`c7dxp`）は 2026-10-07 にここへ一から書いた（今までの V8 は [現役の入口・本体](README.md)）。

## 受け付ける URL と指定（今と同じ）
- `/automations`（ルール）、`/automations?tab=templates`（見本）。
- `/automations?search=<言葉>`：その言葉で探した状態から始める（動いた記録の「ルールを開く」から来る。新しく足した）。
- `/automations/runs?search=<言葉>&status=<executed|skipped|problems>&run=<記録ID>`：今と同じ（検索は URL に書き戻す・`run` は中身を開く）。
- `/common-actions`、`/common-actions/versions?id=<共通アクションID>`：今と同じ。
- タブの行き先は今の V8 と同じ（共通アクション＝`/common-actions`・動いた記録＝`/automations/runs`）。

## 呼ぶ口（今と同じ）
- ルール：`api.automations.list`（数の帯の今月動いた・失敗は `summary`）、条件に外れたは `/api/automation-runs?limit=1` の `summary.skipped`。
  編集＝`createDraftFromAutomation`→`/automations/drafts?id=`、複製＝`duplicate`、止める・動かす・保管＝`setStatus`（確認の窓）、1人で試す＝`test`（窓で友だちIDを入れる）。
- タブの件数：ルール＝一覧の件数、共通アクション＝`api.commonActions.list` の件数、見本＝`api.automations.templates` の件数。読めないときは数を出さない。
- 動いた記録：`/api/automation-runs`（`limit`・`offset`・`search`・`status`・`include_test`）、中身＝`getRun`、もう一度やる＝`POST /retry`、取りやめ＝`cancelRun`、CSV＝`runsCsvUrl`＋`downloadApiFile`。
- 共通アクション：`api.commonActions.list`（`status`・`query`・`limit`・`offset`、数の帯は `summary`）、複製＝`duplicate`→編集、保管・戻す＝`archive`/`unarchive`、CSV＝`csvUrl`。
- 版と使われている場所：`api.commonActions.get`、月次の件数は一覧の口、公開＝`publish`、新しい版＝`createDraft`、利用先の版を上げる＝`updateBinding`（確認の窓・変わった点つき）。
- フォルダの箱：ルール＝`api.folders.list('automation')`、共通アクション＝`api.folders.list('common_action')`。追加は共通の `FolderAddDialog`。

## 権限
- 役割はサーバ（`/api/staff/me`）から読む。owner/admin は変えられる。staff は権限キー `/automations` があるときだけ（サーバの `requireAutomationPermission` と同じ）。
- 閲覧のみ（変えられない人）には、作る・編集・複製・1人で試す・止める・削除・フォルダを追加・保管を**置かずに隠す**（場所だけ空ける。2026-10-06 オーナー決定）。行の「…」は「動いた記録を見る」（共通アクションは「版と使われている場所を見る」）だけ。タブの下・数の帯の上に「閲覧のみで見ています」の帯。
- もう一度やる・取りやめ（`automation.run.retry`）、CSV（`automation.run.export`）は今と同じ権限キーで出し分ける。
- 役割が読めるまでは今までどおり操作を出す（最後の守りはサーバの 403）。

## 今の V8 と違うところ
- ルール・共通アクションのフォルダ：箱は出すが、**ルール・共通アクションをフォルダへ入れる口がまだ無い**（表に folder_id が無い）ので、全件が未分類。箱を選ぶと0件。箱の件数は口が返さないので出さない。
- ルールの並び：既定は更新が新しい順（絵の並び）。広い一覧は「並び順」から動いた回数順・名前順へ変更でき、絞り込みは保つ。狭い一覧は「よく使う絞り込み」から並びも変えられる。失敗があったルール・この30日に動いていないルールもそこから絞れる。
- ルールの「きっかけ」：言葉で動くもの（メッセージ＋言葉）は「「〇〇」と送られた」、ほかは正本の名前。「この30日」の2行目は動いているものは失敗の回数、止めているものは最後に変えた日。
- 数の帯の「先月より」は先月の集計の口が無いので出さない（今月動いた＝この30日の回数）。
- 動いた記録：結果の札は「動いた・失敗・条件に外れた」の3つ（すべては数の帯）。テスト実行を含めるのは「よく使う絞り込み」から。中身は右の詳細パネル。行の「…」に ルールを開く・トークを開く を足した。
- 共通アクション：状態の絞り込みは札（公開中・下書き・古い版あり・呼ばれていない・保管）。「中の処理」は処理の数（一覧の口に処理の並びが無い）。
- 版と使われている場所：下書きがある間は「この版から新しい版」を押せない形で出す（サーバが draft_exists で断るため。理由は title）。

## 共通アクションを作る（common-action-new.tsx・絵 j2hfkS）
今の V8（共通アクションの作成の既存API）と同じ口と動き：`api.commonActions.resources`（選択肢。失敗は帯と「もう一度読み込む」）、
`api.commonActions.create`（名前・説明・処理・要求キー）→ `/common-actions/versions?id=`。閲覧のみ（権限なし）は作らせない。
- 入口：`app/common-actions/new/page.tsx`（`/common-actions/new`）
- 見せ方：処理は「番号・何を・どれを」の1行で並べ、押すとその処理の設定（今の部品 CommonActionEditor／分岐は BranchEditors の写し）を開く。↑↓と削除は閉じた行の右端から使える。設定を開かなくても並べ替え・削除でき、保存する順番に反映する。
- 足す：処理を足す・待ち時間を入れる・条件で分ける・見本から受け渡す（公開版を呼ぶ処理を足す）。足した行は閉じたまま
- 「失敗したとき」の段：全部の処理の「失敗したとき」をまとめて決める。違うものがあれば「処理ごとに違う」と出す
- 写したもの：`branch-editor.tsx`・`action-order.ts`（app/common-actions から。src/v8 は @/app を読めない）
- 入力の誤り：名前は欄を赤くし、その下に理由を1回だけ出して欄へ移る。処理が空の場合は「処理を足す」のそばへ理由を出してそのボタンへ移る。上の帯は通信・保存の失敗だけ。

## 見本（`templates.tsx`・`c7dxp`）
- 呼ぶ口（今と同じ）：見本＝`api.automations.templates`、数の帯＝`api.automations.list`（ルールの数・`summary`）と `/api/automation-runs?limit=1` の `summary.skipped`。
- 「この見本で下書きを作る」＝`api.automations.createDraftFromTemplate`（同じ操作のやり直しだけ同じ鍵）→ `/automations/drafts?id=<下書き>`。失敗は赤い帯「下書きを作れませんでした…」、下書きは作らない。
- 読めないときは「見本を表示できませんでした」と再読み込み。0件の絞り込みは「条件に合う見本はありません」。
- 閲覧のみ：「この見本で下書きを作る」と右上の「見本から作る」を置かない（カードの高さは同じ）。閲覧のみの帯は出す。

### 今の V8 と違うところ
- きっかけの言い方は口の「〇〇とき」から「とき」を落として出す（絵：「友だちになった」）。
- きっかけの札は、かっこの補足を外した同じきっかけを1つにまとめ（「注文が確定した（初回）」→「注文が確定した」）、**先に出てきた順に6つまで**（絵は「すべて」＋6つ）。7つ目以降のきっかけの見本は「すべて」から見る。
- 数の帯はルールの一覧と同じ4つ（今月動いた＝この30日に動いた回数。「先月より」は口が無いので出さない）。

## B-173 保管から戻す
- `?archived=1` の保管の札で保管したルールだけを見る（一覧APIに `includeArchived=1`）。
- 行の「…」→「保管から戻す」→確認の窓→`POST /api/automations/:id/restore`。公開版ありは停止中、公開前は下書きへ。同じID・版・実行記録を残し、稼働は再開しない。閲覧のみでは戻す操作を隠す。

- 共通アクションの空一覧でも、閲覧のみには作成操作を表示し、押せない理由を示す。
