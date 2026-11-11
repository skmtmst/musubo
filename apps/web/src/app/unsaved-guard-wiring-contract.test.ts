import { readdirSync, readFileSync } from 'node:fs'
import { readUiSource } from '../../scripts/test-ui-source.mjs'
// @ts-expect-error 型を持たない点検の道具（.mjs）。
import { screensWithoutLeaveGuard } from '../../scripts/unsaved-guard-wiring.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

/*
 * DETAIL-04系（画面によって未保存の離脱警告が出る／出ない）の再発防止。
 *
 * 「未保存の編集状態」を持つ画面は、離脱の番兵を共通フック
 * `useUnsavedGuard`（+ ConfirmDialog）で持つことを機械的に確認する。
 * 新しい編集画面を足したら、GUARDED か COVERED_BY_PARENT か
 * EXEMPTIONS（理由つき）へ分類を追加する。未分類のままだとこのテストが落ちる。
 */

/** 未保存の編集状態を持つ画面の印。dirty系の名前・スナップショット・未保存の文言。 */
const DIRTY_SIGNATURE = /dirty|unsaved|savedSnapshot|未保存/i

/** 番兵を持つ画面。`useUnsavedGuard` と離脱確認ダイアログの両方が必要。 */
const GUARDED = [
  'components/shared/folder-add-dialog.tsx',
  'components/shared/folder-select.tsx',
  'components/shared/reply-template-picker.tsx',
  // 顧客情報の編集は自身の未保存確認で画面離脱を守る。
  'components/shared/customer-info-panel.tsx',
  'components/shared/use-inline-detail-guard.tsx',
  'v8/common-vars/list.tsx',
  'v8/templates/list.tsx',
  'v8/account-new/registration-unsaved-guard.tsx',
  'v8/hq-banners/project.tsx',
  'v8/restaurant/organization/organization.tsx',
  'v8/hq-banners/dialogs.tsx',
  'v8/hq/member-dialog.tsx',
  'v8/accounts-detail/dialogs.tsx',
  'v8/accounts-detail/senders-card.tsx',
  'v8/ec-auto-line/edit-drawer.tsx',
  'components/merged-person/merged-profile-dialog.tsx',
  'components/merged-person/merged-delivery-dialog.tsx',
  'v8/analytics/funnel-form.tsx',
  'v8/restaurant/line-followup/followup-board.tsx',
  'v8/events/use-event-absence.tsx',
  'v8/hq-starter-sets/catalog-editor.tsx',
  // 会社・連絡先とプール名の下書きは、共通の FormLeaveGuard が画面離脱を守る。
  'v8/hq/company-contact.tsx',
  'v8/ai-reply/qa-list.tsx',
  'v8/settings/pools/pools.tsx',
  // 友だち詳細の情報欄。保存前の入力があればタブ・ほかの画面へ移る前に確認する。
  'v8/friend-detail/info-tab.tsx',
  'v8/restaurant/organization/store-groups.tsx',
  'v8/inbox-chat/screen.tsx',
  // 電話のトーク。書きかけの返信は離れる前に確かめる。
  'v8/inbox-chat/mobile-talk-screen.tsx',
  'v8/settings/customer-look/screen.tsx',
  'v8/hq-deliveries/console.tsx',
  'v8/webhooks/incoming-actions.tsx',
  'components/shared/restaurant-floor-editor.tsx',
  'app/booking/bookings/detail/page.tsx',
  'app/analytics/page.tsx',
  'v8/automations/create/create.tsx',
  'v8/settings/pools/create.tsx',
  'v8/broadcasts/quick-send.tsx',
  'v8/auto-replies/quick-create.tsx',
  'v8/forms/list.tsx',
  'v8/contents/list.tsx',
  'v8/contents/media-replacement-dialog.tsx',
  'v8/contents/media-detail-dialog.tsx',
  'v8/webhooks/incoming.tsx',
  'v8/webhooks/outgoing.tsx',
  'v8/hq/account-dialogs.tsx',
  'v8/tags/folder-page.tsx',
  'v8/tags/tags-tab.tsx',
  'v8/hq-broadcasts/list.tsx',
  'v8/hq-templates/store-list.tsx',
  'v8/hq/home.tsx',
  'v8/friend-add/list.tsx',
  'v8/webinars/list.tsx',
  'v8/inflow-links/ad-mapping-dialog.tsx',
  'v8/inflow-links/ads.tsx',
  'v8/inflow-links/ad-connection-dialog.tsx',
  'v8/inflow-links/genre-dialog.tsx',
  'v8/inflow-links/site-script.tsx',
  'v8/inflow-links/edit-route-dialog.tsx',
  'v8/affiliate-offer-new/create.tsx',
  'v8/affiliates/create.tsx',
  'v8/affiliates/offer-form.tsx',
  // 支払いの取り決めと紹介者名を一つの確認で保護する。
  'v8/affiliates/drawer.tsx',
  'app/analytics/reports/new/page.tsx',
  'v8/auto-replies/edit/wizard.tsx',
  'app/booking/menus/new/page.tsx',
  'app/booking/menus/staff/page.tsx',
  'app/booking/staff/new/page.tsx',
  'v8/common-vars-edit/new.tsx',
  'v8/conversions/create.tsx',
  'v8/contents/media-upload-dialog.tsx',
  'v8/settings/ec-commerce/connector.tsx',
  'v8/form-edit/edit.tsx',
  'v8/templates/asset-list.tsx',
  // 2026-10-07：入口は src/v8 の画面を出すだけ。番兵は画面（operator-edit）が持つ。
  'v8/line-notifications/operator-edit.tsx',
  'app/mileage/earning-rules/edit/v8-earning-rule-edit.tsx',
  /* 入口 page.tsx は V8 の画面を出すだけ。番兵は src/v8 の画面が持つ。 */
  'v8/mileage/reward-edit.tsx',
  'v8/mileage/earning-rules.tsx',
  'v8/nen-campaigns/column-intros.tsx',
  'app/nen-campaigns/page.tsx',
  // ★V8 マイペットのごはんの目安。下の帯の保存まで画面に残る変更を useUnsavedGuard で守る。
  'v8/nen-pets/feeding.tsx',
  'v8/reminders/new/new.tsx',
  'app/reminders/new/page.tsx',
  'v8/restaurant/google/profile-edit.tsx',
  'v8/restaurant/google/hours.tsx',
  // 自動配席の編集窓。保存前の変更を、離れる前に確認する。
  'v8/restaurant/tables/auto-assignment-dialog.tsx',
  'v8/restaurant/google/profile-hours.tsx',
  'v8/rich-menus/new/create.tsx',
  'app/rich-menus/new/page.tsx',
  // ★V8：入口（app/settings/file-scan/page.tsx）は src/v8 の画面を出すだけ。番兵は画面と同じ場所のフックが持つ。
  'v8/settings/file-scan/screen.tsx',
  'v8/settings/features/screen.tsx',
  'v8/settings/staff/create.tsx',
  'app/tags/fields/edit/page.tsx',
  'app/tags/fields/new/page.tsx',
  'app/tags/marks/edit/page.tsx',
  'app/tags/searches/edit/page.tsx',
  'v8/webhooks/create.tsx',
  'v8/conversions/create.tsx',
  'v8/form-edit/edit.tsx',
  'v8/friend-add/editor.tsx',
  'v8/inflow-links/new/create.tsx',
  // ★V8 共通変数の編集・作る（src/v8/common-vars-edit）。useUnsavedGuard で番兵を持つ。
  'v8/common-vars-edit/edit.tsx',
  'v8/common-vars-edit/new.tsx',
  'app/webinars/edit/page.tsx',
  'app/webinars/new/page.tsx',
  'components/broadcasts/broadcast-form.tsx',
  'v8/events/edit-form.tsx',
  'v8/events/create.tsx',
  'v8/tags/mark-editor.tsx',
  /* 2026-10-07：src/v8 に一から書いた画面。それぞれ自分で useUnsavedGuard と離脱確認を持つ。 */
  'v8/booking-menus/assign.tsx',
  'v8/booking-menus/menu-form.tsx',
  'v8/booking-menus/settings.tsx',
  'v8/booking-staff/staff-new.tsx',
  'v8/events/create.tsx',
  'v8/mileage/earning-rule-new/create.tsx',
  'v8/nen-campaigns/column-new.tsx',
  'v8/nen-campaigns/edit.tsx',
  'v8/nen-members/lifetime.tsx',
  'v8/nen-members/ranks.tsx',
  'v8/ops/announcement-edit.tsx',
  'v8/reminders/edit.tsx',
  'v8/restaurant/google/posts.tsx',
  'v8/restaurant/google/reviews.tsx',
  'v8/restaurant/reservations/phone.tsx',
  'v8/restaurant/store-new/store-new.tsx',
  'v8/hq-broadcasts/create.tsx',
  'v8/settings/booking-media/screen.tsx',
  'v8/template-edit/asset.tsx',
  'v8/visit-stamps/visit-stamps.tsx',
  'v8/template-edit/message.tsx',
  'v8/webinar-edit/edit.tsx',
  'v8/webinar-edit/new.tsx',
  /*
   * 2026-10-07：src/v8 の分類で、保存していない変更を画面に持つのに番兵が無かったので足した。
   * シナリオ詳細（追従バーの「未保存の変更があります」）・アカウントの乗り換え（保存していない判断の書き換え）・
   * 予約枠と在庫（下の帯で保存する配分と開ける時間）・統括のお問い合わせ（書きかけの件名・内容・画像）。
   */
  'v8/scenario-detail/detail.tsx',
  'v8/accounts-detail/handover.tsx',
  'v8/restaurant/inventory/stock.tsx',
  'v8/restaurant/inventory/rules.tsx',
  'v8/hq/support.tsx',
  'v8/onboarding/individual-quote-inquiry.tsx',
  'v8/hq/support-detail.tsx',
  /* 2026-10-07：src/v8 に一から書いた画面（まとめの取り込みで見張りの対象に入った）。それぞれ自分で useUnsavedGuard と離脱確認を持つ。 */
  'v8/tag-edit/search-edit.tsx',
  'v8/tags/create.tsx',
  'v8/tags/field-editor.tsx',
  'v8/tags/mark-editor.tsx',
  'v8/hq-templates/attributes.tsx',
  'v8/template-edit/rich.tsx',
  'v8/template-edit/rich-video.tsx',
  'v8/templates/carousel.tsx',
  'v8/templates/question-new.tsx',
  'v8/settings/manual-links/screen.tsx',
  'components/shared/form-leave-guard.tsx',
  'v8/restaurant/line-followup/followup-editor.tsx',
  'v8/restaurant/line-followup/reservation-form-editor.tsx',
  'v8/ai-reply/qa-edit-dialog.tsx',
] as const

