import { initialMenuButtons, type PlannedInitialForms, type StyleMenuButton } from './style-initial-buttons.js';
import { restaurantMenuButtons } from './style-restaurant-buttons.js';
import { liffActionUrl, restaurantGuideMenu, type AccountStyle, type SetupAnswer } from '@line-crm/shared';

import { isCustomerUri, type StarterItem } from './style-starter-definition.js';
import { featureReadiness } from './style-readiness.js';

/** プレビューと保存で同じ解決を使い、移動先がなければ架空のテキスト操作へ置き換えない。 */
export async function styleMenuButtons(
  db: D1Database, account: string, style: AccountStyle, item: StarterItem,
  answers: Record<string, SetupAnswer>, plannedForms?: PlannedInitialForms,
): Promise<StyleMenuButton[]> {
  if (item.initialMenu) return initialMenuButtons(db,account,style,plannedForms,restaurantGuideMenu(style, answers.restaurantMenuPreset));
  if (style === 'restaurant') return restaurantMenuButtons(db, account, style, item, answers);
  const line = await db.prepare('SELECT liff_id FROM line_accounts WHERE id=?')
    .bind(account).first<{ liff_id: string | null }>();
  const buttons = [];
  for (const button of item.buttons ?? []) {
    const answer = answers[button.feature];
    if (button.feature !== 'contact' && answer && (answer.mode !== 'configured' || answer.value === false)) continue;
    let actionType = 'message', actionData = button.label, intent = 'text';
    if (button.feature === 'contact') {
      buttons.push({ ...button, actionType, actionData, intent });
      continue;
    }
    if (button.actionType === 'uri') {
      if (!isCustomerUri(button.actionData)) continue;
      const target = new URL(button.actionData);
      // 保存済みの別 LIFF ID で、顧客を他アカウントへ誘導しない。
      if (target.hostname === 'liff.line.me' && target.pathname.split('/')[1] !== line?.liff_id) continue;
      actionType = 'uri'; actionData = button.actionData; intent = 'url';
    } else if (button.actionType === 'message' && button.actionData?.trim()) {
      actionData = button.actionData;
    } else if (line?.liff_id) {
      const liffBase = `https://liff.line.me/${encodeURIComponent(line.liff_id)}`;
      if (button.feature === 'tickets') {
        actionData = `${liffBase}/?page=mypage`;
      } else if (button.feature === 'classCapacity' || (button.feature === 'booking' && style === 'lesson')) {
        if (button.actionData === 'history') actionData = `${liffBase}/events/me`;
        else {
          // 存在しないイベント一覧でなく、実際の公開教室へつなぐ。
          const event = await db.prepare(
            "SELECT id FROM events WHERE line_account_id=? AND is_published=1 AND deleted_at IS NULL AND (lifecycle_status IS NULL OR lifecycle_status='published') AND (? IS NULL OR id=?) ORDER BY id LIMIT 2",
          ).bind(account, answer?.resourceId ?? null, answer?.resourceId ?? null).all<{ id: string }>();
          // 複数教室がある場合は勝手に選ばず、移動先の明示を求める。
          if (event.results.length !== 1) continue;
          actionData = `${liffBase}/events/${encodeURIComponent(event.results[0]!.id)}`;
        }
      } else if (['booking', 'stamps'].includes(button.feature)) {
        if (!(await featureReadiness(db, account, button.feature, style)).ready) continue;
        if (button.feature === 'stamps') actionData = liffActionUrl({ kind: 'visit_stamp', liffId: line.liff_id });
        else actionData = liffActionUrl({ kind: button.actionData === 'history' ? 'booking_history' : 'booking', liffId: line.liff_id });
      } else continue; // 写真・書類・店舗 URL・クーポンは、実在する URI またはキーワードを必須にする。
      actionType = 'uri'; intent = 'url';
    } else continue;
    buttons.push({ ...button, actionType, actionData, intent });
  }
  return buttons;
}
