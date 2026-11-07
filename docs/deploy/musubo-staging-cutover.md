> 文書：musubo 新リポジトリへの共有検証配備の切り替え｜区分：現行手順・実施記録｜最終確認：2026-11-07（日本時間）

# 共有検証配備の切り替え

`skmtmst/musubo` は新規開発と共有検証配備の基準リポジトリ。2026-11-07 に検証 Worker と管理画面を新リポジトリの公式 workflow から配備した。この節が現行状態であり、後半の「切り替え前」は当時の判断と証拠を残した履歴である。配備のたびに実際の設定・公開 SHA・先行実行を取り直し、ここに書いた SHA を現在値として流用しない。

## 2026-11-07 の切り替え完了記録

| 項目 | 確認した結果 |
| --- | --- |
| 新 `codex/development` | `a385be7fb2044e753138d8548fbd766b6f41a1e9`。切り替え直前の検証公開版 `20bfff7251a5543c7da103c188ea18c8db89aff2` を履歴に含み、`apps` と `packages` の差分はない |
| 新配備 workflow | `deploy-cloudflare-staging.yml` は有効。対象 SHA の [dry-run](https://github.com/skmtmst/musubo/actions/runs/42365634576) と [apply](https://github.com/skmtmst/musubo/actions/runs/42367975976) が成功 |
| 公開中の検証 Worker・管理画面 | 配備直後、`/admin/version` と `/version.json` はともに `a385be7fb2044e753138d8548fbd766b6f41a1e9` を返し、両入口の HTTP 応答は 200 |
| 検証 D1 | dry-run と apply で未適用 migration 0 件。今回 DB 更新なし。旧リポジトリの未統合 migration は別工程 |
| 旧経路 | 旧リポジトリの検証配備・D1 更新 workflow は停止、旧検証用 `CF_API_TOKEN` は削除済み。ジョブ未生成の待機8件だけが GitHub 上で残るため、毎回専用検査で照合する |
| 共有ロック | apply 終了時に解放を確認。新 `refs/deploy-locks/staging` は404（なし） |
| その他の配備経路 | 新リポジトリの D1 更新・本番配備 workflow は無効。Cloudflare Pages の Git 自動公開も無効のまま維持する |

旧リポジトリの PR #2079・#2094・#2097 は担当者の作業中。Masato の今回限りの承認により、これらの統合を待たずに、公開版を履歴に含む上記 SHA を検証環境へ先に配備した。旧 PR の内容は今回の公開版・D1 に含めていない。担当者が完了した変更を、新リポジトリで最新 `codex/development` との差分を確認し、通常の PR・検査で順次取り込む。卓のコードや PR はこの切り替え作業では変更しない。

以後の検証配備は、新リポジトリの最新 `codex/development` だけを `deploy-cloudflare-staging.yml` の共通キューと共有ロックから実行する。実行前と Worker・管理画面の各公開直前に、旧経路の停止、先行実行、D1 未適用分、最新開発 SHA、両公開 SHA の祖先関係、Pages Git 自動公開の停止を検査する。一部だけ反映された場合は未完了とし、古い版へ戻さず前進修正する。DB 更新と本番配備は別途承認・安全確認を要する。

## 切り替え前の確認記録（履歴）

### 2026-11-07 の停止措置と未完了事項

| 項目 | 確認した状態 |
| --- | --- |
| 旧・新 `codex/development` | 旧 `20bfff7251a5543c7da103c188ea18c8db89aff2`、新 `97228a743ac14fdc650a7f8d30c91fccf3ac6969`。新は旧の最新コミットを履歴に含まない |
| 公開中の検証 Worker・管理画面 | 両方とも旧 `20bfff7251a5543c7da103c188ea18c8db89aff2` |
| 検証 D1 | 適用済みの最新は migration 755。旧側で未統合の migration はここでは適用しない |
| 旧配備・D1更新 workflow | 両方 `disabled_manually`。配備6件、D1更新2件が GitHub 上は `queued` のまま残る。全8件のジョブ数は0件。通常取消しと強制取消しは「まだキューに入っていない」と 409 を返した |
| 旧検証資格情報 | 旧リポジトリ `staging` Environment の唯一の Cloudflare API トークン `CF_API_TOKEN` を削除済み。リポジトリ共通の秘密情報は0件。`CF_ACCOUNT_ID` のみ残る。ジョブ未生成の8件が後から始まっても旧経路は Cloudflare へ書き込めない |
| 旧共有検証ロック | `refs/deploy-locks/staging` は404（なし） |
| 新配備 workflow | `disabled_manually`。新 `staging` Environment は `codex/development` のみ許可し、公開 Turnstile サイトキーを設定済み。`CF_API_TOKEN` と `CF_ACCOUNT_ID` の秘密名を確認済み（値は取得しない） |

公開版 `20bfff7251a5543c7da103c188ea18c8db89aff2` は専用枝 `codex/masato-published-sync-1107` に通常の merge で取り込んだ。この枝で祖先関係、差分、対象試験を確認した。新 `codex/development` に入ったかはPR統合後に再確認する。旧リポジトリの未完了PRは別担当の作業として扱う。

旧トークンの値は取得・保存していない。元の秘密情報をそのまま復元することはできず、必要なら新しいトークンを作る。新しい検証用トークンは**新リポジトリだけ**へ登録する。GitHub Actions の新リポジトリ用トークンから旧リポジトリの秘密情報一覧は確認できないため、旧資格情報の削除は切り替え担当が配備前に再確認する。

### GitHub に残る8件の扱い

8件はすべて現在公開中の旧コミットの祖先で、ジョブが生成されていない。旧 workflow の停止と旧トークン削除を確認したため、Masato の今回限りの指示に基づき、**この8件だけ**を配備ゲートの例外とする。`scripts/deploy/verify-legacy-staging-retired.mjs` は実行 ID・元コミット・workflow ID・ジョブ数0を毎回照合する。新たな待機、実行中、承認待ち、ジョブ生成、旧 workflow の再有効化、旧ロック、API の確認失敗では停止する。この例外は、別の旧実行や新しい配備依頼を認めるものではない。

待機 ID：配備 `41045190082`、`41041962168`、`40832194668`、`40804181814`、`40796327597`、`40682929863`。D1更新 `41799880393`、`40635554299`。GitHub の表示はまだ `queued` であり、取消し済みとは報告しない。

### 2026-11-06 の読み取り確認

| 項目 | 確認した状態 |
| --- | --- |
| 旧 `codex/development` | `acfe29abe56664773c732e8cd31369f9b9f0a646` |
| 新 `codex/development` | `85a0b822af0df2670012cbf34af886e723311911`。旧版を履歴に含むが、以後の旧版更新は再照合する |
| 公開中の検証 Worker・管理画面 | 両方とも `acfe29abe56664773c732e8cd31369f9b9f0a646`。公開の `/admin/version` と `/version.json` で確認 |
| 旧配備 workflow | 有効。配備 workflow に `queued` が6件、`waiting` は0件。古い待機依頼も勝手に取消さない |
| 旧D1更新 workflow | `disabled_manually` だが `queued` が2件。これも先行依頼として扱う |
| 旧 `refs/deploy-locks/staging` | GitHub API では404（ロックなし） |
| 新配備 workflow | `disabled_manually`。新リポジトリの `staging` Environment は未作成 |
| 旧 `staging` Environment | 秘密名 `CF_ACCOUNT_ID`、`CF_API_TOKEN`、変数名 `NEXT_PUBLIC_TURNSTILE_SITE_KEY` を確認。値は取得していない |

この確認は切り替え当日の状態を保証しない。実行の直前にすべて取り直す。

### 同じキュー名をコピーするだけでは危険な理由

GitHub Actions の `cloudflare-staging` キューは**リポジトリごと**に管理される。`refs/deploy-locks/staging` もリポジトリごとの Git 参照である。したがって新旧の workflow を同時に有効にすると、同じ名前でも互いに待たず、別々のロックで同じ Worker・管理画面に触れられる。新リポジトリの `GITHUB_TOKEN` は旧リポジトリへの書き込み権限を持たない。広い権限のトークンを追加して見かけ上の共有ロックを作らない。

切り替えは**旧経路を完全に止めたことを確認してから新経路を開く**一方向の引き継ぎにする。途中で失敗しても古いコードを再配備して隠さず、最新の統合版を修正する。

### 切り替え前の必須ゲート

1. 旧配備・D1更新 workflow が停止し、旧 `staging` Environment の Cloudflare API トークンがないことを再確認する。残る8件は上記の ID・コミット・ジョブ未生成の条件に完全一致する場合に限る。その他の待機や実行中があれば停止する。
2. 旧リポジトリの進行中PRを担当者が整理する。卓管理のPRは別担当の作業として、この移行作業では変更・統合・配備しない。旧 `codex/development` が進んだら、新リポジトリの専用ブランチに通常の merge で取り込み、差分・履歴・試験を確認してPRで統合する。force push、履歴の上書き、未検査コピーは禁止する。
3. 旧 `staging` ロックが空で、旧2 workflow の実行中・承認待ちが0件であることを再確認する。上記8件のいずれかにジョブが生成されたら停止する。
4. 新 workflow は**新リポジトリ限定**にし、既存の `codex/development` 限定、`queue: max`、ロック、未適用D1停止、両公開SHAの祖先確認、公開直前の再確認、配備後の公開SHA照合を維持する。旧経路の停止ゲートは実行前と各公開直前に失敗時停止で入れる。関連試験とCIを通す。新 workflow はこの段階でも無効のままにする。
5. 新リポジトリの `staging` Environment を `codex/development` だけに制限する。必要な秘密情報・公開ビルド変数は値をチャットやGitへ出さず、専用の安全な設定経路で登録する。旧リポジトリからの値の無条件コピーはしない。設定変更は対象・影響・復旧を提示して個別承認を得る。
6. Cloudflare Pages `nen-line-stg-admin-git` の Automatic deployments が Disabled のままであることを確認する。Worker/Pages の公開完全SHA、Version/Deployment ID、D1未適用分、Cloudflare設定、旧・新の最新開発SHAを記録する。新候補が両公開SHAを履歴に含まなければ停止する。
7. 新 workflow を有効化する設定変更を個別承認のもと行う。まず最新新 `codex/development` の `dry-run` を実行し、結果を確認する。続いて共有キューの `apply` を順番待ちで実行する。ロック取得後と Worker・管理画面の各公開直前に最新SHA・両公開SHA・旧 workflow の停止を再確認する。未適用migrationは別の承認済み工程で処理する。
8. Worker・管理画面の公開完全SHAと対象機能を照合し、共有ロックが解放されたことを確認する。一部だけ反映された場合は未完了として記録し、古いソースへ巻き戻さない。本番の配備経路は別途承認・整備する。

### 当時の停止条件

新 `staging` Environment の秘密名は揃い、手元の配備前検査は合格した。ただしトークンの実際の権限はまだ配備ジョブで確認していない。公開中の旧コミットは上記の専用枝へ取り込み済みで、PR統合後に新 `codex/development` の祖先関係を再確認する。旧リポジトリの進行中PRの整理も残る。新 workflow の有効化、共有検証への dry-run/apply は、切り替え前の必須ゲートを満たすまで行わない。旧8件が残る間は、旧資格情報が再登録されていないことを担当者が再確認する。

参照：[共通の配備ゲート](../DEPLOY-GATE.md)、[新リポジトリの移行方針](../legal/musubo-repository-transition.md)、[GitHub Actions のリポジトリ別 concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[GitHub のリポジトリ限定 GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/compromised-runners)。