/*
 * dirty を子（pane・部分部品）から親へ報告し、番兵は親が持つ画面。
 * 子は `onDirtyChange` 等で報告するだけで、自分では確認対話を出さない。
 */
const COVERED_BY_PARENT: Record<string, string | readonly string[]> = {
  'v8/restaurant/google/hours-edit-panel.tsx': 'v8/restaurant/google/hours.tsx',
  'components/shared/folder-row-actions.tsx': 'components/shared/folder-add-dialog.tsx',
  // タブ枠は子の名前編集を保持し、確認は子の共通ガードが担当する。
  'v8/tags/list.tsx': 'components/shared/use-inline-detail-guard.tsx',
  'v8/common-vars/list-dialogs.tsx': 'v8/common-vars/list.tsx',
  'v8/templates/list-dialogs.tsx': 'v8/templates/list.tsx',
  // 再開画面のスタイル・メニューは共通の登録状態が離脱を守る。
  'v8/account-new/resume-style.tsx': 'v8/account-new/registration-unsaved-guard.tsx',
  // 飲食店のフォームと選択中の値は組織画面の番兵へ伝える。
  'v8/restaurant/organization/organization-forms.tsx': 'v8/restaurant/organization/organization.tsx',
  // 統合ユーザーの2つの一覧・詳細は子窓の番兵へ委譲し、履歴とパンくずの切替を連携する。
  'app/users/users-screen.tsx': ['components/merged-person/merged-profile-dialog.tsx', 'components/merged-person/merged-delivery-dialog.tsx'],
  'v8/friends/merged/merged.tsx': ['components/merged-person/merged-profile-dialog.tsx', 'components/merged-person/merged-delivery-dialog.tsx'],
  'v8/friends/merged/person.tsx': ['components/merged-person/merged-profile-dialog.tsx', 'components/merged-person/merged-delivery-dialog.tsx'],
  // 共通アクションの編集値は CreatePage に渡し、型の番兵が離脱を守る。
  'v8/automations/common-action-edit.tsx': 'components/templates/create-page.tsx',
  // 入口は保存状態を持たず、カードの入力と画面離脱は実体の番兵へ委ねる。
  'v8/restaurant/line-followup/line-followup.tsx': 'v8/restaurant/line-followup/followup-board.tsx',
  // 振替の窓はonEditStateで未保存/保存中を親へ返し、Dialogが窓内の破棄を、親の番兵が画面離脱を守る。
  'v8/events/makeup-rule-section.tsx': 'v8/events/edit-form.tsx',
  'v8/onboarding/initial-menu-page.tsx': 'components/templates/create-page.tsx',
  'v8/friend-add/editor-basic-routes.tsx': 'v8/friend-add/editor.tsx',
  'v8/friend-add/editor-message.tsx': 'v8/friend-add/editor.tsx',
  // 登録中のスタッフは親の入力を表示するだけ。入力と離脱確認を持つ親を検査する。
  'v8/booking-staff/phone.tsx': 'v8/booking-staff/staff-new.tsx',
  // U05: state/ref と離脱確認は従来の親が保持する。分割先をその親へ結び直す（対象外の追加ではない）。
  'v8/auto-replies/edit/wizard-load.tsx': 'v8/auto-replies/edit/wizard.tsx',
  'v8/auto-replies/edit/wizard-model.tsx': 'v8/auto-replies/edit/wizard.tsx',
  'v8/auto-replies/edit/wizard-save.tsx': 'v8/auto-replies/edit/wizard.tsx',
  'v8/rich-menus/new/create-audience-step.tsx': 'v8/rich-menus/new/create.tsx',
  'v8/rich-menus/new/create-hydration.tsx': 'v8/rich-menus/new/create.tsx',
  'v8/rich-menus/new/create-image-slots.tsx': 'v8/rich-menus/new/create.tsx',
  'v8/rich-menus/new/create-preview-rail.tsx': 'v8/rich-menus/new/create.tsx',
  'v8/rich-menus/new/create-publish-step.tsx': 'v8/rich-menus/new/create.tsx',
  'components/broadcasts/broadcast-confirm-dialogs.tsx': 'components/broadcasts/broadcast-form.tsx',
  'components/broadcasts/broadcast-persist-draft.tsx': 'components/broadcasts/broadcast-form.tsx',
  'v8/reminders/edit-basics.tsx': 'v8/reminders/edit.tsx',
  'v8/reminders/edit-confirm.tsx': 'v8/reminders/edit.tsx',
  'v8/reminders/edit-messages.tsx': 'v8/reminders/edit.tsx',
  'v8/reminders/edit-schedule.tsx': 'v8/reminders/edit.tsx',
  'v8/common-vars-edit/edit-value-fields.tsx': 'v8/common-vars-edit/edit.tsx',
  // U04: 入力状態と番兵は元の入口が持つ。分割先も親の番兵の検査対象にする（対象外にはしない）。
  'v8/automations/create/automation-dialogs.tsx': 'v8/automations/create/create.tsx',
  'v8/automations/create/use-automation-draft-resume.tsx': 'v8/automations/create/create.tsx',
  'v8/automations/create/use-automation-save.tsx': 'v8/automations/create/create.tsx',
  'v8/scenario-detail/scenario-detail-body.tsx': 'v8/scenario-detail/detail.tsx',
  'v8/scenario-detail/scenario-detail-dialogs.tsx': 'v8/scenario-detail/detail.tsx',
  'v8/scenario-detail/use-scenario-settings.tsx': 'v8/scenario-detail/detail.tsx',
  // 統合後の入力の持ち主。各画面が dirty を型／番兵へ渡す。
  'v8/booking-gap/series-drawer.tsx': 'components/shared/form-leave-guard.tsx',
  'v8/booking-menus/customer-booking.tsx': 'v8/booking-menus/menu-form.tsx',
  'v8/booking-menus/meeting-mode.tsx': 'v8/booking-menus/menu-form.tsx',
  'v8/booking-menus/staff-calendar.tsx': 'components/shared/form-leave-guard.tsx',
  'v8/booking-menus/tabs/staff-tab.tsx': 'v8/booking-menus/settings.tsx',
  'v8/booking-payments/assignment.tsx': 'v8/booking-menus/settings.tsx',
  'v8/booking-payments/cancellation.tsx': 'v8/booking-menus/settings.tsx',
  'v8/booking-payments/menu-deposit.tsx': 'v8/booking-menus/menu-form.tsx',
  'v8/booking-payments/menu-payment.tsx': 'v8/booking-menus/menu-form.tsx',
  'v8/booking-payments/payments-tab.tsx': 'v8/booking-menus/settings.tsx',
  'v8/inbox-chat/routing-drawer.tsx': 'components/shared/form-leave-guard.tsx',
  'v8/restaurant/menu/edit.tsx': 'components/templates/create-page.tsx',

  // ③-2 第3波：作る画面は CreatePage の dirty、編集の引き出しは Drawer の離脱の確認、ランクの段の窓は Dialog が守る。
  'v8/booking-passes/create.tsx': 'components/templates/create-page.tsx',
  'v8/form-edit/content-tab.tsx': 'v8/form-edit/edit.tsx',
  // 動き1：画面のdirtyは型／共通の番兵が守る。
  'v8/emergency/control.tsx': 'components/shared/form-leave-guard.tsx',
  'components/templates/create-page.tsx': 'components/shared/form-leave-guard.tsx',
  'v8/dashboard/dashboard-editor.tsx': 'components/templates/create-page.tsx',
  'v8/hq/settings.tsx': 'components/shared/form-leave-guard.tsx',
  'v8/restaurant/google/settings.tsx': 'components/shared/form-leave-guard.tsx',
  'v8/tag-edit/edit-form.tsx': 'components/templates/create-page.tsx',
  'v8/template-edit/frame.tsx': 'v8/template-edit/message.tsx',
  // リンクの見え方も含め、入力は親のスナップショットへ即時反映する。窓を閉じても残り、離脱は親の番兵が守る。
  'v8/form-edit/appearance-tab.tsx': 'v8/form-edit/edit.tsx',
  // ★V8 版の描画。番兵（useUnsavedGuard）は同じ画面の page.tsx が
  // 共有フック経由で持つ。どちらのテーマでも同じ番兵が効く。
  'app/affiliate-offers/new/page.tsx': 'v8/affiliate-offer-new/create.tsx',
  'app/settings/page.tsx': 'v8/settings/features/screen.tsx',

  // 予約設定V8のタブ分割。書きかけは V8TabEditContext で親へ報告し、
  // 番兵（useUnsavedGuard＋離脱確認）は殻の settings-v8.tsx が持つ。
  // ★V8 予約設定（src/v8/booking-menus）のタブ。書きかけは V8TabEditContext で殻の settings.tsx へ報告し、番兵は殻が持つ。
  'v8/booking-menus/settings-view.tsx': 'v8/booking-menus/settings.tsx',
  'v8/booking-menus/photos.tsx': 'v8/booking-menus/settings.tsx',
  'v8/booking-menus/tabs/shared.tsx': 'v8/booking-menus/settings.tsx',
  'v8/booking-menus/tabs/hours-tab.tsx': 'v8/booking-menus/settings.tsx',
  'v8/booking-menus/tabs/holidays-tab.tsx': 'v8/booking-menus/settings.tsx',
  'v8/booking-menus/tabs/rules-tab.tsx': 'v8/booking-menus/settings.tsx',
  // ★V8 ウェビナーの編集（src/v8/webinar-edit）の段。onDirtyChange で edit.tsx へ報告し、番兵は edit.tsx が持つ。
  'v8/webinar-edit/basic.tsx': 'v8/webinar-edit/edit.tsx',
  'v8/webinar-edit/comments.tsx': 'v8/webinar-edit/edit.tsx',
  'v8/webinar-edit/cta.tsx': 'v8/webinar-edit/edit.tsx',
  'v8/webinar-edit/notifications.tsx': 'v8/webinar-edit/edit.tsx',
  'v8/webinar-edit/video.tsx': 'v8/webinar-edit/edit.tsx',
  // 予約設定のタブ。書きかけは V8TabEditContext で殻の settings.tsx へ報告し、番兵は殻が持つ。
  // 割り当て方・メニューごとの支払いは「状態の持ち方」の部品。dirty を返すだけで、番兵は使う側の画面が持つ。
  // 配信の自動応答の編集は、一覧と同じ console.tsx の中で開く。書きかけの有無は親が持ち、番兵は親が持つ。
  'v8/hq-deliveries/auto-reply-editor.tsx': 'v8/hq-deliveries/console.tsx',
  // 作る・直す型（CreatePage）に dirty を渡す画面。離脱の番兵は型が持つ。
}

