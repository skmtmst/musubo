> 文書：V8の板とコードの対応｜区分：今の説明（自動生成）｜最終確認：2026-10-25（日本時間）

# V8 の絵（Pencil の板）と画面のコードの対応表

- 作り直し：`node scripts/visual-qa/build-v8-board-to-code.mjs`（手で直さない）。URL は `scripts/visual-qa/v8-design-map.json` と同じもの（実URL・タブ指定）。入口・画面のファイルは、その URL の入口（`page.tsx`、`?` の後ろは外して探す）が読む `@/v8/…` または `*-v8` のファイル。共通の見出し（`readonly-header-v8`）は画面のファイルに数えない。
- 画面本体は `apps/web/src/v8/<機能>/` に置き、`app/**/page.tsx` は入口だけにする。現在のimportから本体を探し、見た目の一致率で置き場を選ばない（`apps/web/src/v8/README.md`）。1つの入口が複数の画面を読むとき（タブごと）は全部並べる。
- この表はURLとコードの対応を調べる案内。板の合否・対象数の正本は `docs/v8-requirements/v8-switch.md` と正式台帳を参照し、この表の行数を合格の分母にしない。
- 画面の中の見た目は型・部品で決まるので、まず `docs/v8-where-to-change.md` を読む。
- 数：src/v8 を読む板 427・app の V8 ファイルだけを読む板 0・入口から画面本体を自動特定できない板（要確認） 18・URL なし 60。

