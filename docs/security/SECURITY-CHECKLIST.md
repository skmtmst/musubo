> 文書：公開前の安全点検表｜区分：今の説明｜最終確認：2026-11-16（日本時間）

# 公開前の安全点検表

この文書は今の点検の状態とその根拠だけを書く。課題の番号や作業の経緯は git の履歴にある。各行の「済：日付 担当」は、その確認をいつ誰が行ったかの証拠として残す。

調査日：2026-10-16。コードの基点：`cd63dd961f5dc2613a8b16c39a21d01e2cf7c8ba`（取得済みの `origin/codex/development` と一致）。開始時の作業ツリーはクリーン、`DOCTOR_LOCAL=1 bash scripts/codex/doctor.sh` は「合格」。

## 判定の読み方

- **済**：その行に書いた確認を実施した。コードを読んだだけの行は、本番で動作したという意味ではない。
- **未**：残る作業またはコード上の懸念を特定した。担当者の対応・試験が必要。
- **分からない**：本番の設定や契約など、この調査では確認できなかった。未設定と断定しない。
- **危なさ「高」**：乗っ取り・別の店の情報閲覧・誤配信・漏えい・復旧不能につながるもの。「中」は負荷や運用への影響を含む。

**修正後の集計：49項目＝済21・未16・分からない12。未のうち危なさ「高」は15項目。** 件数はこの表の行数で、脆弱性の件数や事故件数ではない。

この点検表の状態は最後に記録された確認範囲を保つ。S05では外部設定・本番・検証DBを確認しておらず、「未」「分からない」を済へ変更していない。コードの入口だけの確認と、実環境の動作確認を分ける。

