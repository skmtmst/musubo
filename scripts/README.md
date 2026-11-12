> 文書：運用と検査の台本｜区分：今の説明｜最終確認：2026-10-19（日本時間）

# 運用と検査の台本

リポジトリ直下から実行します。用途ごとに入口を探し、実DB・配備・通知を伴う命令は、その作業の承認手順に従います。

| 場所 | 役目・入口 |
|---|---|
| `codex/doctor.sh` | 作業開始前の環境確認。手元では `DOCTOR_LOCAL=1 bash scripts/codex/doctor.sh` |
| `db/` | 移行の安全検査、データを変えない移行調査、認証情報の移行。安全検査は `pnpm exec tsx scripts/check-migrations.ts` |
| `deploy/` | 配備ロック、事前検査、staging、本番公開の順序、CLIの隔離実行 |
| `release/` | 配布物・更新manifestの組み立てと試験 |
| `slack/` | 既存の作業報告・PR同期の入口と試験 |
| `browser/` | 認証・EC取込の独立したPlaywright設定、LIFFの復帰・受信失敗の動作検査 |
| `security/` | Workflow接続・本番公開順序・見出し・外部通信・依存の安全検査 |
| `verification/` | 検証環境の運用経路の確認。実行条件・読取専用の契約は各台本の説明に従う |
| `visual-qa/` | 合成データ、模擬API、撮影、崩れと共通部品の検査 |
| `recovery/` | 日付・対象が限定された復旧。自動呼出しがなくても復旧手順として保持 |
| `observability/` | エラー番号の文書生成 |

`pnpm test:scripts` は移動後も `scripts/**/*.test.ts` と共有の単体試験を収集します。前提となる共有パッケージは `pnpm --filter @line-crm/shared build` で用意します。型検査は `pnpm typecheck:scripts` です。全体の重い検査・ビルド・ブラウザは司令塔の `heavy.sh` を通します。

移行調査の入口は `pnpm db:dry-run-automations`・`pnpm db:dry-run-analytics`・`pnpm db:dry-run-funnels` です。従来の `db:dry-run-v6-*` も同じ入口へ接続し、運用中の呼出しを保っています。これらを整理作業の確認のために実DBへ実行する必要はありません。

`check-migrations.ts` は外部HQのci-all.shが使うため元のCLI入口を保持します。郵便データは `db/fetch-jp-postal-data.*`、画面の待ち合わせは `browser/overlay-ready.mjs` へ、アプリ・パッケージの利用元と同時に移しました。見た目の比較地図・外部の撮影命令・安全な失敗の対照で使うIDや機械コードは、経緯だけのコメントと区別して保持します。

構成の決まりは [コードの構成と名前](../docs/code-structure.md)。`pnpm exec tsx scripts/structure/check.ts` が名前・公開入口・循環を検査し、`pnpm test:scripts` がその故障対照を実行します。

品質の後戻りは `pnpm quality:check --base <PRのbase SHA>`、違反を減らした後の実測更新は `pnpm quality:update --base <同じSHA>`、故障対照は `pnpm quality:test`。新しい入口は `pnpm new:screen <name> --title <title> --board <ID>`・`pnpm new:route <name> --method get` で生成します。先に `--dry-run` で保存先を確かめます。詳細は構成の正本を参照してください。

ホームの初回待機は `node apps/web/scripts/v8-guard/browser-host.mjs --test --test-concurrency=1 apps/web/scripts/v8-guard/home-pending-heading.test.mjs` で、認証中は通常メニューと画面の見出しを出さず、認証後の待機から到着までは見出しを毎フレーム確かめます。`V8_GUARD_BASE` に本番形式の出力の配信先、`V8_GUARD_ARTIFACT_DIR` に保存先、`V8_GUARD_VIDEO=1` で動画を指定します。既定は6スタイル・1152/1440・API遅延0/600msです。`V8_GUARD_HOME_HEADING_FAULT=1 HOME_STYLES=standard HOME_DELAYS=600` は待機の見出しをCSSで隠す故障の対照で、赤になることを確認してから旗を外して再実行します。