/*
 * dirty はあるが、画面離脱の番兵を「今は」持たないもの。理由を必ず書く。
 * 番兵を付けられるようになったら EXEMPTIONS から GUARDED へ移す。
 */
const EXEMPTIONS: Record<string, string> = {
  'v8/hq/musubo-line-removal-dialog.tsx': '終了方法のラジオ選択はサーバーへ保存しない確認中の選択。閉じてもLINEの終了予約や利用状態は変更されず、確定ボタンでのみ操作する。',
  'components/shared/managed-folder-panel.tsx': '共通フォルダ列は追加窓を開く操作を既存の未保存確認へ委ねる。名前・色の入力は子窓が持ち、各呼び出し元での画面離脱は別途確認する。',
  'components/shared/inline-edit.tsx': '共有入力部品であり独立した画面ではない。保存前の値を保持するオプションは呼び出し側へ状態を通知し、紹介者画面では同画面の番兵が守る。他の利用箇所は別途点検する。',
  'v8/events/list.tsx': 'イベント詳細の名前は use-inline-detail-guard.tsx が保護する。検索・絞り込みは表示条件で、その他の窓は別途確認する。',
  'v8/restaurant/line-followup/demo.tsx': 'phaseだけで描く静的な見本。編集状態・保存・API呼出はなく、全操作はaria-hiddenとinertの内側、文字入力はreadOnly。未保存は見本の札であり利用者の下書きではない。',
  'v8/restaurant/common-a/frame.tsx': '取得と店の選択だけを持つ共通の器。未保存の入力を持たず、店の切り替えはrequestUnsavedActionで子の実際の番兵へ委ねる。',
  'v8/mileage/adjust-dialog.tsx': '入力中は共通Dialogの自動dirty検出とuseOverlayDiscardが閉じる操作を止める。確認・完了の段だけdirty=false。adjust-dialog-field-errorsの実描画で入力→閉じるの破棄確認とAPI/close未実行を確かめる。',
  'components/shared/table-body.tsx':
    '共有の仮想行表示。structureDirty は列とスクロール領域の寸法キャッシュを再計測する印で、入力の下書きではない。行の表示範囲・実測高さ・フォーカス行を管理するだけで、編集値や保存処理は呼び出し元が持つ。',
  'v8/mileage/ranks.tsx':
    '③-2 第3波：会員ランクのタブ。入力は段を足す・直す小窓（Dialog）の中だけで、窓の保存か［キャンセル］で閉じる。タブ本体は入力を溜めず、数える物・期間は選ぶと即保存する。',
  'v8/style-dashboard/settings-panels.tsx': '表示を変える引き出し・休みを入れる窓。入力は引き出し・窓の中だけで、閉じると戻る。引き出しは dirty の間、閉じる前に破棄の確認を出す',
  'v8/onboarding/wizard.tsx': '入力は窓の中だけ。閉じる・Esc・背景は共通Dialogの破棄確認を通り、破棄では保存しない。明示的な途中保存と失敗時の入力保持は実Wizardと実Dialogの操作試験で守る',
  'components/friend-fields/edit-tag-page-v4.tsx':
    '保管済みタグの名前と説明の訂正。元の取消は確認なしで入力を破棄するため、共通作成型も dirty=false で同じ動きを保つ。番兵の要否は削除台帳の司令塔に確認へ記録する',
  'v8/restaurant/google/google.tsx':
    '編集を持たないGoogleの外枠。タブ・店舗の切替を共通の未保存確認へ委ね、現在の編集画面自身の番兵が止める。URLの試験で確認→続ける/破棄の動きを守る',
  'components/shared/entity-picker.tsx': '選ぶ窓の候補は仮選択で、選ぶを押したときだけ親へ渡す。閉じる操作は仮選択を破棄し、親の保存前の値を変えない。',
  'v8/restaurant/google/post-media-picker-dialog.tsx': '投稿の画像を選ぶ窓。候補は仮選択で、使うを押したときだけ親へ渡す。キャンセルと閉じる操作は仮選択を捨て、親の保存前の値を変えない。',
  'components/chats/friend-info-sidebar.tsx':
    '受信箱の右の欄（B-26 その場で直す）。対応状況・担当・タグは押した瞬間に保存し、メモは書くのをやめて1秒で保存する。保存待ちの入力を溜めないので番兵の対象外（失敗は知らせで戻してもう一度試す）',
  'components/hq/account-menu.tsx':
    '編集を持たないメニュー。アカウント解除と移動を共通の未保存確認へ委ねる',
  'components/shared/top-bar.tsx':
    '編集を持たない上部の帯の部品。段を替えて戻るパンくず（onSelect）を共通の未保存確認（requestUnsavedAction）へ委ねる',
  'components/shell/app-top-bar.tsx':
    '編集を持たない上部の帯。アカウント切替と移動を共通の未保存確認へ委ねる',
  'components/mobile/mobile-shell.tsx':
    '編集を持たない電話の外枠。下のタブ・アカウント切替を共通の未保存確認へ委ね、今の画面自身の番兵が止める',
  'components/shared/command-palette.tsx':
    '編集を持たない探す窓（⌘K）。選んだ行き先への移動を共通の未保存確認へ委ねる',
  'v8/mcp-connect/section.tsx': 'G9 AI とつなぐの区画（Xb0yc）。作る窓の入力は閉じると何も作らない窓の中だけで、止める・作り直すは確認窓で確定する。画面に残る下書きを持たない',
  'v8/restaurant/closures/closure-dialog.tsx': '臨時休業・貸切を足す・変える窓（提案 E-10 nVvXy）。保存の口は窓の中だけで、開くたびに押した日か記録から作り直し、閉じると入力を破棄する。',
  'v8/restaurant/front-desk/phone-drawer.tsx': '電話予約の引き出し（提案 E-2）。保存の口は引き出しの中だけで、開くたびに空から始まり、閉じると入力を破棄する（入力中は題に * が付く）。',
  'v8/reminders/basics-form.tsx':
    'リマインダの作る・直す画面（v8/reminders/edit.tsx・番兵あり）の中の①基本の欄。保存の口に見えるのはフォルダを選ぶ欄からその場でフォルダを作る口（dLffh）だけで、入力の保存は親の画面の番兵が見張る',
  'app/affiliates/new/page.tsx':
    '「未保存の追加情報を破棄して一覧へ戻る」明示フロー。dirty管理ではなく部分保存の案内',
  'app/booking/bookings/new/page.tsx':
    'dirty管理なし（コメント中の「未保存」記述のみ）',
  'app/line-notifications/page.tsx':
    '入力を端末の下書きへ随時保存し、閉じる確認はエディタ内で済ませる設計。画面離脱への警告は要検討',
  'app/scenarios/mode/page.tsx':
    '★V7: 方式選択はラジオの即時確定で未保存を持たない。名前・フォルダ欄は新規時は確定時に同送、既存時は欄内の保存で確定する小さな操作のため番兵を付けない',
  'components/scenarios/trigger-editor.tsx':
    'ダイアログ内の dirty。閉じると元に戻る仕様で、画面離脱ガードの対象外',
  'components/shared/drawer.tsx':
    'dirty 印（*）を表示するだけの共通部品。編集画面ではない',
  'components/shared/dialog.tsx':
    '確認窓の共通部品。未保存の離脱確認では primaryAction="cancel" で残る方を主にする。窓自体は編集を持たない',
  'components/shared/confirm-dialog.tsx':
    '確認窓の共通部品。未保存の離脱確認では主が取消のとき印を付けない。窓自体は編集を持たない',
  'components/shared/overlay-utils.ts':
    '重なりの共通部品。初回フォーカスの寄せ先を呼出側で選べるだけで、編集を持たない',
  'components/shared/button.tsx':
    'ボタンの共通部品。開いた直後の標的用の ref を受けられるだけで、編集を持たない',
  'app/form-submissions/page.tsx':
    '一覧と絞り込みが中心。作る操作は下書きを作って編集画面（GUARDED）へ渡すため、この画面に残る下書きを持たない',
  'app/inflow-links/page.tsx':
    '一覧の一括操作（移動・再開）は押した直後に即時保存し、下書きを持たない',
  'v8/automations/list.tsx':
    '自動化の一覧。入力欄は「試しに動かす」の窓の友だちIDだけで、押して試すまでの一時の値。保存する下書きを持たない（2026-10-08 入力欄を正本の TextField へ移したので見張りに拾われた）',
  'v8/automations/common-action-new.tsx':
    'app/common-actions/common-action-new-v8.tsx と同じ画面を src/v8 に一から書いたもの（j2hfkS）。番兵の要否は元の画面（new/page.tsx・s3 未判定）と一緒に決めるため、同じ扱いでここに置く',
  'v8/tags/field-migrate.tsx':
    'app/tags/field-migrate-v8.tsx と同じ項目移行画面を src/v8 に一から書いたもの（GobMd）。事前確認→明示実行の2段階で、途中離脱で失うのは確認状態だけ',
  'v8/tag-edit/edit.tsx':
    'タグの編集（xn95q）を src/v8 に一から書いたもの。元の画面（components/friend-fields/edit-tag-page-v4.tsx・s1 未判定）と同じ扱いで、番兵の要否は元の画面と一緒に決める',
  'app/inflow-links/detail/page.tsx':
    '転送先の編集は保存ボタン確定式。下書き・dirty 管理がなく番兵の扱いは別途検討',
  'v8/mileage/score-rules.tsx':
    '下書き保存式の編集画面。番兵の扱いは別途検討',
  'components/friend-fields/tags-page-v4.tsx':
    '一覧上の操作（表示切替・分類・並び替え）は押した直後に即時保存し、下書きを持たない',
  'components/friend-fields/tag-editor-v4.tsx':
    '遡及の人数と合計を確認する短い確認窓。dirty=false/confirmationで確認のチェックだけを取り消し、元の編集の入力は親の番兵が保持する',
  /* ★V8 の新しい画面（src/v8）。古い画面ファイルの理由をそのまま写した（2026-10-06）。 */
  'v8/broadcasts/list.tsx':
    '★V8 の一斉配信一覧（l5V9a）。一覧と絞り込みが中心。フォルダ・並び替え・保存した検索など一覧上の操作は押した直後に即時保存し、配信の作成は下書きを作って編集画面（GUARDED）へ渡すため、この画面に残る下書きを持たない',
  'v8/conversions/list.tsx':
    '★V8 のコンバージョンの一覧（r6dJFy）。探す欄・絞り込み・件数表示は一覧上の操作で下書きを持たない。止める小窓の理由欄は閉じると戻る小窓内の入力',
  'v8/scenarios/list.tsx':
    '詳細のシナリオ名は use-inline-detail-guard.tsx が保護する。複製やフォルダの窓は別途確認する。',
  'v8/auto-replies/list.tsx':
    '★V8 の自動応答一覧（uE9gf）。一覧上の操作（停止・再開・フォルダ移動・並び替え・複製・削除）は押した直後に確認窓か即時保存で確定し、画面に残る下書きを持たない。止める窓の理由欄は閉じると戻るダイアログ内の入力',
  'v8/analytics/cross.tsx':
    '★V8 分析のクロス集計。選ぶ欄は集計の条件で、結果の枡から対象者を作って友だち一覧・配信へ渡すだけ。保存する編集画面ではなく、画面に残る下書きを持たない',
  'v8/analytics/funnel.tsx':
    '★V8 分析のファネル。選ぶ欄は見る条件で、結果から対象者を作って友だち一覧・配信へ渡すだけ。保存する編集画面ではなく、画面に残る下書きを持たない',
  /* 2026-10-07：src/v8 に一から書いた画面の分類。元の画面ファイルがあるものはその扱いに合わせた。 */
  'v8/account-new/register.tsx':
    '登録の秘密値とスタイル・初期メニューは registration-unsaved-guard.tsx の番兵で保護。前半の非秘密入力は端末に保存されるが、確認項目などほかの一時状態は別途確認する。',
  'v8/reminders/detail.tsx':
    'app/reminders/detail/detail-v8.tsx と同じ画面の★V8版。登録者の基準日は行内の小さな編集で「基準日を保存」で確定する。元の画面と同じ扱い',
  'v8/settings/line-notifications/screen.tsx':
    'app/line-notifications/page.tsx と同じ画面の★V8版。入力を端末の下書きへ随時保存し、開き直すと復元する。閉じる確認はエディタ内で済ませる設計で、画面離脱への警告は元の画面と一緒に決める',
  'v8/settings/staff/staff.tsx':
    'app/staff/page.tsx と同じ画面の★V8版。dirty は権限プレビューの「変更後の予定」の印で、編集は右の窓の中。窓のリンクは下書きを捨てて移る仕様として明示済み',
  'components/accounts/account-ordering.tsx':
    '★V8 LINEアカウント一覧（src/v8/settings/accounts）の「並び順と親子を変える」窓の中身。並び替えは窓の中だけで、窓を閉じると保存前の並びは捨てて一覧を読み直す（v7 の一覧からは開かない）',
  'v8/accounts-detail/dialogs.tsx':
    '★V8 LINEアカウントの詳細から開く窓（送受信を止める・資格情報の差し替え・アーカイブ・登録の内容を編集）。入力はすべて窓の中で、閉じると戻る',
  'v8/booking-staff/shifts.tsx':
    'app/booking/staff/shifts/staff-detail-v8.tsx と同じ画面の★V8版（d5fmnM・E3YDK・wvGke）。各段がそれぞれの「保存」「作る」「足す」でその場で確定する。元の画面と同じ扱い',
  'v8/events/bookings.tsx':
    'app/events/bookings/bookings-v8.tsx と同じ画面の★V8版（Mu8qW）。承認・キャンセル・待ち順は確認窓で確定して即時保存し、お知らせは「送る」で即時送信する。窓内の理由欄は閉じると戻る',
  'v8/friend-detail/dialogs.tsx':
    '★V8 友だち詳細の個別操作から開く2つの窓（対応状況を編集・シナリオに登録する）。入力は窓の中で、閉じると戻る',
  'v8/hq-templates/console.tsx':
    'app/hq/templates/template-console.tsx と同じ画面の★V8版。多段の作る・配る流れで、段の途中離脱の扱いは元の画面と一緒に決めるため同じ扱い',
  'v8/inflow-links/detail.tsx':
    'app/inflow-links/detail/page.tsx と同じ画面の★V8版（Q5le3）。リンクの編集は窓の中の保存で確定し、ほかの欄は読み取り専用のURL・絞り込み・件数',
  'v8/nen-posts/policy-history.tsx':
    'app/nen-members/photo-policy-history-v8.tsx と同じ小さな窓の★V8版。親の設定画面から開き、閉じれば保存前の値を破棄する',
  'v8/ops/support.tsx':
    '★V8 運営のお問い合わせ（受信箱型）。返信欄は問い合わせごとの下書きで「下書きを保存する」でサーバへ残し、開き直すと読み戻す。起票は窓の中。問い合わせの切り替えが画面内のため、離脱の扱いは元の画面（app/ops/support/page.tsx・未判定）と一緒に決める',
  'v8/restaurant/menu/menu.tsx':
    'app/restaurant-test/v8/menu.tsx と同じ画面の★V8版（MJoJR）。メニューの追加・変更は窓（NkmwU）の中で、閉じると戻る',
  'v8/restaurant/tables/tables.tsx':
    'app/restaurant-test/v8/tables.tsx と同じ画面の★V8版（BERxg）。卓の追加・変更は窓（gBrCz）の中で、閉じると戻る',
  'components/shared/restaurant-table-pen-editor.tsx':
    '卓の追加・変更フォーム本体。下書きは親の tables.tsx が持ち、親の窓を閉じると保存前の値を破棄する。',
  'v8/scenario-first-step/first-step.tsx':
    'app/scenarios/first-step-v8.tsx と同じ画面の★V8版（V6xAo）。番兵の要否は元の画面（first-step/page.tsx・未判定）と一緒に決めるため同じ扱い',
  'v8/nen-pets/editor.tsx':
    'app/nen/pets/pet-editor.tsx と同じ窓の★V8版（eLjeQ）。入力はすべて窓の中で、閉じると戻る。番兵の要否は元の窓（未判定）と一緒に決めるため同じ扱い',
}

