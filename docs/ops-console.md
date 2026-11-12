> 文書：運営コンソールの動きと設定｜区分：今の説明｜最終確認：2026-10-19（日本時間）

# 運営コンソールの動きと設定

入口は `/ops`、ログインは `/ops/login`。動きの共通契約は[要件の索引](v6-requirements/v6-requirements-master-index.md)、見た目は[見た目の決まり](v8-design-rules.md)に従います。契約先・代理ログイン・監査・メンバー・お問い合わせ・売上・お知らせを扱います。

## 運営ナレッジの廃止

運営ナレッジの画面・API・自動生成ジョブ・定期処理は廃止した。既存の `platform_knowledge_*` テーブルと保存済みデータは保持し、新しい記事・ジョブは作らない。お問い合わせの返信には、フォルダ別のテンプレートを引用して編集できる。

## 変えたもの

| 場所 | 内容 |
|---|---|
| `packages/db/migrations/405_platform_admins.sql` | `platform_admins` / `platform_audit_logs` / `impersonation_sessions` / `pii_reveal_logs` |
| `packages/db/src/platform-admins.ts` | 上記の読み書き |
| `apps/worker/src/middleware/platform-admin.ts` | 運営マスターの門番。`platform_admins` が空の間だけ「既定の統括のオーナー」を互換で通す |
| `apps/worker/src/middleware/impersonation.ts` | 代理ログイン中の統括の差し替え、閲覧のみの強制、個人情報の伏せ字、禁止操作 |
| `apps/worker/src/middleware/auth.ts` | 認証の直後に代理ログインを解決する |
| `apps/worker/src/routes/ops.ts` | `/api/ops/*` と `/api/hq/operator-history` |
| `apps/worker/src/routes/tenants.ts` | `canManageTenants()` を `platform_admins` 判定へ |
| `apps/worker/src/routes/admin-auth.ts` | LINE ログインの `?next=ops` と2要素認証、`/api/auth/session` に `platformAdmin` と `impersonation` |
| `apps/web/src/app/ops/**` | 画面 |
| `apps/web/src/components/ops/**` | 外枠・環境帯・代理ログイン帯 |
| `apps/web/src/components/app-shell.tsx` | `/ops` は運営の外枠、それ以外には代理ログイン帯 |
| `apps/web/src/lib/api/features/ops.ts` | 運営の操作履歴を読むAPIの口。契約先の画面に運営用の履歴を表示しない |

## 運営メンバーの登録

