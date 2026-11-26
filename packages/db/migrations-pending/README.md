# まだ当てない migration の置き場所

ここに置いた `.sql` は**配備の順番待ち**で、`packages/db/migrations/` には入っていません。

## なぜ分けるか

検証環境の配備（`.github/workflows/deploy-cloudflare-staging.yml` の
`Count pending staging D1 migrations`）は `packages/db/migrations/*.sql` を数えて、
検証D1に未適用のものが1件でも残っていたら Worker の配備を止めます。これは
「スキーマが古いまま新しいコードを配らない」ための見張りで、緩めません。

一方で、段階移行の migration は「先に当てる分」と「新しいコードを配り終えてから
当てる分」に分かれます。後半をここへ置いておくと、

1. 前半の migration を当てる → 未適用0件
2. 新しい Worker を配る（見張りを通る）
3. 既存データで互換性を確かめる
4. 後続PRで後半をここから `migrations/` へ移す
5. 当てる → 未適用0件

の順番が、見張りをそのまま残したまま成り立ちます。4〜5のあいだだけ未適用が1件に
なるので、そのあいだ Worker の配備は止まります（5で解けます）。3の確認が終わって
から4へ進んでください。

## 後続PRでやること

```sh
git mv packages/db/migrations-pending/<ファイル名>.sql packages/db/migrations/
pnpm --dir packages/db generate:bootstrap   # bootstrap.sql と bootstrap-meta.json を作り直す
```

- SQL の中身は書き換えません（移すだけ）。
- 読んでいる試験があれば読み込み先の相対パスを直します。
- `docs/` 以外（`packages/db/`）が変わるので、必須検査の反映履歴が要ります。
  後続PRの番号で `docs/release-log/unreleased/<PR番号>-<担当>-<内容>.md` に1行足し、
  その行に `#<PR番号>` を入れてください（`required-pr-gate.yml` の
  `Require a release-log entry`）。
- `migrations/` に入ってはじめて `scripts/check-migrations.ts` の安全検査と
  `bootstrap.sql` の対象になります。移した後に `pnpm --dir packages/db check:bootstrap`
  と DB の試験を通してください。

## 置くときの決まり

- ここに置くのは、**当てる順番が決まっていて中身が確定した** migration だけです。
  書きかけの SQL の下書き置き場ではありません。
- 置いた理由と「いつ `migrations/` へ移すか」をファイル先頭のコメントに書きます。
- `packages/db/package.json` の `files` には入れていないので、パッケージには含まれません。

## いま置いてあるもの

ありません。

### 済んだもの

| ファイル | 移した日 | 移す条件 |
| --- | --- | --- |
| `773_sns_multi_connections_drop_compat.sql` | 2026-11-24 | 共有検証D1へ 772 だけを当て、接続IDで読み書きする新しい Worker と Web を配備し、既存接続の互換性を確かめた（上の1〜3）。`packages/db/migrations/` へ移したので、次の Worker 配備は 773 を当ててからになる（上の4〜5） |