/*
 * もう描かれない古い画面ファイル（入口は src/v8 の新しい画面か、別の画面を出す）。
 * ファイルは切り替えの日まで残るので、探すと見つかる。見張っても意味が無いので探す対象から外す。
 * 切り替えの日にファイルと一緒にここから消す（2026-10-06 に GUARDED・EXEMPTIONS・UNTRIAGED から移した）。
 * 2026-10-07：載っていた11本はどの入口からも描かれないので消した（外付けSSDの lh-archive-20261007/repo-code に写しあり）。
 * account-ordering.tsx は V8 の LINE アカウント一覧の窓から開くようになったので、ここから EXEMPTIONS へ移した。
 */
const NOT_RENDERED: Record<string, string> = {
}

/*
 * V6R-S0-c: 「dirty を持たない編集画面」も網に入れる。
 *
 * 上の DIRTY_SIGNATURE は、変更の有無を名前や文言で持つ画面しか拾えない。
 * 変更の有無そのものを持たない編集画面（一斉配信の作成・テンプレート編集など）は、
 * 番兵が無くてもこの試験を通っていた。そこで「保存の口」と「入力欄3つ以上」を持つ
 * 画面を編集画面とみなし、分類を求める。
 */
const EDITOR_SAVE_SIGNATURE = /(?:\bapi(?:\.[A-Za-z]+)+|\b[a-z][A-Za-z]*Api)\.(?:create|update|save|patch|upsert)[A-Za-z]*\(/
const EDITOR_INPUT_SIGNATURE = /<(input|textarea|TextField|TextArea|SharedTextField|SharedTextArea|Select|DateField|DateTimeField|TimeField)\b/g
const EDITOR_MIN_INPUTS = 3

/*
 * 編集画面の印はあるが、番兵が要るかをまだ決めていないもの（2026-09-23 時点の棚卸し）。
 * 担当レーンが「GUARDED へ移す」か「理由を書いて EXEMPTIONS へ移す」を決め、ここから消す。
 * **ここへの追加は禁止。** 新しい編集画面は最初から GUARDED か EXEMPTIONS に入れる。
 */
const UNTRIAGED: Record<string, string> = {
  /* 予約設定V8化でスタッフ編集窓を staff-edit-dialog.tsx へ切り出し、page.tsx から編集画面の印が無くなったので行を消した。 */
  /* ★管理画面: 書き出し項目を共通 Checkbox へ寄せたら入力の印が3未満になり、編集画面の印が無くなったので行を消した。 */
  // 統括の入口はV8の再exportだけ。v8/hq/support.tsx の番兵を上の契約で点検する。
  // お問い合わせの入口はV8だけを読む。現役の返信下書き/起票の扱いは上で点検する。
  'v8/webhooks/edit.tsx':
    's3: 未判定。番兵が要る長い編集か、閉じれば戻る小さな操作かを担当が決める',
  'components/accounts/account-edit-modal.tsx':
    'hq: 未判定。番兵が要る長い編集か、閉じれば戻る小さな操作かを担当が決める',
  'components/broadcasts/broadcast-asset-manager.tsx':
    's2: 未判定。番兵が要る長い編集か、閉じれば戻る小さな操作かを担当が決める',
  'components/friend-fields/support-mark-rules-panel.tsx':
    's1: 未判定。番兵が要る長い編集か、閉じれば戻る小さな操作かを担当が決める',
  'components/friends/advanced-search-dialog.tsx':
    's1: 未判定。番兵が要る長い編集か、閉じれば戻る小さな操作かを担当が決める',
  'components/friends/single-friend-actions.tsx':
    's1: 未判定。番兵が要る長い編集か、閉じれば戻る小さな操作かを担当が決める',
  'components/scenarios/action-editor.tsx':
    's1: 未判定。番兵が要る長い編集か、閉じれば戻る小さな操作かを担当が決める',
}

/*
 * 探す場所。V8 の新しい画面は src/v8 に一から書く（2026-10-06〜）。入口が `@/v8/...` を
 * 出すようになったので、ここも探す。古い画面ファイル（もう描かれないもの）は表から外した。
 */
const SCAN_ROOTS = ['app', 'components', 'v8'] as const

function* tsxFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* tsxFiles(path)
    } else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
      yield path
    }
  }
}