本人確認・ログイン・保存期限の呼び出しは[実装説明](step-up-and-retention.md)、ブラウザの制限と未確認は[CSP](csp.md)、添付と明細の取得は[URLの契約](SIGNED-DOWNLOADS.md)を読む。過去の修正・検査・性能測定は[保管先](../document-archives.md#s05)へ移した。安全条件の未完了項目はこの表と末尾のオーナー作業に残す。

表のパスはリポジトリのルートから。命令は原則として読むだけ。「検証で確認」は、別途用意した架空データの環境で担当者が行う次の作業。実際のお客さまへ試し送信しない。

## ログインと権限

| ID | 点検・危なさ | 確かめ方（命令・画面） | 今の状態 | 根拠のファイル |
| --- | --- | --- | --- | --- |
| S01 | ログインした本人と有効なセッションを確認する・高 | `rg -n 'state\|nonce\|authenticateAdminSession\|expires' apps/worker/src/routes/admin-auth.ts apps/worker/src/middleware/auth.ts`。発行・期限・失効の分岐を読む | 済：OAuthとセッションの確認処理を確認。配備先のログイン成功は別確認 | `apps/worker/src/routes/admin-auth.ts`、`apps/worker/src/middleware/auth.ts`、`apps/worker/src/routes/admin-auth-sessions.test.ts` |
| S02 | Cookieと不正な外部操作への対策・高 | `auth.ts` のCookie属性と更新時のCSRF比較、`admin-auth-config.ts` の許可元を読む | 済：Secure・HttpOnlyのセッションCookie、CSRF比較、接続構成の検査がある | `apps/worker/src/middleware/auth.ts`、`apps/worker/src/middleware/admin-auth-config.ts` |
| S03 | 新しいAPIがスタッフへ無条件に開かない・高 | `permissionForApiPath` とスタッフの許可条件、網羅試験の分類を読む | 済：未分類の管理APIはスタッフを403で拒否する設計。全APIの安全の証明ではない | `apps/worker/src/middleware/auth.ts`、`apps/worker/src/middleware/route-guard-coverage.test.ts` |
| S04 | 統括・店・別アカウントの境界・高 | `tenant-scope.ts`、各APIの所属確認と境界試験を読む。画面の「統括／店」と内部のowner/admin/staffを同じ意味と考えない | 済：共通の所属範囲検査とAPI別の制限がある。全経路の実動作はS07 | `apps/worker/src/middleware/tenant-scope.ts`、`apps/worker/src/middleware/role-guard.ts`、`apps/worker/src/routes/calendar-security.test.ts` |
| S05 | 閲覧のみでは変更・鍵取得ができない・高 | `auth.ts` の安全なHTTPメソッド以外の拒否、`denyReadOnly` を読む | 済：更新の一律拒否と、鍵情報などを読むこと自体の拒否がある。続きでCSV・export・downloadの拒否も追加し、機能ごとの閲覧権限からの書出しも止める | `apps/worker/src/middleware/auth.ts`、`apps/worker/src/middleware/role-guard.ts`、`apps/worker/src/routes/staff-api-key-security.test.ts` |
| S06 | 代理ログインは範囲・理由・履歴で制限する・高 | `resolveImpersonation`、伏せ字、書き出し拒否、理由付き表示、禁止操作を読む | 済：セッションに結び付き、既定は閲覧のみ。個人情報は既定で伏せ、解約等を禁止する | `apps/worker/src/middleware/impersonation.ts`、`apps/worker/src/routes/ops.ts`、`apps/worker/src/middleware/impersonation.test.ts` |
| S07 | 全APIの権限の抜けを実際のリクエストで点検する・高 | 開発担当がOpenAPIと経路一覧を突合し、未ログイン・統括・店・閲覧のみ・代理ログインで別の店のIDを指定する。GET・書き出し・更新・削除を含め、401/403/情報を返さない404を確認 | 未：実登録と照合した[全1,764経路の一覧](../document-archives.md#s05)と[管理1,582経路の共通境界](../document-archives.md#s05)。一覧・履歴・集計・Google連携・旧共通資源・閲覧のみのCSV書出しの抜けを修正し、実データ付きの拒否試験を追加（[修正と残条件](../document-archives.md#s05)）。他店資源ID単独・代理ログインの全組合せの個別証拠は未完。旧スコア5経路はbehaviorfixと同じ410停止を維持 | `apps/worker/src/middleware/route-guard-coverage.test.ts`、`routes/security-scope-inventory.test.ts`、`test-utils/route-security-inventory.ts` |
| S08 | 2人と不要アカウントの実際の権限・高 | 各サービスのメンバー画面とmusuboのユーザー管理を2人で確認し、[権限表](TWO-FACTOR-SETUP.md#誰に何の権限があるか)へ名前・役割だけ記録 | 分からない：アカウントの実際の割り当ては取得していない | `docs/brain/Memory.md`、`apps/worker/src/routes/staff.ts` |
| S09 | 二段階認証と回復手段・高 | [設定手順](TWO-FACTOR-SETUP.md)で各自の設定を確認。musubo側も二段階認証の設定と暗号化用secretの有無を担当者と確認 | 分からない：登録・必須化のコードはあるが、2人の設定と本番の鍵は未確認 | `apps/worker/src/routes/admin-auth.ts`、`apps/worker/src/lib/mfa-config.ts`、`apps/worker/src/routes/admin-auth-mfa-enforcement.test.ts` |

## WebhookとLIFF（お客さまの画面）

Webhookは、外部サービスから届く通知の入口。署名は「正しい相手が作った通知か」を確かめるための印。

| ID | 点検・危なさ | 確かめ方（命令・画面） | 今の状態 | 根拠のファイル |
| --- | --- | --- | --- | --- |
| S10 | LINE通知の署名・高 | `webhook.ts` の生の本文に対する署名検証と、失敗後に処理へ進まない分岐を読む | 済：JSONを読む前に検証。本文上限・署名の形式検査もある | `apps/worker/src/routes/webhook.ts`、`packages/line-sdk/src/`、`apps/worker/src/routes/webhook.test.ts` |
| S11 | Stripe通知の署名・高 | 購入通知と統括課金の2入口、共通の `verifyStripeSignature` を読む | 済：生の本文・HMAC・前後5分の時刻・本文上限を検査。鍵なしは503、署名不正は401 | `apps/worker/src/routes/stripe.ts`、`apps/worker/src/routes/hq-billing.ts`、`apps/worker/src/services/stripe-signature.ts`、`apps/worker/src/routes/stripe-security.test.ts` |
| S12 | Googleの通知入口の有無・高 | `rg -n -i 'x-goog\|pubsub\|calendar.*watch\|google.*webhook' apps/worker/src --glob '!*.test.*'` とカレンダー経路を読む。Google Cloud・Apps Script等の外側の設定も担当者が確認する | 済：このコード内ではGoogle Calendarから直接受けるpush通知の入口は見当たらず、API呼出し方式。署名実装済みとは数えない。外側の設定はS35で確認 | `apps/worker/src/routes/calendar.ts`、`apps/worker/src/services/google-calendar.ts` |
| S13 | Meet完了通知をGoogle通知と混同しない・高 | `/api/meet-callback` と共通の署名検証、受信済み記録を読む | 済：Meet Harness独自のHMACと前後5分の時刻を検証。Googleが付けた署名ではない | `apps/worker/src/routes/meet-callback.ts`、`apps/worker/src/services/support-relay.ts`、`docs/meet-callback-security.md` |
| S14 | LIFFの本人確認・高 | `verifyCallerLineIdentity` のLINEへのIDトークン照会と対象チャネルの選択を読む。ブラウザが送った友だちIDだけでは本人としない | 済：LINEの検証APIへIDトークンとチャネルIDを送り、返された本人IDを使う共通処理がある | `apps/worker/src/services/liff-auth.ts`、`apps/worker/src/services/liff-auth.test.ts`、`apps/worker/src/routes/liff.ts` |
| S15 | LIFF全入口で別人・別店・期限切れを拒否する・高 | 架空の本人Aで本人Bの予約・回答・添付を指定し拒否を確認。別チャネル・期限切れ・トークン欠落でも確認。公開閲覧の入口と本人操作を分けて一覧化する | 未：全入口は[経路一覧](../document-archives.md#s05)へ収録。前回の予約14経路に加え、イベント8経路・待ち案内2経路・ウェビナー7経路の他店チャネルを拒否。未割当の他統括利用、停止統括の素材・案内・会員/ペット9経路、LIFFと店の指定不一致も修正。全入口×別人・別店・失効の実資源を使う検査は未完（[記録](../document-archives.md#s05)） | `routes/events-channel.security.test.ts`、`routes/webinars-channel.security.test.ts`、`services/liff-auth.test.ts`、`packages/db/test/friend-account-lookup.test.ts`、`packages/db/test/webinar-public-scope.test.ts` |

## 秘密の値・個人情報

| ID | 点検・危なさ | 確かめ方（命令・画面） | 今の状態 | 根拠のファイル |
| --- | --- | --- | --- | --- |
| S16 | 秘密の正規の置き場・高 | secretの案内と環境別設定を読む。Cloudflare Worker secret、GitHub Environment secrets、手元の未追跡設定の使い分けを確認する | 済：LINE暗号化鍵等はWorker secretへ置く手順。通常変数へ置かない規定がある。実値や本番の設定状況は取得していない | `docs/line-credential-encryption.md`、`apps/worker/wrangler.toml`、`apps/worker/wrangler.staging.toml`、`.github/workflows/deploy-cloudflare-staging.yml` |
| S17 | 本番・検証のsecretの存在と分離・高 | 各Workerの Settings → Variables and Secrets とGitHubのEnvironment secretsで名前・型・権限だけ確認。担当者がLINE・Stripe・Google・Slack・管理ログイン・暗号化・取得URL署名（API_KEY）の鍵を照合する | 分からない：doctorは検証用の配備資格情報の名前を確認しただけ。サービス用secretや別々の値であることは未確認 | `scripts/codex/doctor.sh`、`apps/worker/src/index.ts`、`.github/workflows/deploy-cloudflare-staging.yml` |
| S18 | 実際の.envや.dev.varsをGitへ入れない・高 | `git ls-files` のファイル名を確認し、`.env`・`.env.*`・`.dev.vars*` からexample/sample/templateを除く。内容を表示しない | 済：現在の追跡対象に実設定ファイル0、例示ファイル2。.gitignoreに除外あり。履歴全体の証明ではない | `.gitignore`、`.env.example`、`docs/.env.example` |
| S19 | 全履歴・全枝の秘密検査・高 | 担当者が承認済みのsecret検査を全履歴・対象の全枝へ行う。GitHubのSecurity → Secret scanningも確認。結果は場所と種類のみ記録 | 済：2026-10-16 kenta。公式Gitleaks 8.30.1をchecksum照合して使用。全ローカルref＋originの現行全枝/tagを隔離mirrorへ取得し、5,704参照・25,793コミットで検出0（終了0）。削除済み履歴の架空secretは終了1で検出し、出力の伏せ字も確認。未到達の履歴・画像内の文字・任意の秘密の不存在まで保証しない。GitHub側の監視設定はオーナー | `.gitignore`、`.github/workflows/`、`docs/line-credential-encryption.md` |
| S20 | DBのLINE認証情報が暗号化済みか・高 | 担当者が鍵設定・移行結果を値なしの件数で確認。暗号文の欠落・復号失敗・平文への切替の有無を確認する | 分からない：AES-GCMの実装はあるが、従来の平文を読む経路も残る。本番DBの完了状態は未照会 | `packages/db/src/credential-crypto.ts`、`packages/db/src/line-accounts.ts`、`docs/line-credential-encryption.md` |
| S21 | Google Calendarの認証情報の保存・高 | `createCalendarConnection` の保存直前と読込を確認し、担当者が暗号化・鍵管理・既存分の移行方法を検討する | 未：新規保存3種はAES-GCMへ修正済。鍵欠落・不正なら保存せず、平文・改ざんはGoogleへ渡さない（`calendar-credentials.security.test.ts`）。既存平文の処理と専用secret登録はオーナー作業が残る。実DBは未照会 | `apps/worker/src/routes/calendar.ts`、`packages/db/src/calendar.ts` |
| S22 | アプリのログへ顧客本文・秘密を出さない・高 | `index.ts` の未処理エラーと固定コードのログ、ログの静的検査を読む | 済：未処理エラーは固定コードと経路の型を出す。秘密・生の例外を防ぐ検査がある。全ての実行ログを閲覧したわけではない | `apps/worker/src/index.ts`、`apps/worker/src/security-console-contract.test.ts`、`apps/worker/src/security-log.test.ts` |
| S23 | Slackへ個人情報・URLのクエリを出さない・高 | `client-errors.ts` → `reportHarnessErrorToSlack` → `sanitizeSlackContent` を追う。架空の氏名・メール・クエリ入り経路を、外へ送らない試験で検証する | 済：2026-10-16 kenta。自動エラー報告を固定のエラー種別・許可した機能名・正規化した日時だけへ限定。自由文・スタック・動的ID・ホスト・クエリ・断片を通知と要対応metadataへ出さない。`codex-slack-relay.test.ts`のS23で全送信本文を検査し、旧実装では失敗することも確認。既存Slack履歴の点検はS25/S38 | `apps/worker/src/routes/client-errors.ts`、`apps/worker/src/services/codex-slack-relay.ts`、`apps/worker/src/services/codex-slack-relay.test.ts` |
| S24 | 画面・書き出しの個人情報制限・高 | 代理ログイン時のJSON伏せ字、ファイル拒否、理由付き表示と監査を読む | 済：共通処理がある。通常ログインの閲覧権限や全画面の確認はS07・S25 | `apps/worker/src/middleware/impersonation.ts`、`apps/worker/src/middleware/output-audit.ts`、`apps/worker/src/middleware/output-audit.test.ts` |
| S25 | 配備先の画面・ログ・Slackの保管設定・高 | 架空データで画面と書き出しを確認。Cloudflareのログ閲覧権限・保持期間、Slackの参加者・保持期間、公開画像・添付の範囲を担当者が点検 | 分からない：本番画面や保存済みのログ・Slack履歴は閲覧していない | `apps/worker/src/middleware/impersonation.ts`、`apps/worker/src/routes/client-errors.ts`、`AGENTS.md` |

## 依存関係・回数の制限

| ID | 点検・危なさ | 確かめ方（命令・画面） | 今の状態 | 根拠のファイル |
| --- | --- | --- | --- | --- |
| S26 | 開発・試験道具を含む依存の穴・高 | `pnpm audit --json`。警告を出した版とlockfileを照合し、安全な更新または到達しない根拠を記録する | 未：司令塔の承認で開発専用Vitestを4.1.11へ更新し、tinypoolがなくなりCritical 2→0。全体はCritical 0 / High 1 / Moderate 5 / Low 4。bracesのHighは修正版なし。開発のNext lint経由で、深く入れ子にしたglob入力が悪用条件。現設定はglobを指定せず、その回避条件を `lint-glob-boundary.test.ts` で監視する。全検査と故障対照は修正記録へ | `package.json`、`pnpm-lock.yaml`、この文書の「依存検査の記録」 |
| S27 | 製品用の依存の穴・中 | `pnpm audit --prod --json`。担当者がビルド後に含まれる物と利用条件を確認する | 未：修正後critical/high 0、moderate 5・low 1（修正前8・1）。製品用依存の絞り込み結果であり、本番への影響なしとは断定しない | `pnpm-lock.yaml`、`apps/worker/package.json`、`apps/web/package.json` |
| S28 | ログイン・出力・アップロードの回数制限・高 | `rate-limit.ts` と `sensitive-rate-limit.ts` を読む | 済：一般の急増制限に加え、重要操作はD1で共有。共有側の失敗時は503で止める。一般のカウンターはWorkerごとのメモリで、再起動で消える | `apps/worker/src/middleware/rate-limit.ts`、`apps/worker/src/middleware/sensitive-rate-limit.ts`、`apps/worker/src/middleware/rate-limit-shared.test.ts` |
| S29 | 本番で制限と負荷対策が効くか・中 | 担当者が検証用の低い予算で429・Retry-After・D1障害時の503を確認。Cloudflare側の防御と請求の監視も確認 | 分からない：本番で大量の試しアクセスはしていない。D1の必要な表、配備版、防御設定も未確認 | `apps/worker/src/middleware/sensitive-rate-limit.ts`、`apps/worker/src/middleware/rate-limit-shared.test.ts` |

## バックアップ・環境分離・公開範囲

| ID | 点検・危なさ | 確かめ方（命令・画面） | 今の状態 | 根拠のファイル |
| --- | --- | --- | --- | --- |
| S30 | D1を戻すための仕組み・高 | migration実行前の復元点取得と失敗時の中止を読む。[復元手順](INCIDENT-RUNBOOK.md#dbを壊した)を確認 | 済：移行前にTime Travelの復元点を取る処理・手順がある。コードの巻き戻しとDB復元は別工程 | `scripts/deploy/migrate.ts`、`.github/workflows/migrate-d1.yml`、`docs/migration-runbook.md` |
| S31 | 本番の復元可能期間・安全な控え・担当・高 | CloudflareのD1画面と契約プラン、現在の復元点を確認。`pnpm exec wrangler d1 time-travel info <DB名> --config <対象設定>`。実値やDBの書き出しをGit/Slackへ置かない | 分からない：契約・復元点・別保管の有無を未確認。無料7日／有料30日が公式の上限で、古い手順の「30日」を一律に採用しない | `docs/migration-runbook.md`、`scripts/deploy/migrate.ts`、下記Cloudflare公式資料 |
| S32 | 実際に復元できるかの練習・高 | マサトさん承認の使い捨てDBで、架空データの控え→破損→復元→件数・予約・配信状態確認を行い、時間を記録 | 未：DB適用禁止のため復元練習は未実施。[オーナーがやること](#オーナーがやること)のS32に承認・架空データ・破損・復元・確認・記録の手順を記載 | `docs/migration-runbook.md`、`docs/DEPLOY-GATE.md` |
| S33 | D1以外の控え・中 | R2の添付・画像、設定、暗号化鍵の保管と復旧手段を確認する。DBとファイルが同じ時点へ戻せるか確認 | 分からない：D1のTime TravelではR2やsecretは戻らない。別保管・復元の実績は未確認 | `apps/worker/wrangler.toml`、`apps/worker/wrangler.staging.toml`、`docs/line-credential-encryption.md` |
| S34 | 本番と検証の資源を分ける・高 | 2本のwrangler設定でWorker・D1・画像保存先・公開先・環境名を比較する | 済：設定上は別の資源を指定。実際の配備先や秘密の分離はS17・S35 | `apps/worker/wrangler.toml`、`apps/worker/wrangler.staging.toml`、`docs/DEPLOY-GATE.md` |
| S35 | 実際の接続先・顧客データ・外部サービスの分離・高 | Cloudflare、LINE Developers、Stripeの本番／sandbox、Googleのプロジェクト・カレンダー・通知先を管理画面で照合。検証に本番の個人情報がないことも確認 | 分からない：実設定を未取得。設定ファイルが別でも、同じ鍵・通知先・データを使っていない証明にはならない | `apps/worker/wrangler.toml`、`apps/worker/wrangler.staging.toml`、`.github/workflows/deploy-cloudflare-staging.yml` |
| S36 | 本番でテスト用機能を閉じる・高 | 本番設定の `RESTAURANT_TEST_ENABLED` と実効値を担当者が確認。オーナーの方針と照合して修正・再検証する | 済：2026-10-16 kenta。コードでDEPLOY_ENV=productionならtrueでも無効化。管理API・外部通知・sandbox用内部入口をD1へ触る前に404へ（`restaurant-production.security.test.ts`、`environment-features.test.ts`）。cron・受信メールも同じ判定を使い、環境名の欠落・未知の値でも無効。本番設定ファイルのtrueは指示により変更せず、実配備確認と設定整理はオーナー作業 | `apps/worker/wrangler.toml`、`docs/brain/Memory.md`、`apps/worker/src/middleware/feature-enforcement.ts` |
| S37 | 公開リポジトリの扱い・高 | `gh repo view skmtmst/musubo --json visibility`。オーナー側で Settings → General → Danger Zone の非公開化を確認する | 未：リポジトリ名は現在の `skmtmst/musubo` に直した（2026-11-16 kenta、origin の参照先で確認）。非公開化は設定変更なので実施せず、[オーナーがやること](#オーナーがやること)のS37へ。過去のコピーは非公開化では消えない | `AGENTS.md`、この文書の調査記録 |
| S38 | 公開する文書・画像・履歴に個人情報を残さない・高 | オーナーと担当者が現行・過去の顧客資料、スクリーンショット、添付、公開成果物を確認。削除の前に記録保全と必要な連絡を検討する | 未：文書・画像・添付・公開成果物の全履歴点検は未実施。[オーナーがやること](#オーナーがやること)のS38で公開面ごとの担当・保全・確認を指定 | `docs/`、`.github/workflows/`、`.gitignore` |
| S39 | 事故対応を2人で練習する・高 | [事故の手順](INCIDENT-RUNBOOK.md)で、管理画面に入れない場合・誤配信・DB破損を机上練習。緊急停止の対象外も確認する | 未：2人の参加と停止操作の承認が必要で未実施。[オーナーがやること](#オーナーがやること)のS39で机上練習・使い捨て環境での故障・復旧確認を指定 | `apps/worker/src/routes/operations.ts`、`apps/worker/src/services/operation-send-paths.ts`、`docs/DEPLOY-GATE.md` |
| S40 | ドメインを取り返せる管理体制・高 | 登録会社とDNS管理会社を請求・契約画面で確認し、二段階認証・更新期限・回復方法・権限を2人で照合 | 分からない：CloudflareでDNSを使っていても、登録会社が同じとは断定できない | `apps/worker/wrangler.toml`、`docs/security/TWO-FACTOR-SETUP.md` |

## 先に扱う項目と担当案

残る「未・高」は **S07・S15・S21・S26・S32・S37・S38・S39**。S07・S15・S21・S26にも修正・試験はあるが、残条件があるため「済」へ繰り上げない。

| 順番 | 対象 | 次の行動 | 担当案 |
| --- | --- | --- | --- |
| 1 | S21・S23・S36 | DBへ保存する秘密の保護、Slack報告の絞り込み、本番設定の食い違いを修正タスク化 | Codexが実装案、司令塔が割り当て。DB変更は番号ごとに承認 |
| 2 | S26・S27 | 依存の警告と実際の利用条件を確認し、開発PC・CIも含めて対処 | 開発担当・司令塔 |
| 3 | S07・S15 | APIとLIFFの全入口の権限確認を、架空データで実行して証拠を残す | API担当・画面担当 |
| 4 | S19・S38・S37 | 公開物の秘密・個人情報の検査とリポジトリの非公開化（S37） | オーナー・マサトさん・司令塔 |
| 5 | S32・S39、「分からない」12件 | バックアップと事故練習、各サービスの権限・二段階認証・実設定を確認 | オーナー・マサトさん |

## 漏えい対策の強化

強化の案（下の表の「強化N」）のうち、1・2・3・7は **保留**。この9行には数えず、実装・設定変更・催促はしない。残りのコードは司令塔の「公開できる形」の段でまとめる。

| ID | 点検・危なさ | 確かめ方（命令・画面） | 今の状態 | 根拠のファイル |
| --- | --- | --- | --- | --- |
| S41 | 強化4 ログイン不要の入口・高 | [公開入口](PUBLIC-ENTRYPOINTS.md)を実登録と照合。別人・別店・期限切れ・連続取得を架空データで拒否する | 未：全入口を一覧化。短縮リンクの無制限取得を修正。添付画像/動画を含め署名は最長15分へ、明細は認証ヘッダー＋署名へ修正。本人用の取り直しAPI・古いリンクのLIFF案内・送信本文の入口を追加し、別人/別店/削除を拒否する試験を追加。取り直し画面の接続、LINE内表示用URLの期限内の転送、全入口の個別組合せ・公開素材の誤配置は残る（[契約と試験](SIGNED-DOWNLOADS.md)） | `apps/worker/src/middleware/public-referral-rate-limit-security.test.ts`、`routes/public-entrypoints.security.test.ts`、`services/image-access.ts` |
| S42 | 強化5 ログイン失敗・新しい端末・ロボット避け・高 | 同一メールへの失敗を別IPから繰り返す。架空の新端末で監査・通知を確認。全ログイン方法でロボット避けの適用を照合 | 未：コード対応は済。同一メールの10回/15分制限を維持し、パスワードログインにもTurnstile検証を追加。726の端末ハッシュでログアウト後も新端末を検知し、検証では模擬通知だけ。拒否と再通知の実SQLite試験・故障対照を実施。画面のTurnstile接続・実メール到達・実配備の確認は残る | `routes/auth-email.test.ts`、`services/login-device.security.test.ts`、`packages/db/migrations/726_auth_known_devices.sql` |
| S43 | 強化6 WAF・ボット対策・請求急増の知らせ・高 | オーナーがCloudflareのSecurityとNotifications/Billingで対象ホスト・通知先・条件・適用範囲を照合。架空の連続アクセスと通知の試験 | 分からない：配備先の設定・プラン・通知の到達は未確認。オーナー作業欄へ手順を追加 | `apps/worker/src/middleware/rate-limit.ts`、`docs/security/DETECTION.md`、この文書のオーナー手順 |
| S44 | 強化8 危ない操作の直前の本人確認・高 | 削除・権限・鍵再発行・停止・書き出しごとに確認票の欠落/期限切れ/別セッション/再使用を拒否。全危険操作の一覧を照合 | 未：コード対応は済。書き出し・配信/予約/再送・権限変更・代理ログインに共通の再確認を追加し、既存の鍵/MFA/承認の強い確認を維持。未確認/失効/別セッション/再使用と実アプリでの拒否・故障対照を実施。画面全体の再確認の接続と実地確認は残る | `middleware/sensitive-step-up.ts`、`middleware/sensitive-step-up.security.test.ts`、`lib/step-up.ts`、[今回の契約](step-up-and-retention.md) |
| S45 | 強化10 本番のCSP・高 | web/LIFFを通常ビルドし、出力の_headersをHTTP応答へ付けてPlaywrightで実行。強制用ヘッダーで通常表示の違反0と、故意のinline/未知スクリプトの拒否を分けて確認する | 未：静的配信用の強制コードを実装。起動の外部化・動画Worker・実PDFの紙面と文字を実ブラウザで確認。[CSP記録](csp.md)のLINE内の追加窓・Worker HTML・既存のスタイル許可・本番実効値は残る。本番へは未配備 | `apps/web/public/_headers`、`apps/liff/public/_headers`、`scripts/security/csp-policy.test.ts`、`scripts/security/csp-browser.mjs` |
| S46 | 強化9 不要アカウント・権限の毎月の見直し・高 | オーナー2人が毎月、実際のサービスのメンバーと担当表を照合。退職/不要/過大権限を止め、既存セッションと鍵も失効したことを確認 | 分からない：アプリの削除/失効の口はあるが、実際の全アカウント・毎月の実施記録は未確認。オーナー作業欄へ手順を追加 | `apps/worker/src/routes/staff.ts`、`docs/security/TWO-FACTOR-SETUP.md`、この文書のオーナー手順 |
| S47 | 強化11 配備のたびの本番設定の機械点検・高 | 配備前の設定と配備後の実効値を照合。試験用フラグ・公開接続先・secretの型/存在・CSP・署名検証を確認。故意の設定違いで配備判定が失敗すること | 未：配備前に試験用の旗・明示したCORS・全R2の公開設定・必須secretの名前/型を照合する台本をWorker/Admin/検証のworkflowへ追加。実際の検証用設定＋架空の応答で成功、不安全/不明/権限不足で失敗。実配備先の照会と、本番に残る試験用の旗の是正はオーナー作業として残る | `scripts/security/deployment-safety.ts`、`scripts/security/deployment-safety.test.ts`、`.github/workflows/deploy-cloudflare-{worker,admin,staging}.yml` |
| S48 | 強化12 個人情報の期限・自動削除・書き出しの印・高 | 情報の種類ごとに期限と例外を決め、期限前/後と失敗時の再実行を確認。書き出しの操作者・日時の印がファイルから分かるか確認 | 未：店ごとの期限/保留/版付き設定APIと6時間ごとの回答/ブロック済み顧客の削除を追加。既定は無効、日数は案。期限境界/別店/保留/失敗後の再試行と監査失敗の巻き戻しを試験。CSVファイル名・新規明細PDFへ操作者と日時の印。保護履歴の個人情報の残存範囲・端末ハッシュ履歴の期限削除・期限の決定・画面接続と有効化は残る | `routes/personal-data-retention.ts`、`services/personal-data-retention.ts`、`middleware/output-audit.ts`、[保存対象と期限案](step-up-and-retention.md) |
| S49 | 強化13 鍵の入れ替えの練習・高 | 検証の架空鍵を使い、旧鍵停止→新鍵登録→署名/暗号化と通知確認→旧鍵の拒否を練習。復号用の旧鍵を消す前に既存分の移行を確認 | 未：専用の[鍵交換と検証の練習手順](KEY-ROTATION.md)を作成。製品の署名URLとAES-GCMを使う架空鍵の練習で新鍵成功/旧鍵拒否/移行後の復号を確認。検証Workerへのsecret登録と実地練習は未実施 | `docs/security/KEY-ROTATION.md`、`services/key-rotation-drill.test.ts` |

## 依存の確認

S26は未のまま。過去の監査結果を現在の依存の安全性の証明に使わず、公開する版で `pnpm audit` と製品の利用経路を再確認する。大きな版上げ・未修正版・回避策・担当と期限は司令塔が判断する。古い監査の数値と更新経緯は外部保管に残す。

## コード整理との分担・既存手順

手元の `~/lh-work/design/v8/review/CLEANUP-PLAN-1016.md` の**④（§4「何も見張っていない試験・古い失敗」T01〜T03）**を参照する。この文書はリポジトリ外で、GitHubからは直接読めない。司令塔が手元の計画と対応付ける。

S07・S15・S22・S24・S28の「試験が本当の故障を見付けるか」は整理側のT01と重なる。旧い文字の確認だけを減らす場合も、権限・署名・本人確認・停止・失敗の動作試験は先に残す。整理で試験を消して安全対策済みにはしない。依存更新や秘密管理の修正を単なる不要コード削除へ混ぜない。

- [配備の承認・排他](../DEPLOY-GATE.md)：本番はマサトさんの明示承認と担当指定。現行AGENTS.mdの司令塔運用を優先する。
- [DBの移行と復元](../migration-runbook.md)：旧日付の件数・未適用番号・PR例を現在の状態として使わない。
- [LINEの秘密の暗号化](../line-credential-encryption.md)、[Meet完了通知](../meet-callback-security.md)。
- [D1のTime Travel公式資料](https://developers.cloudflare.com/d1/reference/time-travel/)：保持期間はプラン別。S31は契約画面でも確認する（2026-10-16参照）。

更新時は行に担当・確認日・秘密を除いた証拠を足し、集計と[入口](README.md)を同時に更新する。


## オーナーがやること

以下はオーナー側に残る作業。S19の一時点の履歴検査は実施済みで、公開直前の再検査とGitHubの監視設定は別。担当案はケンタさん・マサトさん、操作役は司令塔と相談して指定。実行日・対象環境・結果・秘密を除いた証拠だけを各行へ追記する。値・顧客本文・認証画面・復元点は貼らない。

| ID | 手順 | 完了の条件・故障の確かめ方 |
| --- | --- | --- |
| S17・S41 | 配備前に取得URL署名の既存binding `API_KEY` をsecretとして登録済みか、名前・型・存在だけで確認する。実値の取得や今回の登録変更はしない。過去の署名なしリンクは本文を返さずLIFFへ案内する。本人用の取り直しAPIと送信本文の入口は用意済み。LIFFの取り直し画面を接続し、本人・別人・別店で確認する（SIGNED-DOWNLOADS.md） | 検証で鍵なしは保存前503、署名なし/改ざん/15分後は取得403。元の会話の読み直しだけでURLを更新でき、他の会話では更新できない。実配備の存在確認は未。本人用の取得URLはBearerも必須。LINE内の写真/動画表示用URLの15分内の転送は制約として残る。LIFFの取り直し画面はClaude担当の残件 |
| S19 | 今回のGitleaks 8.30.1による全参照検査と故障対照は済。公開直前に承認済みの端末で同じ版と検出設定を固定して再検査。全対象remoteの枝・tagを取得して対象ref数を記録し、`gitleaks git --redact=100 --log-opts="--all" .` を実行。レポートと標準出力はGit/Slack外の権限を絞った保管先へ。GitHub SecurityのSecret scanning・push protectionの利用可否と有効範囲も確認 | 別の使い捨てrepoで架空の検出対象を過去commit→削除し、全履歴検査が終了1になることを先に確認。問題発見時は種類・場所だけ記録し旧鍵を失効。検査の終了値と全対象refの網羅を確認してから済。画像内の秘密はS38で目視。[公式の使い方](https://github.com/gitleaks/gitleaks#usage) |
| S21 | 環境ごとに別の32バイト鍵を安全な端末で生成し、Worker secret `GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY` へ標準入力またはCloudflareの秘密設定画面で登録（通常変数・引数・履歴・ログへ置かない）。承認・控えを整え、既存平文はGoogleで失効後に暗号化対応した接続口から再登録し、旧接続と控えの扱いを確認。既存予約のconnection_id参照の付替えは別途承認済み移行手順を用意し、先に削除しない | 新規3種の暗号化と旧平文件数0を値なしの件数で確認。検証用接続で鍵欠落・改ざん時に保存/Google呼出しが止まることを確認。既存接続はこの修正後500で停止するため、secret設定と移行準備なしで配備しない。手順の詳細は修正記録 |
| S26 | 開発依存の大きい更新は司令塔が承認し、Vitest 4.1.11への更新でCriticalは0。bracesの上流修正版を確認し、公開後に更新。現行のlintではnext.rootDirを未指定のまま保ち、外部入力からパターンを作らない | 現在Critical 0 / High 1。旧Vitest・危険なtinypoolを混ぜる試験と、globの解析経路を再開すると落ちる試験で再発を防ぐ。Highは未解消として公開判断に残す |
| S32 | マサトさんが使い捨てDBと操作役を承認。本番データを使わず架空の友だち・予約・配信状態を作り、控え/復元点を取得。件数と状態を控え、故障（予約の変更・削除）を入れ、復元して同じ確認を繰り返す。送信は無効のまま | 故障後の確認は失敗し、復元後は件数・予約・配信状態が一致。開始/終了/所要時間と担当を記録。戻せない場合は未。復元点の実値とDBの中身は非公開保管 |
| S36 | コード反映時にDEPLOY_ENV=productionを値の種類だけで確認する。設定ファイルは本番false・検証trueの分離済み（wrangler.toml:47,52とwrangler.staging.toml:67,73で確認、2026-11-16 kenta）。本番の設定や配備は今回は変更していない | 配備後に管理API・通知入口・内部sandbox入口が404、飲食店cron/予約メールも停止。架空の検証でstagingだけ動く。単に設定ファイルを直しただけでは実配備確認に数えない |
| S37 | オーナー/マサトさんがGitHub Settings → General → Danger Zone → Change repository visibilityで非公開化を実施し、共同開発者・Actions・Pagesへの影響を確認 | `gh repo view skmtmst/musubo --json visibility` がPRIVATE。未ログインの別ブラウザでソースが読めない。Pages等の公開は別に確認。過去のコピーや漏れた鍵は回収できないためS19/S38も続ける |
| S38 | 現在の枝・公開していた枝/tag・削除済み文書・画像・添付に加え、Releases/Actions artifacts/Pagesの公開物を一覧化し、文字は検査、画像/動画は目視。顧客資料は担当者が非公開環境で照合。記録保全と必要な連絡を決めてから公開停止・削除を実施 | 別の架空画像・架空顧客文書を混ぜた検査対象で、文字/目視の両方が見付けることを先に確認。対象件数・担当・確認結果だけ記録。履歴の書換え・forceは禁止のまま、既存履歴の扱いは司令塔へ |
| S39 | 2人で「全員ログインできない」「誤配信」「秘密漏えい」「DB破損」を各15分の机上練習。[気づく仕組みの反映](#気づく仕組みの反映上の49項目とは別)の時間割と案内の型も使い、1時間/24時間/72時間の担当を確認。連絡網、手動返信など停止対象外、承認先、戻す版とDBの互換性を確認。承認した使い捨て環境で停止/復元を試す | 故障中は確認失敗、停止後は新しい自動送信0、復元後の予約/配信状態が一致。連絡不能の代替手段と実測時間を記録。実客への送信や本番停止を練習に使わない |
| S43 | Cloudflareで本番のWeb・LIFF・APIの対象ホストを確認し、SecurityのWAF/ボット対策/回数制限の利用可能範囲と現在の設定を記録。LINE/Stripe等の正規通知を誤って遮らない条件を先に決める。Notifications/Billingで利用量・費用急増の通知条件、受信先、代理担当を確認。変更と試験はオーナー承認後 | 検証の架空アクセスで遮断/通知、正規の通知を想定した試験が通る。請求通知の試し送信を受領し、日付・対象・条件・担当だけ記録。プラン上できない監視は代わりの確認時刻を決める。今回は設定を変更しない |
| S46 | 毎月の最初の営業日に2人でGitHub/Cloudflare/Google/LINE/Stripe/Slack/ドメインとmusuboの利用者・招待・役割・鍵を照合。不要な権限を止める対象と代替担当を決め、承認後にセッション・鍵も失効。最後の管理者と復旧手段を失わない順で行う | 架空の停止済みアカウントでログイン/API操作が拒否され、担当者が必要な操作を続けられる。実施月・対象サービス・役割・対応結果・次回日だけ記録。メールアドレスや鍵をGit/Slackへ載せない |

### 気づく仕組みの反映（上の49項目とは別）

- [ ] 司令塔が691の採番の衝突を再確認し、承認・クリーン確認・控え・dry-runを終えてからDBへ適用する。本作業では作成のみ。既存監査の時刻索引も追加するため、所要時間と対象を先に確認する。
- [ ] 司令塔がコードを検証へ配備し、Claudeが[API契約](SECURITY-MONITOR-CONTRACT.md)に沿って運用状態の要対応へ接続する。未取得・監視停止・Slack未設定を正常表示しない。
- [ ] オーナーが通知先と担当の連絡網、基準値を確認する。架空記録で警告→Slack→受領→解消→新しい操作で再発を確認し、既存の古い記録だけでは再発しないことも確認する。
- [ ] オーナーがCloudflare側の監視停止・全HTTPの急増・署名失敗、GitHubの秘密混入、外部サービスの鍵変更を見張る。今回の監査集計外の項目は[DETECTION](DETECTION.md)に沿って担当と確認時刻を決める。
- [ ] 「わな」の値は検証だけの案。採用する場合は実在の権限や友だちを使わず、1回の接触で必ず通知し、値を出さず、本番で有効化できないことを先に確認する。

## 漏えい対策の強化で残るオーナー作業

- 726の番号とSQLを確認し、通常のバックアップ・承認・dry-runを経て検証へ適用する。この組は適用しない。
- 検証の配備資格情報にWorker設定とR2の読取権限があるか確かめ、`deployment-safety.ts staging apps/worker/wrangler.staging.toml` を値を出さずに実行する。手元はAPI token未設定のため未実施。
- 本番に残るWorkerとAdminの試験用フラグは新しい点検で停止対象。設定を変える判断と反映はオーナー。今回のコードで点検を迂回しない。
- 店ごとに保存期限の案・保留対象・会計等に残る個人情報を確認し、設定APIの版と本人確認を使って有効化する。既定は無効。
- Claude担当がTurnstile・追加の本人確認・保存期限の画面を契約どおりにつなぎ、架空データで確認する。
- [鍵交換の練習](KEY-ROTATION.md)を検証環境で担当2人が実施し、旧鍵拒否・復号・通知の結果だけ記録する。本番の鍵には触らない。
