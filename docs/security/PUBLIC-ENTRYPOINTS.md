> 文書：ログイン不要の入口（B-351/4）｜区分：今の説明｜最終確認：2026-10-19（日本時間）

# ログイン不要の入口（B-351/4）

2026-10-16 / kenta・Codex。本線 `af8e504d75` を通常mergeして点検。ここで「ログイン不要」は**管理画面のログインを通らない**意味。LINEの本人確認、Webhook署名、専用鍵が必要な入口も含める。公開URLを知っているだけで、その人の本人確認を済ませたとは考えない。

## 数え方と限界

WorkerのHono実登録にある管理認証の外の入口は **211経路**（メソッド＋パステンプレート、ALLを含む）。下の表に全件を載せた。10-16 19:23の続きで今回の取り直し2経路だけを追記（173＋2）。10-17のAPI列車の取り込みで、追加された7経路だけを追記（175＋7）。10-17の列車42で統合後の実登録と照合し、不足していた19経路を追記した（182＋19）。既存行の全入力組合せを再監査したという意味ではない。`route-guard-coverage.test.ts` が構文の一覧を実登録と照合し、`public-entrypoints.security.test.ts` がこの表との不足/余分を検出する。数は機能数や脆弱性数ではない。一般のstatic assetとSPA fallbackは末尾で別に数える。 10-19 P02で店の写真の公開取得1経路を追記（201＋1）。認証の許可範囲は変更しない。 10-19にチャネル別LINE Webhookを追加（202＋1）。10-21に本人確認済みのクリック遷移資格発行を追加（203＋1）。10-31にF1の公開フォーム画像1経路を追加（204＋1）。10-31に本人の月謝契約の閲覧1経路を追加（205＋1）。10-31にStripeのConnect試験の共通の受け口1経路を追加（206＋1）。同日の実登録との照合で、本線から掲載漏れだったパスキー確認2経路・イベント一覧1経路を追記（207＋3、認証範囲の変更なし）。

「全経路を列挙」と「すべての入力で安全を確認」は別。表の本人確認・期限はコードの方式で、実配備の設定や全資源ID×本人の組合せはS07/S15の未完を維持する。URLの実値・query・顧客情報は記録しない。

## 今回直したことと残る危なさ

| 記号 | 対象・状態 | 次の直しと確かめ方 |
| --- | --- | --- |
| R00 | `/r/:ref` とhelpは回数制限を完全に除外していた。今回、同一IPで1分100回に制限した。URL/偽Cookie/Bearerを変えても同じ枠を消費し、101回目は処理前に429 | `middleware/public-referral-rate-limit.security.test.ts`。単一実行環境の一時的な制限であり、分散したアクセスや再起動をまたぐ保証はしない。永続の制限とWAFは後続/S43 |
| R01・高 | 会話の添付はUUIDの能力URL。汎用ファイルには期限があるが、画像・動画を含め、取得は最長15分の署名を必須へ変更。署名なしの既存URLは本文を返さずLIFFへ案内 | [短命URLの設計と契約](SIGNED-DOWNLOADS.md)。会話を読み直して更新できる。本人用の取り直しURLはLINE本人のBearerも必須、送信本文はLIFF入口へ変更。LINE内表示用URLは15分内の転送で取得可能な制約が残る。取り直し画面はClaudeの接続待ち。DB変更なし |
| R02・高 | `/images/*` の明示公開名前空間と `/media/:id/content` は期限なし。private写真は5分HMAC、審査原本とprivate書類は公開しない。公開素材へ誤って個人情報を入れる危険は残る | 公開用素材と顧客添付の分離・公開取り消し後のCDNの扱いを後続で確認。既存の `images-public-delivery.test.ts`・`media-download-chain.test.ts`・`form-documents.test.ts` を保持 |
| R03・高 | 本人用の支払明細PDFは店/友だち/期限を検査する。今回、期限がNULLの旧明細も拒否するよう修正した。追加対応で認証ヘッダー＋最長15分の署名へ変更。queryだけの認証は拒否 | `routes/affiliate-self.ts`、`apps/liff/src/lib/affiliate-self-api.ts`。[契約と試験](SIGNED-DOWNLOADS.md)。同じUIのAPI関数が発行→本人認証付き取得を行う。別人・改ざん・期限切れは拒否。本番反映は司令塔 |
| R04 | 領収書そのものの無認証ダウンロード経路は実登録に見当たらない。支払明細とクーポンreceiptは別物 | 新設時は短命URL・本人と店・公開状態・期限切れの試験を必須にする。「領収書が安全に実装済み」とは数えない |
| R05・高 | LIFF/フォームの全本人・他店・失効の組合せと公開メタデータの全入力差の個別証拠は未完 | S07/S15の継続作業。推測しづらいUUIDだけで権限を済にしない |

共通の回数制限：`middleware/rate-limit.ts`。認証・upload等には `sensitive-rate-limit.ts` の共有D1枠もある。下のIPの上限は単一実行環境の1分窓（特記を除く）。IPを分散した取得を止めるものではなく、本番WAFの確認はS43。

## 全211経路

