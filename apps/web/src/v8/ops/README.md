> 文書：ops のコード案内｜区分：今の説明｜最終確認：2026-10-20（日本時間）

# 運営コンソール（V8）の動き：コードの入口

現役の読み込み先を探す案内です。URL・保存・権限・失敗時の条件は下の動きの説明と要件を読み、ここへ複製しません。

## URLから本体へ

- `/ops/announcements` → [app/ops/announcements/page.tsx](../../app/ops/announcements/page.tsx)
- `/ops/audit` → [app/ops/audit/page.tsx](../../app/ops/audit/page.tsx)
- `/ops/dashboard` → [app/ops/dashboard/page.tsx](../../app/ops/dashboard/page.tsx)
- `/ops/invite` → [app/ops/invite/page.tsx](../../app/ops/invite/page.tsx)
- `/ops/login` → [app/ops/login/page.tsx](../../app/ops/login/page.tsx)
- `/ops/members` → [app/ops/members/page.tsx](../../app/ops/members/page.tsx)
- `/ops/support` → [app/ops/support/page.tsx](../../app/ops/support/page.tsx)
- `/ops/tenants/detail` → [app/ops/tenants/detail/page.tsx](../../app/ops/tenants/detail/page.tsx)
- `/ops/tenants` → [app/ops/tenants/page.tsx](../../app/ops/tenants/page.tsx)
- `/ops/two-factor` → [app/ops/two-factor/page.tsx](../../app/ops/two-factor/page.tsx)

本体：[announcements.tsx](announcements.tsx)、[audit.tsx](audit.tsx)、[dashboard.tsx](dashboard.tsx)、[invite.tsx](invite.tsx)、[login.tsx](login.tsx)、[members.tsx](members.tsx)、[support.tsx](support.tsx)、[tenant-detail.tsx](tenant-detail.tsx)、[tenants.tsx](tenants.tsx)、[two-factor.tsx](two-factor.tsx)

## 外に見せる名前（index.ts）

- [index.ts](index.ts)：`OpsAnnouncementsV8`・`OpsAuditV8`・`OpsDashboardV8`・`OpsInviteV8`・`OpsLoginV8`・`OpsMembersV8`・`OpsSupportV8`・`OpsTenantDetailV8`・`OpsTenantsV8`・`OpsTwoFactorV8`・`OpsShellV8`
- [public/shell/index.ts](public/shell/index.ts)：`OpsShellV8`

機能の内部は宣言元を直接読み、外部は明示された公開入口を使います。Nextのpage・layoutとWorkerのroute登録は直接接続します。決まりは [コードの構成と名前](../../../../../docs/code-structure.md)。

## API・保存の実装へ

- [lib/api.ts](../../lib/api.ts)

HTTP契約は [API文書の一覧](../../../../../docs/README.md#api)、失敗の形式は [エラーの共通契約](../../../../../docs/error-codes.md)。公開名や応答を改名しません。

## 動きと試験

- [BEHAVIOR.md](BEHAVIOR.md)
- [list-page.test.tsx](list-page.test.tsx)
- [ops.test.tsx](ops.test.tsx)
- [shell-behavior.test.tsx](shell-behavior.test.tsx)
- [support-reply.test.tsx](support-reply.test.tsx)
- [support-stats.test.tsx](support-stats.test.tsx)
- [tenant-overview-stats.test.tsx](tenant-overview-stats.test.tsx)
- [tenants-details.test.tsx](tenants-details.test.tsx)

実行：`NEXT_PUBLIC_API_URL=http://127.0.0.1:8788 pnpm --filter web test -- src/v8/ops`。関連する入口の試験も実行してください。保存・入力保持・権限・別店舗・失敗からの回復を守り、文書の整合だけを動作の合格に数えません。
