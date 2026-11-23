> 文書：デプロイ安全ゲートと排他運用｜区分：今の正本｜最終確認：2026-11-05（日本時間）

# デプロイ安全ゲートと排他運用

2026-08-14 に masato / kenta で合意した、2人以上で並行開発するときの運用ルールです。
`AGENTS.md` のゲートを、共同開発の状況に合わせて具体化したものです。

## なぜ必要か

検証環境は1組しかありません。

| 種別 | 検証 | 本番 |
| --- | --- | --- |
| Worker | `nen-line-stg` | `nen-line` |
| D1 | `nen-line-stg` | `nen-line` |
| R2（画像） | `nen-line-stg-images` | `nen-line-images` |
| R2（予約メール原文・非公開） | `musubo-raw-mail-stg` | `musubo-raw-mail` |
| 管理画面 Pages | `nen-line-stg-admin-git` | `nen-line-admin-98712679` |
| LINEチャネル | `然-NEN- TEST` | 本番アカウント |

コードはブランチで分けられますが、**検証環境は分けられません**。
片方が検証している最中にもう片方がデプロイすると、テスト結果が無効になり、
LINEのテスト通知も混ざります。だから排他制御が要ります。

## ブランチの役割

| ブランチ | 役割 |
| --- | --- |
| `codex/<担当者名>-<作業内容>` | 個人の作業ブランチ。ここで実装する |
| `codex/development` | 開発・検証環境の統合版 |
| `main` | 検証合格後、本番へ反映してよい確定版 |

デプロイの基準ブランチは**環境ごとに違います**。

| デプロイ先 | 基準ブランチ | wrangler 設定 |
| --- | --- | --- |
| 検証 (`staging`) | `codex/development` | `apps/worker/wrangler.staging.toml` |
| 本番 (`production`) | `main` | `apps/worker/wrangler.toml` |

本番を `codex/development` から出すと未検証の変更が本番へ入り、
検証を `main` から出すと検証そのものが成立しません。preflight は両方を拒否します。

- `codex/development` への直接 push は禁止。PR経由のみ。
- `codex/development` は、条件を確認できた開発者が自分でマージしてよい。
- `main` への反映は masato の承認が必要。
- `LINE_HARNESS_CLOUDFLARE_DEPLOY` は当面未設定のまま。安全なリリース手順が
  確立するまで自動本番デプロイは有効化しない。

## 設定（PC・環境ごとに違う値）

既定値をコードに埋め込んでいません。**確認できない値があれば実行を止めます**。

| 値 | 指定方法 | 既定 |
| --- | --- | --- |
| 親のEC-CUBEリポジトリ | `--parent-repo <path>` または `LINE_HARNESS_PARENT_REPO` | **なし（必須）** |
| デプロイ対象remote | `--remote <name>` または `LINE_HARNESS_DEPLOY_REMOTE` | `origin`（実在を確認） |

親リポジトリのパスはPCごとに違うため既定値を持ちません。
remote名もフォーク環境によって `origin` だったり `fork` だったりするため、
指定値が `git remote` に無ければ推測せずに停止します。

`~/.zshrc` などに書いておくと毎回指定せずに済みます。

```bash
export LINE_HARNESS_PARENT_REPO="$HOME/path/to/nen-petfood-eccube"
export LINE_HARNESS_DEPLOY_REMOTE=origin
```

## 全チャット共通の配備手順（2026-11-05 Masato指示）

共有検証環境は **最新 `codex/development` の共通Actionsだけ**から配備する。
本番準備用の固定版・個別ブランチ・旧workflowの再実行で上書きしない。
以前の一度限りの例外や承認より、この巻き戻し禁止指示を優先する。
固定版の検証は独立プレビューまたは専用環境で行い、環境の新設・認証変更は別途確認する。

1. 最新開発版へPR統合し、必要な検査を成功させる。
2. `deploy-cloudflare-staging.yml` を同じ開発SHAで `mode=dry-run`、その後 `mode=apply` として申請する。
3. `cloudflare-staging` の `queue: max` で全チャット・開発者の申請を順に待つ。実行中・先行待機の依頼を取り消して割り込まない。GitHubの待機上限やActions予算で拒否されたら、未受付・未配備と報告する。
4. 順番が来たらworkflowが `refs/deploy-locks/staging` を取得する。手元で先にロックを取らず、他人のロックを削除しない。取得できなければ停止・保持者確認とする。
5. ロック取得後と各公開操作の直前に最新開発SHAとWorker・管理画面両方の公開SHAを確認する。候補は両公開版を祖先として含む必要がある。取得不能・不明SHA・古い候補・分岐版なら配備せず、差分統合と再検査からやり直す。
6. ソース固定の設定再配備は、現在公開中と同一SHA・配備IDだけを許可する。履歴確認も省略しない。
7. 公開後は両公開SHAと対象機能を確認し、ロックを解放した記録を共有する。一部失敗なら未完了として報告し、後続の統合版で回復する。

