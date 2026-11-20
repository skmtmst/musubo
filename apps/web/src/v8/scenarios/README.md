> 文書：scenarios のコード案内｜区分：今の説明｜最終確認：2026-10-30（日本時間）

# シナリオ配信一覧の動き：コードの入口

現役の読み込み先を探す案内です。URL・保存・権限・失敗時の条件は下の動きの説明と要件を読み、ここへ複製しません。

## URLから本体へ

- `/scenarios/mode` → [app/scenarios/mode/page.tsx](../../app/scenarios/mode/page.tsx)
- `/scenarios/new` → [app/scenarios/new/page.tsx](../../app/scenarios/new/page.tsx)
- `/scenarios` → [app/scenarios/page.tsx](../../app/scenarios/page.tsx)
- `/scenarios/results` → [app/scenarios/results/page.tsx](../../app/scenarios/results/page.tsx)

本体：[create.tsx](create.tsx)、[list.tsx](list.tsx)、[results.tsx](results.tsx)

## 外に見せる名前（index.ts）

- [index.ts](index.ts)：`ScenarioCreateV8`・`ScenariosListV8`・`ScenarioResultsV8`・`captureScenarioWriteAccess`・`useScenarioWriteAccess`（1通目の保存も同じ本人/代理判定を使う）

機能の内部は宣言元を直接読み、外部は明示された公開入口を使います。Nextのpage・layoutとWorkerのroute登録は直接接続します。決まりは [コードの構成と名前](../../../../../docs/code-structure.md)。

## API・保存の実装へ

- [lib/api.ts](../../lib/api.ts)

HTTP契約は [API文書の一覧](../../../../../docs/README.md#api)、失敗の形式は [エラーの共通契約](../../../../../docs/error-codes.md)。公開名や応答を改名しません。

## 動きと試験

- [BEHAVIOR.md](BEHAVIOR.md)
- [create-results.test.tsx](create-results.test.tsx)
- [list-folder-dot-and-reorder.test.tsx](list-folder-dot-and-reorder.test.tsx)
- [list-counts-and-actions.test.tsx](list-counts-and-actions.test.tsx)
- [result-summary.test.tsx](result-summary.test.tsx)

実行：`NEXT_PUBLIC_API_URL=http://127.0.0.1:8788 pnpm --filter web test -- src/v8/scenarios`。関連する入口の試験も実行してください。保存・入力保持・権限・別店舗・失敗からの回復を守り、文書の整合だけを動作の合格に数えません。
