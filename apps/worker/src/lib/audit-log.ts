import { logger } from '@line-crm/shared/server';
import type { Context } from 'hono';
import { auditDeviceFamily, maskAuditIp, recordAuditEvent } from '@line-crm/db';
import type { Env } from '../worker-env.js';

/**
 * お金が動く操作の記録。
 *
 * マイルとアフィリエイトは残高や報酬に直結するため、
 * 「誰がいつ何を変更したか」を残す。
 *
 * 誰が・何を・いつは共通監査台帳へ残す。consoleは固定コードとroute型だけ。
 *
 * 値そのものは残さない。金額やマイル数は変更後の状態を見れば分かるし、
 * 個人情報をログへ流さないため。残すのは「誰が・いつ・何に対して・何をしたか」だけ。
 */

export type AuditAction =
  | 'restaurant.table.delete'
  | 'restaurant.menu.delete'
  | 'restaurant.reservation_form.repair'
  | 'form.submission.export'
  | 'ad_conversion.retry'
  | 'line_account_folder.create'
  | 'line_account_folder.update'
  | 'line_account_folder.delete'
  | 'line_account_folder.move'
  | 'line_account_tag.create'
  | 'line_account_tag.update'
  | 'line_account_tag.delete'
  | 'line_account_tag.replace'
  | 'line_account.deactivate'
  | 'line_account.activate'
  | 'line_account.pool_switch'
  | 'account_handover.rollback'
  | 'mileage.rule.export'
  | 'mileage.rule.create'
  | 'mileage.rule.update'
  | 'mileage.rule.delete'
  | 'mileage.rule.publish'
  | 'mileage.event.create'
  | 'mileage.adjustment.create'
  | 'mileage.adjustment.notification.retry'
  | 'mileage.adjustment.policy.update'
  | 'mileage.adjustment.approval.request'
  | 'mileage.adjustment.approval.approve'
  | 'mileage.adjustment.approval.reject'
  | 'mileage.adjustment.approval.cancel'
  | 'mileage.entry.confirm'
  | 'mileage.entry.void'
  | 'action_score.rules.draft.save'
  | 'action_score.rules.publish'
  | 'action_score.rules.stop'
  | 'action_score.adjustment.create'
  | 'mileage.reward.create'
  | 'mileage.reward.update'
  | 'mileage.reward.publish'
  | 'mileage.reward.status'
  | 'mileage.reward.codes.import'
  | 'mileage.redemption.create'
  | 'mileage.redemption.retry'
  | 'affiliate.create'
  | 'affiliate.update'
  | 'affiliate.delete'
  | 'affiliate.archive'
  | 'affiliate.settlement.close'
  | 'affiliate.bank.update'
  | 'affiliate.payout.create'
  | 'affiliate.payout.export'
  | 'affiliate.payout.download'
  | 'affiliate.statement.generate'
  | 'affiliate.statement.download'
  | 'affiliate.offer.create'
  | 'affiliate.offer.update'
  | 'affiliate.offer.version.create'
  | 'dashboard.preference.update'
  | 'dashboard.preference.reset'
  | 'dashboard.preference.default.update'
  | 'conversion.approval.update'
  | 'conversion.definition.create'
  | 'conversion.definition.stop'
  | 'conversion.definition.replace'
  | 'conversion.definition.revise'
  | 'conversion.definition.delete'
  | 'conversion.definition.publish'
  | 'conversion.definition.ingest_secret.issue'
  | 'conversion.definition.ingest.disable'
  | 'conversion.definition.ingest.enable'
  | 'conversion.definition.usage.create'
  | 'conversion.report.export'
  | 'ec.connector.update'
  | 'ec.action.retry'
  | 'line_notification.definition.create'
  | 'line_notification.definition.update'
  | 'line_notification.definition.publish'
  | 'line_notification.definition.stop'
  | 'line_notification.delivery.retry'
  | 'line_notification.delivery.resend'
  | 'line_notification.definition.test'
  | 'analytics.export'
  | 'nen.column.duplicate'
  | 'nen.column.import'
  | 'nen.campaign.save'
  | 'nen.campaign.enable'
  | 'nen.campaign.stop'
  | 'nen.birthday_coupon.save'
  | 'nen.column.create'
  | 'nen.column.save'
  | 'nen.pet.archive'
  | 'nen.column.schedule'
  | 'nen.delivery.pending_now'
  | 'operator_notification.rule.publish'
  | 'operator_notification.rule.stop'
  | 'operator_notification.rule.test'
  | 'operator_notification.delivery.export'
  | 'nen.delivery.retry'
  | 'photo.assessment.request'
  | 'photo.asset.request'
  | 'photo.review.bulk'
  | 'media.download'
  | 'media.replace_usages'
  | 'common_var_export.download'
  | 'photo.original.issue'
  | 'photo.original.download'
  | 'photo.reward.policy.create'
  | 'photo.reward.policy.revert'
  | 'webinar.archive'
  | 'webinar.publish'
  | 'webinar.pause'
  | 'webinar.duplicate'
  | 'webinar.participant.export'
  | 'webinar.video_stage'
  | 'webinar.session_capacity'
  | 'event.applicant.export'
  | 'event.change.apply'
  // 外部連携の操作履歴。作成・設定変更・動かす/止める・
  // 合言葉の入れ直し・削除・送り直し・公開APIトークンの発行系。
  | 'webhook.incoming.create'
  | 'webhook.incoming.update'
  | 'webhook.incoming.config.update'
  | 'webhook.incoming.activate'
  | 'webhook.incoming.deactivate'
  | 'webhook.incoming.secret.rotate'
  | 'webhook.incoming.delete'
  | 'webhook.incoming.restore'
  | 'webhook.incoming.unmatched.resolve'
  | 'webhook.incoming.test'
  | 'webhook.outgoing.create'
  | 'webhook.outgoing.update'
  | 'webhook.outgoing.activate'
  | 'webhook.outgoing.deactivate'
  | 'webhook.outgoing.secret.rotate'
  | 'webhook.outgoing.delete'
  | 'webhook.outgoing.restore'
  | 'webhook.outgoing.test'
  | 'webhook.interaction.retry'
  | 'webhook.interaction.retry_failed'
  | 'webhook.api_token.create'
  | 'webhook.api_token.revoke'
  | 'webhook.api_token.rotate'
  | 'webhook.api_token.reactivate'
  // #838 第2段: Google Sheets 連携の接続・切断・出力先変更・手動同期。
  | 'google.sheets.connect.start'
  | 'google.sheets.connect'
  | 'google.sheets.reconnect'
  | 'google.sheets.disconnect'
  | 'google.sheets.target.update'
  | 'google.sheets.sync'
  // TikTok利益計算シートの手動同期。
  | 'tiktok_pnl.manual_sync'
  | 'restaurant.google.store.bootstrap'
  | 'restaurant.google.connect.start'
  | 'restaurant.google.connect'
  | 'restaurant.google.reconnect'
  | 'restaurant.google.disconnect'
  | 'restaurant.google.review.reply'
  | 'restaurant.google.change.send'
  | 'restaurant.google.hours.save'
  | 'restaurant.google.post.publish'
  | 'restaurant.google.post.instagram_retry'
  | 'restaurant.google.post.remove'
  // デリバリー受注（Uber Eats・出前館・ロケットナウ）。店舗の操作は各サービスへ送るため必ず残す。
  | 'restaurant.delivery.order.accept'
  | 'restaurant.delivery.order.reject'
  | 'restaurant.delivery.order.ready'
  | 'restaurant.delivery.order.handed_over'
  | 'restaurant.delivery.order.cancel'
  | 'restaurant.delivery.menu.sold_out'
  | 'restaurant.delivery.menu.resume'
  | 'restaurant.delivery.intake.stop'
  | 'restaurant.delivery.intake.resume'
  | 'restaurant.media_email_import.stop'
  | 'restaurant.media_email_import.resume'
  | 'restaurant.media_email_import.held_expired'
  // 履歴CSVの書き出し（注文番号・金額が店舗の外へ出るため、他の出力と同じく残す）。
  | 'restaurant.delivery.history.export'
  // Uber Eats のログイン連携。店舗の代理で使えるトークンを得る操作なので必ず残す。
  | 'restaurant.delivery.ubereats.connect.start'
  | 'restaurant.delivery.ubereats.connect'
  // つなぐお店の確定。Uber 側で連携が有効になる取り消しにくい操作なので必ず残す。
  | 'restaurant.delivery.ubereats.store.select'
  | 'restaurant.delivery.ubereats.connection.check'
  | 'restaurant.delivery.ubereats.connection.disconnect'
  // #818: 広告費の手入力と、管理画面からの取り直し
  | 'ad_cost.manual_entry'
  | 'ad_cost.import'
  // R275: 手入力した費用の取り消し
  | 'ad_cost.cancel'
  // #819: 計測サイトの管理と成果の取り消し
  | 'measurement_site.create'
  | 'measurement_site.update'
  // R275: 計測サイトの停止と再開
  | 'measurement_site.stop'
  | 'measurement_site.resume'
  | 'conversion.event.reverse'
  | 'conversion.event.restore';

