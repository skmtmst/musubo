import { validateStampSettings } from './visit-stamps.js';

import type { VisitStampSettings } from '@line-crm/shared';

import {
  StyleError,
  features,
  featureLink,
  questionsForStyle,
} from './style-setup-core.js';
import { profile, profileAnswers } from './style-profile.js';
import { connectedGoogleProfile, googleOpeningWeek } from './restaurant-google-hours-source.js';
import { accountOpeningHours, openingWeek } from './account-opening-hours.js';
export async function featureReadiness(
  db: D1Database,
  account: string,
  feature: string,
  styleOverride?: import('@line-crm/shared').AccountStyle,
) {
  const p = await profile(db, account),
    answers = profileAnswers(p);
  if (!Object.hasOwn(features, feature))
    throw new StyleError('invalid_feature');
  let configured =
    answers[feature]?.mode === 'configured' &&
    answers[feature]?.value !== false;
  if (feature === 'booking') {
    const selectedStyle = styleOverride ?? p?.style;
    if (selectedStyle === 'restaurant') {
      const stores = (await db.prepare(`SELECT DISTINCT s.id,h.hours_json FROM rt_stores s
        JOIN rt_tables t ON t.store_id=s.id LEFT JOIN rt_opening_hours_settings h ON h.store_id=s.id
        WHERE s.line_account_id=? AND s.status='active' AND t.is_active=1`)
        .bind(account).all<{ id: string; hours_json: string | null }>()).results;
      configured = false;
      for (const store of stores) {
        const connection = await db.prepare('SELECT status FROM rt_google_connections WHERE store_id=?')
          .bind(store.id).first<{ status: string }>();
        const googleProfile = connection ? await connectedGoogleProfile(db, store.id) : null;
        const week: unknown = connection ? googleProfile && googleOpeningWeek(googleProfile)
          : store.hours_json ? JSON.parse(store.hours_json) : null;
        if (Array.isArray(week) && week.some(day => day && Array.isArray(day.periods) && day.periods.length > 0)) {
          configured = true;
          break;
        }
      }
    } else {
    const hoursSource = await accountOpeningHours(db, account);
    const googleWeek = openingWeek(hoursSource);
    const googleReady = hoursSource.source === 'manual' || !!googleWeek?.some(day => day.intervals.length > 0);
    const sql =
      selectedStyle === 'lesson'
          ? `SELECT 1 FROM events e JOIN event_slots s ON s.event_id=e.id WHERE e.line_account_id=? AND e.is_published=1 AND e.deleted_at IS NULL AND s.deleted_at IS NULL AND s.is_active=1 LIMIT 1`
          : `SELECT 1 FROM menus m JOIN booking_settings b ON b.line_account_id=m.line_account_id JOIN staff_menus sm ON sm.menu_id=m.id AND sm.is_offered=1 JOIN staff s ON s.id=sm.staff_id AND s.line_account_id=m.line_account_id WHERE m.line_account_id=? AND m.is_active=1 AND m.deleted_at IS NULL AND s.is_active=1 AND s.deleted_at IS NULL ${hoursSource.source === 'manual' ? 'AND b.business_hours_configured=1' : ''} LIMIT 1`;
    configured = googleReady && !!(await db.prepare(sql).bind(account).first());
    }
  }
  if(feature==='tickets')configured=!!await db.prepare("SELECT 1 FROM booking_pass_plans WHERE line_account_id=? AND status='on_sale' LIMIT 1").bind(account).first();
  if (feature === 'stamps') {
    const cards = (
      await db
        .prepare(
          `SELECT c.settings_json FROM visit_stamp_cards c JOIN visit_stamp_card_accounts ca ON ca.card_id=c.id WHERE ca.line_account_id=? AND c.active=1`,
        )
        .bind(account)
        .all<{ settings_json: string }>()
    ).results;
    configured = cards.some((card) => {
      try {
        validateStampSettings(
          JSON.parse(card.settings_json) as VisitStampSettings,
        );
        return true;
      } catch {
        return false;
      }
    });
  }

  return {
    feature,
    ready: configured,
    state: configured ? 'ready' : 'preparing',
    message: configured ? null : '現在準備中です',
    ...featureLink(feature),
  };
}
export async function styleWarnings(db: D1Database, account: string) {
  const p = await profile(db, account),
    answers = profileAnswers(p);
  const areas = (
    await db
      .prepare(
        `SELECT a.id,a.label,a.intent,a.action_data,a.template_id,a.form_id,g.id groupId FROM rich_menu_areas a JOIN rich_menu_pages p ON p.id=a.page_id JOIN rich_menu_groups g ON g.id=p.group_id WHERE g.account_id=?`,
      )
      .bind(account)
      .all<{
        id: string;
        label: string;
        intent: string;
        action_data: string;
        template_id: string | null;
        form_id: string | null;
        groupId: string;
      }>()
  ).results;
  const warnings = [];
  for (const area of areas) {
    const text = [area.label, area.intent, area.action_data].join(' ');
    const feature = /stamp|ポイント|スタンプ/.test(text)
      ? 'stamps'
      : /ticket|回数券/.test(text)
        ? 'tickets'
        : /coupon|クーポン/.test(text)
          ? 'coupons'
          : /booking|予約/.test(text)
            ? 'booking'
            : null;
    if (feature && !(await featureReadiness(db, account, feature)).ready)
      warnings.push({
        feature,
        areaId: area.id,
        groupId: area.groupId,
        ...featureLink(feature),
        customerState: 'preparing',
      });
  }
  return {
    count: warnings.length,
    items: warnings,
    pending: questionsForStyle(p?.style ?? 'standard')
      .filter((k) => !answers[k] || answers[k].mode === 'later')
      .map((key) => ({
        key,
        ...featureLink(key),
        mode: answers[key]?.mode ?? 'later',
      })),
    manual: questionsForStyle(p?.style ?? 'standard')
      .filter((k) => answers[k]?.mode === 'manual')
      .map((key) => ({ key, ...featureLink(key) })),
  };
}
