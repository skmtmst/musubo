> 文書：musubo 新リポジトリへの共有検証配備の切り替え準備｜区分：未実施の手順・確認記録｜最終確認：2026-11-06（日本時間）

# 共有検証配備の切り替え準備

`skmtmst/musubo` を新規開発の基準にする一方、共有検証環境の配備はまだ `skmtmst/line-harness-oss` が担当している。この文書は切り替えの判断条件を記録する。**ここに書いた手順は実施済みという意味ではない。** 切り替えが終わるまで、新リポジトリから共有検証環境へ配備しない。

## 2026-11-06 の読み取り確認

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

## 同じキュー名をコピーするだけでは危険な理由

GitHub Actions の `cloudflare-staging` キューは**リポジトリごと**に管理される。`refs/deploy-locks/staging` もリポジトリごとの Git 参照である。したがって新旧の workflow を同時に有効にすると、同じ名前でも互いに待たず、別々のロックで同じ Worker・管理画面に触れられる。新リポジトリの `GITHUB_TOKEN` は旧リポジトリへの書き込み権限を持たない。広い権限のトークンを追加して見かけ上の共有ロックを作らない。

切り替えは**旧経路を完全に止めたことを確認してから新経路を開く**一方向の引き継ぎにする。途中で失敗しても古いコードを再配備して隠さず、最新の統合版を修正する。

## 切り替え前の必須ゲート

1. 旧 workflow の先行待機6件を含め、配備・DB更新の実行と待機がすべて終了したことを確認する。待機依頼を取り消して順番を飛ばさない。状態が取得できない場合も停止する。
2. 旧リポジトリの進行中PRを担当者が整理する。卓管理のPRは別担当の作業として、この移行作業では変更・統合・配備しない。旧 `codex/development` が進んだら、新リポジトリの専用ブランチに通常の merge で取り込み、差分・履歴・試験を確認してPRで統合する。force push、履歴の上書き、未検査コピーは禁止する。
3. 旧 `staging` ロックが空で、旧配備 workflow の実行中・待機中が0件であることを再確認する。旧配備 workflow を無効化し、無効状態と0件を再読込する。旧リポジトリのD1更新経路も競合がないか確認する。
4. 新 workflow は**新リポジトリ限定**に改修し、既存の `codex/development` 限定、`queue: max`、ロック、未適用D1停止、両公開SHAの祖先確認、公開直前の再確認、配備後の公開SHA照合を維持する。新側の旧配備workflow無効・旧キュー空の確認も、実行前と各公開直前に失敗時停止で入れる。関連試験とCIを通す。新 workflow はこの段階でも無効のままにする。
5. 新リポジトリの `staging` Environment を `codex/development` だけに制限する。必要な秘密情報・公開ビルド変数は値をチャットやGitへ出さず、専用の安全な設定経路で登録する。旧リポジトリからの値の無条件コピーはしない。設定変更は対象・影響・復旧を提示して個別承認を得る。
6. Cloudflare Pages `nen-line-stg-admin-git` の Automatic deployments が Disabled のままであることを確認する。Worker/Pages の公開完全SHA、Version/Deployment ID、D1未適用分、Cloudflare設定、旧・新の最新開発SHAを記録する。新候補が両公開SHAを履歴に含まなければ停止する。
7. 新 workflow を有効化する設定変更を個別承認のもと行う。まず最新新 `codex/development` の `dry-run` を実行し、結果を確認する。続いて共有キューの `apply` を順番待ちで実行する。ロック取得後と Worker・管理画面の各公開直前に最新SHA・両公開SHA・旧 workflow の停止を再確認する。未適用migrationは別の承認済み工程で処理する。
8. Worker・管理画面の公開完全SHAと対象機能を照合し、共有ロックが解放されたことを確認する。一部だけ反映された場合は未完了として記録し、古いソースへ巻き戻さない。本番の配備経路は別途承認・整備する。

## 現在の停止条件

旧配備 workflow に6件、旧D1更新workflowに2件の先行待機があり、旧配備経路は有効のまま。新側のコードには旧経路の状態を公開前に再確認する停止ゲートを追加したが、workflowは無効のままにする。新 workflow の有効化、Cloudflare設定の移管、共有検証への dry-run/apply はまだ行わない。先に旧待機の状態が正常に解消するかを確認し、その時点の開発版と公開版を再照合する。

参照：[共通の配備ゲート](../DEPLOY-GATE.md)、[新リポジトリの移行方針](../legal/musubo-repository-transition.md)、[GitHub Actions のリポジトリ別 concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[GitHub のリポジトリ限定 GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/compromised-runners)。