[メンバー招待](#運営メンバーの招待)から登録します。最初の本人登録の互換判定は `isPlatformAdminRow`、通常の有効判定は `getPlatformAdminByStaffId` を使います。手で表へ追加して招待・2要素認証を飛ばしません。

DBの適用は[更新手順](migration-runbook.md)、配備は[配備ゲート](DEPLOY-GATE.md)に従います。必要な移行の実適用を確認し、過去の番号を一律で再適用しません。

## 操作の確認

- 登録した LINE / メールで `/ops` に入れる。どちらのログインも、TOTP登録済みなら6桁の確認、未登録なら設定を終えるまで通常セッションを発行しない。統括のオーナーは `/api/ops/*` が 403
- 契約先を停止すると `tenants.status = 'suspended'`、`platform_audit_logs` が 1 件（`visible_to_tenant = 1`）
- 代理ログインで統括の画面が開き、赤い帯が出る。閲覧のみでは書き込み API が 403
- 理由を入れて書き込みに切り替えると書ける。記録は `platform_audit_logs` と `/api/hq/operator-history` に残る（2026-10-06 から契約先の `/hq` には表示しない）
- 代理ログイン中、`/api/friends` の氏名が `友だち#xxxx`、本文が伏せ字。理由を入れて表示すると戻る
- `/ops/audit` に上の操作が並ぶ

## 契約先の停止・保管の実効化（OPS-d-1）

- `tenants.status` が `suspended` または `archived` の契約先も、メール・LINE・2要素認証の通常手順を終えると停止中セッションを発行する。停止中セッションは `GET /api/auth/session`、`POST /api/auth/logout`、`/api/hq/support/*`、運営からのお知らせの取得と既読だけを使え、それ以外の管理 API は `TENANT_SUSPENDED` で拒否する。許可経路は `middleware/auth.ts` の一覧だけを正本にする。
- 統括画面は、通常画面を停止案内と `/hq/support` への導線に差し替える。お問い合わせは専用外枠で、メニューを「お問い合わせ」だけにし、LINE アカウント切替を出さない。
- 運営が契約先を `active` に戻すと、次のセッション確認から同じセッションのまま通常画面へ戻る。再ログインは求めない。
- 停止中も LINE の受信と友だち状態は保存するが、自動応答、シナリオ、自動化、リッチメニュー切り替え、その他の外部送信は行わない。LIFF・公開 API の読み書きも 503 で止める。
- 予約済みの配信・リマインド・チャット送信等は終端のスキップ状態へ移し、復帰後に期限切れの送信が自動で流れないようにする。新しい予約と通常操作は `active` へ戻すと再開する。
- 運営マスターの有効な代理ログインだけは停止中の契約先を閲覧できる。書き込み制限は従来の代理ログイン規則を維持する。
- DB migration、新しい環境変数、Webhook・OAuth・Cron 設定の変更はない。

## 未実装・注意

- 2 要素認証の画面を通ったあとは `/ops` へ戻る。Worker は `?next=ops` を付け、画面は query を正本、`lh_next=ops` と一時保存を後方互換として読む
- 伏せ字は `/api/friends` `/api/chats` `/api/inbox` `/api/conversations` `/api/support` `/api/nen-members` `/api/form-submissions` `/api/forms/` の応答に掛かる。ほかの経路で氏名を返す API があれば `middleware/impersonation.ts` の `PII_MASK_PREFIXES` に足す
- 代理ログインでも止める操作は `isForbiddenWhileImpersonating`（権限者の削除・LINE アカウントの削除・課金ポータル・契約状態の変更）

## 運営メンバーの招待

- 「既存の権限者のメールを入れると即登録」はやめた。メンバー管理 →「運営メンバーを招待」にメールを入れる → 招待メール（24 時間有効）
- 相手はメールのリンク（`/ops/invite#invite=…`）を開き、パスワードが無ければ名前とパスワードを設定 → そのまま `/ops/two-factor` で 2要素認証を登録 → 登録完了で運営マスターになる
- 状態は `platform_admins.activation_state`（invited → awaiting_totp → active）。active だけを運営マスターとして扱う（`getPlatformAdminByStaffId`）
- 新しいメールは運営会社（既定の統括）の権限者（role staff）として作る。別の統括の権限者はメール招待では加えられない（Kenta / Kyohei は初期の特例）
- 既存の運営メンバーも `/ops/login` から入ると2要素認証が必須。未設定ならログイン途中の設定画面へ進み、登録完了後に `/ops` へ戻る。左下メニューの「2要素認証の設定」→ `/ops/two-factor` から事前登録もできる
- 招待メールを送り直すと前のリンクは失効する。2要素認証の確認（`/api/staff/:id/two-factor/confirm`）が通った瞬間に `activatePlatformAdminIfAwaitingTotp` が active にする
- 公開の口は `/api/auth/ops-invite/check` と `/api/auth/ops-invite/accept`（トークンだけで守る。Turnstile は使わない）

## 検証配備とD1の整合性

- `Deploy Cloudflare Staging` は配備前に検証D1の `_migrations` とリポジトリ内のmigration一覧を比較する
- dry-run は未適用件数とファイル名をJob Summaryへ出すだけで、DBを書き換えない
- 通常のapplyは未適用が1件でもあれば失敗する。先に `Migrate D1` の正式経路で承認済みの変更を適用し、未適用0件にしてから再実行する。設定だけを再配備する `worker_config_replay` は、AGENTS.mdの検証環境限定の条件に従い、他者の未適用移行を勝手に適用しない。

## お問い合わせ

統括の 36-3 が書き込む `hq_support_requests` を、運営側で「チケット」として扱う。表は増やさず列を足した（migration 421）。

| 場所 | 内容 |
|---|---|
| `packages/db/migrations/421_ops_support_tickets.sql` | `ticket_no`（#MB-0001 から）・`stage`（新規／対応中／待ち／解決済み／クローズ）・`priority`・`channel`・返信の表 `hq_support_messages`・下書きの表 `hq_support_reply_drafts`・採番の `platform_counters` |
| `packages/db/src/ops-support.ts` | 一覧・数値カード・返信・下書き・契約先の状況の読み書き。`statusForStage` が統括向けの `status` を導く |
| `apps/worker/src/routes/ops-support.ts` | `/api/ops/support/*`。返信は登録メールへ送り、統括の 36-3 の履歴にも載せる |
| `apps/worker/src/routes/hq-support.ts` | 統括側の一覧に `ticketLabel`・`stage`・`replies` を足した |
| `apps/web/src/app/ops/support/page.tsx` | 画面。左が一覧、右が内容と返信。返信文にはフォルダ別テンプレートを引用できる |
| `apps/web/src/app/hq/support/page.tsx` | 「これまでの問い合わせ」に運営からの返信を出す |

決まりごと:

- `hq_support_requests.status` の CHECK（open/answered/closed）は後から変えられないので、運営の細かい進み具合は `stage` に持ち、`status` は `stage` から導く。
- 返信すると `stage` は既定で「待ち」（相手の返事待ち）。返信と同時に「解決済み」にもできる。クローズ済みには返信できない。
- 監査: 閲覧 `ticket.view`（統括には見せない）、返信 `ticket.reply`（統括に見せる）、状態変更 `ticket.stage.change`、運営の起票 `ticket.create`。
- 「契約者専用LINEにも通知します」は 37-7（お知らせ配信）の LINE の口ができてから足す。いまは `delivered_via` に `screen` / `email` だけが入る。
- 統括側の続き（36-3-A。旧 ★V6 の目印 `Nt0UH`）: `GET /api/hq/support/requests/:id`・`POST /api/hq/support/requests/:id/messages`（`apps/worker/src/routes/hq-support.ts`）と `apps/web/src/app/hq/support/detail/page.tsx`。36-3 の「これまでの問い合わせ」から開く。続きを送ると運営のチケットは待ち・解決済み・クローズから「対応中」へ戻り、運営（`SUPPORT_NOTIFY_EMAIL` か `CONTACT_EMAIL`）へ通知、送信者に控えが届く。
- 運営コンソールの画面は API の例外を `opsCall`（`apps/web/src/components/ops/ops-ui.tsx`）で受ける。`fetchApi` は 2xx 以外を例外にするため、これが無いと busy のまま画面が固まる。

## ダッシュボード

| 場所 | 内容 |
|---|---|
| `packages/db/migrations/448_billing_invoices.sql` | Stripe 請求書の非個人情報・入金額・返金額・請求期間を保存する表（追加のみ） |
| `packages/db/src/billing-invoices.ts` | 請求書の保存・入金集計・直近の支払済み請求書の読み取り |
| `packages/db/src/ops-dashboard.ts` | 契約先・Stripe の出来事・要対応・チケット・LINE 登録・使用量の読み取り |
| `apps/worker/src/routes/ops-dashboard.ts` | `GET /api/ops/dashboard?period=month|prev_month|year`、`GET /api/ops/dashboard/line-unregistered` |
| `apps/worker/src/routes/ops-billing.ts` | `POST /api/ops/billing/sync`（過去 1〜12 か月の請求書を手動同期） |
| `apps/worker/src/services/billing-invoices-sync.ts` | Stripe 請求書のページ送り同期。日次更新と手動同期で共用 |
| `apps/worker/src/services/billing-plans.ts` | プランに `monthlyMessages`・`mediaBytes` を足した（使用量の上限） |
| `apps/web/src/app/ops/dashboard/page.tsx` | 画面 |
| `apps/web/src/components/ops/ops-charts.tsx` | 棒グラフとドーナツ（SVG、色はトークンだけ） |
| `apps/web/src/app/ops/tenants/page.tsx` | `?status=past_due` などで来たときの初期絞り込み、決済失敗の札 |

決まりごと:

- **今月の売上（入金済み）**は、今月（JST）に入金された Stripe 請求書の `amount_paid - amount_refunded`。JPY 以外は保存するが集計しない。画面には返金額も併記する。
- **契約中の月額合計**は、契約中の各契約先の直近の支払済み請求書を使う。年払いは 12 で割って円未満を切り捨て、請求書が無い契約先だけ `fallbackMonthlyYen` で補う。
- 運営会社（既定の統括）、`plan_status = exempt`、保管済みの契約先は売上に含めない。Stripe 未設定または請求書が 0 件の環境では定価へ戻し、画面に「定価で数えています」と明記する。
- 初回同期は過去 12 か月、以後は Webhook と日次同期で更新する。日次同期は最後の成功時刻から 7 日戻して再取得し、契約先ごとに失敗を分離する。1 件でも失敗・時間切れがあれば同期時刻を進めない。
- 検証環境の `wrangler.staging.toml` には Cron の設定が無いため、初回取り込みと再同期は運営ダッシュボードの「Stripe と同期」から行う。書き込み権限のある運営マスターだけが実行でき、過去 12 か月を取り込んだあと画面を読み直す。
- Webhook は `invoice.paid`・`invoice.payment_failed`・`invoice.voided`・`charge.refunded` を請求書へ反映する。既存の契約状態更新とイベントの重複防止は維持する。
- 保存するのは請求書 ID、契約先 ID、Stripe 顧客・契約 ID、状態、金額、通貨、周期、期間、入金時刻、請求書 URL、同期時刻だけ。顧客名・メール・カード情報は保存・記録しない。
- 契約中＝`plan_status` が `active` か `past_due`。トライアルは月額に入れない。運営会社（既定の統括）と `archived` の契約先は数えない。
- Stripe 未設定時の月ごとの売上だけ、「その月末に契約中だった契約先」を現在の契約先と解約日から逆算した定価の概算にする。
- 解約数は同じ出来事を期間で数え、解約率は期間はじめの契約数で割る。
- 要対応: 決済失敗（`past_due`）／トライアル期限 3 日以内／LINE トークン期限 14 日以内（`line_accounts.token_expires_at`）／未返信のお問い合わせ（`stage = 'new'`）。
- 「契約者専用LINEの登録」は権限者の `notice_friend_id`（37-7 の確認コードで紐づいた友だち）の有無で数える。「未登録の N 人へ案内」は対象の一覧を出すまで。案内の一斉送信は 37-7 のお知らせ（メール）で代用できる。
- 使用量: 今月の配信通数（`messages_log` の outgoing）・バナー生成（`banner_usage_ledger`）・メディア容量（`media.size_bytes`）を、プランの上限と比べて使用率の高い順に 5 件。

## お知らせ配信と契約者専用LINE

| 場所 | 内容 |
|---|---|
| `packages/db/migrations/429_platform_announcements.sql` | `platform_settings`・`platform_announcements`・`platform_announcement_recipients`・`staff_line_link_codes`、`staff_members.notice_friend_id / notice_linked_at`（追加のみ） |
| `packages/db/src/platform-announcements.ts` | お知らせの読み書き、宛先の解決、予約の claim、既読、確認コードの発行と消費 |
| `apps/worker/src/services/platform-announcements.ts` | 配信本体（LINE push・メール・画面）、予約配信（cron）、確認コードでの紐づけ |
| `apps/worker/src/routes/ops-announcements.ts` | `GET/PUT /api/ops/notice-line-account`、`GET/POST /api/ops/announcements`、`POST /api/ops/announcements/preview`、`PUT/DELETE /api/ops/announcements/:id` |
| `apps/worker/src/routes/hq-notices.ts` | `GET /api/hq/notices`、`POST /api/hq/notices/:id/read`、`GET /api/hq/notices/line-registration` |
| `apps/worker/src/routes/webhook.ts` | 契約者専用LINEに届いた 6 桁のテキストを確認コードとして先に処理する（`handleNoticeLinkCode`） |
| `apps/worker/src/index.ts` | cron `platform announcements`（予約の時刻を過ぎたものを 1 件ずつ送る） |
| `apps/web/src/app/ops/announcements/page.tsx` | 運営の画面（宛先・件名・本文・送り方・公開日時、一覧に LINE送達／画面で既読） |
| `apps/web/src/components/ops/notice-line-account-card.tsx` | メンバー管理「運営の情報」で契約者専用LINEのアカウントを指定する |
| `apps/web/src/components/hq/platform-notices.tsx` | 統括コンソール上部の「運営からのお知らせ」（「読みました」で消える） |
| `apps/web/src/components/hq/notice-line-register-dialog.tsx` | 契約者専用LINEの登録案内（QR・確認コード・友だち追加リンク） |

決まりごと:

- **契約者専用LINEは「musubo契約者様 通知専用」（@540qlkhn）の公式アカウント**。運営会社（既定の統括）の設定画面から通知先として接続・指定する（`platform_settings.notice_line_account_id`）。未指定の間は LINE の送り方が使えない（API は 409）。
- **登録の必須化はしない**。統括が LINE アカウント登録の手順 5 を終えた直後に案内の窓を一度だけ出す。ログインは止めない。案内は `/hq/support` の帯からもいつでも開ける。
- **紐づけは 6 桁の確認コード**（24 時間有効、同じ人は再表示で同じコードを返す）。統括が契約者専用LINEを友だち追加してコードをトークで送ると、`staff_members.notice_friend_id` に友だちが入る。コードは契約者専用LINEに届いたときだけ処理し、他のアカウントでは通常のメッセージとして扱う。
- 通知専用として接続した公式アカウントは、確認コードと友だち追加・ブロック状態を受信する。通常のメッセージには管理画面の「お問い合わせ」への案内だけを自動返信し、内容を店舗向け受信箱・自動応答・シナリオへ流さない。確認コードには案内ではなく紐づけ結果を返す。問い合わせは各アカウントの管理画面の「お問い合わせ」から受け付ける。LINE側で表示名を変えた場合、運営設定と登録案内はLINEの現在の表示名を優先する。
- この公式アカウントは検証・本番で共用するため、あいさつ文と通常メッセージへの自動返信には本番管理画面 `https://admin.musubo.jp` を案内する。検証Workerで受けた場合も検証用URLへ切り替えない。
- 通知専用LINEの LINE Official Account Manager では Webhook をオンのまま、応答メッセージをオフにする。既定の一律応答をオンにしたままだと、Worker の案内や確認コードの結果に別の返信が重なる。設定変更前には現在の応答設定を記録し、Worker と一緒に切り戻す。
- 送り方は LINE（登録済みの権限者へ push）・画面（統括コンソール上部に出て「読みました」で消える）・メール（登録メールアドレス）。**LINE は送達（push が通ったか）まで**。Messaging API に既読はないので「LINE送達」と表示する。
- 宛先は 全契約先／プラン（ライト・スタンダード・プロ・トライアル）／契約先を選ぶ。運営会社と `archived` の契約先は常に外す。
- 送り方は 下書き／今すぐ送る／配信を予約する（日本時間）。送信済みは直せず消せない。予約は cron が `publish_at` を過ぎたものを `sending` に claim してから送るので二重送信しない。
- 本文に共通情報（`{{var.x}}`）は展開しない（契約先の権限者宛ての固定文）。
- 監査: `announcement.create / update / delete / send`、`notice_line_account.change` を `platform_audit_logs` に残す。

検証環境で確かめること:

1. `/accounts/new` で「musubo 運営（契約者専用）」を運営会社のアカウントとして登録する（Masato）。
2. `/ops/members` の「運営の情報」でそのアカウントを指定する。
3. 統括の権限者として `/hq/support` の帯から登録案内を開き、QR で友だち追加 → 6 桁をトークで送る → 「紐づきました」の返事。
4. `/ops/announcements` で LINE＋画面＋メールを選んで「今すぐ送る」→ LINE に届く、`/hq` の上部に出る、登録メールに届く。
5. 公開日時を入れて「配信を予約する」→ 5 分以内に送られ、一覧の状態が「送信済み」になる。
