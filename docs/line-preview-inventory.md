> 文書：LINEの見え方の利用箇所｜区分：調査結果｜最終確認：2026-11-23（日本時間）

# LINEの見え方の利用箇所

共通のスマホ枠は中身を受け取る器で、種類や通数を決めません。各画面が渡す内容の確認が必要です。見た目の照合元は [LINE公式のメッセージ見本](https://developers.line.biz/ja/docs/messaging-api/message-types/) です。Flex はレイアウトと色が送信内容により変わり、区切り線も設定されたときに描画します。

- 一斉配信：本文・画像などの各通のあとに、追加ボタンを別の Flex として1通送ります。
- 飲食店の予約案内：編集した各通を順に送り、来店確認が必要な場合は確認用 Flex を別途追加します。
- テンプレート・シナリオ・自動応答：選んだ本文、画像、カルーセル、Flex などの種類に従います。
- 受信箱の履歴：実際の記録を表示します。見本の値には置き換えません。
- リッチメニュー：トーク下にメニュー画像を置きます。
- クイックリプライの専用プレビュー利用箇所は今回の検索では見つかりませんでした。

## 検索で見つかった利用箇所と構成部品

共通プレビューとその呼び出しを含む名前の検索結果です。各ファイル内のすべてが送信画面とは限りません。

- `apps/web/src/app/booking/bookings/new/page.tsx`
- `apps/web/src/app/broadcasts/detail/page.tsx`
- `apps/web/src/app/mileage/earning-rules/edit/v8-earning-rule-edit.tsx`
- `apps/web/src/components/broadcasts/broadcast-form-gap-parts.tsx`
- `apps/web/src/components/broadcasts/broadcast-form-model.tsx`
- `apps/web/src/components/broadcasts/broadcast-form.tsx`
- `apps/web/src/components/broadcasts/broadcast-message-preview.tsx`
- `apps/web/src/components/broadcasts/broadcast-preview-model.tsx`
- `apps/web/src/components/broadcasts/broadcast-preview-rail.tsx`
- `apps/web/src/components/broadcasts/broadcast-text-bubble.tsx`
- `apps/web/src/components/scenarios/step-preview.tsx`
- `apps/web/src/components/shared/coupon-preview.tsx`
- `apps/web/src/components/shared/entity-picker-sources.tsx`
- `apps/web/src/components/shared/line-preview.tsx`
- `apps/web/src/components/shared/message-composer.tsx`
- `apps/web/src/components/templates/message-template-editor.tsx`
- `apps/web/src/v8/auto-replies/edit/wizard-preview.tsx`
- `apps/web/src/v8/broadcast-detail/phone.tsx`
- `apps/web/src/v8/common-vars-edit/edit.tsx`
- `apps/web/src/v8/common-vars-edit/new.tsx`
- `apps/web/src/v8/ec-auto-line/edit-drawer.tsx`
- `apps/web/src/v8/friend-add-publish/publish.tsx`
- `apps/web/src/v8/friend-add/editor.tsx`
- `apps/web/src/v8/hq-broadcasts/create.tsx`
- `apps/web/src/v8/hq-broadcasts/source-picker.tsx`
- `apps/web/src/v8/hq-broadcasts/template-picker.tsx`
- `apps/web/src/v8/hq-deliveries/auto-reply-editor.tsx`
- `apps/web/src/v8/hq-templates/detail.tsx`
- `apps/web/src/v8/hq-templates/message-form.tsx`
- `apps/web/src/v8/inbox-chat/message-row.tsx`
- `apps/web/src/v8/inbox-chat/mobile-talk-screen.tsx`
- `apps/web/src/v8/inbox-chat/template-picker-view.tsx`
- `apps/web/src/v8/inflow-links/new/create.tsx`
- `apps/web/src/v8/line-notifications/operator-edit.tsx`
- `apps/web/src/v8/mileage/ranks.tsx`
- `apps/web/src/v8/nen-campaigns/column-new.tsx`
- `apps/web/src/v8/nen-campaigns/edit.tsx`
- `apps/web/src/v8/nen-campaigns/list.tsx`
- `apps/web/src/v8/nen-campaigns/preview.tsx`
- `apps/web/src/v8/onboarding/initial-menu-choice.tsx`
- `apps/web/src/v8/onboarding/sample-menu.tsx`
- `apps/web/src/v8/onboarding/style-experience-player/scenes.tsx`
- `apps/web/src/v8/reminders/detail.tsx`
- `apps/web/src/v8/reminders/ui.tsx`
- `apps/web/src/v8/reminders/wizard-ui.tsx`
- `apps/web/src/v8/restaurant/line-followup/flow-editor.tsx`
- `apps/web/src/v8/restaurant/line-followup/message-sample.tsx`
- `apps/web/src/v8/rich-menu-edit/compatibility-form.tsx`
- `apps/web/src/v8/rich-menus/new/create-preview-rail.tsx`
- `apps/web/src/v8/rich-menus/new/create-preview.tsx`
- `apps/web/src/v8/rich-menus/new/create.tsx`
- `apps/web/src/v8/scenario-detail/detail.tsx`
- `apps/web/src/v8/scenario-detail/scenario-detail-body.tsx`
- `apps/web/src/v8/scenario-first-step/first-step.tsx`
- `apps/web/src/v8/template-detail/detail.tsx`
- `apps/web/src/v8/template-edit/asset.tsx`
- `apps/web/src/v8/template-edit/message.tsx`
- `apps/web/src/v8/template-edit/rich-video.tsx`
- `apps/web/src/v8/template-edit/rich.tsx`
- `apps/web/src/v8/templates/carousel.tsx`
- `apps/web/src/v8/templates/question-new.tsx`
- `apps/web/src/v8/webinar-edit/basic-form.tsx`
- `apps/web/src/v8/webinar-edit/notifications.tsx`