ローカル `staging-deploy.sh` とWorkers Buildsの `cf-staging-deploy.sh` はdry-run／plan専用とし、`apply` は停止する。直接のwranglerや別のキューでこの手順を迂回しない。CI・課金停止は新しい有料利用や安全ゲート迂回の許可ではない。

GitHub `staging` Environmentの許可元も `codex/development` のブランチだけに限定する。これは古いブランチ内のworkflowに書かれた一時例外より外側で拒否する設定である。公開中のSHAが既に開発版から分岐している場合も自動例外は作らず、差分を整理するまで停止する。

GitHubのキューは最大100件で、満杯時は新しい申請が拒否される。申請が失われたまま完了と扱わず、起動・待機・成功を区別する。本番の共通 `cloudflare-production` も `queue: max` で順番に処理し、既存の承認・固定候補・DBの安全確認を維持する。

仕様の根拠：[GitHubの順番待ち](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[Environmentの配備元制限](https://docs.github.com/en/rest/deployments/branch-policies)。

## ロックの仕組みと制限

**取得**：空の orphan commit を `refs/deploy-locks/<env>` へ push します。
既に埋まっていればサーバーが非fast-forwardとして拒否するため、
「確認してから書く」方式の競合が起きません。
git plumbing だけを使うので、**ロック取得で作業ツリーが汚れません**。

**解放**：読み取ったロックrefのSHAを `--force-with-lease=<ref>:<SHA>` で渡し、
**refが変わっていない場合だけ削除**します。
これが無いと、ロックを読んでから削除するまでの間に別の担当者が取得し直した場合、
その新しいロックを消してしまいます（相手のデプロイ中に排他が外れる）。
SHAが変わっていた場合は削除せず、現在の保持者を確認するよう促します。

**他人のロック**は既定では解放できません（`--force` が必要）。

**古いロック**は `status` で「放置の可能性あり」と表示されますが（90分）、
**時間経過での自動解放はしません**。デプロイ継続中か中断かは人が判断すべきだからです。

### GitHub Actions のロック（2026-10-13 修正）

`deploy-cloudflare-staging.yml` は `DELIVERY_MODE=apply` のときだけロックを取得し、
run が終わる段で解放します。この解放の段は
**`always() && steps.staging_lock.outcome == 'success'`** です。

- 途中の段が失敗・中断しても解放します。ロックは「いま配備中」の宣言であり、
  run が終わった時点で配備している人はいないためです。
  途中まで反映された事実は run の失敗と `Summarize` の出力が示します。
- 取得していない run（`outcome != success`）は解放しません。
  他担当のロックに触れないためです。

**workflow を使うなら、手元で先にロックを取らないでください。**
ロックは「空いているrefへのpush」で取るので、自分が先に取っていても
workflow 側の取得は `lock-held-by-other` 相当で失敗します。
自分のロックだから通るということはありません。
手元の `pnpm deploy:staging -- --apply` は2026-11-05から禁止している。
共通Actionsだけが取得・配備・公開確認・解放を担当する。旧手順のロック取得や
直接配備を復活させてはならない。

run [38894823582](https://github.com/skmtmst/line-harness-oss/actions/runs/38894823582) が
これで落ちました。手元のロックを取った状態で workflow を起動したため、
**コードの公開処理に入る前**に取得の段で停止しています（配備は未実施）。

以前はここが `success()` だったため、**取得後に1段でも失敗すると解放が飛ばされ、
誰も配備していないのにロックが残り続けました**。
run [38250060610](https://github.com/skmtmst/line-harness-oss/actions/runs/38250060610) で
Worker の配備は成功、管理画面が Cloudflare 側の `Unknown internal error occurred` で失敗し、
staging のロックが242分残留してその間の配備が全部止まりました。
`scripts/deploy/staging-actions-workflow.test.ts` が `success()` への差し戻しを拒否します。

残ってしまったロックの扱いは人の判断です。保持者に解放してもらうか、
**保持者と状況を確認した上で** `pnpm deploy:lock release staging --force` を使います。

## 事前確認（preflight）が見ているもの

`scripts/deploy/preflight.ts` は次を確認し、違反を全件まとめて表示します。

| コード | 内容 |
| --- | --- |
| `dirty-worktree` | LINEリポジトリに未コミット変更・未追跡ファイルがある |
| `parent-repo-unspecified` | 親のEC-CUBEリポジトリが指定されていない |
| `parent-repo-missing` | 指定されたパスにリポジトリが見つからない |
| `parent-dirty-worktree` | 親のEC-CUBEリポジトリに未コミット変更がある |
| `wrong-branch` | その環境の基準ブランチ以外からデプロイしようとしている |
| `head-behind-remote` | ローカルHEADが `<remote>/<基準ブランチ>` と一致しない |
| `config-env-mismatch` | 環境と wrangler 設定ファイルの組み合わせが違う |
| `production-approval-missing` | 本番デプロイに `--approved-by` がない |
| `production-approval-invalid` | 承認者として認められていないログインが指定された |
| `production-approval-ref-missing` | 本番デプロイに `--approval-ref`（承認記録URL）がない |
| `lock-not-held` | デプロイロックを取得していない |
| `lock-held-by-other` | 別の開発者が使用中 |
| `lock-sha-mismatch` | 宣言した対象コミットと実際のデプロイ対象が違う |

`head-behind-remote` は並行開発で最も重要です。
これが出たら、共同開発者の更新が入っています。取り込んでテストをやり直してください。
古いテスト結果のまま反映してはいけません。

## 本番デプロイ

原則として masato 専任です。

本番候補の40桁SHAには、Workerと管理画面の両方を配備し、公開SHAを照合して成功した
過去の検証Actions run IDを添えます。検証環境はその後も更新してよく、本番の事前検査は
**現在公開中の検証SHAとの一致を要求しません**。候補を再確認するときに共有検証環境を
古い版で上書きせず、独立プレビューを使います。本番用の`main`は候補を含み、
ソース全体が同じ内容であることを引き続き確認します。

Cloudflare の本番アクセス権限があること自体は、本番変更の承認ではありません。
kenta は調査・差分確認・dry-run・手順準備まで進められますが、
本番への適用は masato の明示的な承認と担当指定がある場合だけ実施します。

### `--approved-by` は承認の証明ではない

スクリプト上、本番は次の2つを要求します。

```bash
pnpm deploy:preflight production \
  --approved-by skmtmst \
  --approval-ref https://github.com/skmtmst/line-harness-oss/pull/123#issuecomment-456
```

- `PRODUCTION_APPROVERS` は GitHub ログインの `skmtmst` のみです。
  表示名（`masato` など）は使いません。承認者の同定はログインに統一します。
- **`--approved-by` は実行者が自分で入力できるため、それ単独では
  masato の承認を技術的に証明しません。** 入力ミスと勘違いを防ぐ安全確認です。
- したがって `--approval-ref` で**承認記録のURL**を必須にしています。
  PRコメントなど、承認が実際に残っている場所を指定してください。
- **本番実行前には、この承認記録が別途必要です。** スクリプトが通ったことは
  承認があったことを意味しません。

## マイグレーションの採番

`packages/db/migrations` は3桁連番です。並行開発では必ず番号を取り合うため、
**着手前に宣言して予約する**方式にします。

1. 最新の upstream と `codex/development` を取得してから次番号を確認する
2. 着手前に「番号・機能名・担当者」を共有する
3. 先に宣言した人がその番号を使う
4. マージ前に同じ番号が追加されていた場合、**まだ適用していない自分側**を採番し直す
5. 検証・本番へ適用済みのマイグレーションは改名・書き換えしない

担当者ごとの番号帯は、将来の upstream 採番と衝突するため使いません。

なお `scripts/check-migrations.ts` が additive-only ポリシー（`DROP TABLE` /
`DROP COLUMN` / `RENAME` / `DEFAULT` なし `NOT NULL` などの禁止）を静的検査します。

### 表の作り直し（CHECK 制約を変えるとき）

SQLite は CHECK を後から変えられません。種別を1つ増やすだけでも、
**新しい表を作る → 中身を写す → 古い表を落とす → 名前を付け替える**しか手がなく、
途中に `DROP TABLE` と `RENAME TO` が必ず入ります。

そのため、ファイルに次の1行を書いた場合だけ、この2つを見逃します。

```sql
-- migration-policy: table-rebuild
```

書けば何でも通るわけではありません。

- `<表名>_new` を作って、同じ `<表名>` を落として、`<表名>_new` を `<表名>` へ改名する、
  という**組になっていないと通りません**
- 作り直しと関係ない禁止事項（`DROP COLUMN` など）は、印があっても止まります
- 意図した作り直しは `grep 'table-rebuild' packages/db/migrations/` で全部数えられます

**落とすのと改名するのは、必ず同じファイルに書いてください。** 当てる仕組みは
ファイルごとに `wrangler d1 execute --file` を呼ぶので、ファイルの境目が
そのまま「その表が存在しない時間」になります。同じファイルなら1回の呼び出しで
済み、その隙間が消えます。

**索引は貼り直しになるので、名前を毎回変えてください。** 適用の要否を
「いま索引があるか」で判定する仕組みは、表を落とす前の状態を見て「もうある」と
判断し、その行を飛ばします。飛ばされると索引が消えたまま戻りません
（136 で実際に踏みました）。

### 新しいコードを配り終えてから当てる分（順番待ち）

検証配備（`deploy-cloudflare-staging.yml` の `Count pending staging D1 migrations`）は
`packages/db/migrations/*.sql` を数え、検証D1に未適用が1件でもあれば Worker 配備を
止めます。この見張りは緩めません。

そのため段階移行で「新しいコードを配り終えてから当てる分」がある場合、その分は
`packages/db/migrations/` に**まだ入れず** `packages/db/migrations-pending/` で
順番待ちさせます。置き方と移し方は `packages/db/migrations-pending/README.md`。

```
前半を当てる → 未適用0 → 新Workerを配る → 互換性を確かめる
  → 後続PRで pending から migrations/ へ移す → 当てる → 未適用0
```

後続PRをマージしてから当てるまでのあいだは未適用が1件になるので、そのあいだ
Worker 配備は止まります（当てれば解けます）。互換性の確認を終えてから移してください。

`migrations-pending/` に居るあいだは `check-migrations.ts` の静的検査と
`bootstrap.sql` の対象外です。`migrations/` へ移した後に
`pnpm --dir packages/db generate:bootstrap` と DB の試験を通してください。

## CI

`.github/workflows/deploy-scripts-ci.yml` が、`scripts/**`・`package.json`・
`.github/workflows/**` に触るPRで次を自動実行します。

- `pnpm test:scripts`（デプロイロックのgit実挙動テストを含む）
- TypeScript 型検査（`scripts/tsconfig.json`）
- `bash -n`（`scripts/**/*.sh` 全件）
- workflow YAML の構文検査と、各 run ステップのシェル構文検査

型検査に必要な `@types/node` は、リポジトリの依存には追加せず CI 内の一時領域へ入れています。
root へ追加すると、`packageManager` の pin より新しい pnpm で生成された
`pnpm-lock.yaml` が広範囲に書き換わるためです。

## upstream 取り込み

`.github/workflows/update-from-upstream.yml` が毎日 JST 4:17 に、
本家 `Shudesu/line-harness-oss` の main を取り込む PR を作ります。

- 起点・宛先ともに `codex/development`
- マージもデプロイも自動では行わない
- 一次確認: kenta / 最終確認・バックアップ: masato

溜めると一気に競合するので、その日のうちに一次確認します。

## 担当領域

同じ画面を2人で同時に触ると必ず競合します。現在は、管理メニューの上側と下側に
作業範囲を分けて、着手時点から変更箇所が重ならないようにします。

- kenta: 管理メニューを上から順に進め、各画面の機能実装とデザイン実装を担当する
- masato: 管理メニューを下から順に進め、各画面の機能実装とデザイン実装を担当する
- masato 側のデザインも仮置きとは限らず、確認結果によってそのまま正式採用できる
- 担当の境界に近いメニュー、サイドバー、共通レイアウト、共通部品へ着手する前だけ、
  どちらが変更するかを共有してから作業する

この分担は「先にpushした側を優先し、後からもう一方が整合する」という意味ではありません。
最初から変更範囲を分け、同じ画面と共通部品を同時に変更しないための分担です。
個別ブランチでの実装・push・PR作成は並行して進められますが、PR統合と検証環境への
デプロイは、この文書と `AGENTS.md` のゲートに従って順番に行います。

## 関連文書

- `AGENTS.md` — 上位の運用ルール
- `docs/NEN-LINE-STAGING.md` — 検証環境の構成と接続情報
- `docs/admin-ui-design-guidelines.md` — 管理画面のデザイン基準

## 並行で作業するとき

- 作業ごとに専用のworktreeとブランチを使い、依存を `pnpm install --frozen-lockfile` で導入する。
- 共有パッケージを先にビルドし、古いdistや別の作業場所の出力を合格の証拠に使わない。
- 反映履歴・マイグレーションの採番・同時統合の扱いは `AGENTS.md` の現行手順に従う。過去の衝突記録から別の規則を作らない。
- 開始・コミット前後・DB更新前・配備前後にクリーン状態とSHAを確認する。DB更新・配備・ロックは上の独立した関門を保つ。
- 試験の実行終了と失敗件数を確かめ、日時の処理は異なるTZでも確認する。旧作業の失敗例と件数は[外部保管](document-archives.md#s05)へ分離した。