| メソッド・経路 | IDの形・推測への耐性 | 回数の制限 | 返す個人情報/確認する人 | 期限 | 根拠のファイル |
| --- | --- | --- | --- | --- | --- |
| `GET /api/liff/files/:id/download` | ランダムUUID。UUIDだけで取得権限にしない | IP 100/分（単一実行環境） | LINE ID tokenで本人・店/統括・R2持ち主・保存期限を照合して、名前/種類/大きさと本人専用の署名URLだけを返す | 署名は最長15分、保存期限が先ならその期限まで。別人/別店/削除/保存期限切れは404 | `apps/worker/src/routes/customer-downloads.ts`、`services/customer-file-access.ts` |
| `GET /liff/:kind/:id` | kindはfiles/statementsのみ。添付UUID/明細ID自体は認証ではない | IP 100/分（単一実行環境） | 本文/個人情報は返さず、保存物の店の登録済みLIFFへ303。外部の遷移先/元queryは使わない | 入口自体は期限なし。削除/停止/LIFF未設定は410で問い合わせ案内 | `apps/worker/src/routes/customer-downloads.ts` |
| `GET /admin/manifest` | 固定パス、IDは秘密にしない | IP 3,000/分（単一実行環境） | 公開の版/稼働/ブランド/静的手引き・スクリプト/転送 | 期限なし。公開メタデータ | `apps/worker/src/routes/admin-version.ts` |
| `ALL /admin/update/*` | 固定パス、IDは秘密にしない | IP 3,000/分（単一実行環境） | updateは404で廃止。internalは検証専用＋専用確認 | 本番では実行不可（既存試験で確認） | `apps/worker/src/routes/admin-update.ts` |
| `GET /admin/version` | 固定パス、IDは秘密にしない | IP 3,000/分（単一実行環境） | 公開の版/稼働/ブランド/静的手引き・スクリプト/転送 | 期限なし。公開メタデータ | `apps/worker/src/routes/admin-version.ts` |
| `POST /api/affiliates/click` | 利用者指定の紹介コード。推測可能で秘密ではない | IP 3,000/分（単一実行環境） | 稼働中の紹介元へクリックを記録し、201とdata:null。紹介者の個人情報は返さない | 入口自体の期限なし。認証/資源の期限は個別 | `apps/worker/src/routes/affiliates.ts` |
| `GET /api/auth/line` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/admin-auth.ts` |
| `GET /api/auth/line/callback` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/admin-auth.ts` |
| `POST /api/auth/login` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/admin-auth.ts` |
| `POST /api/auth/logout` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/admin-auth.ts` |
| `POST /api/auth/ops-invite/accept` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/ops-invite.ts` |
| `GET /api/auth/ops-invite/check` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 有効な招待票の保有者へ招待先のメール・名前とパスワード設定の要否。票なしでは404/410 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/ops-invite.ts` |
| `POST /api/auth/password/forgot` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/auth-email.ts` |
| `POST /api/auth/password/login` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/auth-email.ts` |
| `POST /api/auth/password/reset` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 有効な一回用再設定票の保有者へ本人のメール。再設定は全既存セッションも失効。TOTPは保持 | 再設定票は1時間。有効期限/使用済みを検査 | `apps/worker/src/routes/auth-email.ts` |
| `GET /api/auth/password/reset/check` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 有効な一回用再設定票の保有者へ本人のメール。再設定は全既存セッションも失効。TOTPは保持 | 再設定票は1時間。有効期限/使用済みを検査 | `apps/worker/src/routes/auth-email.ts` |
| `GET /api/auth/register/check` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 有効な一回用確認票の保有者へ登録メールと試用日数。資格情報なしでは404/410 | 登録票は24時間。有効期限/使用済みを検査 | `apps/worker/src/routes/auth-email.ts` |
| `POST /api/auth/register/complete` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/auth-email.ts` |
| `POST /api/auth/register/request` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/auth-email.ts` |
| `POST /api/auth/register/resend-expired` | 期限切れのランダムな一回用登録票を提示。票だけで送信先を変更できない | IP・申込ごとの日次上限と申込ごとの10分待機 | 承認済みで未登録の申込に限り、保存済みの申込メールアドレスへ新しい登録票を送信。応答のメールは一部だけ表示 | 元の票が期限切れのときだけ再送。新しい登録票は24時間 | `apps/worker/src/routes/auth-email.ts` |
| `POST /api/auth/two-factor/setup` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/admin-auth.ts` |
| `POST /api/auth/two-factor/setup/confirm` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/admin-auth.ts` |
| `POST /api/auth/two-factor/verify` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 100/分（登録/パスワード）または3,000/分＋認証の共有D1制限（対象経路）。詳細はS42 | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/admin-auth.ts` |
| `POST /api/conversions/ingest/:id` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/conversions.ts` |
| `POST /api/events/liff/bookings/:id/change` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/events.ts` |
| `GET /api/forms/:id` | フォームUUID。秘密ではない。試し合言葉は別の確認票 | 送信はIP 100/分、他3,000/分。uploadは共有D1 30/分 | 公開版の設問・表示設定。回答/下書き/管理用秘密は公開しない。送信等はLINE本人確認 | 公開中/受付期間。試し合言葉は24時間。添付は別の管理取得口 | `apps/worker/src/routes/forms.ts` |
| `GET /api/forms/:id/images/:blockId` | フォームUUID・採用中の画像ブロック・現在の公開版の番号。任意のメディアIDは受け付けない | IP 3,000/分。公開フォームと同じ入口制限 | フォームの所属アカウントと公開版から解決した画像だけ。所属が1アカウントなら本人確認なし、複数ならLINE本人確認の所属を検証 | 公開中・有効・統括の契約が有効・現在の公開版のみ。試し合言葉では取得不可。応答はprivate/no-store | `apps/worker/src/routes/form-public-image.ts` |
| `POST /api/forms/:id/files` | フォームUUID。秘密ではない。試し合言葉は別の確認票 | 送信はIP 100/分、他3,000/分。uploadは共有D1 30/分 | 公開版の設問・表示設定。回答/下書き/管理用秘密は公開しない。送信等はLINE本人確認 | 公開中/受付期間。試し合言葉は24時間。添付は別の管理取得口 | `apps/worker/src/routes/forms.ts` |
| `POST /api/forms/:id/opened` | フォームUUID。秘密ではない。試し合言葉は別の確認票 | 送信はIP 100/分、他3,000/分。uploadは共有D1 30/分 | 公開版の設問・表示設定。回答/下書き/管理用秘密は公開しない。送信等はLINE本人確認 | 公開中/受付期間。試し合言葉は24時間。添付は別の管理取得口 | `apps/worker/src/routes/forms.ts` |
| `POST /api/forms/:id/partial` | フォームUUID。秘密ではない。試し合言葉は別の確認票 | 送信はIP 100/分、他3,000/分。uploadは共有D1 30/分 | 公開版の設問・表示設定。回答/下書き/管理用秘密は公開しない。送信等はLINE本人確認 | 公開中/受付期間。試し合言葉は24時間。添付は別の管理取得口 | `apps/worker/src/routes/forms.ts` |
| `POST /api/forms/:id/submit` | フォームUUID。秘密ではない。試し合言葉は別の確認票 | 送信はIP 100/分、他3,000/分。uploadは共有D1 30/分 | 公開版の設問・表示設定。回答/下書き/管理用秘密は公開しない。送信等はLINE本人確認 | 公開中/受付期間。試し合言葉は24時間。添付は別の管理取得口 | `apps/worker/src/routes/forms.ts` |
| `GET /api/forms/unassigned` | 固定パス。IDなし | IP 3,000/分 | 公開境界の正規表現に含まれるが、経路内のowner/admin確認で匿名は403。未割当フォームは公開しない | 認証がない取得は不可。管理者も所属を検査 | `apps/worker/src/routes/forms.ts` |
| `GET /api/health` | 固定パス、IDは秘密にしない | IP 3,000/分（単一実行環境） | 公開の版/稼働/ブランド/静的手引き・スクリプト/転送 | 期限なし。公開メタデータ | `apps/worker/src/routes/health.ts` |
| `POST /api/hq/billing/webhook` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/hq-billing.ts` |
| `GET /api/instagram/webhook` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/instagram.ts` |
| `POST /api/instagram/webhook` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/instagram.ts` |
| `POST /api/integrations/ai-loop/reports` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/ai-loop-slack-reports.ts` |
| `POST /api/integrations/codex-slack/events` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/codex-slack-events.ts` |
| `POST /api/integrations/eccube/columns` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/nen-campaigns.ts` |
| `POST /api/integrations/eccube/coupon-usages` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/nen-campaigns.ts` |
| `POST /api/integrations/eccube/events` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/ec-integrations.ts` |
| `POST /api/integrations/slack/actions` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/codex-slack-events.ts` |
| `POST /api/integrations/slack/events` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/codex-slack-events.ts` |
| `POST /api/integrations/stripe/webhook` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/stripe.ts` |
| `POST /api/internal/deployments/events` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/operations.ts` |
| `GET /api/liff/affiliate/bank` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/affiliate-self.ts` |
| `PUT /api/liff/affiliate/bank` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/affiliate-self.ts` |
| `POST /api/liff/affiliate/links` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/affiliate-self.ts` |
| `GET /api/liff/affiliate/me` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/affiliate-self.ts` |
| `GET /api/liff/affiliate/offers` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/affiliate-self.ts` |
| `POST /api/liff/affiliate/offers/:id/enroll` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/affiliate-self.ts` |
| `POST /api/liff/affiliate/register` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/affiliate-self.ts` |
| `GET /api/liff/affiliate/statements` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/affiliate-self.ts` |
| `GET /api/liff/affiliate/statements/:id/download` | 明細ID＋LINE本人の所属照合 | IP 3,000/分（単一実行環境） | 本人の支払明細PDF。発行/取得とも認証ヘッダー必須。旧署名なしリンクはqueryの認証情報を捨てLIFF入口へ303案内。R03のquery認証を廃止 | 署名は最長15分。本人/店/統括と明細の公開状態/取得期限も照合。期限なしの旧行は拒否 | `apps/worker/src/routes/affiliate-self.ts` |
| `POST /api/liff/booking/:id/cancel` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `POST /api/liff/booking/:id/reschedule` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `GET /api/liff/booking/monthly-contracts` | LIFF IDでアカウントを解決し、LINE本人確認とそのアカウントへの友だちの所属を照合 | IP 3,000/分（単一実行環境） | 本人の友だちIDに属する月謝契約だけを返す。tenant/accountの範囲を固定 | LINE本人確認・アカウント有効・統括の契約有効を照合。private/no-store | `apps/worker/src/routes/booking-monthly.ts` |
| `GET /api/liff/booking/availability` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 公開の空き枠/メニュー/表示設定。利用者一覧や秘密を含めないことを個別確認 | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `GET /api/liff/booking/last-booking` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `GET /api/liff/booking/me` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `GET /api/liff/booking/menus` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 公開の空き枠/メニュー/表示設定。利用者一覧や秘密を含めないことを個別確認 | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `GET /api/liff/booking/menus/:id/staff` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 公開の空き枠/メニュー/表示設定。利用者一覧や秘密を含めないことを個別確認 | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `GET /api/liff/booking/payments/by-booking` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking-payments.ts` |
| `POST /api/liff/booking/payments/start` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking-payments.ts` |
| `POST /api/liff/booking/requests` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `GET /api/liff/booking/seat-availability` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `GET /api/liff/booking/seat-waitlist` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `POST /api/liff/booking/seat-waitlist` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `DELETE /api/liff/booking/seat-waitlist/:id` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `POST /api/liff/booking/seat-waitlist/:id/accept` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `GET /api/liff/booking/settings` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 公開の空き枠/メニュー/表示設定。利用者一覧や秘密を含めないことを個別確認 | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `GET /api/liff/booking/store-photos` | 公開LIFF ID。秘密ではない。有効な店の公開写真だけを返す | IP 3,000/分（単一実行環境） | 登録済み写真の用途・公開画像URLを保存順で返す。顧客情報・管理用の版・秘密値を含めない | LIFF IDから有効な店を固定。写真の保存順・未登録・別店は実HTTP試験で確認 | `apps/worker/src/routes/booking/register-photos.ts` |
| `GET /api/liff/booking/waitlist` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `POST /api/liff/booking/waitlist` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `DELETE /api/liff/booking/waitlist/:id` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `GET /api/liff/booking/waitlist/mine` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/booking.ts` |
| `POST /api/liff/tracked-link-identity` | 公開のリンクID。資格ではない | IP 3,000/分（単一実行環境） | リンクの店のLINE ID token・店の稼働・本人の所属を照合し、本人用の遷移資格だけを返す。no-store | 5分。リンク・本人・店に署名で束縛 | `apps/worker/src/routes/tracked-links.ts` |
| `GET /api/liff/config` | 公開LIFF ID。秘密ではない | IP 3,000/分 | 公開のbotBasicId・accountName・accountId・customerLook。LINE本人確認は不要。友だち/鍵は返さない | 有効な店/統括を確認。既定店へのfallbackあり、個別の入力差はS15 | `apps/worker/src/routes/liff.ts` |
| `GET /api/liff/customer-look` | 公開LIFF ID。秘密ではない | IP 3,000/分 | 公開の見た目と表示設定だけ。LINE本人確認は不要 | 有効な店/統括を確認。期限なし、no-store | `apps/worker/src/routes/liff.ts` |
| `POST /api/liff/entry-route-coupon` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/liff.ts` |
| `POST /api/liff/entry-route-coupon/use` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/liff.ts` |
| `GET /api/liff/events/:id` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/events.ts` |
| `POST /api/liff/events/:id/bookings` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/events.ts` |
| `GET /api/liff/events/:id/slots` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/events.ts` |
| `GET /api/liff/events/me` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/events.ts` |
| `GET /api/liff/events/me/:bookingId` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/events.ts` |
| `POST /api/liff/events/me/:bookingId/cancel` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/events.ts` |
| `GET /api/liff/events/me/waitlist` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/events.ts` |
| `GET /api/liff/events/me/waitlist/:waitlistId` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/events.ts` |
| `POST /api/liff/events/me/waitlist/:waitlistId/cancel` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/events.ts` |
| `GET /api/liff/events/waitlist/:token` | ランダム案内のハッシュ照合＋LINE本人＋所属 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 案内の期限/状態/版を照合 | `apps/worker/src/routes/events.ts` |
| `POST /api/liff/events/waitlist/:token/accept` | ランダム案内のハッシュ照合＋LINE本人＋所属 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 案内の期限/状態/版を照合 | `apps/worker/src/routes/events.ts` |
| `POST /api/liff/friend-add-intent` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/liff.ts` |
| `POST /api/liff/link` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/liff.ts` |
| `GET /api/liff/mileage/me` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/affiliate-self.ts` |
| `GET /api/liff/mileage/rewards` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/affiliate-self.ts` |
| `POST /api/liff/mileage/rewards/:id/redeem` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/affiliate-self.ts` |
| `GET /api/liff/nen/health-logs` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/nen-members.ts` |
| `POST /api/liff/nen/health-logs` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/nen-members.ts` |
| `GET /api/liff/nen/health-logs/summary` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/nen-members.ts` |
| `GET /api/liff/nen/member` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/nen-members.ts` |
| `POST /api/liff/nen/pets` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/nen-members.ts` |
| `PUT /api/liff/nen/pets/:id` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/nen-members.ts` |
| `POST /api/liff/nen/pets/:id/photo` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/nen-members.ts` |
| `POST /api/liff/nen/photos` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/nen-members.ts` |
| `PUT /api/liff/nen/photos/:id/publication-consent` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/nen-members.ts` |
| `POST /api/liff/profile` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/liff.ts` |
| `GET /api/liff/research/:id/form` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/research.ts` |
| `GET /api/liff/restaurant/availability` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 公開の空き枠/メニュー/表示設定。利用者一覧や秘密を含めないことを個別確認 | 検証専用。本番DEPLOY_ENVでは404。リンク/保留/確認は保存期限と本人を照合 | `apps/worker/src/routes/restaurant-customer-booking.ts` |
| `POST /api/liff/restaurant/confirmations/:requestId/respond` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 検証専用。本番DEPLOY_ENVでは404。リンク/保留/確認は保存期限と本人を照合 | `apps/worker/src/routes/restaurant-customer-booking.ts` |
| `GET /api/liff/restaurant/courses` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 公開の空き枠/メニュー/表示設定。利用者一覧や秘密を含めないことを個別確認 | 検証専用。本番DEPLOY_ENVでは404。リンク/保留/確認は保存期限と本人を照合 | `apps/worker/src/routes/restaurant-customer-booking.ts` |
| `POST /api/liff/restaurant/form-booking` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 検証専用。本番DEPLOY_ENVでは404。リンク/保留/確認は保存期限と本人を照合 | `apps/worker/src/routes/restaurant-customer-booking.ts` |
| `POST /api/liff/restaurant/holds` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 検証専用。本番DEPLOY_ENVでは404。リンク/保留/確認は保存期限と本人を照合 | `apps/worker/src/routes/restaurant-customer-booking.ts` |
| `GET /api/liff/restaurant/link/:token` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 検証専用。本番DEPLOY_ENVでは404。リンク/保留/確認は保存期限と本人を照合 | `apps/worker/src/routes/restaurant-customer-booking.ts` |
| `GET /api/liff/restaurant/referrals` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 検証専用。本番DEPLOY_ENVでは404。リンク/保留/確認は保存期限と本人を照合 | `apps/worker/src/routes/restaurant-customer-booking.ts` |
| `POST /api/liff/restaurant/referrals` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 検証専用。本番DEPLOY_ENVでは404。リンク/保留/確認は保存期限と本人を照合 | `apps/worker/src/routes/restaurant-customer-booking.ts` |
| `GET /api/liff/restaurant/reservations` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 検証専用。本番DEPLOY_ENVでは404。リンク/保留/確認は保存期限と本人を照合 | `apps/worker/src/routes/restaurant-customer-booking.ts` |
| `POST /api/liff/restaurant/reservations/:id/cancel` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 検証専用。本番DEPLOY_ENVでは404。リンク/保留/確認は保存期限と本人を照合 | `apps/worker/src/routes/restaurant-customer-booking.ts` |
| `POST /api/liff/restaurant/reservations/:id/confirm` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 検証専用。本番DEPLOY_ENVでは404。リンク/保留/確認は保存期限と本人を照合 | `apps/worker/src/routes/restaurant-customer-booking.ts` |
| `POST /api/liff/restaurant/reservations/:id/reschedule` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 検証専用。本番DEPLOY_ENVでは404。リンク/保留/確認は保存期限と本人を照合 | `apps/worker/src/routes/restaurant-customer-booking.ts` |
| `POST /api/liff/send-form-link` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/liff.ts` |
| `GET /api/liff/visit-stamps/cards` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/visit-stamps.ts` |
| `GET /api/liff/visit-stamps/cards/:id` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/visit-stamps.ts` |
| `POST /api/liff/visit-stamps/cards/:id/paper-photos` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/visit-stamps.ts` |
| `GET /api/liff/visit-stamps/cards/:id/paper-requests` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/visit-stamps.ts` |
| `POST /api/liff/visit-stamps/cards/:id/paper-requests` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/visit-stamps.ts` |
| `POST /api/liff/visit-stamps/cards/:id/rewards` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/visit-stamps.ts` |
| `GET /api/liff/visit-stamps/paper-photos/:id` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の紙カード写真。LINE本人と所属を照合 | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/visit-stamps.ts` |
| `POST /api/liff/visit-stamps/qr/redeem` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/visit-stamps.ts` |
| `POST /api/liff/visit-stamps/redemptions/:id/use` | 資源ID/公開slug/LIFF IDは秘密ではない。本人操作はLINEと所属、公開表示は店の状態を確認 | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | LINE検証の有効性＋各予約/資源の状態。全組合せの証拠はS15の残件 | `apps/worker/src/routes/visit-stamps.ts` |
| `GET /api/liff/webinars/:slug` | 公開slug。個人操作はLINE本人＋対象店チャネル | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 公開状態/申込/視聴期限。動画は署名付き別入口 | `apps/worker/src/routes/webinars.ts` |
| `GET /api/liff/webinars/:slug/audience` | 公開slug。LINE本人＋対象店を検査 | IP 3,000/分 | 開催状態・視聴者の数・集計秒数。視聴者の名簿や個人情報は返さない | 公開期間/申込/開催セッションを確認 | `apps/worker/src/routes/webinars.ts` |
| `POST /api/liff/webinars/:slug/comments` | 公開slug。個人操作はLINE本人＋対象店チャネル | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 公開状態/申込/視聴期限。動画は署名付き別入口 | `apps/worker/src/routes/webinars.ts` |
| `POST /api/liff/webinars/:slug/cta-click` | 公開slug。個人操作はLINE本人＋対象店チャネル | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 公開状態/申込/視聴期限。動画は署名付き別入口 | `apps/worker/src/routes/webinars.ts` |
| `POST /api/liff/webinars/:slug/funnel-event` | 公開slug。個人操作はLINE本人＋対象店チャネル | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 公開状態/申込/視聴期限。動画は署名付き別入口 | `apps/worker/src/routes/webinars.ts` |
| `POST /api/liff/webinars/:slug/heartbeat` | 公開slug。個人操作はLINE本人＋対象店チャネル | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 公開状態/申込/視聴期限。動画は署名付き別入口 | `apps/worker/src/routes/webinars.ts` |
| `POST /api/liff/webinars/:slug/register` | 公開slug。個人操作はLINE本人＋対象店チャネル | IP 3,000/分（単一実行環境） | 本人の予約/会員/ペット/回答/支払等を返す経路を含む。IDだけで認可しない | 公開状態/申込/視聴期限。動画は署名付き別入口 | `apps/worker/src/routes/webinars.ts` |
| `POST /api/meet-callback` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/meet-callback.ts` |
| `GET /api/public/brand` | 固定パス、IDは秘密にしない | IP 3,000/分（単一実行環境） | 公開の版/稼働/ブランド/静的手引き・スクリプト/転送 | 期限なし。公開メタデータ | `apps/worker/src/routes/brand.ts` |
| `GET /api/public/nen/adopted-photos` | 公開用写真ID。gallery-previewは専用署名 | IP 3,000/分（単一実行環境） | 同意/公開承認後の派生写真。審査原本は返さない | 採用状態/同意とプレビュー署名の期限 | `apps/worker/src/routes/nen-members.ts` |
| `GET /api/public/nen/gallery-preview` | 公開用写真ID。gallery-previewは専用署名 | IP 3,000/分（単一実行環境） | 同意/公開承認後の派生写真。審査原本は返さない | 採用状態/同意とプレビュー署名の期限 | `apps/worker/src/routes/nen-members.ts` |
| `POST /api/public/v1/friends/:friendId/tags` | integration_api_tokensのBearerを照合。利用者IDは認証ではない | IP 3,000/分（単一実行環境） | 許可したスコープ/店のタグ等。専用トークンが必要 | 鍵の失効/有効状態。公開利用者への無認証取得ではない | `apps/worker/src/routes/public-api.ts` |
| `GET /api/public/v1/tags` | integration_api_tokensのBearerを照合。利用者IDは認証ではない | IP 3,000/分（単一実行環境） | 許可したスコープ/店のタグ等。専用トークンが必要 | 鍵の失効/有効状態。公開利用者への無認証取得ではない | `apps/worker/src/routes/public-api.ts` |
| `OPTIONS /api/public/web-conversions` | 固定パス。IDなし | IP 3,000/分 | CORSの公開応答204だけ。顧客データなし | 期限なし | `apps/worker/src/routes/web-measurement.ts` |
| `POST /api/public/web-conversions` | site_＋32桁16進の公開ID。認証の代わりにしない | IP 3,000/分 | 常に204で本文なし。許可ドメイン/同意/友だちとの結び付きを照合し、受信データを応答しない | サイトの稼働状態。URL自体に期限なし | `apps/worker/src/routes/web-measurement.ts` |
| `GET /api/qr` | 固定パス＋公開URLを指定 | IP 30/分 | 指定した内容のQR。秘密や個人情報を入力しない | 取得URL自体の期限なし | `apps/worker/src/index.ts` |
| `POST /api/restaurant-test/delivery/webhooks/:service` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/restaurant-delivery.ts` |
| `OPTIONS /api/site/collect` | 固定パス、IDは秘密にしない | IP 3,000/分（単一実行環境） | 用途別の公開データ/本人確認後のデータ。全入力組合せは未確認 | 入口自体の期限なし。認証/資源の期限は個別 | `apps/worker/src/routes/site-tracking.ts` |
| `POST /api/site/collect` | 固定パス、IDは秘密にしない | IP 3,000/分（単一実行環境） | 用途別の公開データ/本人確認後のデータ。全入力組合せは未確認 | 入口自体の期限なし。認証/資源の期限は個別 | `apps/worker/src/routes/site-tracking.ts` |
| `GET /api/site/script.js` | 固定パス、IDは秘密にしない | IP 3,000/分（単一実行環境） | 公開の版/稼働/ブランド/静的手引き・スクリプト/転送 | 期限なし。公開メタデータ | `apps/worker/src/routes/site-tracking.ts` |
| `POST /api/staff/email-change/confirm` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 3,000/分（単一実行環境） | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/staff.ts` |
| `GET /api/staff/invitations/:token/verify` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 3,000/分（単一実行環境） | 管理画面の確認ページへ302で移動するだけ。招待を消費/有効化せず、POSTで票を確認する | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/staff.ts` |
| `POST /api/staff/invitations/confirm/verify` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 3,000/分（単一実行環境） | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/staff.ts` |
| `POST /api/webhooks/incoming/:id/receive` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 100/分＋サービス固有の重複/署名検証 | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/webhooks.ts` |
| `GET /auth/callback` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 3,000/分（単一実行環境） | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/liff.ts` |
| `GET /auth/line` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 3,000/分（単一実行環境） | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/liff.ts` |
| `GET /auth/oauth` | 固定パス/ランダムな招待・確認票/OAuth state。メール・利用者IDは秘密ではない | IP 3,000/分（単一実行環境） | 確認票/本人確認の結果で分岐。メール・名前を返す口、認証成功後にセッションを返す口がある。下の補足を参照 | 確認票/セッションの保存済み期限を照合（方法ごとに異なる） | `apps/worker/src/routes/liff.ts` |
| `GET /book` | 固定パス、IDは秘密にしない | IP 3,000/分（単一実行環境） | 公開の版/稼働/ブランド/静的手引き・スクリプト/転送 | 期限なし。公開メタデータ | `apps/worker/src/index.ts` |
| `GET /docs` | 固定パス、IDは秘密にしない | アプリの回数制限から除外 | 公開API仕様。実値は置かない | 入口自体の期限なし。認証/資源の期限は個別 | `apps/worker/src/routes/openapi.ts` |
| `GET /health` | 固定パス、IDは秘密にしない | IP 3,000/分（単一実行環境） | 公開の版/稼働/ブランド/静的手引き・スクリプト/転送 | 期限なし。公開メタデータ | `apps/worker/src/routes/health.ts` |
| `GET /images/*` | 公開画像のUUID/公開名前空間。private画像はHMAC付きURL（R01/R02参照） | IP 3,000/分。配備先のWAFは未確認 | 公開素材は公開前提。友だち写真/添付は個人情報を含み得る | private画像5分。公開画像/ライブ素材は原則期限なし | `apps/worker/src/routes/images.ts` |
| `GET /images/broadcast-media/:filename` | 公開画像のUUID/公開名前空間。private画像はHMAC付きURL（R01/R02参照） | IP 3,000/分。配備先のWAFは未確認 | 公開素材は公開前提。友だち写真/添付は個人情報を含み得る | private画像5分。公開画像/ライブ素材は原則期限なし | `apps/worker/src/routes/broadcast-message-assets.ts` |
| `GET /images/chat-attachments/:attachmentId` | ランダムUUID＋15分の署名。署名込みのURL自体が取得権限になる | IP 3,000/分。配備先のWAFは未確認 | 会話の添付。本人用の署名には同じ本人のBearerも必須。LINE内表示/管理用の署名は15分内なら転送先も取得可能。署名なしは本文を返さずLIFFへ303（R01） | 全種別で署名は最長15分。汎用ファイルの保存期限が先なら短縮（R01） | `apps/worker/src/routes/chat-attachments.ts` |
| `GET /images/chat-attachments/video-preview.png` | 固定パス | IP 3,000/分。配備先のWAFは未確認 | 固定の見本PNGだけ | 期限なし | `apps/worker/src/routes/chat-attachments.ts` |
| `GET /images/imagemaps/:id/:width` | 公開画像のUUID/公開名前空間。private画像はHMAC付きURL（R01/R02参照） | IP 3,000/分。配備先のWAFは未確認 | 公開素材は公開前提。友だち写真/添付は個人情報を含み得る | private画像5分。公開画像/ライブ素材は原則期限なし | `apps/worker/src/routes/broadcast-message-assets.ts` |
| `POST /internal/ubereats/sandbox-token-probe` | 固定パス、IDは秘密にしない | IP 3,000/分（単一実行環境） | updateは404で廃止。internalは検証専用＋専用確認 | 本番では実行不可（既存試験で確認） | `apps/worker/src/routes/restaurant-delivery.ts` |
| `ALL /line-api-data/*` | 専用Proxy認証。URLのIDだけでは通さない | IP 3,000/分（単一実行環境） | LINE APIの個人情報を含み得る。専用鍵と対象アカウント照合 | 専用資格情報の有効性。一般公開APIではない | `apps/worker/src/routes/line-proxy.ts` |
| `ALL /line-api/*` | 専用Proxy認証。URLのIDだけでは通さない | IP 3,000/分（単一実行環境） | LINE APIの個人情報を含み得る。専用鍵と対象アカウント照合 | 専用資格情報の有効性。一般公開APIではない | `apps/worker/src/routes/line-proxy.ts` |
| `GET /media/:id/content` | 公開画像のUUID/公開名前空間。private画像はHMAC付きURL（R01/R02参照） | IP 3,000/分。配備先のWAFは未確認 | 公開素材は公開前提。友だち写真/添付は個人情報を含み得る | private画像5分。公開画像/ライブ素材は原則期限なし | `apps/worker/src/routes/contents.ts` |
| `GET /o` | 固定パス、IDは秘密にしない | IP 3,000/分（単一実行環境） | 用途別の公開データ/本人確認後のデータ。全入力組合せは未確認 | 入口自体の期限なし。認証/資源の期限は個別 | `apps/worker/src/index.ts` |
| `GET /openapi.json` | 固定パス、IDは秘密にしない | アプリの回数制限から除外 | 公開API仕様。実値は置かない | 入口自体の期限なし。認証/資源の期限は個別 | `apps/worker/src/routes/openapi.ts` |
| `GET /pool/:slug` | rは利用者指定ref、poolは指定slugで推測可能。tはランダム短縮コード/UUID。認証の代用にしない | rはIP 100/分（今回追加、ref/help/query共通）。t/poolはIP 3,000/分 | 公開の店/案内/転送先。個人プロフィールを返さない用途 | URL自体の期限なし。有効状態で停止 | `apps/worker/src/routes/traffic-pools.ts` |
| `GET /r/:ref` | rは利用者指定ref、poolは指定slugで推測可能。tはランダム短縮コード/UUID。認証の代用にしない | rはIP 100/分（今回追加、ref/help/query共通）。t/poolはIP 3,000/分 | 公開の店/案内/転送先。個人プロフィールを返さない用途 | URL自体の期限なし。有効状態で停止 | `apps/worker/src/index.ts` |
| `GET /r/:ref/help` | rは利用者指定ref、poolは指定slugで推測可能。tはランダム短縮コード/UUID。認証の代用にしない | rはIP 100/分（今回追加、ref/help/query共通）。t/poolはIP 3,000/分 | 公開の店/案内/転送先。個人プロフィールを返さない用途 | URL自体の期限なし。有効状態で停止 | `apps/worker/src/index.ts` |
| `GET /robots.txt` | 固定パス、IDは秘密にしない | IP 3,000/分（単一実行環境） | 公開の版/稼働/ブランド/静的手引き・スクリプト/転送 | 期限なし。公開メタデータ | `apps/worker/src/index.ts` |
| `GET /setup` | 固定パス、IDは秘密にしない | IP 3,000/分（単一実行環境） | 公開の版/稼働/ブランド/静的手引き・スクリプト/転送 | 期限なし。公開メタデータ | `apps/worker/src/routes/setup.ts` |
| `GET /t/:linkId` | rは利用者指定ref、poolは指定slugで推測可能。tはランダム短縮コード/UUID。認証の代用にしない | rはIP 100/分（今回追加、ref/help/query共通）。t/poolはIP 3,000/分 | 公開の店/案内/転送先。個人プロフィールを返さない用途 | URL自体の期限なし。有効状態で停止 | `apps/worker/src/routes/tracked-links.ts` |
| `POST /webhook` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 100/分＋サービス固有の重複/署名検証 | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/webhook.ts` |
| `POST /webhook/:channelId` | 数字のチャネルIDは公開識別子。対象アカウントのLINE署名を検証 | IP 100/分＋受信済み記録 | 署名で確定したアカウント内だけに保存・取消。本文のdestinationは他顧客の識別に使用しない | 受信済みイベントとメッセージの重複を抑止 | `apps/worker/src/routes/webhook.ts` |
| `POST /webhooks/xserver/support-email` | 入口IDは秘密ではない。サービス別の署名/専用鍵で確認 | IP 3,000/分（単一実行環境） | 署名/専用鍵を検査後に通知処理。GETの登録確認は専用確認値。顧客本文・鍵を応答/Slackへ出さない | サービス別の署名時刻/受信済み記録（全方式の期限の統一はしていない） | `apps/worker/src/routes/support-inbox.ts` |
| `GET /webinar-assets/:token/:slug/*` | 期限＋HMACを含むtoken、slug/パスも署名照合 | IP 3,000/分（単一実行環境） | 申込者へ配る動画。URLの再配布は防ぎ切れない | 署名時のexpまで。期限と動画公開状態を確認 | `apps/worker/src/routes/webinars.ts` |
| `POST /api/auth/passkeys/login/options` | 一次ログイン後の短命challenge必須。RP/Originと有効なスタッフを照合 | IP 3,000/分（単一実行環境）、本文1KiB | 本人に登録済みの認証器の公開情報だけ。パスワードなしログインには使わない | 一次challengeの有効期限と試行上限 | `apps/worker/src/routes/admin-passkeys-login.ts` |
| `POST /api/auth/passkeys/login/verify` | 一次ログインと一度限りのchallenge、WebAuthn署名・RP/Origin・本人確認必須 | IP 3,000/分（単一実行環境）＋MFA試行制限、本文128KiB | 本人の認証器の検証後だけログインを発行 | challengeの期限・一度限りの消費・counterのCAS | `apps/worker/src/routes/admin-passkeys-login.ts` |
| `GET /api/liff/events` | LIFFから店を解決し、公開状態・店・公開対象のタグを検査 | IP 3,000/分（単一実行環境） | 公開対象のイベント一覧。参加用URLを返さず、タグ限定のものはLINE本人を照合 | 店とイベントの公開状態を都度検査 | `apps/worker/src/routes/events/register-liff-catalog.ts` |
| `POST /api/booking/stripe-test/webhook` | 専用 `BOOKING_STRIPE_TEST_CONNECT_WEBHOOK_SECRET` によるStripe署名必須（fallbackなし） | IP 3,000/分（単一実行環境）、本文256KiB | Connect試験の共通口。外側・対象ともlivemode:false必須。対応先未登録はpending、対象外typeは保存せず無視、未知API版は要確認で保存。後続の固定した店・本人・用途・接続先・金額を照合して反映 | 署名時刻は前後5分。Connect＋event IDの受信記録と同batchで一度だけ反映 | `apps/worker/src/routes/booking-stripe-webhook.ts` |
| `POST /api/booking/pass-payments/webhook` | Stripe試験用の専用署名。管理ログインとは別 | IP 3,000/分（単一実行環境） | 署名を検査した試験イベントだけ。livemodeと支払状態を確認し、本番決済や外部Stripe書込は行わない | 署名時刻は前後5分。イベントIDで二重適用を抑止 | `apps/worker/src/routes/booking-pass-billing.ts` |
| `POST /api/ec/events` | 店ごとの連携鍵による本文と時刻のHMAC。対象店ヘッダーも照合 | 店ごとの直近1分の受信記録600件＋共通IP枠。本文64KB | 有効な店・契約・接続だけ受信。イベントIDの重複を抑止。秘密値を返さない | 署名時刻は前後5分。保存と再送は連携の台帳で管理 | `apps/worker/src/routes/ec-auto-line.ts` |
| `GET /api/liff/booking/cancellation-quote` | LINE本人＋対象店の友だち照合。資源IDだけでは通さない | IP 3,000/分（単一実行環境） | 本人が持つ対象店の予約だけのキャンセル料見積もり。予約IDの所属も検査 | LINE本人確認と保存済みのキャンセル条件で判定 | `apps/worker/src/routes/booking-cancellation.ts` |
| `GET /api/liff/booking/cost-estimate` | LINE本人＋対象店の友だち照合。資源IDだけでは通さない | IP 3,000/分（単一実行環境） | 本人と対象店のメニュー・組の費用/空き計算。入力と公開範囲を検査 | 対象メニュー・日時・人数の条件を都度検査 | `apps/worker/src/routes/booking-gap3.ts` |
| `GET /api/liff/booking/group-availability` | LINE本人＋対象店の友だち照合。資源IDだけでは通さない | IP 3,000/分（単一実行環境） | 本人と対象店のメニュー・組の費用/空き計算。入力と公開範囲を検査 | 対象メニュー・日時・人数の条件を都度検査 | `apps/worker/src/routes/booking-gap3.ts` |
| `GET /api/liff/booking/menus/:id/addons` | 店のLIFF設定とメニューの公開/対象条件。限定メニューはLINE本人の範囲も照合 | IP 3,000/分（単一実行環境） | 表示してよい追加メニューの候補だけ。停止した追加メニューを除く | 公開/対象条件と有効状態を都度検査 | `apps/worker/src/routes/booking.ts` |
| `POST /api/liff/booking/pass-plans/:id/checkout` | LINE本人＋対象店の友だち照合。資源IDだけでは通さない | IP 3,000/分（単一実行環境） | 対象店の公開商品の模擬購入。二重作成防止キーを確認。実決済しない | 本人・商品状態と試験モードを都度検査 | `apps/worker/src/routes/booking-pass-billing.ts` |
| `GET /api/liff/booking/pass-purchases/:id` | LINE本人＋対象店の友だち照合。資源IDだけでは通さない | IP 3,000/分（単一実行環境） | 購入ID・対象店・本人の一致した購入状態だけを返す | 本人と所属を都度検査。IDだけで取得させない | `apps/worker/src/routes/booking-pass-billing.ts` |
| `GET /api/liff/booking/series/preview` | LINE本人＋対象店の友だち照合。資源IDだけでは通さない | IP 3,000/分（単一実行環境） | 対象店の公開メニューに許可された繰り返し予約の見積もり。保存/送信はしない | 許可された頻度・回数・本人の閲覧範囲を都度検査 | `apps/worker/src/routes/booking-gap3.ts` |
| `POST /api/liff/booking/series/preview` | LINE本人＋対象店の友だち照合。資源IDだけでは通さない | IP 3,000/分（単一実行環境） | 対象店の公開メニューに許可された繰り返し予約の見積もり。保存/送信はしない | 許可された頻度・回数・本人の閲覧範囲を都度検査 | `apps/worker/src/routes/booking-gap3.ts` |
| `POST /api/liff/booking/setup-intent` | LINE本人＋対象店の友だち照合。資源IDだけでは通さない | IP 3,000/分（単一実行環境） | 同意・メニュー・試験用接続と二重作成防止キーを確認して登録待ちを作る。自己申告では登録済みにしない | 署名済み試験Webhookで既存の登録待ちを更新 | `apps/worker/src/routes/booking-cancellation.ts` |
| `POST /api/liff/booking/setup-webhook` | Stripe試験用の専用署名。LINE本人/管理ログインとは別 | IP 3,000/分（単一実行環境） | 署名後にlivemode・イベント種別・完了状態を検査し、既存の試験用登録待ちだけ更新 | 署名時刻は前後5分。登録待ちからの更新に限定 | `apps/worker/src/routes/booking-cancellation.ts` |
| `POST /api/liff/events/bookings/:id/absence` | LINE本人＋対象店の友だち照合。資源IDだけでは通さない | IP 3,000/分（単一実行環境） | 本人の教室予約の欠席登録。二重操作防止キーと対象予約を検査 | 予約の状態と保存された欠席/振替条件を都度検査 | `apps/worker/src/routes/booking-makeup.ts` |
| `GET /api/liff/events/makeup-credits` | LINE本人＋対象店の友だち照合。資源IDだけでは通さない | IP 3,000/分（単一実行環境） | 本人の振替券だけを一覧/候補表示/使用。使用時は二重操作防止キーと振替先を検査 | 券の期限・所有・対象条件・使用状態を検査 | `apps/worker/src/routes/booking-makeup.ts` |
| `GET /api/liff/events/makeup-credits/:id/options` | LINE本人＋対象店の友だち照合。資源IDだけでは通さない | IP 3,000/分（単一実行環境） | 本人の振替券だけを一覧/候補表示/使用。使用時は二重操作防止キーと振替先を検査 | 券の期限・所有・対象条件・使用状態を検査 | `apps/worker/src/routes/booking-makeup.ts` |
| `POST /api/liff/events/makeup-credits/:id/use` | LINE本人＋対象店の友だち照合。資源IDだけでは通さない | IP 3,000/分（単一実行環境） | 本人の振替券だけを一覧/候補表示/使用。使用時は二重操作防止キーと振替先を検査 | 券の期限・所有・対象条件・使用状態を検査 | `apps/worker/src/routes/booking-makeup.ts` |
| `POST /api/liff/forms/:id/routing/resolve` | LINE本人＋対象店の友だち照合。資源IDだけでは通さない | IP 3,000/分（単一実行環境） | 対象店の公開フォームの回答から行き先を計算し、本人・版・行き先を束縛した署名を返す | 行き先署名は30分。署名と本文/版/本人の取り違えを拒否 | `apps/worker/src/routes/form-routing.ts` |
| `GET /api/liff/member-card` | LINE本人＋対象店の友だち照合。資源IDだけでは通さない | IP 3,000/分（単一実行環境） | 対象店の本人の会員番号・ランク・特典だけ。有効でないランク設定は空を返す | 本人・所属・ランク設定の有効状態を都度検査 | `apps/worker/src/routes/member-ranks.ts` |
| `POST /mcp` | 専用Bearer鍵のハッシュ・接続/鍵の期限・所有者と許可店/操作を照合 | IP 3,000/分＋接続ごと60/分をD1で同時制御。本文16KB | 集計の読取・テキスト下書き・模擬配信の承認依頼に限定。実送信しない。失効/権限不足を拒否 | 接続/鍵の有効期限と旧鍵の猶予を都度検査 | `apps/worker/src/routes/mcp-rpc.ts` |

### 認証・招待の補足

ログイン前でも、有効な確認票を持つ人へメールや名前を返す口がある。票は一時的な取得権限なので、URLの流出を無害と考えない。登録は24時間、再設定は1時間（`services/auth-mail.ts`）。他の招待・OAuth・MFAは保存した期限と目的を照合する。外部のログへquery/票を写さず、票なし・期限切れ・使用済みの検査を維持する。GETの移動だけの口と、本人確認後に処理するPOSTを混同しない。

## Static asset・SPA（上の204とは別）

| 面 | ID/回数制限 | 個人情報・期限・残る条件 |
| --- | --- | --- |
| 管理画面の `apps/web/out` のHTML・JS・CSS・公開画像・version.json | 固定パスとビルドのhash。静的配信の回数制限はCloudflare側、未確認 | ログイン画面の骨組みは公開。顧客データは管理APIの本人確認後。CSPは[CSP記録](csp.md)。ビルドへ秘密を埋めない |
| LIFFの `apps/liff/dist` とWorkerの `dist/client`、未知の非APIパスのSPA fallback | 画面のパス、ID/slugは秘密ではない。Worker経由は共通IP枠、Pages直配信は別確認 | 予約確認/フォーム/本人履歴の骨組みは公開。個人情報の取得は表のAPIで検証。外部ログインの実試験は今回は行わない |
| 管理専用の添付 `/api/form-files/:id/content` | 管理認証の外ではないため204に含めない。本人確認書類はowner/admin、所属と期限・検査状態を照合 | `routes/form-documents.ts`。`private/form-documents/` のR2原本は公開画像口では404。期限付きURLへ切り替えたという意味ではない |

## API列車で加わった入口（全一覧の再生成ではない）

共通の回数制限はIPごと3,000回/分、Workerの単一実行環境内。分散した厳密な制限ではない。LINEの認証はLINE側のトークン期限も照合する。下の列挙は所属や期限の実装を読んだ記録であり、全資源と本人の組合せの試験完了とは扱わない。

| 経路 | IDの形・推測 | 回数の制限 | 返す個人情報・確認の境界 | 期限 | 根拠 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/liff/booking/entitlements` | 公開LIFF ID。本人はLINE tokenから確定し、友だちIDを受け取らない | 共通IP枠 | 本人の店の券・契約名、残数、期限のみ。管理者の理由・担当者は返さない | LINE tokenの期限＋券・契約の有効期間。取得URLの発行はない | `apps/worker/src/routes/booking-entitlements.ts` |
| `POST /api/liff/booking/page-views` | 公開LIFF ID・メニューID。本人と店をLINEで照合 | 共通IP枠 | 本人の閲覧を記録し成功だけ返す。別店/無効メニュー拒否、友だちの一覧を返さない | LINE tokenの期限。記録自体の保存期限は別の残件 | `apps/worker/src/routes/booking.ts` |
| `GET /api/liff/booking/style-readiness` | 公開LIFF IDと機能名。本人と店をLINEで照合 | 共通IP枠 | 本人の店の利用可否・不足する設定。本人の追従状態も確認し、他の友だちを返さない | LINE tokenの期限。取得URLの発行はない | `apps/worker/src/routes/booking.ts` |
| `GET /api/liff/hq-form-tests/:id` | テンプレートID単独では不可。UUID2個から作るランダムな試験票のhashで照合 | 共通IP枠。発行はテンプレートごと有効5個まで | 試験票を持つ人へ固定版のフォーム定義。顧客の回答は返さない。作成者の役割・所属/統括の稼働・取消も確認。queryの試験票は秘密として扱う | 発行から24時間。取消・保管・作成者の停止でも拒否 | `apps/worker/src/routes/hq-form-tests.ts`、`apps/worker/src/services/hq-templates/form-test.ts` |
| `POST /api/liff/hq-form-tests/:id/submit` | 同上。試験票を確認し、入力は100,000文字以内 | 共通IP枠 | 入力の妥当性だけ返す。回答・配信・操作イベントを保存しない。試験票なしは404 | 発行から24時間。取消等も上と同じ | `apps/worker/src/routes/hq-form-tests.ts`、`apps/worker/src/services/hq-templates/form-test.ts` |
| `GET /api/liff/notification-preferences` | 店IDは秘密ではない。店のLINE LoginチャネルでID tokenを確認して本人を確定 | 共通IP枠 | 本人の目的別の受取状態・版・更新時刻のみ。別人/別店・停止した店/統括は拒否。no-store | LINE tokenの期限。設定は保存され、URL単独に取得権限はない | `apps/worker/src/routes/liff-notification-preferences.ts` |
| `PUT /api/liff/notification-preferences/:purpose` | 上と同じ。目的は固定2種類、版の一致が必要 | 共通IP枠 | 本人の設定のみ変更して返す。状態の未記録を同意済みにしない | LINE tokenの期限。古い版は409 | `apps/worker/src/routes/liff-notification-preferences.ts` |

## 再確認

`SECURITY_INVENTORY_REPORT=docs/security/API-ROUTE-INVENTORY-1016.tsv pnpm --filter worker exec vitest run src/middleware/route-guard-coverage.test.ts` をリポジトリルートから使うと出力先がWorker基準になるため、実行時はレポート先を絶対パスで指定する。次に `pnpm --filter worker exec vitest run src/routes/public-entrypoints-security.test.ts src/middleware/public-referral-rate-limit-security.test.ts`。重い検査はheavy経由で行う。

既存の画像・書類・LINE本人/所属・Webhook署名の試験も合わせる。本番の顧客データや本物の送信を確認用に使わない。配備の設定を読んだ証拠がなければ「分からない」のまま残す。