窓の下の帯は `pnpm test:scripts scripts/visual-qa/dialog-footer-contract.test.ts` が全画面の自前帯と参照だけの閉じる帯を検査します。実窓は `node apps/web/scripts/v8-guard/browser-host.mjs --test --test-concurrency=1 apps/web/scripts/v8-guard/dialog-footer.test.mjs`、題と札・失敗の重複・設定ナビ・手順の焦点・状態セルは同じ入口の `patrol-layout.test.mjs` です。上と同じ配信先・保存先・動画の環境変数を使い、各検査は故障を入れて赤になることと復元後の緑も必須で確認します。設定ナビは1024/1152/1440、窓などは1152/1440を測ります。

予約送信の入力不足は `node apps/web/scripts/v8-guard/browser-host.mjs --test --test-concurrency=1 apps/web/scripts/v8-guard/scheduled-message.test.mjs` で受信箱と友だち一覧を2幅で操作し、押せない主操作・理由1行・通常の緑との差を検査します。日時の過去判定は既存の処理とAPIが担当します。

### 初期リッチメニュー画像

`node scripts/rich-menu/build-initial-images.mjs` は共有の4面定義から、LINEへのアップロードと管理画面の見本で使うPNGを再生成する。WebのNext.jsが依存するSharpとTypeScriptを使う。業種のラベル・順序・色を変えた時だけ実行し、画像寸法と実際の公開用座標の一致を試験・写真で確認する。

`visual-qa/initial-menu-layout.mjs` はページ・ダイアログ共通の初期メニューを実際の寸法で確認する。画像の文字12px以上・横はみ出し0・広い欄での見本と説明の左右配置を守り、`capture.spec.mjs` からも使う。判定器の故障対照は `pnpm test:scripts scripts/visual-qa/initial-menu-layout.test.ts`。
画像のJSONはこの生成器だけで作り、手では編集しません。内容を変える時は `INITIAL_MENU_VERSION` を上げます。同じ版のまま内容を変えると生成器が止まります。`pnpm test:scripts scripts/rich-menu/image-version.test.ts` でこの判定を確認します。

入口の空の待機は `pnpm test:scripts scripts/visual-qa/route-pending-contract.test.ts` が全appを検査します。fallback省略・null・undefined・false・空文字・空fragmentは赤、認証のカードと共通PagePendingは可です。外枠と入口の題と型は `apps/web/src/lib/route-pending.ts` で共有し、固定の題は実画面到着後にも一致を確かめます。

入口の待機と題は `node apps/web/scripts/v8-guard/browser-host.mjs --test --test-concurrency=1 apps/web/scripts/v8-guard/route-pending.test.mjs` で共有表の全入口を2幅・API遅延600msで開き、認証中の通常メニュー非表示、認証後の待機フレームの題、固定の題の到着後の一致を確かめます。`V8_GUARD_ROUTE_PENDING_FAULT=1 ROUTE_PENDING_PATHS=/friends` は題をCSSで隠す故障で赤、旗を外すと緑です。

スタイル切り替えの固定は同じ入口の `style-switcher.test.mjs` が、登録とはじめの設定を1152/1440/390で操作します。本文の上・下で切り替えが題の下に残り、見るだけでは保存せず、次の問から戻っても窓内に焦点が残ることを確かめます。本文へ移す故障で赤、元の帯へ戻して緑も必須です。390はオーナーが指定した狭い幅の範囲です。

### 共有検証環境への配備

配備は共通Actionsの順番待ちだけで行います。`deploy/verify-staging-forward.mjs` が最新開発版と両公開版のGit履歴をロック取得後・各公開直前に確認します。手元とWorkers Buildsの配備スクリプトはdry-run／plan専用です。動作試験は `pnpm test:scripts scripts/deploy/verify-staging-forward.test.ts`、運用の正本は [共通配備手順](../docs/DEPLOY-GATE.md) です。
