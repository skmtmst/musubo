> 文書：onboarding のコード案内｜区分：今の説明｜最終確認：2026-10-31（日本時間）

# はじめの質問・使い方の設定：コードの入口

現役の読み込み先を探す案内です。URL・保存・権限・失敗時の条件は下の動きの説明と要件を読み、ここへ複製しません。

## URLから本体へ

初期メニューの選び直しは `/getting-started/rich-menu` から [initial-menu-page.tsx](initial-menu-page.tsx) へ直接つながります。質問の窓と設定は、呼び出し側の画面から利用します。

呼び出し側：[v8/dashboard/dashboard.tsx](../dashboard/dashboard.tsx)、[v8/dashboard/first-steps.tsx](../dashboard/first-steps.tsx)、[v8/hq-attention/attention.tsx](../hq-attention/attention.tsx)、[v8/hq-starter-sets/starter-sets.tsx](../hq-starter-sets/starter-sets.tsx)、[v8/rich-menu-sample/sample.tsx](../rich-menu-sample/sample.tsx)、[v8/settings/accounts/accounts.tsx](../settings/accounts/accounts.tsx)、[v8/settings/getting-started/getting-started.tsx](../settings/getting-started/getting-started.tsx)

はじめの設定での質問・選び直しは [initial-menu-choice.tsx](initial-menu-choice.tsx) を共有します。

本体：[icons.tsx](icons.tsx)、[style-experience-player/player.tsx](style-experience-player/player.tsx)（スタイル体験の見本）、[sample-menu.tsx](sample-menu.tsx)、[setup-card.tsx](setup-card.tsx)、[setup-links.tsx](setup-links.tsx)、[style-entry.tsx](style-entry.tsx)、[style-choice-step.tsx](style-choice-step.tsx)、[wizard.tsx](wizard.tsx)

## 外に見せる名前（index.ts）

- [index.ts](index.ts)：`SetupCard`・`SetupWarningBands`・`setupSummary`・`useStyleSetup`・`useFirstRun`・`styleLabel`・`STYLE_CHOICES`・`FEATURES`・`featureHref`・`featureName`・`sampleMenuFor`・`StyleWarning`・`useStarterMenu`・`SampleMenuTiles`・`StyleEntry`・`StyleExperiencePlayer`・`STYLE_EXPERIENCE_SCRIPT`・`StyleExperiencePlayerProps`・`StyleExperienceScript`・`InitialMenuChoice`・`InitialMenuPhone`・`InitialMenuSelection`・`InitialMenuPage`
- [style-experience-player/index.ts](style-experience-player/index.ts)：`StyleExperiencePlayer`・`StyleExperiencePlayerProps`・`STYLE_EXPERIENCE_SCRIPT`・`StyleExperienceCan`・`StyleExperienceScript`・`StyleExperienceStyle`
- [public/model/index.ts](public/model/index.ts)：`StyleWarning`・`FEATURES`・`STYLE_CHOICES`・`featureHref`・`featureName`・`sampleMenuFor`・`styleLabel`
- [public/sample-menu/index.ts](public/sample-menu/index.ts)：`SampleMenuTiles`
- [public/guide-engine/index.ts](public/guide-engine/index.ts)：`useGuideEngine`・`GuideAnchor`・`GuideEnginePhase`・`GuideSummary`（開店準備ガイドの進み具合。正本はサーバー、localStorageは控え）
- [public/guide-overlay/index.ts](public/guide-overlay/index.ts)：`GuideHost`・`GuideOverlay`・`GuideSharedProvider`・`useSharedGuide`・`SharedGuide`・`guideProcedure`・`guideProcedureTotal`・`guideAnchorAttribute`・`emitGuideSignal`・`useGuideSignal`（手順別の案内。`GuideHost` は全画面で1つだけ `AuthenticatedAppShell` に置く）
- [public/setup-card/index.ts](public/setup-card/index.ts)：`SetupCard`・`SetupWarningBands`・`setupSummary`
- [public/style-setup-progress/index.ts](public/style-setup-progress/index.ts)：`useStyleSetupProgress`・`loadStyleSetupProgress`（業種の設定を実物のGETで確認）
- [public/style-entry/index.ts](public/style-entry/index.ts)：`StyleEntry`
- [public/use-first-run/index.ts](public/use-first-run/index.ts)：`useFirstRun`
- [public/use-starter-menu/index.ts](public/use-starter-menu/index.ts)：`useStarterMenu`
- [public/use-style-setup/index.ts](public/use-style-setup/index.ts)：`useStyleSetup`
- [wizard/index.ts](wizard/index.ts)：`WizardStep`・`Props`・`Pair`・`SummaryData`・`default`

機能の内部は宣言元を直接読み、外部は明示された公開入口を使います。Nextのpage・layoutとWorkerのroute登録は直接接続します。決まりは [コードの構成と名前](../../../../../docs/code-structure.md)。

## API・保存の実装へ

- [lib/api.ts](../../lib/api.ts)
- [lib/api/helpers/styles.ts](../../lib/api/helpers/styles.ts)

HTTP契約は [API文書の一覧](../../../../../docs/README.md#api)、失敗の形式は [エラーの共通契約](../../../../../docs/error-codes.md)。公開名や応答を改名しません。

## 動きと試験

- [BEHAVIOR.md](BEHAVIOR.md)
- [first-run-watch.test.tsx](first-run-watch.test.tsx)
- [guide-engine.test.ts](guide-engine.test.ts)
- [guide-overlay-geometry.test.ts](guide-overlay-geometry.test.ts)（枠 04-1 の寸法どおりの位置計算）
- [guide-overlay-react.test.tsx](guide-overlay-react.test.tsx)（吹き出しの文面・進行トリガー・スキップ・ESC・対象外画面での自動一時停止）
- [load-state.test.tsx](load-state.test.tsx)
- [model.test.ts](model.test.ts)
- [initial-menu-choice.test.tsx](initial-menu-choice.test.tsx)
- [sample-menu-image.test.tsx](sample-menu-image.test.tsx)
- [style-choice-step.test.tsx](style-choice-step.test.tsx)
- [style-setup-links.test.tsx](style-setup-links.test.tsx)

実行：`NEXT_PUBLIC_API_URL=http://127.0.0.1:8788 pnpm --filter web test -- src/v8/onboarding`。関連する入口の試験も実行してください。保存・入力保持・権限・別店舗・失敗からの回復を守り、文書の整合だけを動作の合格に数えません。
