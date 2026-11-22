> 文書：LINEアカウントの詳細・乗り換え（V8）の動き｜区分：今の説明｜最終確認：2026-10-20（日本時間）

# LINEアカウントの詳細・乗り換え（V8）の動き

入口：`app/accounts/detail/page.tsx`（V8専用で `src/v8/accounts-detail/detail.tsx`）と `app/accounts/handover/page.tsx`（V8専用で `src/v8/accounts-detail/handover.tsx`）。
動き・権限・入力保持の試験は維持する。古い V8（[現役の入口・本体](README.md)）は入口から外れた（ファイルと試験は残す）。

| 画面・窓 | ファイル | 絵 |
|---|---|---|
| 詳細 | `detail.tsx` | `ihjfd` |
| 送受信を止める・再開する | `dialogs.tsx` の `StopDialog` | `CFAyf`（再開は同じ形） |
| 資格情報を差し替える | `dialogs.tsx` の `CredentialsDialog` | `Msb1j`（LINE Login の秘密は同じ形） |
| アーカイブ | `dialogs.tsx` の `ArchiveDialog` | `WOfBN` |
| 登録の内容を編集する | `dialogs.tsx` の `EditDialog` | `n9Z2P` |
| アーカイブから戻す・テスト送信先 | `dialogs.tsx` | 絵なし（同じ窓の形） |
| 乗り換え | `handover.tsx` | `x2dSNv` |

## 受け付ける URL と指定（今と同じ）
- `/accounts/detail?id=<アカウント>`。`?id=` が無い・見つからない・読めないは今と同じ案内（一覧へ戻る・もう一度読み込む）
- `?tab=overview|connection|credentials|handover` は受け付けるが切り替えない。V8 は1枚の画面で、資格情報と Webhook も最初の画面に出ている（スクロールさせると窓の撮影の位置もずれる）。乗り換えは頭の「乗り換え」から
- `/accounts/handover?id=<アカウント>`。コードを読んだ側は今と同じく移し元の `?id=` を開き直す

## 呼ぶ口（今と同じ）
- 詳細：`api.lineAccounts.get(id)`・親の名前は `api.lineAccounts.list()`（失敗してもその欄だけ「読み込めませんでした・もう一度読み込む」）
- 止まっているとき：`api.lineAccounts.skippedDeliveries(id)`（読めないときはその段だけ断る）
- テスト送信先：`api.accountSettings.getTestRecipients(id)`。変えるのは今の部品 `TestRecipientsSetting`（窓の中）
- 止める・再開：`deactivate / activate(id, 理由)`。本人確認を求められたら `StepUpPrompt`（`line_account.credentials`）でやり直す
- アーカイブ：窓の中で本人確認（6桁・パスワード）→ `api.auth.stepUp({ purpose: 'line_account.archive' })` → `archive(id, 理由, token)`。本人確認の方法が無い人は確認なしで送る（サーバが断れば言葉を出す）。断られた理由（blockers）は今と同じ言葉
- アーカイブから戻す：`restore(id)`（本人確認を求められたら `StepUpPrompt`）
- 資格情報・登録の編集：`api.lineAccounts.update(id, 変えた欄だけ)`。秘密の欄は空なら送らない。Login の ID を消したら組の秘密も消す（今の編集窓と同じ）。本人確認を求められたら `StepUpPrompt`
- トークンの発行・更新はmusuboが行う。資格情報には自動更新と最終更新時刻を表示する。Messaging API の差し替え窓ではチャネルシークレットだけを受け付ける（2026-11-22承認、Pen `LINE-token-auto-renew-v01.pen`、`KgF2h`・`t30eU`・`Z2Y9C`・`F5ZbkA`）。
- 乗り換え：`api.accountHandovers.listForAccount / get / issue / link / preview / saveDecisions / execute / cancel / rollback`。本実行・切り戻しは `useStepUpGate`（`account_handover.execute`）

## 権限（今と同じ）
- 変える操作（編集する・差し替える・止める／再開・アーカイブ・戻す・テスト送信先を変える）はオーナーと管理者だけ。役割が分かるまでは出さない。タイムゾーンはオーナーだけが変えられる（編集の窓の名前の横）
- 閲覧のみ（それ以外）には上の操作を**置かず**、内容の上に「閲覧のみで見ています」の帯（2026-10-06 オーナー決定）。「乗り換え」は見るための入口なので残す
- 乗り換え：変える操作（コードを出す・読む・判断を選ぶ・保存・やめる・本実行・切り戻す・申告の数）はオーナーと管理者だけ（役割が分かるまでは出す。最後の守りはサーバ）。閲覧のみには帯

## 今の画面と違うところ
- 4つのタブ（概要・接続の確認・資格情報・乗り換え）をやめ、絵どおり1枚にした
- 題の下の1行：`ID・状態・既定かどうか・親`。状態は、止まっている・Webhook が合っていない・最後の確認が通っていないときに「要確認（LINE ID・接続状態を確かめてください）」、ほかは「正常」
- 「設定をほかのアカウントへ写す」は、写す口が無く押せない案内だけだったので出さない
- Webhook の「最後のテスト」「最後の受信」：最後の確認はチャネルシークレットの行に、最後の受信は Webhook の利用の行の右に小さく出す（記録があるときだけ）
- 「いまの状態をもう一度確かめる」（接続のタブへ移るだけだった）は出さない
- アーカイブの本人確認は、別の窓を重ねず、アーカイブの窓の中で済ませる（絵 `WOfBN`）
- 編集の窓：OGP の説明・画像は「説明と画像も変える」で開く。LINE Developers に貼る URL の一覧は出さない（このシステムが待っている URL は詳細の行にある）
- 乗り換え：段の札は4つ（引き継ぎコード・事前確認・要確認を決める・本実行）。事前確認が済んだら「要確認を決める」を光らせる
- 乗り換え：コードとコピーは「どこからどこへ」の右上、申告の数は「事前確認の結果」の右上から開く（絵に無い）。「事前確認をやり直す」は保存していない書き換えの帯と、申告の数の欄の横
- 乗り換え：判断を書き換えられない行（自動で同じ人・一致しない）は、選ぶ欄でなく文字で出す。未判断の人は API が行を返さないので、表に「— 選んでください —」の行は出ない

## 撮影の指定（対応表への提案）
- `Msb1j`：`click: ["資格情報", "資格情報を差し替える"]` は押す相手が無い（タブも「資格情報を差し替える」ボタンも無い）。`click: ["差し替える"]` で最初の行の窓が開く
- `x2dSNv`：絵は「1件の書き換えをまだ保存していません」の帯が出た状態。`click: ["ゆみ🐶の判断", "新しく作る"]` で同じ状態になる
