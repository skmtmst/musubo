> 文書：inbox-chat のコード案内｜区分：今の説明｜最終確認：2026-10-26（日本時間）

# inbox-chat：コードの入口

現役の読み込み先を探す案内です。URL・保存・権限・失敗時の条件は下の動きの説明と要件を読み、ここへ複製しません。

## URLから本体へ

- `/chats` → [app/chats/page.tsx](../../app/chats/page.tsx)
- `/m/chats`（電話の画面のトーク） → [app/m/chats/page.tsx](../../app/m/chats/page.tsx)

本体：[screen.tsx](screen.tsx)。電話の画面は [mobile-talk-screen.tsx](mobile-talk-screen.tsx)（一覧と会話を 2 枚に分け、取得・送信・下書き・アカウントの照合は同じフックを使う。決まりは `docs/v8-design-rules.md` §6.48）。

## 外に見せる名前（index.ts）

- [index.ts](index.ts)：`TemplatePickerView`・`TemplatePickerSideKey`・`ConversationHead`
- [public/conversation-head/index.ts](public/conversation-head/index.ts)：`ConversationHead`
- [public/template-picker-view/index.ts](public/template-picker-view/index.ts)：`TemplatePickerSideKey`・`TemplatePickerView`
- [public/mobile-talk-item/index.ts](public/mobile-talk-item/index.ts)：`talkItem`（電話の画面の会話の一覧の 1 件の形）

機能の内部は宣言元を直接読み、外部は明示された公開入口を使います。Nextのpage・layoutとWorkerのroute登録は直接接続します。決まりは [コードの構成と名前](../../../../../docs/code-structure.md)。

## API・保存の実装へ

- [lib/api.ts](../../lib/api.ts)
- [lib/api/helpers/gap1.ts](../../lib/api/helpers/gap1.ts)

HTTP契約は [API文書の一覧](../../../../../docs/README.md#api)、失敗の形式は [エラーの共通契約](../../../../../docs/error-codes.md)。公開名や応答を改名しません。

## 動きと試験

- 動きの正本：[機能要件の索引](../../../../../docs/v6-requirements/v6-requirements-master-index.md)、[追加要件](../../../../../docs/v8-requirements/README.md)。
- [attach-parts.test.tsx](attach-parts.test.tsx)
- [attachments.test.ts](attachments.test.ts)
- [customer-panel-react.test.tsx](customer-panel-react.test.tsx)
- [deep-link-react.test.tsx](deep-link-react.test.tsx)
- [head-menus.test.tsx](head-menus.test.tsx)
- [inbox-reply-composer-inserts.test.tsx](inbox-reply-composer-inserts.test.tsx)（返信欄の差し込み：テンプレートを入れた後の札・札を消す・カーソル・コピー・送る値は {{…}} のまま・送るとこうなりますの改行と「入りません」・全文の窓・入らない差し込みの知らせ）
- [send-preview.test.tsx](send-preview.test.tsx)（全文の窓は相手・本文・結果が変わったら閉じ、戻っても開き直さない）
- [chat-inserts.test.ts](chat-inserts.test.ts)（入らない差し込みの知らせと送信を止めた時の文：札の名前・理由を言い切らない・生の記号を出さない）
- [use-reservation-warning.test.tsx](use-reservation-warning.test.tsx)（送るとこうなりますの取得：未解決の全部・確かめられない時・遅れた応答）
- [manual-send-path.test.ts](manual-send-path.test.ts)
- [mobile-talk-screen.test.tsx](mobile-talk-screen.test.tsx)（電話の画面：1 回だけ送る・失敗の後に同じキー・閲覧のみ・別のアカウント・権限）
- [rules-popover.test.tsx](rules-popover.test.tsx)
- [schedule-dialog.test.tsx](schedule-dialog.test.tsx)
- [schedule-presets.test.ts](schedule-presets.test.ts)
- [sidebar-safety-react.test.tsx](sidebar-safety-react.test.tsx)
- [sla.test.tsx](sla.test.tsx)
- 並びの切り替え（`?sort=latest`）：[inbox-sort-control-react.test.tsx](../../app/chats/inbox-sort-control-react.test.tsx)
- 開いたら既読：[inbox-open-read-react.test.tsx](../../app/chats/inbox-open-read-react.test.tsx)
- 一覧の時刻（今日は時刻・6日前までは曜日・前は月/日）：[format-list-recent.test.ts](../../lib/format-list-recent.test.ts)

実行：`NEXT_PUBLIC_API_URL=http://127.0.0.1:8788 pnpm --filter web test -- src/v8/inbox-chat`。関連する入口の試験も実行してください。保存・入力保持・権限・別店舗・失敗からの回復を守り、文書の整合だけを動作の合格に数えません。