function dirtyTrackingFiles(): string[] {
  const found: string[] = []
  for (const root of SCAN_ROOTS) {
    for (const path of tsxFiles(join(SRC, root))) {
      const file = path.slice(SRC.length + 1)
      if (file in NOT_RENDERED) continue
      if (DIRTY_SIGNATURE.test(readFileSync(path, 'utf8'))) {
        found.push(file)
      }
    }
  }
  return found.sort()
}

function editorFiles(): string[] {
  const found: string[] = []
  for (const root of SCAN_ROOTS) {
    for (const path of tsxFiles(join(SRC, root))) {
      if (path.slice(SRC.length + 1) in NOT_RENDERED) continue
      const source = readFileSync(path, 'utf8')
      if (DIRTY_SIGNATURE.test(source)) continue
      if (!EDITOR_SAVE_SIGNATURE.test(source)) continue
      if ((source.match(EDITOR_INPUT_SIGNATURE) ?? []).length < EDITOR_MIN_INPUTS) continue
      found.push(path.slice(SRC.length + 1))
    }
  }
  return found.sort()
}

describe('未保存の編集がある画面は離脱の番兵を持つ契約（DETAIL-04系）', () => {
  it('dirty を持つ画面は「番兵あり／親が持つ／理由つき対象外」のどれかへ分類されている', () => {
    const classified = new Set([...GUARDED, ...Object.keys(COVERED_BY_PARENT), ...Object.keys(EXEMPTIONS)])
    const unclassified = dirtyTrackingFiles().filter((file) => !classified.has(file))
    expect(
      unclassified,
      '未保存の編集状態を持つ画面が未分類です。useUnsavedGuard を付けて GUARDED へ、' +
        'または理由を書いて EXEMPTIONS へ追加してください（unsaved-guard-wiring-contract.test.ts）',
    ).toEqual([])
  })

  /*
   * 画面の守りを共有フック（同じフォルダの use-*.ts）へ寄せた画面は、
   * フックの中身も合わせて1つの画面として見る。
   */

  it('番兵を持つ画面は共通フックと離脱確認ダイアログを配線している', () => {
    // 足りない画面の一覧が空であること（ソース文字を直接は比べない。点検は scripts/unsaved-guard-wiring.mjs）。
    expect(screensWithoutLeaveGuard(SRC, [...new Set(GUARDED)])).toEqual([])
  })

  it('親へ dirty を報告する画面の親は、共通フックで番兵を持っている', () => {
    for (const [file, parents] of Object.entries(COVERED_BY_PARENT)) {
      for (const parent of typeof parents === 'string' ? [parents] : parents) {
        expect(screensWithoutLeaveGuard(SRC, [parent]), `${file} の番兵を持つ親 ${parent}`).toEqual([])
      }
    }
  })

  it('分類表に載せたファイルは実在し、対象外には理由がある', () => {
    for (const file of [...GUARDED, ...Object.keys(COVERED_BY_PARENT), ...Object.keys(EXEMPTIONS)]) {
      expect(() => readFileSync(join(SRC, file), 'utf8'), `${file} が見つかりません`).not.toThrow()
    }
    for (const [file, reason] of Object.entries(EXEMPTIONS)) {
      expect(reason.length, `${file} の対象外理由`).toBeGreaterThan(0)
    }
    for (const file of Object.keys(NOT_RENDERED)) {
      expect(() => readFileSync(join(SRC, file), 'utf8'), `${file} は消えたので NOT_RENDERED から消す`).not.toThrow()
    }
  })

  it('dirty を持たない編集画面も、分類か未判定の一覧のどちらかに載っている（V6R-S0-c）', () => {
    const known = new Set([
      ...GUARDED, ...Object.keys(COVERED_BY_PARENT), ...Object.keys(EXEMPTIONS), ...Object.keys(UNTRIAGED),
    ])
    const unclassified = editorFiles().filter((file) => !known.has(file))
    expect(
      unclassified,
      '保存の口と入力欄を持つ編集画面が未分類です。useUnsavedGuard を付けて GUARDED へ、' +
        'または理由を書いて EXEMPTIONS へ追加してください（UNTRIAGED への追加は禁止）',
    ).toEqual([])
  })

  it('未判定の一覧は、まだ番兵が無く・まだ編集画面の印を持つものだけ（直したら一覧から消す）', () => {
    const stale = Object.keys(UNTRIAGED).filter(file => {
      const source = readUiSource(join(SRC, file), 'utf8')
      const stillEditor = !DIRTY_SIGNATURE.test(source) && EDITOR_SAVE_SIGNATURE.test(source) && (source.match(EDITOR_INPUT_SIGNATURE) ?? []).length >= EDITOR_MIN_INPUTS
      return source.includes('useUnsavedGuard(') || !stillEditor
    })
    expect(stale, '番兵が付いた画面、編集の印が無くなった画面は未判定から外す').toEqual([])
  })
})