function commonAuditWriter(): typeof recordAuditEvent | null {
  try {
    return typeof recordAuditEvent === 'function' ? recordAuditEvent : null;
  } catch {
    // 一部のroute単体テストはDB packageを必要な関数だけに絞ってmockする。
    return null;
  }
}

/**
 * 統括の境界で止めた要求のうち、routeまで届かずとも正規の操作名で
 * 残すべきもの。route側の監査は上流で止まると動かないため、境界自身が
 * 同じ操作名・同じ結果で1件だけ残す。二重記録にしないよう、ここに載った
 * 操作の拒否は境界側が持ち、route側の同じ記録は直接掛けの場合の
 * 予備として残す。本番の順序では境界で止まるため二重にはならない。
 */
const CANONICAL_DENY_AUDITS: Array<{
  method: string;
  pattern: RegExp;
  action: AuditAction;
  kind: string;
}> = [
  { method: 'GET', pattern: /^\/api\/media\/([^/]+)\/download(?:\/|$)/, action: 'media.download', kind: 'media' },
  { method: 'GET', pattern: /^\/api\/media\/([^/]+)\/versions\/([^/]+)\/download(?:\/|$)/, action: 'media.download', kind: 'media' },
  { method: 'GET', pattern: /^\/api\/common-vars\/exports\/([^/]+)\/download(?:\/|$)/, action: 'common_var_export.download', kind: 'common_var_export' },
];

