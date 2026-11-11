> 文書：運営コンソール（V8）の動き｜区分：今の説明｜最終確認：2026-10-30（日本時間）

# 運営コンソール（V8）の動き

入口：外枠は `components/ops/ops-shell.tsx`（V8専用で `src/v8/ops/shell.tsx`）。画面は各 `app/ops/**/page.tsx` が V8専用で下の画面を出す。
管理画面はV8に固定する。旧表示だけの固定試験は整理し、動きと安全を守る試験は維持する。認証・担当者の取得は今の `OpsShell` のまま（V8 の外枠は見た目だけ）。

| 画面 | ファイル | 絵 |
|---|---|---|
| 外枠（左メニュー・上の帯・白い板・板の頭・左メニュー下の記録の印） | `shell.tsx` | 運営の板すべて |
| ログイン | `login.tsx` | `D9JALJ` |
| 2要素認証を設定 | `two-factor.tsx` | `qod6X` |
| メンバーの招待を受ける | `invite.tsx` | `tVaUh` |
| ダッシュボード | `dashboard.tsx` | `CyW0E` |
| メンバー管理・停止の窓 | `members.tsx` | `FvbHW`・`VUyYu` |
| 監査ログ | `audit.tsx` | `e7ljE` |
| お知らせの一覧 | `announcements.tsx` | `tQ2MJ` |
| お知らせの作る・直す・送る前の確認 | `announcement-edit.tsx` | `TJUUl` |
| 契約先アカウント・作る窓 | `tenants.tsx` | `XWtYC`・`i0FTN` |
| 契約先の詳細・停止の窓 | `tenant-detail.tsx` | `Oub6x`・`okXoi` |
| お問い合わせ・代わりに起票 | `support.tsx` | `P0jhqO`・`Izau1`（返信の前の窓 `GgP2d`） |

## 受け付ける URL と指定（今と同じ）
- `/ops` → `/ops/tenants`（入口の転送は今のまま）
- `/ops/tenants?status=<active|trialing|past_due|suspended|archived>`：その札で絞っておく（ダッシュボードの要対応から来る）
- `/ops/tenants/detail?id=<契約先>`：詳細。id が無ければ「見る契約先が指定されていません」
- `/ops/support?id=<チケット>`：そのチケットを開く
- `/ops/announcements/new`：お知らせの作る画面。`?id=` で下書き・予約の直し、`?copy=` で送ったものの中身を写して新しく作る。送ったものを `?id=` で開いたら写しに切り替える
- `/ops/invite#invite=<招待の鍵>`：鍵は # の後ろ（サーバーのログに残さない）
- `/ops/login?error=<not_authorized|not_platform_admin|line_*|invalid_state>`：失敗の理由を出す

## 呼ぶ口（今と同じ）
- 外枠：`/api/auth/session`・`api.ops.me`（今の `OpsShell` が呼ぶ）
- ログイン：`/api/auth/password/login`（next=ops）→ `/api/auth/session` で運営メンバーか確かめる。LINE は `/api/auth/line?next=ops`
- 2要素認証：`api.staff.beginTwoFactorSetup`・`confirmTwoFactorSetup`。通ったらログインし直し
- 招待：`/api/auth/ops-invite/check`・`/api/auth/ops-invite/accept` → `/ops/two-factor`
- ダッシュボード：`api.ops.dashboard(period)`・`lineUnregistered`・`billingSync`（Stripe と同期は書ける人だけ）
- ダッシュボードの「最初の10分（新しいお店）」：`api.ops.firstRun(period)`。数と割合だけ。閲覧のみの人には段ごと出さず、代理ログイン中（403）も隠す
- メンバー：`api.ops.members`・`addMember`・`resendInvite`・`setMemberActive`。運営の情報は `NoticeLineAccountCard`
- 監査：`api.ops.audit`（50件ずつ）。CSV はいまの条件で全部（上限 2万件）
- お知らせ：`api.ops.announcements.list / preview / create（再実行キー）/ update（版つき）/ remove`
- 契約先：`api.ops.tenants`・`createTenant`・`tenant`・`changeTenantStatus`・`impersonation.start`。飲食店機能の切り替えは契約先詳細に置かない
- お問い合わせ：`api.ops.support.summary / tickets / ticket / update / saveDraft / deleteDraft / reply / create / templates / createTemplate / createTemplateFolder`

## 閲覧のみ（`/api/ops/me` の readOnly）
- `useOpsReadOnlyState` で「分からない／閲覧のみ／書ける」を分ける（`use-ops-read-only.ts`）。取れなかったときは分からないまま（理由なしの押せない形）。
- 閲覧のみの人には、隠さず押せない形＋理由で出す（2026-10-26 オーナー決定。2026-10-06 の「隠す」から変更）。理由は `OPS_READONLY_LOCK_REASON` で全画面そろえる：
  お知らせの一覧・作る画面の作る・直す・消す・送る／
  契約先を作る・停止・アーカイブ・再開／招待メールを送る・停止・取り消す・再送／
  お問い合わせの起票・返信・優先度・段階の変更・代理ログイン／申込の連絡メモ保存・承認・招待メールの再送／
  ダッシュボードの「Stripe と同期」。
  行の「…」も押せない形＋理由で出す。処理の本体でも書ける人以外は止める。
- 例外：監査ログの写しは共通部品に理由の口が無いため隠す方式のまま（共通部品の口ができたらそろえる）。
  ダッシュボードの「最初の10分」は操作が無い段のため、閲覧のみには段ごと出さないまま。
  入力欄（問い合わせの返信欄、申込の連絡メモ）は理由なしの止める形でよい。

## 今の V8（app/ops の v8 分岐）と違うところ
- 外枠：各画面の注意の帯はやめ、左メニュー下の小さな印「操作は記録されます」1つにした。
- 外枠：メンバー管理・2要素認証・ログアウトは左下の本人メニューから開く。サイドバーにメンバー管理を重ねて置かず、運営にはプロフィール編集を出さない。
- 外枠：上の帯のアカウントの札は「運営コンソール」1つだけ（切り替える先が無い）。通知のベルは数を出さない。
- ログイン：絵どおり「または」の区切り・LINE でログイン・パスワードを忘れた方は、カードの中。下に招待の案内。
- 招待：「24時間で期限切れ」は説明の文に入れた（下の注記はやめた）。
- お知らせ：一覧と作る画面に分けた（右上の［お知らせを作る］→ `/ops/announcements/new`）。今すぐ送るも予約も、必ず送る前の確認を挟む。送ったものの「直す」は中身を写して新しいお知らせを作る。下書き・予約は一覧の行の「…」からも消せる。下書きの直しはその場に残り、直して送信・予約したら一覧へ戻して行を光らせる。送り方の既定は「画面のお知らせ・メール」。
- 契約先の一覧：行末の「…」（代理ログイン・詳細）はやめ、名前から詳細へ。代理ログインは詳細の画面の上から。表は絵の列（店舗・権限者・利用 / 請求・飲食店機能）。利用の割合を返す口が無いので、利用 / 請求はプランと期限・次回の日。
- 契約先の詳細：契約先に表示・最終更新・使用量の割合・請求の金額を返す口が無いので、登録日・最終ログイン・店舗と権限者の数で埋めた。停止・アーカイブの窓は、名前と理由がそろう前でもボタンを出し、押すと足りないものを知らせる。
- お問い合わせ：絵の「保留」は段階の口に無いので出さない。優先度を変える欄は題の行の右。

- WEB219（2026-10-09 オーナー決定）：優先度だけを変更しても返信の書きかけは残す。返信時の状態は送信ボタンの横で選び、既定は現在の状態のまま。