| 文書 | 板ID | 板の名前 | 画面のURL | 入口 | V8 の画面ファイル |
|---|---|---|---|---|---|
| V8 | d8X09 | 1. ダッシュボード | / | `app/page.tsx` | `v8/style-dashboard/home.tsx` |
| V8 | mcOqK | ★P5 ダッシュボード /（編集・隠れているカード）2026-10-01 | / | `app/page.tsx` | `v8/style-dashboard/home.tsx` |
| V8 | WQmep | ダッシュボード V8｜状態は型の見本 LS のとおり | / | `app/page.tsx` | `v8/style-dashboard/home.tsx` |
| V8-B | V7vn3 | 設定 LINEアカウント V8｜状態は型の見本 LS のとおり | /accounts | `app/accounts/page.tsx` | `v8/settings/accounts/accounts.tsx` |
| V8-B | CFAyf | LINEアカウント 送受信を止める V8｜状態は型の見本 CS のとおり | /accounts/detail?id=visual-qa-account | `app/accounts/detail/page.tsx` | `v8/accounts-detail/detail.tsx` |
| V8-B | ihjfd | LINEアカウント 詳細 V8｜状態は型の見本 LS のとおり | /accounts/detail?id=visual-qa-account | `app/accounts/detail/page.tsx` | `v8/accounts-detail/detail.tsx` |
| V8-B | n9Z2P | LINEアカウント 登録の内容を編集する V8｜状態は型の見本 CS のとおり | /accounts/detail?id=visual-qa-account | `app/accounts/detail/page.tsx` | `v8/accounts-detail/detail.tsx` |
| V8-B | WOfBN | LINEアカウント アーカイブ V8｜状態は型の見本 LS のとおり | /accounts/detail?id=visual-qa-account-old | `app/accounts/detail/page.tsx` | `v8/accounts-detail/detail.tsx` |
| V8-B | Msb1j | LINEアカウント 資格情報を差し替える V8｜状態は型の見本 LS のとおり | /accounts/detail?id=visual-qa-account&tab=credentials | `app/accounts/detail/page.tsx` | `v8/accounts-detail/detail.tsx` |
| V8-B | x2dSNv | LINEアカウント 乗り換え V8｜状態は型の見本 LS のとおり | /accounts/handover?id=visual-qa-account | `app/accounts/handover/page.tsx` | `v8/accounts-detail/handover.tsx` |
| V8-B | GwKE2 | 統括 LINEアカウントを登録 ③基本情報 V8｜状態は型の見本 LS のとおり | /accounts/new | `app/accounts/new/page.tsx` | `v8/account-new/register.tsx` |
| V8-B | JYfda | 統括 LINEアカウントを登録 ②チャネル設定 V8｜状態は型の見本 LS のとおり | /accounts/new | `app/accounts/new/page.tsx` | `v8/account-new/register.tsx` |
| V8-B | TvXII | 統括 LINEアカウントを登録 ⑤完了 V8｜状態は型の見本 LS のとおり | /accounts/new | `app/accounts/new/page.tsx` | `v8/account-new/register.tsx` |
| V8-B | v2KMj | 統括 LINEアカウントを登録 ④接続確認 V8｜状態は型の見本 LS のとおり | /accounts/new | `app/accounts/new/page.tsx` | `v8/account-new/register.tsx` |
| V8-B | xj3zz | 統括 LINEアカウントを登録 ①LINE準備 V8｜状態は型の見本 LS のとおり | /accounts/new | `app/accounts/new/page.tsx` | `v8/account-new/register.tsx` |
| V8-B | Td4TN | 成果とアフィリエイト 案件を作る V8（機能追加 F-23・API待ち）｜状態は型の見本 CS のとおり | /affiliate-offers/new | `app/affiliate-offers/new/page.tsx` | `v8/affiliate-offer-new/create.tsx` |
| V8-B | aINnz | 成果とアフィリエイト 支払い V8｜状態は型の見本 LS のとおり | /affiliates | `app/affiliates/page.tsx` | `v8/affiliates/affiliates.tsx` |
| V8-B | CVz5d | 成果とアフィリエイト 銀行用 CSV（本人確認）V8｜状態は型の見本 LS のとおり | /affiliates | `app/affiliates/page.tsx` | `v8/affiliates/affiliates.tsx` |
| V8-B | Eo56k | 成果とアフィリエイト レポート V8｜状態は型の見本 LS のとおり | /affiliates | `app/affiliates/page.tsx` | `v8/affiliates/affiliates.tsx` |
| V8-B | h7dmB | 成果とアフィリエイト 案件 V8｜状態は型の見本 LS のとおり | /affiliates | `app/affiliates/page.tsx` | `v8/affiliates/affiliates.tsx` |
| V8-B | hadfk | 成果とアフィリエイト 成果をまとめて操作（操作を選ぶ）V8｜状態は型の見本 LS のとおり | /affiliates | `app/affiliates/page.tsx` | `v8/affiliates/affiliates.tsx` |
| V8-B | KdFRI | 成果とアフィリエイト アフィリエイター 1152 V8｜状態は型の見本 LS のとおり | /affiliates | `app/affiliates/page.tsx` | `v8/affiliates/affiliates.tsx` |
| V8-B | nJlxX | 成果とアフィリエイト アフィリエイター V8｜状態は型の見本 LS のとおり | /affiliates | `app/affiliates/page.tsx` | `v8/affiliates/affiliates.tsx` |
| V8-B | OylSV | 成果とアフィリエイト 成果承認 V8｜状態は型の見本 LS のとおり | /affiliates | `app/affiliates/page.tsx` | `v8/affiliates/affiliates.tsx` |
| V8-B | rRk0C | ★V8-B 成果とアフィリエイト 状態｜状態は型の見本 LS のとおり | /affiliates | `app/affiliates/page.tsx` | `v8/affiliates/affiliates.tsx` |
| V8-B | usDpO | 成果とアフィリエイト 期間を締める（確かめ）V8｜状態は型の見本 LS のとおり | /affiliates | `app/affiliates/page.tsx` | `v8/affiliates/affiliates.tsx` |
| V8-B | v9JWQ | 成果とアフィリエイト アフィリエイター（閲覧のみ）V8｜状態は型の見本 LS のとおり | /affiliates | `app/affiliates/page.tsx` | `v8/affiliates/affiliates.tsx` |
| V8-B | tnTn9 | 成果とアフィリエイト アフィリエイターの詳細（引き出し）V8｜状態は型の見本 LS のとおり | /affiliates?affiliate=af-1 | `app/affiliates/page.tsx` | `v8/affiliates/affiliates.tsx` |
| V8-B | Gqve5 | 成果とアフィリエイト アフィリエイターを作る（競合）V8｜状態は型の見本 CS のとおり | /affiliates/new | `app/affiliates/new/page.tsx` | `v8/affiliates/create.tsx` |
| V8-B | RaMf3 | 成果とアフィリエイト アフィリエイターを作る V8｜状態は型の見本 CS のとおり | /affiliates/new | `app/affiliates/new/page.tsx` | `v8/affiliates/create.tsx` |
| V8-B | bglah | 分析 保存した分析 V8｜状態は型の見本 LS のとおり | /analytics | `app/analytics/page.tsx` | `v8/analytics/analytics.tsx`<br>`v8/analytics/funnel-form.tsx` |
| V8-B | DkRDE | 分析 ファネル V8｜状態は型の見本 LS のとおり | /analytics | `app/analytics/page.tsx` | `v8/analytics/analytics.tsx`<br>`v8/analytics/funnel-form.tsx` |
| V8-B | eEhYU | 分析 友だちの増減 1152 V8｜状態は型の見本 LS のとおり | /analytics | `app/analytics/page.tsx` | `v8/analytics/analytics.tsx`<br>`v8/analytics/funnel-form.tsx` |
| V8-B | iK4cQ | 分析 URLクリック V8｜状態は型の見本 LS のとおり | /analytics | `app/analytics/page.tsx` | `v8/analytics/analytics.tsx`<br>`v8/analytics/funnel-form.tsx` |
| V8-B | L4Uov | 分析 友だちの増減（閲覧のみ）V8｜状態は型の見本 LS のとおり | /analytics | `app/analytics/page.tsx` | `v8/analytics/analytics.tsx`<br>`v8/analytics/funnel-form.tsx` |
| V8-B | N8ZrUl | 分析 使われ方 V8｜状態は型の見本 LS のとおり | /analytics | `app/analytics/page.tsx` | `v8/analytics/analytics.tsx`<br>`v8/analytics/funnel-form.tsx` |
| V8-B | PFe9c | 分析 経路と成果 V8｜状態は型の見本 LS のとおり | /analytics | `app/analytics/page.tsx` | `v8/analytics/analytics.tsx`<br>`v8/analytics/funnel-form.tsx` |
| V8-B | u5CuB8 | 分析 クロス分析 V8｜状態は型の見本 LS のとおり | /analytics | `app/analytics/page.tsx` | `v8/analytics/analytics.tsx`<br>`v8/analytics/funnel-form.tsx` |
| V8-B | ws9wt | 分析 友だちの増減 V8｜状態は型の見本 LS のとおり | /analytics | `app/analytics/page.tsx` | `v8/analytics/analytics.tsx`<br>`v8/analytics/funnel-form.tsx` |
| V8-B | yvOtn | 分析 配信の反応 V8｜状態は型の見本 LS のとおり | /analytics | `app/analytics/page.tsx` | `v8/analytics/analytics.tsx`<br>`v8/analytics/funnel-form.tsx` |
| V8-B | AzrZq | 分析 成果地点ごとのレポート V8｜状態は型の見本 LS のとおり | /analytics?view=conversion-report | `app/analytics/page.tsx` | `v8/analytics/analytics.tsx`<br>`v8/analytics/funnel-form.tsx` |
| V8-B | G83vi | 分析 レポートを作る（競合）V8｜状態は型の見本 CS のとおり | /analytics/reports/new | `app/analytics/reports/new/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8-B | H5UoIu | 分析 レポートを作る V8｜状態は型の見本 CS のとおり | /analytics/reports/new | `app/analytics/reports/new/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | G4GejG | 自動応答 かんたんに作る（小窓 560）V8（機能追加 F-7・API待ち）｜状態は型の見本 CS のとおり | /auto-replies | `app/auto-replies/page.tsx` | `v8/auto-replies/list.tsx`<br>`v8/ai-reply/answer-log.tsx`<br>`v8/ai-reply/qa-list.tsx` |
| V8 | G8i4xP | ★V8 自動応答 一覧の状態｜状態は型の見本 CS のとおり | /auto-replies | `app/auto-replies/page.tsx` | `v8/auto-replies/list.tsx`<br>`v8/ai-reply/answer-log.tsx`<br>`v8/ai-reply/qa-list.tsx` |
| V8 | i8F12 | 自動応答 止めるダイアログ V8｜状態は型の見本 CS のとおり | /auto-replies | `app/auto-replies/page.tsx` | `v8/auto-replies/list.tsx`<br>`v8/ai-reply/answer-log.tsx`<br>`v8/ai-reply/qa-list.tsx` |
| V8 | IIesG | 自動応答 行の「…」を開いた V8｜状態は型の見本 CS のとおり | /auto-replies | `app/auto-replies/page.tsx` | `v8/auto-replies/list.tsx`<br>`v8/ai-reply/answer-log.tsx`<br>`v8/ai-reply/qa-list.tsx` |
| V8 | Q5lOCc | 自動応答 一覧（閲覧のみ）V8｜状態は型の見本 CS のとおり | /auto-replies | `app/auto-replies/page.tsx` | `v8/auto-replies/list.tsx`<br>`v8/ai-reply/answer-log.tsx`<br>`v8/ai-reply/qa-list.tsx` |
| V8 | u8sKN | 自動応答 削除ダイアログ V8｜状態は型の見本 CS のとおり | /auto-replies | `app/auto-replies/page.tsx` | `v8/auto-replies/list.tsx`<br>`v8/ai-reply/answer-log.tsx`<br>`v8/ai-reply/qa-list.tsx` |
| V8 | uE9gf | 自動応答 一覧 V8｜状態は型の見本 CS のとおり | /auto-replies | `app/auto-replies/page.tsx` | `v8/auto-replies/list.tsx`<br>`v8/ai-reply/answer-log.tsx`<br>`v8/ai-reply/qa-list.tsx` |
| V8 | WPrd5 | 自動応答 一覧（1152）V8｜状態は型の見本 CS のとおり | /auto-replies | `app/auto-replies/page.tsx` | `v8/auto-replies/list.tsx`<br>`v8/ai-reply/answer-log.tsx`<br>`v8/ai-reply/qa-list.tsx` |
| V8 | A0pDt | 自動応答 作る② どんなときに動くか V8｜状態は型の見本 CS のとおり | /auto-replies/edit | `app/auto-replies/edit/page.tsx` | `v8/auto-replies/edit/wizard.tsx` |
| V8 | Guoye | 自動応答 作る④ 優先順位 V8｜状態は型の見本 CS のとおり | /auto-replies/edit | `app/auto-replies/edit/page.tsx` | `v8/auto-replies/edit/wizard.tsx` |
| V8 | K7HWG | 自動応答 作る① 基本設定 V8｜状態は型の見本 CS のとおり | /auto-replies/edit | `app/auto-replies/edit/page.tsx` | `v8/auto-replies/edit/wizard.tsx` |
| V8 | rfhIf | 自動応答 作る③ 何を返すか V8｜状態は型の見本 CS のとおり | /auto-replies/edit | `app/auto-replies/edit/page.tsx` | `v8/auto-replies/edit/wizard.tsx` |
| V8 | UGrd2 | 自動応答 編集（競合）V8｜状態は型の見本 CS のとおり | /auto-replies/edit | `app/auto-replies/edit/page.tsx` | `v8/auto-replies/edit/wizard.tsx` |
| V8 | V4LjH | 自動応答 作る 完了（有効にした） V8｜状態は型の見本 CS のとおり | /auto-replies/edit | `app/auto-replies/edit/page.tsx` | `v8/auto-replies/edit/wizard.tsx` |
| V8 | XJUqs | 自動応答 作る⑤ 確認 V8｜状態は型の見本 CS のとおり | /auto-replies/edit | `app/auto-replies/edit/page.tsx` | `v8/auto-replies/edit/wizard.tsx` |
| V8 | Z2LIUx | 自動応答 作る②（1152）V8｜状態は型の見本 CS のとおり | /auto-replies/edit | `app/auto-replies/edit/page.tsx` | `v8/auto-replies/edit/wizard.tsx` |
| V8 | nWmLg | 自動応答 実行結果 V8｜状態は型の見本 LS のとおり | /auto-replies/runs | `app/auto-replies/runs/page.tsx` | `v8/auto-replies/runs.tsx` |
| V8-B | c7dxp | オートメーション 見本 V8（機能追加 F-16・API待ち）｜状態は型の見本 LS のとおり | /automations | `app/automations/page.tsx` | `v8/automations/list.tsx`<br>`v8/automations/templates.tsx` |
| V8-B | En14p | オートメーション 一覧 1152 V8｜状態は型の見本 LS のとおり | /automations | `app/automations/page.tsx` | `v8/automations/list.tsx`<br>`v8/automations/templates.tsx` |
| V8-B | J1VA8 | オートメーション 下書きを仕上げる V8（機能追加 F-15・API待ち）｜状態は型の見本 LS のとおり | /automations | `app/automations/page.tsx` | `v8/automations/list.tsx`<br>`v8/automations/templates.tsx` |
| V8-B | LWQXd | オートメーション 一覧 V8（機能追加 F-14・API待ち）｜状態は型の見本 LS のとおり | /automations | `app/automations/page.tsx` | `v8/automations/list.tsx`<br>`v8/automations/templates.tsx` |
| V8-B | nH9L8 | オートメーション 一覧（閲覧のみ）V8｜状態は型の見本 LS のとおり | /automations | `app/automations/page.tsx` | `v8/automations/list.tsx`<br>`v8/automations/templates.tsx` |
| V8-B | S3pdQ | オートメーション 状態 V8｜状態は型の見本 LS のとおり | /automations | `app/automations/page.tsx` | `v8/automations/list.tsx`<br>`v8/automations/templates.tsx` |
| V8-B | M4torY | オートメーション ルールを作る V8｜状態は型の見本 CS のとおり | /automations/new | `app/automations/new/page.tsx` | `v8/automations/create/create.tsx` |
| V8-B | tJqST | オートメーション ルールを作る（競合）V8｜状態は型の見本 CS のとおり | /automations/new | `app/automations/new/page.tsx` | `v8/automations/create/create.tsx` |
| V8-B | g98F9 | オートメーション 動いた記録 V8｜状態は型の見本 LS のとおり | /automations/runs | `app/automations/runs/page.tsx` | `v8/automations/runs.tsx` |
| V8 | acRIl | ★P2 予約 /booking/bookings（今日・今週・今月・一覧）2026-10-01 | /booking/bookings | `app/booking/bookings/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8-B | AjZhH | 予約台帳 予約の詳細 V8 | /booking/bookings | `app/booking/bookings/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | If9Mh | ★P2-2 予約：電話の予約・予約の詳細 2026-10-01 | /booking/bookings/new | `app/booking/bookings/new/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | C9fv7A | 予約設定 メニュー（閲覧のみ）V8｜状態は型の見本 LS のとおり | /booking/menus | `app/booking/menus/page.tsx` | `v8/booking-menus/settings.tsx` |
| V8 | owaS3 | 予約設定 メニュー V8｜状態は型の見本 LS のとおり | /booking/menus | `app/booking/menus/page.tsx` | `v8/booking-menus/settings.tsx` |
| V8 | P6EdLW | 予約設定 メニュー（1152）V8｜状態は型の見本 LS のとおり | /booking/menus | `app/booking/menus/page.tsx` | `v8/booking-menus/settings.tsx` |
| V8 | xCoDe | ★V8 予約設定 状態｜状態は型の見本 LS のとおり | /booking/menus | `app/booking/menus/page.tsx` | `v8/booking-menus/settings.tsx` |
| V8-B | ZyDd6 | 予約設定 予約経路の連携（人）V8｜状態は型の見本 LS のとおり | /booking/menus?tab=channels | `app/booking/menus/page.tsx` | `v8/booking-menus/settings.tsx` |
| V8 | KRgTQ | 予約設定 休業日 V8｜状態は型の見本 LS のとおり | /booking/menus?tab=holidays | `app/booking/menus/page.tsx` | `v8/booking-menus/settings.tsx` |
| V8 | VFxWU | 予約設定 受付枠（1152）V8｜状態は型の見本 LS のとおり | /booking/menus?tab=hours | `app/booking/menus/page.tsx` | `v8/booking-menus/settings.tsx` |
| V8 | yRPxl | 予約設定 受付枠 V8｜状態は型の見本 LS のとおり | /booking/menus?tab=hours | `app/booking/menus/page.tsx` | `v8/booking-menus/settings.tsx` |
| V8 | x1OZS6 | 予約設定 予約のルール V8｜状態は型の見本 LS のとおり | /booking/menus?tab=rules | `app/booking/menus/page.tsx` | `v8/booking-menus/settings.tsx` |
| V8 | VLEaj | 予約設定 担当スタッフ V8｜状態は型の見本 LS のとおり | /booking/menus?tab=staff | `app/booking/menus/page.tsx` | `v8/booking-menus/settings.tsx` |
| V8 | QqER7 | 予約設定 メニューを作る V8｜状態は型の見本 CS のとおり | /booking/menus/new | `app/booking/menus/new/page.tsx` | `v8/booking-menus/menu-form.tsx` |
| V8 | v5L19Z | 予約設定 メニュー編集（競合）V8｜状態は型の見本 CS のとおり | /booking/menus/new | `app/booking/menus/new/page.tsx` | `v8/booking-menus/menu-form.tsx` |
| V8 | ooufy | 予約設定 担当メニューをまとめて決める V8｜状態は型の見本 LS のとおり | /booking/menus/staff | `app/booking/menus/staff/page.tsx` | `v8/booking-menus/assign.tsx` |
| V8 | CcA4k | 予約設定 予約スタッフを登録 V8｜状態は型の見本 CS のとおり | /booking/staff/new | `app/booking/staff/new/page.tsx` | `v8/booking-staff/staff-new.tsx` |
| V8 | d5fmnM | 予約設定 勤務とシフト（管理者）V8｜状態は型の見本 LS のとおり | /booking/staff/shifts | `app/booking/staff/shifts/page.tsx` | `v8/booking-staff/shifts.tsx` |
| V8 | E3YDK | 自分の勤務（スタッフ本人）V8｜状態は型の見本 LS のとおり | /booking/staff/shifts | `app/booking/staff/shifts/page.tsx` | `v8/booking-staff/shifts.tsx` |
| V8 | wvGke | 自分の勤務（ひも付けなし）V8｜状態は型の見本 LS のとおり | /booking/staff/shifts | `app/booking/staff/shifts/page.tsx` | `v8/booking-staff/shifts.tsx` |
| V8 | A8jzaQ | ★V8 一斉配信 一覧の状態｜状態は型の見本 CS のとおり | /broadcasts | `app/broadcasts/page.tsx` | `v8/broadcasts/list.tsx` |
| V8 | bIdqV | 欄 一覧の状態｜状態は型の見本 CS のとおり | /broadcasts | `app/broadcasts/page.tsx` | `v8/broadcasts/list.tsx` |
| V8 | EML2F | 欄 一覧 | /broadcasts | `app/broadcasts/page.tsx` | `v8/broadcasts/list.tsx` |
| V8 | jjFNi | 一斉配信 一覧 V8（1152）｜状態は型の見本 CS のとおり | /broadcasts | `app/broadcasts/page.tsx` | `v8/broadcasts/list.tsx` |
| V8 | l5V9a | 一斉配信 一覧 V8｜状態は型の見本 CS のとおり | /broadcasts | `app/broadcasts/page.tsx` | `v8/broadcasts/list.tsx` |
| V8 | NtCE3 | 一斉配信 一覧（閲覧のみ）V8｜状態は型の見本 CS のとおり | /broadcasts | `app/broadcasts/page.tsx` | `v8/broadcasts/list.tsx` |
| V8 | P6vbxn | 一斉配信 かんたんに送る（小窓 640）V8｜状態は型の見本 CS のとおり | /broadcasts | `app/broadcasts/page.tsx` | `v8/broadcasts/list.tsx` |
| V8 | rfdmA | 欄 一覧（1152） | /broadcasts | `app/broadcasts/page.tsx` | `v8/broadcasts/list.tsx` |
| V8 | Xr6eu | 一斉配信・自動応答 作るボタンの分け方 V8｜状態は型の見本 CS のとおり | /broadcasts | `app/broadcasts/page.tsx` | `v8/broadcasts/list.tsx` |
| V8 | cgiGB | 一斉配信 詳細（下書き） V8｜状態は型の見本 LS のとおり | /broadcasts/detail | `app/broadcasts/detail/page.tsx` | `v8/broadcast-detail/detail.tsx` |
| V8 | dK1aE | 欄 詳細（下書き）｜状態は型の見本 LS のとおり | /broadcasts/detail | `app/broadcasts/detail/page.tsx` | `v8/broadcast-detail/detail.tsx` |
| V8 | F3X1Mo | 一斉配信 詳細（送った後） V8｜状態は型の見本 LS のとおり | /broadcasts/detail | `app/broadcasts/detail/page.tsx` | `v8/broadcast-detail/detail.tsx` |
| V8 | pNiUk | 一斉配信 詳細（承認待ち） V8｜状態は型の見本 LS のとおり | /broadcasts/detail | `app/broadcasts/detail/page.tsx` | `v8/broadcast-detail/detail.tsx` |
| V8 | Q28Gb | 一斉配信 詳細（競合）V8｜状態は型の見本 LS のとおり | /broadcasts/detail | `app/broadcasts/detail/page.tsx` | `v8/broadcast-detail/detail.tsx` |
| V8 | tPm3e | 欄 詳細（送った後）｜状態は型の見本 LS のとおり | /broadcasts/detail | `app/broadcasts/detail/page.tsx` | `v8/broadcast-detail/detail.tsx` |
| V8 | wfHIE | 欄 詳細（承認待ち）｜状態は型の見本 LS のとおり | /broadcasts/detail | `app/broadcasts/detail/page.tsx` | `v8/broadcast-detail/detail.tsx` |
| V8 | FU2aU | ★P3 一斉配信の作成 /broadcasts/new（5つの手順）2026-10-01 | /broadcasts/new | `app/broadcasts/new/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | BeNtj | 一斉配信 予約を取り消す（確かめ）V8｜状態は型の見本 LS のとおり | /broadcasts/reserved | `app/broadcasts/reserved/page.tsx` | `v8/broadcast-detail/reserved.tsx` |
| V8 | cdZBf | 一斉配信 予約した後 V8｜状態は型の見本 LS のとおり | /broadcasts/reserved | `app/broadcasts/reserved/page.tsx` | `v8/broadcast-detail/reserved.tsx` |
| V8 | CRtK8 | 欄 予約した後｜状態は型の見本 LS のとおり | /broadcasts/reserved | `app/broadcasts/reserved/page.tsx` | `v8/broadcast-detail/reserved.tsx` |
| V8 | M0393 | ★P4 受信箱 /chats 2026-10-01 | /chats | `app/chats/page.tsx` | `v8/inbox-chat/screen.tsx` |
| V8-B | LnGNw | オートメーション 共通アクション V8｜状態は型の見本 LS のとおり | /common-actions | `app/common-actions/page.tsx` | `v8/automations/common-actions.tsx` |
| V8-B | j2hfkS | オートメーション 共通アクションを作る V8｜状態は型の見本 CS のとおり | /common-actions/new | `app/common-actions/new/page.tsx` | `v8/automations/common-action-new.tsx` |
| V8-B | ziSgL | オートメーション 共通アクション 版と使われている場所 V8｜状態は型の見本 LS のとおり | /common-actions/versions | `app/common-actions/versions/page.tsx` | `v8/automations/versions.tsx` |
| V8-B | O7hUt7 | 登録メディア一覧 V8｜状態は型の見本 LS のとおり | /contents | `app/contents/page.tsx` | `v8/contents/list.tsx` |
| V8 | FM94M | 共通情報 一覧 V8｜状態は型の見本 LS のとおり | /contents/vars | `app/contents/vars/page.tsx` | `v8/common-vars/list.tsx` |
| V8 | Hhl9M | 共通情報 止めるダイアログ V8｜状態は型の見本 LS のとおり | /contents/vars | `app/contents/vars/page.tsx` | `v8/common-vars/list.tsx` |
| V8 | OxSw8 | 共通情報 一覧（閲覧のみ）V8｜状態は型の見本 LS のとおり | /contents/vars | `app/contents/vars/page.tsx` | `v8/common-vars/list.tsx` |
| V8 | RqO7O | ★V8 共通情報 状態｜状態は型の見本 LS のとおり | /contents/vars | `app/contents/vars/page.tsx` | `v8/common-vars/list.tsx` |
| V8 | XIzkJ | 共通情報 一覧（1152）V8｜状態は型の見本 LS のとおり | /contents/vars | `app/contents/vars/page.tsx` | `v8/common-vars/list.tsx` |
| V8 | xxKtW | 共通情報 削除ダイアログ V8｜状態は型の見本 LS のとおり | /contents/vars | `app/contents/vars/page.tsx` | `v8/common-vars/list.tsx` |
| V8 | AYc6O | 共通情報 編集（変える前に影響を見る） V8｜状態は型の見本 CS のとおり | /contents/vars/edit | `app/contents/vars/edit/page.tsx` | `v8/common-vars-edit/edit.tsx` |
| V8 | C67dE | 共通情報 編集（1152）V8｜状態は型の見本 CS のとおり | /contents/vars/edit | `app/contents/vars/edit/page.tsx` | `v8/common-vars-edit/edit.tsx` |
| V8 | piWhz | 共通情報 編集（競合）V8｜状態は型の見本 CS のとおり | /contents/vars/edit | `app/contents/vars/edit/page.tsx` | `v8/common-vars-edit/edit.tsx` |
| V8 | p82v9 | 共通情報 作る V8｜状態は型の見本 CS のとおり | /contents/vars/new | `app/contents/vars/new/page.tsx` | `v8/common-vars-edit/new.tsx` |
| V8-B | BygrU | コンバージョン 一覧 1152 V8｜状態は型の見本 LS のとおり | /conversions | `app/conversions/page.tsx` | `v8/conversions/list.tsx` |
| V8-B | E2l8cw | ★V8-B コンバージョン 一覧の状態｜状態は型の見本 LS のとおり | /conversions | `app/conversions/page.tsx` | `v8/conversions/list.tsx` |
| V8-B | r6dJFy | コンバージョン 一覧 V8｜状態は型の見本 LS のとおり | /conversions | `app/conversions/page.tsx` | `v8/conversions/list.tsx` |
| V8-B | WSGvo | コンバージョン 一覧（閲覧のみ）V8｜状態は型の見本 LS のとおり | /conversions | `app/conversions/page.tsx` | `v8/conversions/list.tsx` |
| V8-B | cXqlS | コンバージョン 作る（競合）V8｜状態は型の見本 CS のとおり | /conversions/new | `app/conversions/new/page.tsx` | `v8/conversions/create.tsx` |
| V8-B | j8p3yj | コンバージョン 作る V8｜状態は型の見本 CS のとおり | /conversions/new | `app/conversions/new/page.tsx` | `v8/conversions/create.tsx` |
| V8-B | GmVR5 | 設定 EC連携 V8｜状態は型の見本 LS のとおり | /ec-commerce | `app/ec-commerce/page.tsx` | `v8/settings/ec-commerce/screen.tsx` |
| V8-B | nAesv | EC連携 注文の状況（引き出し）V8｜状態は型の見本 LS のとおり | /ec-commerce | `app/ec-commerce/page.tsx` | `v8/settings/ec-commerce/screen.tsx` |
| V8-B | iLJmw | EC連携 つなぎ先 V8｜状態は型の見本 LS のとおり | /ec-commerce?tab=connector | `app/ec-commerce/page.tsx` | `v8/settings/ec-commerce/screen.tsx` |
| V8-B | wqC8x | EC連携 定期便 V8｜状態は型の見本 LS のとおり | /ec-commerce?tab=subscriptions | `app/ec-commerce/page.tsx` | `v8/settings/ec-commerce/screen.tsx` |
| V8-B | w1W8h | EC連携 会員のつき合わせ V8｜状態は型の見本 LS のとおり | /ec-commerce/identity-candidates | `app/ec-commerce/identity-candidates/page.tsx` | `v8/settings/ec-commerce/identity.tsx` |
| V8-B | OHwbU | 運用状態 緊急コントロール V8｜状態は型の見本 LS のとおり | /emergency?tab=control | `app/emergency/page.tsx` | `v8/settings/emergency/screen.tsx` |
| V8-B | Y4LkX1 | 設定 運用状態 V8｜状態は型の見本 LS のとおり | /emergency?tab=health | `app/emergency/page.tsx` | `v8/settings/emergency/screen.tsx` |
| V8-B | I2V65v | 運用状態 更新履歴 V8｜状態は型の見本 LS のとおり | /emergency?tab=history | `app/emergency/page.tsx` | `v8/settings/emergency/screen.tsx` |
| V8-B | e2ekFu | イベント予約 一覧 V8｜状態は型の見本 LS のとおり | /events | `app/events/page.tsx` | `v8/events/list.tsx` |
| V8-B | Mu8qW | イベント予約 申込者 V8｜状態は型の見本 LS のとおり | /events/bookings?id=ev-1 | `app/events/bookings/page.tsx` | `v8/events/bookings.tsx` |
| V8-B | hmr2P | イベント予約 変更の確認 V8｜状態は型の見本 LS のとおり | /events/change-review?id=ev-1 | `app/events/change-review/page.tsx` | `v8/events/change-review.tsx` |
| V8-B | qUdNh | イベント予約 変更内容を確認 V8｜状態は型の見本 LS のとおり | /events/change-review?id=ev-1 | `app/events/change-review/page.tsx` | `v8/events/change-review.tsx` |
| V8-B | d4adD4 | イベント予約 イベントを作る V8｜状態は型の見本 CS のとおり | /events/new | `app/events/new/page.tsx` | `v8/events/create.tsx` |
| V8 | GrnO4 | 回答フォーム 一覧（1152）V8｜状態は型の見本 LS のとおり | /form-submissions | `app/form-submissions/page.tsx` | `v8/forms/list.tsx` |
| V8 | GVizd | 回答フォーム アーカイブ・削除 V8｜状態は型の見本 LS のとおり | /form-submissions | `app/form-submissions/page.tsx` | `v8/forms/list.tsx` |
| V8 | i2ZAS | ★V8 回答フォーム 状態｜状態は型の見本 LS のとおり | /form-submissions | `app/form-submissions/page.tsx` | `v8/forms/list.tsx` |
| V8 | I3L41O | 回答フォーム 一覧 V8｜状態は型の見本 LS のとおり | /form-submissions | `app/form-submissions/page.tsx` | `v8/forms/list.tsx` |
| V8 | JV2oR | 回答フォーム 一覧（閲覧のみ）V8｜状態は型の見本 LS のとおり | /form-submissions | `app/form-submissions/page.tsx` | `v8/forms/list.tsx` |
| V8 | ijxur | 回答フォーム 編集（予約を入れるブロック） V8｜状態は型の見本 CS のとおり | /form-submissions/edit | `app/form-submissions/edit/page.tsx` | `v8/form-edit/edit.tsx` |
| V8 | ITBAB | 回答フォーム 編集（1152）V8｜状態は型の見本 CS のとおり | /form-submissions/edit | `app/form-submissions/edit/page.tsx` | `v8/form-edit/edit.tsx` |
| V8 | J1pdB | 回答フォーム 編集（競合）V8｜状態は型の見本 CS のとおり | /form-submissions/edit | `app/form-submissions/edit/page.tsx` | `v8/form-edit/edit.tsx` |
| V8 | m1cWEy | 回答フォーム 編集（中身） V8（機能追加 F-11・API待ち）｜状態は型の見本 CS のとおり | /form-submissions/edit | `app/form-submissions/edit/page.tsx` | `v8/form-edit/edit.tsx` |
| V8 | tpRRT | 回答フォーム 編集（受付と見た目） V8｜状態は型の見本 CS のとおり | /form-submissions/edit | `app/form-submissions/edit/page.tsx` | `v8/form-edit/edit.tsx` |
| V8 | WOPjZ | 回答フォーム 5段階・住所のブロック（機能追加 F-11・API待ち）｜状態は型の見本 CS のとおり | /form-submissions/edit | `app/form-submissions/edit/page.tsx` | `v8/form-edit/edit.tsx` |
| V8 | XXFT4 | 回答フォーム 編集（答え終わったあと） V8｜状態は型の見本 CS のとおり | /form-submissions/edit | `app/form-submissions/edit/page.tsx` | `v8/form-edit/edit.tsx` |
| V8 | Z9wXm | 回答フォーム この版を公開（確かめ） V8｜状態は型の見本 CS のとおり | /form-submissions/edit | `app/form-submissions/edit/page.tsx` | `v8/form-edit/edit.tsx` |
| V8 | MKQyJ | 回答フォーム 集まった回答（1件ずつ） V8｜状態は型の見本 LS のとおり | /form-submissions/responses | `app/form-submissions/responses/page.tsx` | `v8/form-responses/responses.tsx` |
| V8 | v0SbYR | 回答フォーム 集まった回答（まとめて見る） V8｜状態は型の見本 LS のとおり | /form-submissions/responses | `app/form-submissions/responses/page.tsx` | `v8/form-responses/responses.tsx` |
| V8 | al47K | 友だち追加時の配信 作る③ 初回案内 V8｜状態は型の見本 CS のとおり | /friend-add-settings | `app/friend-add-settings/page.tsx` | `v8/friend-add/list.tsx`<br>`v8/friend-add/editor.tsx` |
| V8 | C0lfUP | 友だち追加時の配信 受け皿の「…」を開いた V8｜状態は型の見本 CS のとおり | /friend-add-settings | `app/friend-add-settings/page.tsx` | `v8/friend-add/list.tsx`<br>`v8/friend-add/editor.tsx` |
| V8 | cFo2p | 友だち追加時の配信 受け皿は止められない（案内） V8｜状態は型の見本 CS のとおり | /friend-add-settings | `app/friend-add-settings/page.tsx` | `v8/friend-add/list.tsx`<br>`v8/friend-add/editor.tsx` |
| V8 | h5rm8t | 友だち追加時の配信 編集（競合）V8｜状態は型の見本 CS のとおり | /friend-add-settings | `app/friend-add-settings/page.tsx` | `v8/friend-add/list.tsx`<br>`v8/friend-add/editor.tsx` |
| V8 | h8uNW | 友だち追加時の配信 作る② 流入リンク V8｜状態は型の見本 CS のとおり | /friend-add-settings | `app/friend-add-settings/page.tsx` | `v8/friend-add/list.tsx`<br>`v8/friend-add/editor.tsx` |
| V8 | i1nThZ | 友だち追加時の配信 作る④ あわせて行うこと V8（機能追加 F-9・API待ち）｜状態は型の見本 CS のとおり | /friend-add-settings | `app/friend-add-settings/page.tsx` | `v8/friend-add/list.tsx`<br>`v8/friend-add/editor.tsx` |
| V8 | kFz4b | ★V8 友だち追加時の配信 状態｜状態は型の見本 CS のとおり | /friend-add-settings | `app/friend-add-settings/page.tsx` | `v8/friend-add/list.tsx`<br>`v8/friend-add/editor.tsx` |
| V8 | LEwkJ | 友だち追加時の配信 一覧（閲覧のみ）V8｜状態は型の見本 CS のとおり | /friend-add-settings | `app/friend-add-settings/page.tsx` | `v8/friend-add/list.tsx`<br>`v8/friend-add/editor.tsx` |
| V8 | MRhef | 友だち追加時の配信 一覧（はじめての人） V8（機能追加 F-8・API待ち）｜状態は型の見本 CS のとおり | /friend-add-settings | `app/friend-add-settings/page.tsx` | `v8/friend-add/list.tsx`<br>`v8/friend-add/editor.tsx` |
| V8 | P20kYU | 友だち追加時 一覧（1152）V8｜状態は型の見本 CS のとおり | /friend-add-settings | `app/friend-add-settings/page.tsx` | `v8/friend-add/list.tsx`<br>`v8/friend-add/editor.tsx` |
| V8 | sFwWf | 友だち追加時の配信 テストで自分に送る（機能追加 F-12・API待ち）｜状態は型の見本 CS のとおり | /friend-add-settings | `app/friend-add-settings/page.tsx` | `v8/friend-add/list.tsx`<br>`v8/friend-add/editor.tsx` |
| V8 | wDzkc | 友だち追加時の配信 作る① 基本設定 V8｜状態は型の見本 CS のとおり | /friend-add-settings | `app/friend-add-settings/page.tsx` | `v8/friend-add/list.tsx`<br>`v8/friend-add/editor.tsx` |
| V8 | xHpkS | 友だち追加時 作る②（1152）V8｜状態は型の見本 CS のとおり | /friend-add-settings | `app/friend-add-settings/page.tsx` | `v8/friend-add/list.tsx`<br>`v8/friend-add/editor.tsx` |
| V8 | e0FD1J | 友だち追加時の配信 作る 完了（有効にした） V8｜状態は型の見本 CS のとおり | /friend-add-settings/publish | `app/friend-add-settings/publish/page.tsx` | `v8/friend-add-publish/publish.tsx` |
| V8 | U8Xm3X | 友だち追加時の配信 作る⑤ 確認 V8｜状態は型の見本 CS のとおり | /friend-add-settings/publish | `app/friend-add-settings/publish/page.tsx` | `v8/friend-add-publish/publish.tsx` |
| V8 | REIxB | 友だち追加時の配信 実行結果 V8｜状態は型の見本 LS のとおり | /friend-add-settings/runs | `app/friend-add-settings/runs/page.tsx` | `v8/friend-add-runs/runs.tsx` |
| V8 | N43uVX | 友だち追加時の配信 実行の詳細（失敗あり） V8｜状態は型の見本 LS のとおり | /friend-add-settings/runs/detail | `app/friend-add-settings/runs/detail/page.tsx` | `v8/friend-add-runs/detail.tsx` |
| V8 | ADjK8 | 友だち 統合ユーザー V8｜状態は型の見本 LS のとおり | /friends | `app/friends/page.tsx` | `v8/friends/host.tsx` |
| V8 | CYJ0L | ★P1-2 友だち一覧から開くもの 2026-10-01（機能追加 F-1・API待ち） | /friends | `app/friends/page.tsx` | `v8/friends/host.tsx` |
| V8 | MyJP7 | 友だち「…」から予約して送る（小窓）V8｜状態は型の見本 LS のとおり | /friends | `app/friends/page.tsx` | `v8/friends/host.tsx` |
| V8 | SXCb3 | ★V8 友だちの残り 状態｜状態は型の見本 LS のとおり | /friends | `app/friends/page.tsx` | `v8/friends/host.tsx` |
| V8 | x6QsVz | 友だち一覧 V8（閲覧のみ）｜状態は型の見本 LS のとおり | /friends | `app/friends/page.tsx` | `v8/friends/host.tsx` |
| V8 | ywJ5H | ★P1 友だち一覧 /friends（個別設計・承認待ち）2026-10-01 | /friends | `app/friends/page.tsx` | `v8/friends/host.tsx` |
| V8 | Hn9eE | 友だち 統合ユーザーの詳細 V8｜状態は型の見本 LS のとおり | /friends/detail | `app/friends/detail/page.tsx` | `v8/friend-detail/detail.tsx` |
| V8 | JCDRm | 概要｜状態は型の見本 LS のとおり | /friends/detail | `app/friends/detail/page.tsx` | `v8/friend-detail/detail.tsx` |
| V8 | Q5F2QE | ★P1-4 友だち詳細 /friends/detail 2026-10-01 | /friends/detail | `app/friends/detail/page.tsx` | `v8/friend-detail/detail.tsx` |
| V8 | fcg2D | 友だち 重複候補を比べて決める V8｜状態は型の見本 LS のとおり | /friends/identity-candidates | `app/friends/identity-candidates/page.tsx` | `v8/friends/compare/compare.tsx` |
| V8 | G9C4Uw | 友だち 重複検出（1152）V8｜状態は型の見本 LS のとおり | /friends/identity-candidates | `app/friends/identity-candidates/page.tsx` | `v8/friends/compare/compare.tsx` |
| V8 | hn6Y8 | 友だち 重複検出 V8（機能追加 F-2・API待ち）｜状態は型の見本 LS のとおり | /friends/identity-candidates | `app/friends/identity-candidates/page.tsx` | `v8/friends/compare/compare.tsx` |
| V8 | p15At | 友だち 比べて決める（1152）V8｜状態は型の見本 LS のとおり | /friends/identity-candidates | `app/friends/identity-candidates/page.tsx` | `v8/friends/compare/compare.tsx` |
| V8 | L48eY | 友だち UID移行（本移行と照合・完了） V8｜状態は型の見本 LS のとおり | /friends/migrations | `app/friends/migrations/page.tsx` | `v8/friends/migrations/page.tsx` |
| V8 | T9gblG | 友だち CSVで書き出す・取り込む V8｜状態は型の見本 LS のとおり | /friends/migrations | `app/friends/migrations/page.tsx` | `v8/friends/migrations/page.tsx` |
| V8 | Z0jHp | 友だち UID移行（要確認の判断） V8（機能追加 F-3・API待ち）｜状態は型の見本 LS のとおり | /friends/migrations | `app/friends/migrations/page.tsx` | `v8/friends/migrations/page.tsx` |
| V8 | BOj1a | ★P6 ログイン・はじめの設定 2026-10-01 | /getting-started | `app/getting-started/page.tsx` | `v8/settings/getting-started/getting-started.tsx` |
| V8-B | xuJ7D | 設定 はじめの設定 V8｜状態は型の見本 LS のとおり | /getting-started | `app/getting-started/page.tsx` | `v8/settings/getting-started/getting-started.tsx` |
| V8-B | HMpVx | 統括 アカウント（アカウントの設定）V8｜状態は型の見本 LS のとおり | /hq | `app/hq/page.tsx` | `v8/hq/home.tsx` |
| V8-B | JKjsE | 統括 アカウント（ホーム）V8｜状態は型の見本 LS のとおり | /hq | `app/hq/page.tsx` | `v8/hq/home.tsx` |
| V8-B | VtJQ6 | 運営 代理ログイン中（閲覧のみ）V8｜状態は型の見本 LS のとおり | /hq | `app/hq/page.tsx` | `v8/hq/home.tsx` |
| V8-B | B9ZAr | 統括 バナー生成（プロジェクト一覧）V8｜状態は型の見本 LS のとおり | /hq/banners | `app/hq/banners/page.tsx` | `v8/hq-banners/list.tsx` |
| V8-B | W7Z57 | 統括 バナー生成（プロジェクトを作る）V8｜状態は型の見本 CS のとおり | /hq/banners | `app/hq/banners/page.tsx` | `v8/hq-banners/list.tsx` |
| V8-B | AnwtH | 統括 バナー生成（画像を取り込む）V8｜状態は型の見本 LS のとおり | /hq/banners?tab=library | `app/hq/banners/page.tsx` | `v8/hq-banners/list.tsx` |
| V8-B | W5Wxr | 統括 バナー生成（画像ライブラリ）V8｜状態は型の見本 LS のとおり | /hq/banners?tab=library | `app/hq/banners/page.tsx` | `v8/hq-banners/list.tsx` |
| V8-B | B24oNg | 統括 バナー生成（一覧から外す・確認）V8｜状態は型の見本 LS のとおり | /hq/banners/project?id=banner-project-qa-1 | `app/hq/banners/project/page.tsx` | `v8/hq-banners/project.tsx` |
| V8-B | I0w2e | 統括 バナー生成（アーカイブ・確認）V8｜状態は型の見本 LS のとおり | /hq/banners/project?id=banner-project-qa-1 | `app/hq/banners/project/page.tsx` | `v8/hq-banners/project.tsx` |
| V8-B | iMnph | 統括 バナー生成（プロジェクトの中）V8｜状態は型の見本 LS のとおり | /hq/banners/project?id=banner-project-qa-1 | `app/hq/banners/project/page.tsx` | `v8/hq-banners/project.tsx` |
| V8-B | p03ImY | 統括 バナー生成（生成中）V8｜状態は型の見本 LS のとおり | /hq/banners/project?id=banner-project-qa-1 | `app/hq/banners/project/page.tsx` | `v8/hq-banners/project.tsx` |
| V8-B | rI5uh | 統括 バナー生成（画像の詳細）V8｜状態は型の見本 LS のとおり | /hq/banners/project?id=banner-project-qa-1 | `app/hq/banners/project/page.tsx` | `v8/hq-banners/project.tsx` |
| V8-B | UcBQ5 | 統括 バナー生成（参照画像を選ぶ）V8｜状態は型の見本 LS のとおり | /hq/banners/project?id=banner-project-qa-1 | `app/hq/banners/project/page.tsx` | `v8/hq-banners/project.tsx` |
| V8-B | zOpMG | 統括 バナー生成（上限に達した）V8｜状態は型の見本 LS のとおり | /hq/banners/project?id=banner-project-qa-1 | `app/hq/banners/project/page.tsx` | `v8/hq-banners/project.tsx` |
| V8-B | JB8V1 | 統括 請求 V8｜状態は型の見本 LS のとおり | /hq/billing | `app/hq/billing/page.tsx` | `v8/hq/billing.tsx` |
| V8-B | BHEl9 | 統括 メンバー（権限を変更する）V8｜状態は型の見本 LS のとおり | /hq/members | `app/hq/members/page.tsx` | `v8/hq/members.tsx` |
| V8-B | M4jS9 | 統括 メンバー 権限を変える（確認）V8｜状態は型の見本 LS のとおり | /hq/members | `app/hq/members/page.tsx` | `v8/hq/members.tsx` |
| V8-B | r4ARpV | 統括 メンバー V8｜状態は型の見本 LS のとおり | /hq/members | `app/hq/members/page.tsx` | `v8/hq/members.tsx` |
| V8-B | yLKwV | 統括 メンバー（権限者を招待）V8｜状態は型の見本 LS のとおり | /hq/members | `app/hq/members/page.tsx` | `v8/hq/members.tsx` |
| V8-B | K7HYu | 統括 統括の情報 V8｜状態は型の見本 LS のとおり | /hq/settings | `app/hq/settings/page.tsx` | `v8/hq/settings.tsx` |
| V8-B | b8xBtZ | 統括 お問い合わせ V8｜状態は型の見本 LS のとおり | /hq/support | `app/hq/support/page.tsx` | `v8/hq/support.tsx` |
| V8-B | D6fh3 | 統括 お問い合わせ（運営のLINEを登録）V8｜状態は型の見本 LS のとおり | /hq/support | `app/hq/support/page.tsx` | `v8/hq/support.tsx` |
| V8-B | OhguS | 統括 お問い合わせ（やり取り）V8｜状態は型の見本 LS のとおり | /hq/support/detail | `app/hq/support/detail/page.tsx` | `v8/hq/support-detail.tsx` |
| V8-B | LRc93 | 統括 テンプレート（ひな形の一覧）V8｜状態は型の見本 LS のとおり | /hq/templates | `app/hq/templates/page.tsx` | `v8/hq-templates/console.tsx`<br>`v8/hq-deliveries/console.tsx` |
| V8-B | meBRB | 統括 テンプレート（アカウントへ配る）V8｜状態は型の見本 LS のとおり | /hq/templates | `app/hq/templates/page.tsx` | `v8/hq-templates/console.tsx`<br>`v8/hq-deliveries/console.tsx` |
| V8-B | X4JcOf | 統括 テンプレート（ひな形を作る）V8｜状態は型の見本 CS のとおり | /hq/templates | `app/hq/templates/page.tsx` | `v8/hq-templates/console.tsx`<br>`v8/hq-deliveries/console.tsx` |
| V8-B | EMUl9 | 流入と計測 一覧（閲覧のみ）V8｜状態は型の見本 LS のとおり | /inflow-links | `app/inflow-links/page.tsx` | `v8/inflow-links/ad-connections.tsx`<br>`v8/inflow-links/ad-history.tsx`<br>`v8/inflow-links/site-script.tsx`<br>`v8/inflow-links/ads.tsx`<br>`v8/inflow-links/list.tsx` |
| V8-B | FDBsG | 流入と計測 広告とのつなぎ V8（機能追加 F-21・API待ち）｜状態は型の見本 LS のとおり | /inflow-links | `app/inflow-links/page.tsx` | `v8/inflow-links/ad-connections.tsx`<br>`v8/inflow-links/ad-history.tsx`<br>`v8/inflow-links/site-script.tsx`<br>`v8/inflow-links/ads.tsx`<br>`v8/inflow-links/list.tsx` |
| V8-B | GtI4Y | 流入と計測 QR コードの小窓 V8｜状態は型の見本 LS のとおり | /inflow-links | `app/inflow-links/page.tsx` | `v8/inflow-links/ad-connections.tsx`<br>`v8/inflow-links/ad-history.tsx`<br>`v8/inflow-links/site-script.tsx`<br>`v8/inflow-links/ads.tsx`<br>`v8/inflow-links/list.tsx` |
| V8-B | p0kA3 | 流入と計測 広告への送信履歴 V8（機能追加 F-22・API待ち）｜状態は型の見本 LS のとおり | /inflow-links | `app/inflow-links/page.tsx` | `v8/inflow-links/ad-connections.tsx`<br>`v8/inflow-links/ad-history.tsx`<br>`v8/inflow-links/site-script.tsx`<br>`v8/inflow-links/ads.tsx`<br>`v8/inflow-links/list.tsx` |
| V8-B | Q5le3 | 流入と計測 詳細（新）V8｜状態は型の見本 LS のとおり | /inflow-links | `app/inflow-links/page.tsx` | `v8/inflow-links/ad-connections.tsx`<br>`v8/inflow-links/ad-history.tsx`<br>`v8/inflow-links/site-script.tsx`<br>`v8/inflow-links/ads.tsx`<br>`v8/inflow-links/list.tsx` |
| V8-B | qSTVR | 流入と計測 広告連携 V8｜状態は型の見本 LS のとおり | /inflow-links | `app/inflow-links/page.tsx` | `v8/inflow-links/ad-connections.tsx`<br>`v8/inflow-links/ad-history.tsx`<br>`v8/inflow-links/site-script.tsx`<br>`v8/inflow-links/ads.tsx`<br>`v8/inflow-links/list.tsx` |
| V8-B | URzvC | ★V8-B 流入と計測 一覧の状態｜状態は型の見本 LS のとおり | /inflow-links | `app/inflow-links/page.tsx` | `v8/inflow-links/ad-connections.tsx`<br>`v8/inflow-links/ad-history.tsx`<br>`v8/inflow-links/site-script.tsx`<br>`v8/inflow-links/ads.tsx`<br>`v8/inflow-links/list.tsx` |
| V8-B | xbHxg | 流入と計測 一覧 V8｜状態は型の見本 LS のとおり | /inflow-links | `app/inflow-links/page.tsx` | `v8/inflow-links/ad-connections.tsx`<br>`v8/inflow-links/ad-history.tsx`<br>`v8/inflow-links/site-script.tsx`<br>`v8/inflow-links/ads.tsx`<br>`v8/inflow-links/list.tsx` |
| V8-B | XjOte | 流入と計測 サイトスクリプト V8｜状態は型の見本 LS のとおり | /inflow-links | `app/inflow-links/page.tsx` | `v8/inflow-links/ad-connections.tsx`<br>`v8/inflow-links/ad-history.tsx`<br>`v8/inflow-links/site-script.tsx`<br>`v8/inflow-links/ads.tsx`<br>`v8/inflow-links/list.tsx` |
| V8-B | y1ztx | 流入と計測 一覧 1152 V8｜状態は型の見本 LS のとおり | /inflow-links | `app/inflow-links/page.tsx` | `v8/inflow-links/ad-connections.tsx`<br>`v8/inflow-links/ad-history.tsx`<br>`v8/inflow-links/site-script.tsx`<br>`v8/inflow-links/ads.tsx`<br>`v8/inflow-links/list.tsx` |
| V8-B | ZxKL5 | 流入と計測 広告費を手で入れる V8｜状態は型の見本 LS のとおり | /inflow-links | `app/inflow-links/page.tsx` | `v8/inflow-links/ad-connections.tsx`<br>`v8/inflow-links/ad-history.tsx`<br>`v8/inflow-links/site-script.tsx`<br>`v8/inflow-links/ads.tsx`<br>`v8/inflow-links/list.tsx` |
| V8-B | E14GFm | 流入と計測 作る（競合の比べ）V8｜状態は型の見本 CS のとおり | /inflow-links/new | `app/inflow-links/new/page.tsx` | `v8/inflow-links/new/create.tsx` |
| V8-B | KMaMk | 流入と計測 作る V8｜状態は型の見本 CS のとおり | /inflow-links/new | `app/inflow-links/new/page.tsx` | `v8/inflow-links/new/create.tsx` |
| V8-B | vWJEm | 流入と計測 作る（競合）V8｜状態は型の見本 CS のとおり | /inflow-links/new | `app/inflow-links/new/page.tsx` | `v8/inflow-links/new/create.tsx` |
| V8-B | g3iDs | LINE通知 V8｜状態は型の見本 LS のとおり | /line-notifications?tab=customer | `app/line-notifications/page.tsx` | `v8/settings/line-notifications/screen.tsx` |
| V8-B | DrwMm | LINE通知 送れなかったもの V8｜状態は型の見本 LS のとおり | /line-notifications?tab=failures | `app/line-notifications/page.tsx` | `v8/settings/line-notifications/screen.tsx` |
| V8-B | PZBVb | LINE通知 記録 V8｜状態は型の見本 LS のとおり | /line-notifications?tab=history | `app/line-notifications/page.tsx` | `v8/settings/line-notifications/screen.tsx` |
| V8-B | u8xibp | LINE通知 運用者へのお知らせ V8｜状態は型の見本 LS のとおり | /line-notifications?tab=operator | `app/line-notifications/page.tsx` | `v8/settings/line-notifications/screen.tsx` |
| V8-B | gjUz3 | LINE通知 運用者へのお知らせを作る V8｜状態は型の見本 CS のとおり | /line-notifications/operator/new | `app/line-notifications/operator/new/page.tsx` | `v8/line-notifications/operator-edit.tsx` |
| V8-B | sDXNy | LINE通知 運用者へのお知らせ 公開前の確認 V8｜状態は型の見本 CS のとおり | /line-notifications/operator/new | `app/line-notifications/operator/new/page.tsx` | `v8/line-notifications/operator-edit.tsx` |
| V8-B | CJlf4 | マイル 友だちの残高 V8｜状態は型の見本 CS のとおり | /mileage | `app/mileage/page.tsx` | `v8/mileage/mileage.tsx` |
| V8-B | E2Any | マイル たまる決めごと（閲覧のみ）V8｜状態は型の見本 CS のとおり | /mileage | `app/mileage/page.tsx` | `v8/mileage/mileage.tsx` |
| V8-B | IRPw8 | マイル 行動スコア V8｜状態は型の見本 CS のとおり | /mileage | `app/mileage/page.tsx` | `v8/mileage/mileage.tsx` |
| V8-B | L2Bzp | マイル 使い道を作る V8｜状態は型の見本 CS のとおり | /mileage | `app/mileage/page.tsx` | `v8/mileage/mileage.tsx` |
| V8-B | Nv7An | マイル 行動スコアを手で直す V8｜状態は型の見本 CS のとおり | /mileage | `app/mileage/page.tsx` | `v8/mileage/mileage.tsx` |
| V8-B | OC0gy | マイル たまる決めごと V8｜状態は型の見本 CS のとおり | /mileage | `app/mileage/page.tsx` | `v8/mileage/mileage.tsx` |
| V8-B | oRbJi | マイル 履歴 V8｜状態は型の見本 CS のとおり | /mileage | `app/mileage/page.tsx` | `v8/mileage/mileage.tsx` |
| V8-B | R6kIG | マイル 友だちのマイル詳細（新）V8｜状態は型の見本 CS のとおり | /mileage | `app/mileage/page.tsx` | `v8/mileage/mileage.tsx` |
| V8-B | R8NNi | マイル 点数の変化の明細 V8｜状態は型の見本 CS のとおり | /mileage | `app/mileage/page.tsx` | `v8/mileage/mileage.tsx` |
| V8-B | S35pO | マイル 使い道 V8｜状態は型の見本 CS のとおり | /mileage | `app/mileage/page.tsx` | `v8/mileage/mileage.tsx` |
| V8-B | zaqP9 | マイル 状態 V8｜状態は型の見本 CS のとおり | /mileage | `app/mileage/page.tsx` | `v8/mileage/mileage.tsx` |
| V8-B | ZJIyl | マイル たまる決めごと 1152 V8｜状態は型の見本 CS のとおり | /mileage | `app/mileage/page.tsx` | `v8/mileage/mileage.tsx` |
| V8-B | BnrQp | マイル たまる決めごとを作る（競合）V8｜状態は型の見本 CS のとおり | /mileage/earning-rules/new | `app/mileage/earning-rules/new/page.tsx` | `v8/mileage/earning-rule-new/create.tsx` |
| V8-B | ctLwT | マイル たまる決めごとを作る V8｜状態は型の見本 CS のとおり | /mileage/earning-rules/new | `app/mileage/earning-rules/new/page.tsx` | `v8/mileage/earning-rule-new/create.tsx` |
| V8-B | M8zhjL | マイル マイルを手で増やす・減らす V8｜状態は型の見本 LS のとおり | /mileage/friends/detail?id=friend-1&adjust=1 | `app/mileage/friends/detail/page.tsx` | `v8/mileage/friend-detail.tsx` |
| V8-B | MuhWR | NEN配信 一覧（自動配信）V8｜状態は型の見本 LS のとおり | /nen-campaigns | `app/nen-campaigns/page.tsx` | `v8/nen-campaigns/display.ts`<br>`v8/nen-campaigns/list.tsx` |
| V8-B | oqSJP | NEN配信 誕生日クーポンの決めごと（引き出し）V8｜状態は型の見本 LS のとおり | /nen-campaigns | `app/nen-campaigns/page.tsx` | `v8/nen-campaigns/display.ts`<br>`v8/nen-campaigns/list.tsx` |
| V8-B | Tj7n4 | NEN配信 送った履歴 V8｜状態は型の見本 LS のとおり | /nen-campaigns | `app/nen-campaigns/page.tsx` | `v8/nen-campaigns/display.ts`<br>`v8/nen-campaigns/list.tsx` |
| V8-B | Jxmqh | NEN配信 コラム一覧 V8｜状態は型の見本 LS のとおり | /nen-campaigns?tab=columns | `app/nen-campaigns/page.tsx` | `v8/nen-campaigns/display.ts`<br>`v8/nen-campaigns/list.tsx` |
| V8-B | yRDwW | NEN配信 コラムを書く V8｜状態は型の見本 CS のとおり | /nen-campaigns/columns/new | `app/nen-campaigns/columns/new/page.tsx` | `v8/nen-campaigns/column-new.tsx` |
| V8-B | w5pwG | NEN配信 配信を直す（口コミのお願い）V8｜状態は型の見本 CS のとおり | /nen-campaigns/edit | `app/nen-campaigns/edit/page.tsx` | `v8/nen-campaigns/edit.tsx`<br>`v8/nen-campaigns/column-intros.tsx` |
| V8-B | cniyw | 投稿 採用 V8｜状態は型の見本 LS のとおり | /nen-members | `app/nen-members/page.tsx` | `v8/nen-posts/review.tsx` |
| V8-B | Jn95h | 投稿 写真の審査（閲覧のみ）V8｜状態は型の見本 LS のとおり | /nen-members | `app/nen-members/page.tsx` | `v8/nen-posts/review.tsx` |
| V8-B | N1br7 | 投稿 報酬の決まり 版の履歴 V8｜状態は型の見本 LS のとおり | /nen-members | `app/nen-members/page.tsx` | `v8/nen-posts/review.tsx` |
| V8-B | SyQA1 | 投稿 公式サイト掲載 V8（機能追加 F-20・API待ち）｜状態は型の見本 LS のとおり | /nen-members | `app/nen-members/page.tsx` | `v8/nen-posts/review.tsx` |
| V8-B | TkA4D | 投稿 写真の審査 V8｜状態は型の見本 LS のとおり | /nen-members | `app/nen-members/page.tsx` | `v8/nen-posts/review.tsx` |
| V8-B | ujcar | 投稿 この写真を見送る V8｜状態は型の見本 LS のとおり | /nen-members | `app/nen-members/page.tsx` | `v8/nen-posts/review.tsx` |
| V8-B | BVuYh | 健康日記 30日のまとめ（引き出し）V8｜状態は型の見本 LS のとおり | /nen/health | `app/nen/health/page.tsx` | `v8/nen-health/health.tsx` |
| V8-B | mIwA4 | 健康日記 一覧 V8｜状態は型の見本 LS のとおり | /nen/health | `app/nen/health/page.tsx` | `v8/nen-health/health.tsx` |
| V8-B | z2tvtX | 健康日記 記録の項目 V8｜状態は型の見本 LS のとおり | /nen/health | `app/nen/health/page.tsx` | `v8/nen-health/health.tsx` |
| V8-B | AOWoJ | 会員 一覧 V8（機能追加 F-19・API待ち）｜状態は型の見本 LS のとおり | /nen/members | `app/nen/members/page.tsx` | `v8/nen-members/members.tsx` |
| V8-B | dEv6G | 会員 ランクを消す（確認）V8｜状態は型の見本 LS のとおり | /nen/members | `app/nen/members/page.tsx` | `v8/nen-members/members.tsx` |
| V8-B | dzx5D | 専用機能 状態 V8｜状態は型の見本 LS のとおり | /nen/members | `app/nen/members/page.tsx` | `v8/nen-members/members.tsx` |
| V8-B | fb9NJ | 会員 ランク設定 V8｜状態は型の見本 LS のとおり | /nen/members | `app/nen/members/page.tsx` | `v8/nen-members/members.tsx` |
| V8-B | zQ5vY | 会員 ライフタイム V8｜状態は型の見本 LS のとおり | /nen/members | `app/nen/members/page.tsx` | `v8/nen-members/members.tsx` |
| V8-B | e5yBLx | 会員 ランク設定（競合）V8｜状態は型の見本 LS のとおり | /nen/members?tab=ranks | `app/nen/members/page.tsx` | `v8/nen-members/members.tsx` |
| V8-B | eLjeQ | マイペット ペットの情報を直す V8｜状態は型の見本 LS のとおり | /nen/pets | `app/nen/pets/page.tsx` | `v8/nen-pets/pets.tsx` |
| V8-B | h7A2F | マイペット ごはんの目安 V8｜状態は型の見本 LS のとおり | /nen/pets | `app/nen/pets/page.tsx` | `v8/nen-pets/pets.tsx` |
| V8-B | t2SMXX | マイペット 一覧 1152 V8｜状態は型の見本 LS のとおり | /nen/pets | `app/nen/pets/page.tsx` | `v8/nen-pets/pets.tsx` |
| V8-B | wTIej | マイペット 一覧 V8｜状態は型の見本 LS のとおり | /nen/pets | `app/nen/pets/page.tsx` | `v8/nen-pets/pets.tsx` |
| V8-B | y8QQV | 通知 V8｜状態は型の見本 LS のとおり | /notifications | `app/notifications/page.tsx` | `v8/notifications/list.tsx` |
| V8-B | TJUUl | 運営 お知らせ 送る前の確認 V8｜状態は型の見本 LS のとおり | /ops/announcements | `app/ops/announcements/page.tsx` | `v8/ops/announcements.tsx` |
| V8-B | tQ2MJ | 運営 お知らせ V8｜状態は型の見本 LS のとおり | /ops/announcements | `app/ops/announcements/page.tsx` | `v8/ops/announcements.tsx` |
| V8-B | e7ljE | 運営 監査ログ V8｜状態は型の見本 LS のとおり | /ops/audit | `app/ops/audit/page.tsx` | `v8/ops/audit.tsx` |
| V8-B | CyW0E | 運営 ダッシュボード V8｜状態は型の見本 LS のとおり | /ops/dashboard | `app/ops/dashboard/page.tsx` | `v8/ops/dashboard.tsx` |
| V8-B | tVaUh | 運営 メンバーの招待 V8｜状態は型の見本 LS のとおり | /ops/invite | `app/ops/invite/page.tsx` | `v8/ops/invite.tsx` |
| V8-B | h114s | 運営 ナレッジ V8｜状態は型の見本 LS のとおり | /ops/knowledge | `app/ops/knowledge/page.tsx` | `v8/ops/knowledge.tsx` |
| V8-B | R5ckwJ | 運営 ナレッジの記事 V8｜状態は型の見本 LS のとおり | /ops/knowledge | `app/ops/knowledge/page.tsx` | `v8/ops/knowledge.tsx` |
| V8-B | D9JALJ | 運営 ログイン V8｜状態は型の見本 LS のとおり | /ops/login | `app/ops/login/page.tsx` | `v8/ops/login.tsx` |
| V8-B | FvbHW | 運営 メンバー管理 V8｜状態は型の見本 LS のとおり | /ops/members | `app/ops/members/page.tsx` | `v8/ops/members.tsx` |
| V8-B | VUyYu | 運営 メンバーを停止 V8｜状態は型の見本 LS のとおり | /ops/members | `app/ops/members/page.tsx` | `v8/ops/members.tsx` |
| V8-B | Izau1 | 運営 お問い合わせを代わりに起票 V8｜状態は型の見本 LS のとおり | /ops/support | `app/ops/support/page.tsx` | `v8/ops/support.tsx` |
| V8-B | P0jhqO | 運営 お問い合わせ V8｜状態は型の見本 LS のとおり | /ops/support | `app/ops/support/page.tsx` | `v8/ops/support.tsx` |
| V8-B | i0FTN | 運営 契約先を作る V8｜状態は型の見本 CS のとおり | /ops/tenants | `app/ops/tenants/page.tsx` | `v8/ops/tenants.tsx` |
| V8-B | XWtYC | 運営 契約先アカウント V8｜状態は型の見本 CS のとおり | /ops/tenants | `app/ops/tenants/page.tsx` | `v8/ops/tenants.tsx` |
| V8-B | Oub6x | 運営 契約先の詳細 V8｜状態は型の見本 LS のとおり | /ops/tenants/detail | `app/ops/tenants/detail/page.tsx` | `v8/ops/tenant-detail.tsx` |
| V8-B | okXoi | 運営 契約先を停止 V8｜状態は型の見本 LS のとおり | /ops/tenants/detail?id=visual-tenant-1 | `app/ops/tenants/detail/page.tsx` | `v8/ops/tenant-detail.tsx` |
| V8-B | qod6X | 運営 2要素認証を設定 V8｜状態は型の見本 LS のとおり | /ops/two-factor | `app/ops/two-factor/page.tsx` | `v8/ops/two-factor.tsx` |
| V8-B | u3iab3 | 設定 プール管理 V8｜状態は型の見本 LS のとおり | /pools | `app/pools/page.tsx` | `v8/settings/pools/pools.tsx` |
| V8-B | D0AOyx | プール管理 プールを作る V8｜状態は型の見本 CS のとおり | /pools/new | `app/pools/new/page.tsx` | `v8/settings/pools/create.tsx` |
| V8 | a5C1p | リマインダ 一覧（閲覧のみ）V8｜状態は型の見本 LS のとおり | /reminders | `app/reminders/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | apLqS | リマインダ 一覧 V8｜状態は型の見本 LS のとおり | /reminders | `app/reminders/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | Iffil | リマインダ 一覧（1152）V8｜状態は型の見本 LS のとおり | /reminders | `app/reminders/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | RrYYJ | ★V8 リマインダ 状態｜状態は型の見本 LS のとおり | /reminders | `app/reminders/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | RwVo5 | リマインダ 一時停止ダイアログ V8｜状態は型の見本 LS のとおり | /reminders | `app/reminders/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | SkY9V | リマインダ 行の「…」を開いた V8｜状態は型の見本 LS のとおり | /reminders | `app/reminders/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | VsSyu | リマインダ 削除ダイアログ V8｜状態は型の見本 LS のとおり | /reminders | `app/reminders/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | loVfW | リマインダ 登録者を管理 V8｜状態は型の見本 LS のとおり | /reminders/detail | `app/reminders/detail/page.tsx` | `v8/reminders/detail.tsx` |
| V8 | rbAig | リマインダ 詳細（概要） V8｜状態は型の見本 LS のとおり | /reminders/detail | `app/reminders/detail/page.tsx` | `v8/reminders/detail.tsx` |
| V8 | k32cn | リマインダ 編集（競合）V8｜状態は型の見本 CS のとおり | /reminders/edit | `app/reminders/edit/page.tsx` | `v8/reminders/edit.tsx` |
| V8 | T0nis | リマインダ 作る④ 配信予定 V8｜状態は型の見本 CS のとおり | /reminders/edit?id=reminder-new&stage=schedule | `app/reminders/edit/page.tsx` | `v8/reminders/edit.tsx` |
| V8 | hjNpJ | リマインダ 作る 完了（有効にした） V8｜状態は型の見本 CS のとおり | /reminders/new | `app/reminders/new/page.tsx` | `v8/reminders/new/new.tsx` |
| V8 | ltAaq | リマインダ 作る⑤ 確認 V8（機能追加 F-10・API待ち）｜状態は型の見本 CS のとおり | /reminders/new | `app/reminders/new/page.tsx` | `v8/reminders/new/new.tsx` |
| V8 | p5YuP | リマインダ 作る③ 通知の中身 V8（機能追加 F-10・API待ち）｜状態は型の見本 CS のとおり | /reminders/new | `app/reminders/new/page.tsx` | `v8/reminders/new/new.tsx` |
| V8 | r1l0bT | リマインダ 作る③（1152）V8｜状態は型の見本 CS のとおり | /reminders/new | `app/reminders/new/page.tsx` | `v8/reminders/new/new.tsx` |
| V8 | VE1u5 | リマインダ 作る① 基本設定 V8｜状態は型の見本 CS のとおり | /reminders/new | `app/reminders/new/page.tsx` | `v8/reminders/new/new.tsx` |
| V8 | YChR6 | リマインダ 作る② 対象者と止める条件 V8｜状態は型の見本 CS のとおり | /reminders/new | `app/reminders/new/page.tsx` | `v8/reminders/new/new.tsx` |
| V8-B | n4DT7 | 承認ワークフロー（閲覧のみ）V8｜状態は型の見本 LS のとおり | /restaurant-test/approvals | `app/restaurant-test/approvals/page.tsx` | `v8/restaurant/approvals/approvals.tsx` |
| V8-B | t8WgD8 | 承認ワークフロー V8｜状態は型の見本 LS のとおり | /restaurant-test/approvals | `app/restaurant-test/approvals/page.tsx` | `v8/restaurant/approvals/approvals.tsx` |
| V8-B | ao15G | 飲食店向け 店舗を追加 ①利用規約への同意 V8｜状態は型の見本 LS のとおり | /restaurant-test/dashboard | `app/restaurant-test/dashboard/page.tsx` | `v8/restaurant/dashboard/entry.tsx` |
| V8-B | CHz31 | 店舗ダッシュボード V8 | /restaurant-test/dashboard | `app/restaurant-test/dashboard/page.tsx` | `v8/restaurant/dashboard/entry.tsx` |
| V8-B | faGn4 | 飲食店向け 店舗を追加 ②店舗の基本情報 V8｜状態は型の見本 LS のとおり | /restaurant-test/dashboard | `app/restaurant-test/dashboard/page.tsx` | `v8/restaurant/dashboard/entry.tsx` |
| V8-B | VdKOK | 飲食店向け 利用規約 V8｜状態は型の見本 LS のとおり | /restaurant-test/dashboard | `app/restaurant-test/dashboard/page.tsx` | `v8/restaurant/dashboard/entry.tsx` |
| V8-B | j0Wcg | Googleビジネス V8｜状態は型の見本 LS のとおり | /restaurant-test/google | `app/restaurant-test/google/page.tsx` | `v8/restaurant/google/google.tsx` |
| V8-B | SrmVs | Googleビジネス パフォーマンス V8｜状態は型の見本 LS のとおり | /restaurant-test/google?tab=performance | `app/restaurant-test/google/page.tsx` | `v8/restaurant/google/google.tsx` |
| V8-B | Cfed0 | Googleビジネス 投稿 V8｜状態は型の見本 LS のとおり | /restaurant-test/google?tab=posts | `app/restaurant-test/google/page.tsx` | `v8/restaurant/google/google.tsx` |
| V8-B | T1j2Sw | Googleビジネス 投稿を作る V8｜状態は型の見本 CS のとおり | /restaurant-test/google?tab=posts&view=new | `app/restaurant-test/google/page.tsx` | `v8/restaurant/google/google.tsx` |
| V8-B | JUTGz | Googleビジネス プロフィール V8｜状態は型の見本 LS のとおり | /restaurant-test/google?tab=profile | `app/restaurant-test/google/page.tsx` | `v8/restaurant/google/google.tsx` |
| V8-B | x9HIR | Googleビジネス 返信を作る V8｜状態は型の見本 CS のとおり | /restaurant-test/google?tab=reviews&view=draft | `app/restaurant-test/google/page.tsx` | `v8/restaurant/google/google.tsx` |
| V8-B | CuHXG | Googleビジネス 設定 V8｜状態は型の見本 LS のとおり | /restaurant-test/google?tab=settings | `app/restaurant-test/google/page.tsx` | `v8/restaurant/google/google.tsx` |
| V8-B | hQQlt | 予約枠・在庫 予約経路の連携 V8 | /restaurant-test/inventory | `app/restaurant-test/inventory/page.tsx` | `v8/restaurant/inventory/inventory.tsx` |
| V8-B | qf3ky | 予約枠・在庫（競合）V8｜状態は型の見本 LS のとおり | /restaurant-test/inventory | `app/restaurant-test/inventory/page.tsx` | `v8/restaurant/inventory/inventory.tsx` |
| V8-B | Y8SjT2 | 予約枠・在庫 V8 | /restaurant-test/inventory | `app/restaurant-test/inventory/page.tsx` | `v8/restaurant/inventory/inventory.tsx` |
| V8-B | xLpnS | LINE来店フォロー V8 | /restaurant-test/line-followup | `app/restaurant-test/line-followup/page.tsx` | `v8/restaurant/line-followup/line-followup.tsx` |
| V8-B | MJoJR | メニュー管理 V8｜状態は型の見本 LS のとおり | /restaurant-test/menu | `app/restaurant-test/menu/page.tsx` | `v8/restaurant/menu/menu.tsx` |
| V8-B | MV5Os | メニュー管理 停止の確認 V8｜状態は型の見本 LS のとおり | /restaurant-test/menu | `app/restaurant-test/menu/page.tsx` | `v8/restaurant/menu/menu.tsx` |
| V8-B | NkmwU | メニュー管理 メニューを追加・変更 V8｜状態は型の見本 LS のとおり | /restaurant-test/menu | `app/restaurant-test/menu/page.tsx` | `v8/restaurant/menu/menu.tsx` |
| V8-B | bSp4h | 組織・権限 V8 | /restaurant-test/organization | `app/restaurant-test/organization/page.tsx` | `v8/restaurant/organization/organization.tsx` |
| V8-B | ou60i | 組織・権限 ユーザーを追加・変更 V8｜状態は型の見本 CS のとおり | /restaurant-test/organization | `app/restaurant-test/organization/page.tsx` | `v8/restaurant/organization/organization.tsx` |
| V8-B | l9NlC0 | 予約台帳 今日（時間×卓）V8 | /restaurant-test/reservations | `app/restaurant-test/reservations/page.tsx` | `v8/restaurant/reservations/reservations.tsx` |
| V8-B | rm92Y | 予約台帳 電話の予約を入れる V8｜状態は型の見本 LS のとおり | /restaurant-test/reservations | `app/restaurant-test/reservations/page.tsx` | `v8/restaurant/reservations/reservations.tsx` |
| V8-B | xzCK6 | 予約台帳 今日（1152）V8 | /restaurant-test/reservations | `app/restaurant-test/reservations/page.tsx` | `v8/restaurant/reservations/reservations.tsx` |
| V8-B | Z3FoM | 予約台帳 一覧 V8 | /restaurant-test/reservations | `app/restaurant-test/reservations/page.tsx` | `v8/restaurant/reservations/reservations.tsx` |
| V8-B | BERxg | 座席・卓管理 V8 | /restaurant-test/tables | `app/restaurant-test/tables/page.tsx` | `v8/restaurant/tables/tables.tsx` |
| V8-B | eY9F3 | 座席・卓 卓を止める（確認）V8｜状態は型の見本 LS のとおり | /restaurant-test/tables | `app/restaurant-test/tables/page.tsx` | `v8/restaurant/tables/tables.tsx` |
| V8-B | gBrCz | 座席・卓 卓を追加・変更 V8｜状態は型の見本 LS のとおり | /restaurant-test/tables | `app/restaurant-test/tables/page.tsx` | `v8/restaurant/tables/tables.tsx` |
| V8 | f3SoAm | ★V8 リッチメニュー 状態｜状態は型の見本 LS のとおり | /rich-menus | `app/rich-menus/page.tsx` | `v8/rich-menus/list.tsx` |
| V8 | rZEGN | リッチメニュー 一覧 V8｜状態は型の見本 LS のとおり | /rich-menus | `app/rich-menus/page.tsx` | `v8/rich-menus/list.tsx` |
| V8 | Y9ASp | リッチメニュー 一覧（1152）V8｜状態は型の見本 LS のとおり | /rich-menus | `app/rich-menus/page.tsx` | `v8/rich-menus/list.tsx` |
| V8 | yOyCg | リッチメニュー 削除できない理由 V8｜状態は型の見本 LS のとおり | /rich-menus | `app/rich-menus/page.tsx` | `v8/rich-menus/list.tsx` |
| V8 | ZoKow | リッチメニュー 一覧（閲覧のみ）V8｜状態は型の見本 LS のとおり | /rich-menus | `app/rich-menus/page.tsx` | `v8/rich-menus/list.tsx` |
| V8 | wxIQ7 | リッチメニュー 切替のつながり V8｜状態は型の見本 LS のとおり | /rich-menus/connections | `app/rich-menus/connections/page.tsx` | `v8/rich-menus/connections.tsx` |
| V8 | hKr8f | リッチメニュー 公開した（公開の進み） V8｜状態は個別の見本 RS のとおり | /rich-menus/edit | `app/rich-menus/edit/page.tsx` | `v8/rich-menu-edit/detail.tsx` |
| V8 | r8dGXT | リッチメニュー 編集（競合）V8｜状態は個別の見本 RS のとおり | /rich-menus/edit | `app/rich-menus/edit/page.tsx` | `v8/rich-menu-edit/detail.tsx` |
| V8 | F4gELj | リッチメニュー 作る④ 公開 V8｜状態は個別の見本 RS のとおり | /rich-menus/new | `app/rich-menus/new/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | JeINq | リッチメニュー 作る① 形と画像 V8｜状態は個別の見本 RS のとおり | /rich-menus/new | `app/rich-menus/new/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | kmTab | リッチメニュー 作る②（1152）V8｜状態は個別の見本 RS のとおり | /rich-menus/new | `app/rich-menus/new/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | OxEMM | リッチメニュー 作る③ 誰に出すか V8｜状態は個別の見本 RS のとおり | /rich-menus/new | `app/rich-menus/new/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | Z0uO6 | リッチメニュー 作る② ボタンの動き V8｜状態は個別の見本 RS のとおり | /rich-menus/new | `app/rich-menus/new/page.tsx` | （入口から画面本体を自動特定できないため要確認） |
| V8 | axFrW | シナリオ配信 一覧 V8｜状態は型の見本 LS のとおり | /scenarios | `app/scenarios/page.tsx` | `v8/scenarios/list.tsx` |
| V8 | BxGhV | ★V8 シナリオ配信 一覧の状態｜状態は型の見本 LS のとおり | /scenarios | `app/scenarios/page.tsx` | `v8/scenarios/list.tsx` |
| V8 | wjfLe | シナリオ 一覧（1152）V8｜状態は型の見本 LS のとおり | /scenarios | `app/scenarios/page.tsx` | `v8/scenarios/list.tsx` |
| V8 | X0QrW0 | シナリオ配信 一覧（閲覧のみ）V8｜状態は型の見本 LS のとおり | /scenarios | `app/scenarios/page.tsx` | `v8/scenarios/list.tsx` |
| V8 | Al4Ek | シナリオ配信 複製した直後（その場で下書きを足して光らせ知らせ・B-177）V8｜状態は型の見本 CS のとおり | /scenarios/detail | `app/scenarios/detail/page.tsx` | `v8/scenario-detail/detail.tsx` |
| V8 | ARuZ4 | シナリオ配信 編集（停止中） V8｜状態は型の見本 CS のとおり | /scenarios/detail | `app/scenarios/detail/page.tsx` | `v8/scenario-detail/detail.tsx` |
| V8 | kz2B6 | シナリオ配信 編集（競合）V8｜状態は型の見本 CS のとおり | /scenarios/detail | `app/scenarios/detail/page.tsx` | `v8/scenario-detail/detail.tsx` |
| V8 | nMSiE | シナリオ配信 編集（配信を始めた直後） V8｜状態は型の見本 CS のとおり | /scenarios/detail | `app/scenarios/detail/page.tsx` | `v8/scenario-detail/detail.tsx` |
| V8 | PMLkX | シナリオ配信 編集（稼働中） V8｜状態は型の見本 CS のとおり | /scenarios/detail | `app/scenarios/detail/page.tsx` | `v8/scenario-detail/detail.tsx` |
| V8 | OPGU2 | シナリオ配信 止める確認（小窓） V8｜状態は型の見本 LS のとおり | /scenarios/detail?id=scenario-0 | `app/scenarios/detail/page.tsx` | `v8/scenario-detail/detail.tsx` |
| V8 | U5rxyH | シナリオ 作る②（1152）V8｜状態は型の見本 CS のとおり | /scenarios/first-step | `app/scenarios/first-step/page.tsx` | `v8/scenario-first-step/first-step.tsx` |
| V8 | V6xAo | シナリオ配信 作る②（1通目を設定） V8｜状態は型の見本 CS のとおり | /scenarios/first-step | `app/scenarios/first-step/page.tsx` | `v8/scenario-first-step/first-step.tsx` |
| V8 | dnzqC | シナリオ配信 作る①（シナリオ情報・配信方式） V8｜状態は型の見本 CS のとおり | /scenarios/new | `app/scenarios/new/page.tsx` | `v8/scenarios/create.tsx` |
| V8 | X4STXS | シナリオ配信 配信結果 V8｜状態は型の見本 LS のとおり | /scenarios/results | `app/scenarios/results/page.tsx` | `v8/scenarios/results.tsx` |
| V8-B | h1G4d | 分析 Search Console V8｜状態は型の見本 LS のとおり | /search-console | `app/search-console/page.tsx` | `v8/analytics/search-console.tsx` |
| V8 | bKipf | 機能設定（1152）V8｜状態は型の見本 LS のとおり | /settings | `app/settings/page.tsx` | `v8/settings/features/screen.tsx` |
| V8 | bR6a1 | ★V8 設定 状態｜状態は型の見本 LS のとおり | /settings | `app/settings/page.tsx` | `v8/settings/features/screen.tsx` |
| V8 | ywFJT | 設定 機能設定 V8｜状態は型の見本 LS のとおり | /settings | `app/settings/page.tsx` | `v8/settings/features/screen.tsx` |
| V8 | ziYCN | 設定 機能設定（競合）V8｜状態は型の見本 LS のとおり | /settings | `app/settings/page.tsx` | `v8/settings/features/screen.tsx` |
| V8 | ztgRD | 設定 並びを変える V8｜状態は型の見本 LS のとおり | /settings | `app/settings/page.tsx` | `v8/settings/features/screen.tsx` |
| V8 | PfA4o | 設定 ファイルの検査 V8｜状態は型の見本 LS のとおり | /settings/file-scan | `app/settings/file-scan/page.tsx` | `v8/settings/file-scan/screen.tsx` |
| V8 | cIdA2 | 設定 マニュアルの正本表 V8｜状態は型の見本 LS のとおり | /settings/manual-links | `app/settings/manual-links/page.tsx` | `v8/settings/manual-links/screen.tsx` |
| V8 | A35Gh | 設定 ログインユーザー（閲覧のみ）V8｜状態は型の見本 LS のとおり | /staff | `app/staff/page.tsx` | `v8/settings/staff/staff.tsx` |
| V8 | nku0f | 設定 ログインユーザー（管理者・権限） V8｜状態は型の見本 LS のとおり | /staff | `app/staff/page.tsx` | `v8/settings/staff/staff.tsx` |
| V8 | wbDHy | ログインユーザー（1152）V8｜状態は型の見本 LS のとおり | /staff | `app/staff/page.tsx` | `v8/settings/staff/staff.tsx` |
| V8-B | bMpC5 | 組織・権限 ユーザーの停止 V8｜状態は型の見本 LS のとおり | /staff | `app/staff/page.tsx` | `v8/settings/staff/staff.tsx` |
| V8 | aPeD8 | 友だち属性 一覧（1152）V8｜状態は型の見本 LS のとおり | /tags | `app/tags/page.tsx` | `v8/tags/list.tsx` |
| V8 | fkGUR | 友だち属性 タグ（閲覧のみ）V8｜状態は型の見本 LS のとおり | /tags | `app/tags/page.tsx` | `v8/tags/list.tsx` |
| V8 | I1E7Bt | 友だち属性 タグ V8｜状態は型の見本 LS のとおり | /tags | `app/tags/page.tsx` | `v8/tags/list.tsx` |
| V8 | U0aKD | ★V8 友だち属性 一覧の状態｜状態は型の見本 LS のとおり | /tags | `app/tags/page.tsx` | `v8/tags/list.tsx` |
| V8 | q5gbcM | 友だち属性 友だち情報欄 V8｜状態は型の見本 LS のとおり | /tags?tab=fields | `app/tags/page.tsx` | `v8/tags/list.tsx` |
| V8 | vKDj5 | 友だち属性 対応マーク V8｜状態は型の見本 LS のとおり | /tags?tab=marks | `app/tags/page.tsx` | `v8/tags/list.tsx` |
| V8 | IWnYX | 友だち属性 保存した検索 V8｜状態は型の見本 LS のとおり | /tags?tab=searches | `app/tags/page.tsx` | `v8/tags/list.tsx` |
| V8 | Qat9s | 友だち属性 タグの編集 V8｜状態は型の見本 CS のとおり | /tags/edit | `app/tags/edit/page.tsx` | `v8/tag-edit/edit.tsx` |
| V8 | xn95q | 友だち属性 タグの編集（競合）V8｜状態は型の見本 CS のとおり | /tags/edit | `app/tags/edit/page.tsx` | `v8/tag-edit/edit.tsx` |
| V8 | w9zY5 | 友だち属性 友だち情報欄を作る・編集 V8｜状態は型の見本 CS のとおり | /tags/fields/edit | `app/tags/fields/edit/page.tsx` | `v8/tags/field-edit.tsx` |
| V8 | GobMd | 友だち属性 友だち情報欄の移行 V8｜状態は型の見本 LS のとおり | /tags/fields/migrate | `app/tags/fields/migrate/page.tsx` | `v8/tags/field-migrate.tsx` |
| V8 | IjVpM | 友だち属性 フォルダを追加（ダイアログ） V8｜状態は型の見本 CS のとおり | /tags/folders/new | `app/tags/folders/new/page.tsx` | `v8/tags/folder-page.tsx` |
| V8 | ulq9Y | 友だち属性 対応マークの編集 V8｜状態は型の見本 CS のとおり | /tags/marks/edit | `app/tags/marks/edit/page.tsx` | `v8/tags/mark-editor.tsx` |
| V8 | d9xoI | 友だち属性 タグを作る V8｜状態は型の見本 CS のとおり | /tags/new | `app/tags/new/page.tsx` | `v8/tags/create.tsx` |
| V8 | AqDWN | 友だち属性 保存した検索の編集 V8｜状態は型の見本 CS のとおり | /tags/searches/edit | `app/tags/searches/edit/page.tsx` | `v8/tag-edit/search-edit.tsx` |
| V8 | hEDTK | テンプレート 一覧（閲覧のみ）V8｜状態は型の見本 CS のとおり | /templates | `app/templates/page.tsx` | `v8/templates/list.tsx` |
| V8 | L7zA7C | テンプレート 一覧（1152）V8｜状態は型の見本 CS のとおり | /templates | `app/templates/page.tsx` | `v8/templates/list.tsx` |
| V8 | R9XUMr | テンプレート 作る：種類を選ぶ V8（機能追加 F-5・API待ち）｜状態は型の見本 CS のとおり | /templates | `app/templates/page.tsx` | `v8/templates/list.tsx` |
| V8 | susGP | ★V8 テンプレート 状態｜状態は型の見本 CS のとおり | /templates | `app/templates/page.tsx` | `v8/templates/list.tsx` |
| V8 | v19Ivv | テンプレート 一覧（メッセージ） V8｜状態は型の見本 CS のとおり | /templates | `app/templates/page.tsx` | `v8/templates/list.tsx` |
| V8 | V6JFnd | テンプレート 削除（使っていない） V8｜状態は型の見本 CS のとおり | /templates | `app/templates/page.tsx` | `v8/templates/list.tsx` |
| V8 | J60utH | テンプレート カルーセルを作る V8｜状態は型の見本 CS のとおり | /templates/carousel | `app/templates/carousel/page.tsx` | `v8/templates/carousel.tsx`<br>`v8/templates/carousel-core.ts` |
| V8 | cuR8I | テンプレート 公開する（確かめ） V8｜状態は型の見本 LS のとおり | /templates/detail | `app/templates/detail/page.tsx` | `v8/template-detail/detail.tsx` |
| V8 | UTbi1 | テンプレート 詳細（未公開の変更あり） V8｜状態は型の見本 LS のとおり | /templates/detail | `app/templates/detail/page.tsx` | `v8/template-detail/detail.tsx` |
| V8 | Z0g3si | テンプレート 削除（使っている所がある） V8｜状態は型の見本 LS のとおり | /templates/detail | `app/templates/detail/page.tsx` | `v8/template-detail/detail.tsx` |
| V8 | a1k3d | テンプレート メッセージを作る（1152）V8｜状態は型の見本 CS のとおり | /templates/edit | `app/templates/edit/page.tsx` | `v8/template-edit/edit.tsx`<br>`v8/template-edit/core.ts`<br>`v8/template-edit/message.tsx` |
| V8 | EFV8l | テンプレート リッチメッセージを作る V8（機能追加 F-4・API待ち）｜状態は型の見本 CS のとおり | /templates/edit | `app/templates/edit/page.tsx` | `v8/template-edit/edit.tsx`<br>`v8/template-edit/core.ts`<br>`v8/template-edit/message.tsx` |
| V8 | EsYo4 | テンプレート リサーチを作る V8｜状態は型の見本 CS のとおり | /templates/edit | `app/templates/edit/page.tsx` | `v8/template-edit/edit.tsx`<br>`v8/template-edit/core.ts`<br>`v8/template-edit/message.tsx` |
| V8 | NCbYn | テンプレート 編集（競合）V8｜状態は型の見本 CS のとおり | /templates/edit | `app/templates/edit/page.tsx` | `v8/template-edit/edit.tsx`<br>`v8/template-edit/core.ts`<br>`v8/template-edit/message.tsx` |
| V8 | S6FEuB | テンプレート クーポンを作る V8｜状態は型の見本 CS のとおり | /templates/edit | `app/templates/edit/page.tsx` | `v8/template-edit/edit.tsx`<br>`v8/template-edit/core.ts`<br>`v8/template-edit/message.tsx` |
| V8 | u5YC6 | テンプレート メッセージを作る V8｜状態は型の見本 CS のとおり | /templates/edit | `app/templates/edit/page.tsx` | `v8/template-edit/edit.tsx`<br>`v8/template-edit/core.ts`<br>`v8/template-edit/message.tsx` |
| V8 | l87p1J | テンプレート 質問を作る V8｜状態は型の見本 CS のとおり | /templates/questions/new | `app/templates/questions/new/page.tsx` | `v8/templates/question-new.tsx` |
| V8-B | AsfFB | 外部連携 一覧 1152 V8｜状態は型の見本 LS のとおり | /webhooks | `app/webhooks/page.tsx` | `v8/webhooks/outgoing.tsx`<br>`v8/webhooks/interactions.tsx`<br>`v8/webhooks/incoming.tsx`<br>`v8/webhooks/api-tokens.tsx`<br>`v8/webhooks/sheets.tsx`<br>`v8/webhooks/samples.tsx` |
| V8-B | DxAAA | 外部連携 Google Sheets V8｜状態は型の見本 LS のとおり | /webhooks | `app/webhooks/page.tsx` | `v8/webhooks/outgoing.tsx`<br>`v8/webhooks/interactions.tsx`<br>`v8/webhooks/incoming.tsx`<br>`v8/webhooks/api-tokens.tsx`<br>`v8/webhooks/sheets.tsx`<br>`v8/webhooks/samples.tsx` |
| V8-B | gW0F2 | 外部連携 こちらで受け取る V8｜状態は型の見本 LS のとおり | /webhooks | `app/webhooks/page.tsx` | `v8/webhooks/outgoing.tsx`<br>`v8/webhooks/interactions.tsx`<br>`v8/webhooks/incoming.tsx`<br>`v8/webhooks/api-tokens.tsx`<br>`v8/webhooks/sheets.tsx`<br>`v8/webhooks/samples.tsx` |
| V8-B | l5SRfT | 外部連携 一覧（閲覧のみ）V8｜状態は型の見本 LS のとおり | /webhooks | `app/webhooks/page.tsx` | `v8/webhooks/outgoing.tsx`<br>`v8/webhooks/interactions.tsx`<br>`v8/webhooks/incoming.tsx`<br>`v8/webhooks/api-tokens.tsx`<br>`v8/webhooks/sheets.tsx`<br>`v8/webhooks/samples.tsx` |
| V8-B | ralAc | 外部連携 API 接続 V8（機能追加 F-17・API待ち）｜状態は型の見本 LS のとおり | /webhooks | `app/webhooks/page.tsx` | `v8/webhooks/outgoing.tsx`<br>`v8/webhooks/interactions.tsx`<br>`v8/webhooks/incoming.tsx`<br>`v8/webhooks/api-tokens.tsx`<br>`v8/webhooks/sheets.tsx`<br>`v8/webhooks/samples.tsx` |
| V8-B | SAUCs | 外部連携 見本 V8｜状態は型の見本 LS のとおり | /webhooks | `app/webhooks/page.tsx` | `v8/webhooks/outgoing.tsx`<br>`v8/webhooks/interactions.tsx`<br>`v8/webhooks/incoming.tsx`<br>`v8/webhooks/api-tokens.tsx`<br>`v8/webhooks/sheets.tsx`<br>`v8/webhooks/samples.tsx` |
| V8-B | Uv9AA | 外部連携 やり取りの記録 V8｜状態は型の見本 LS のとおり | /webhooks | `app/webhooks/page.tsx` | `v8/webhooks/outgoing.tsx`<br>`v8/webhooks/interactions.tsx`<br>`v8/webhooks/incoming.tsx`<br>`v8/webhooks/api-tokens.tsx`<br>`v8/webhooks/sheets.tsx`<br>`v8/webhooks/samples.tsx` |
| V8-B | wWrpY | 外部連携 状態 V8｜状態は型の見本 LS のとおり | /webhooks | `app/webhooks/page.tsx` | `v8/webhooks/outgoing.tsx`<br>`v8/webhooks/interactions.tsx`<br>`v8/webhooks/incoming.tsx`<br>`v8/webhooks/api-tokens.tsx`<br>`v8/webhooks/sheets.tsx`<br>`v8/webhooks/samples.tsx` |
| V8-B | ZSbFY | 外部連携 一覧（こちらから送る）V8｜状態は型の見本 LS のとおり | /webhooks | `app/webhooks/page.tsx` | `v8/webhooks/outgoing.tsx`<br>`v8/webhooks/interactions.tsx`<br>`v8/webhooks/incoming.tsx`<br>`v8/webhooks/api-tokens.tsx`<br>`v8/webhooks/sheets.tsx`<br>`v8/webhooks/samples.tsx` |
| V8-B | H031gC | 外部連携 受け取る設定を追加 V8｜状態は型の見本 LS のとおり | /webhooks?tab=incoming | `app/webhooks/page.tsx` | `v8/webhooks/outgoing.tsx`<br>`v8/webhooks/interactions.tsx`<br>`v8/webhooks/incoming.tsx`<br>`v8/webhooks/api-tokens.tsx`<br>`v8/webhooks/sheets.tsx`<br>`v8/webhooks/samples.tsx` |
| V8-B | DA0Ag | 外部連携 やり取りの中身 V8（機能追加 F-18・API待ち）｜状態は型の見本 LS のとおり | /webhooks?tab=interactions | `app/webhooks/page.tsx` | `v8/webhooks/outgoing.tsx`<br>`v8/webhooks/interactions.tsx`<br>`v8/webhooks/incoming.tsx`<br>`v8/webhooks/api-tokens.tsx`<br>`v8/webhooks/sheets.tsx`<br>`v8/webhooks/samples.tsx` |
| V8-B | YZ57z | 外部連携 Google Sheets の接続を解除 V8｜状態は型の見本 LS のとおり | /webhooks?tab=sheets | `app/webhooks/page.tsx` | `v8/webhooks/outgoing.tsx`<br>`v8/webhooks/interactions.tsx`<br>`v8/webhooks/incoming.tsx`<br>`v8/webhooks/api-tokens.tsx`<br>`v8/webhooks/sheets.tsx`<br>`v8/webhooks/samples.tsx` |
| V8-B | hsD8e | 外部連携 送り先を作る V8｜状態は型の見本 CS のとおり | /webhooks/new | `app/webhooks/new/page.tsx` | `v8/webhooks/create.tsx` |
| V8-B | NGh7b | 外部連携 送り先を作る（競合）V8｜状態は型の見本 CS のとおり | /webhooks/new | `app/webhooks/new/page.tsx` | `v8/webhooks/create.tsx` |
| V8-B | E7iAYs | ウェビナー ④通知 V8｜状態は型の見本 LS のとおり | /webinars | `app/webinars/page.tsx` | `v8/webinars/list.tsx` |
| V8-B | eAQ3t | ウェビナー 状態 V8｜状態は型の見本 LS のとおり | /webinars | `app/webinars/page.tsx` | `v8/webinars/list.tsx` |
| V8-B | jiNg0 | ウェビナー 一覧（閲覧のみ）V8｜状態は型の見本 LS のとおり | /webinars | `app/webinars/page.tsx` | `v8/webinars/list.tsx` |
| V8-B | Omqd4 | ウェビナー コメント演出 V8｜状態は型の見本 LS のとおり | /webinars | `app/webinars/page.tsx` | `v8/webinars/list.tsx` |
| V8-B | pvimJ | ウェビナー ③CTA・フォーム（競合）V8｜状態は型の見本 LS のとおり | /webinars | `app/webinars/page.tsx` | `v8/webinars/list.tsx` |
| V8-B | Q0Jrk | ウェビナー ③CTA・フォーム V8｜状態は型の見本 LS のとおり | /webinars | `app/webinars/page.tsx` | `v8/webinars/list.tsx` |
| V8-B | uBMuB | ウェビナー 一覧 1152 V8｜状態は型の見本 LS のとおり | /webinars | `app/webinars/page.tsx` | `v8/webinars/list.tsx` |
| V8-B | uNsEy | ウェビナー 参加者 V8｜状態は型の見本 LS のとおり | /webinars | `app/webinars/page.tsx` | `v8/webinars/list.tsx` |
| V8-B | UyUMw | ウェビナー 一覧 V8｜状態は型の見本 LS のとおり | /webinars | `app/webinars/page.tsx` | `v8/webinars/list.tsx` |
| V8-B | VWNaA | ウェビナー ②動画 V8｜状態は型の見本 LS のとおり | /webinars | `app/webinars/page.tsx` | `v8/webinars/list.tsx` |
| V8-B | VXZ6T | ウェビナー アーカイブの確認 V8｜状態は型の見本 LS のとおり | /webinars | `app/webinars/page.tsx` | `v8/webinars/list.tsx` |
| V8-B | z2dgw | ウェビナー 分析 V8｜状態は型の見本 LS のとおり | /webinars | `app/webinars/page.tsx` | `v8/webinars/list.tsx` |
| V8-B | j7PP04 | ウェビナー ①基本設定（作る）V8｜状態は型の見本 CS のとおり | /webinars/new | `app/webinars/new/page.tsx` | `v8/webinar-edit/new.tsx` |
| V8-B | LPOe7 | ウェビナー ②動画（日時指定・開催回）V8｜状態は型の見本 CS のとおり | /webinars/new | `app/webinars/new/page.tsx` | `v8/webinar-edit/new.tsx` |
| V8-B | XCUNf | ウェビナー ⑤確認 V8｜状態は型の見本 CS のとおり | /webinars/new | `app/webinars/new/page.tsx` | `v8/webinar-edit/new.tsx` |
| V8 | AcTHQ | LIFF 状態：読み込み中｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | ADutg | LIFF 状態：空きがない｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | aNZKe | LIFF 回答フォーム 送った｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | B8rCt | LIFF 回答フォーム ①（ページ1）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | biNP5 | LIFF 予約 ② 担当を選ぶ｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | BjcuB | LIFF イベント 空きが出た（席を取る）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | CbGpr | LIFF 予約 ⑤ 確認（お支払いあり・将来）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | EscPA | LIFF イベント 申し込みの確認｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | F1LK4e | シナリオ配信 配信を始める前の確認（小窓） V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | fy5dz | ｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | g9osGN | LIFF 回答フォーム ②（予約を入れる・新）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | gLReL | LIFF 予約 ⑤ 内容の確認｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | gVjiC | LIFF イベント 詳細｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | gzkXs | ｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | i7Zkz | 決済の準備（将来）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | IruGD | LIFF 予約 ① メニューを選ぶ｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | k3aJKU | LIFF 予約 ④ 日時を選ぶ（カレンダー）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | kdWac | 設定の場所（左のメニュー）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | M2p63S | LIFF 予約 ③ 日時を選ぶ（週）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | nUYyb |  | — | — | （撮らない板・URL なし） |
| V8 | O5tUeE | 権限なし（その機能に入れない）V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | qJNti | LIFF 予約 ⑦ 予約が確定しました（支払い済み）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | qVdiX | LIFF イベント 申し込み完了・キャンセル待ち｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | RmjcT | LIFF 予約 ⑥ お支払い（決済サービスの画面へ）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | RpW2h | LIFF ウェビナー 配信中｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | S3uBl | LIFF マイル・紹介｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | sxNO5 | LIFFの決まり | — | — | （撮らない板・URL なし） |
| V8 | uAWb7 | 設定 会社とロゴ V8（新）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | uZqMA | LIFF 予約 ⑤ 内容の確認（414）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | v9WJd | LIFF 予約 お支払いが終わらなかった｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | vqu9B |  | — | — | （撮らない板・URL なし） |
| V8 | VU6Xi | LIFF 予約 ⑥ 受け付けました｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | wPfqW | LIFF 回答フォーム ①（414）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | xvtSz | LIFF 予約 ③ 日時を選ぶ（414）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | y1bs9A | LIFF 自分のイベント｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | YvTJ3 | LIFF 予約の履歴（機能追加 F-6・API待ち）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8 | zz9R3 | LIFF 状態：読み込めなかった｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | a7lUk | 設定 LINEアカウント 並び順と親子を変える V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | D6ljr | 統括 アカウントをアーカイブ V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | dEvJM | 統括 テンプレートを配る（結果）V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | DFl3Q | 予約管理 予約が重なった知らせ（人）V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | EA8rM | 運用状態 緊急停止の確認 V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | eSXxA | 運営 ナレッジ 保存して承認 V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | GgP2d | 運営 お問い合わせ 返事を送る前の確認 V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | HFsO9 | 統括 アカウントをアーカイブから戻す V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | hiBO8 | LINE通知 顧客へのお知らせを編集する V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | iJdAi | 予約台帳 取消の確認 V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | l4qsT | 予約台帳 受信データを試す V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | n4j0Rm | 承認ワークフロー 差し戻す（理由）V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | nGcY1 | 予約枠・在庫 自動で合わせるルール V8（機能追加 F-24・API待ち）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | qw80E | 統括 LINEアカウント 接続確認（手動の項目）V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | rSRFK | 組織・権限 アドレスを発行（再発行の確認）V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | tOPeY | 運営 ログイン 2段目（6桁）V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | ukPgd | 統括 メンバー 招待（入力の間違い）V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | UkZLi | 外部連携 鍵を発行しました V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | vCEKM | 組織・権限 店舗を編集 V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | VDPz5 | 分析 ファネルを作る V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | wJYQb | 予約設定 自動で合わせるルール（人）V8（機能追加 F-25・API待ち）｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | YXrF6 | 予約台帳 予約を変更 V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
| V8-B | Yyw6i | 予約枠・在庫 媒体を閉じる知らせ V8｜状態は型の見本 CS のとおり | — | — | （撮らない板・URL なし） |