export function canonicalDenyAuditFor(
  method: string,
  path: string,
): { action: AuditAction; kind: string; id: string | null } | null {
  for (const entry of CANONICAL_DENY_AUDITS) {
    if (method.toUpperCase() !== entry.method) continue;
    const match = entry.pattern.exec(path);
    if (!match) continue;
    return { action: entry.action, kind: entry.kind, id: match[1] ?? null };
  }
  return null;
}

export function auditLog(
  c: Context<Env>,
  action: AuditAction,
  target?: { id?: string | null; kind?: string },
  opts?: { result?: 'success' | 'denied' | 'failed'; lineAccountId?: string | null; after?: Record<string, unknown> | null },
): void {
  const staff = c.get('staff');
  // 認証前に呼ばれることはない想定だが、ログのために例外を投げたくない。
  const actorRole = staff?.role ?? 'unknown';
  c.set('auditRecorded', true);
  logger.log("audit.recorded");

  const db = c.env?.DB;
  const writer = commonAuditWriter();
  if (!db || typeof db.prepare !== 'function' || !writer) return;
  const lineAccountId = opts?.lineAccountId
    ?? c.req.query('lineAccountId') ?? c.req.query('account_id') ?? null;
  const task = writer(db, {
    tenantId: staff?.tenantId,
    lineAccountId,
    category: 'business',
    actorPrincipalId: staff?.id,
    actorRole,
    action,
    targetKind: target?.kind ?? null,
    targetId: target?.id ?? null,
    result: opts?.result ?? 'success',
    after: opts?.after,
    requestTraceId: c.req.header('cf-ray') ?? c.req.header('x-request-id') ?? null,
    ipPrefix: maskAuditIp(c.req.header('cf-connecting-ip')),
    deviceFamily: auditDeviceFamily(c.req.header('user-agent')),
  }).catch((error: unknown) => {
    logger.error("audit_log.write_failed");
  });
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // 単体テスト等でExecutionContextが無い場合も、開始済みPromiseのcatchは維持する。
    void task;
  }
}
