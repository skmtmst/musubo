import { hasConversionApprovalRevision } from './conversion-approval-revision.js';
import { sqlIdSet } from './id-queries.js';
import { jstNow, jstDateString } from './utils.js';

/**
 * Web計測の公開口。
 *
 * サイトごとの公開IDと許可ドメインを持ち、タグはサイトIDだけを載せる
 * (秘密の鍵はタグに含めない)。許可にないドメインからの送信は成果に
 * 数えず、件数と最後の来た先だけを管理画面へ出す。
 *
 * 成果の取り消しは conversion_event_reversals への追記で表す。
 * 元の成果行は消さず、取り消しの取り消しも同じ形で記録する。
 */

export interface MeasurementSite {
  id: string;
  line_account_id: string;
  label: string;
  created_at: string;
  updated_at: string | null;
  /** 停止した日時。NULL なら計測を受け付ける。 */
  stopped_at: string | null;
  /** 停止の理由(画面で入力)。履歴として残す。 */
  stopped_reason: string | null;
  last_received_at: string | null;
}

export interface MeasurementSiteWithDomains extends MeasurementSite {
  domains: string[];
  rejectedTotal: number;
  lastRejectedHost: string | null;
  lastRejectedAt: string | null;
}

const HOST_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** ドメイン名の検査。小文字・末尾ドットなし・ポートなしに揃える。 */
export function normalizeSiteHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase();
  if (host === '') return null;
  // URLとして書かれた場合も受け付けて正規化する。
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/\.$/, '').split(':')[0];
  if (!HOST_PATTERN.test(host)) return null;
  const bare = host.replace(/^www\./, '');
  return HOST_PATTERN.test(bare) ? bare : host;
}

export async function listMeasurementSites(
  db: D1Database,
  lineAccountId: string,
): Promise<MeasurementSiteWithDomains[]> {
  const sites = await db
    .prepare(`SELECT * FROM measurement_sites WHERE line_account_id = ? ORDER BY created_at, id`)
    .bind(lineAccountId)
    .all<MeasurementSite>();
  const result: MeasurementSiteWithDomains[] = [];
  for (const site of sites.results) {
    const [domains, rejection] = await Promise.all([
      db
        .prepare(`SELECT host FROM measurement_site_domains WHERE site_id = ? ORDER BY host`)
        .bind(site.id)
        .all<{ host: string }>(),
      db
        .prepare(
          `SELECT SUM(rejected_count) AS total,
                  (SELECT host FROM measurement_domain_rejections r2
                    WHERE r2.site_id = ?
                    ORDER BY last_seen_at DESC, rowid DESC LIMIT 1) AS last_host,
                  MAX(last_seen_at) AS last_seen_at
             FROM measurement_domain_rejections WHERE site_id = ?`,
        )
        .bind(site.id, site.id)
        .first<{ total: number | null; last_host: string | null; last_seen_at: string | null }>(),
    ]);
    result.push({
      ...site,
      domains: domains.results.map((d) => d.host),
      rejectedTotal: Number(rejection?.total ?? 0),
      lastRejectedHost: rejection?.last_host ?? null,
      lastRejectedAt: rejection?.last_seen_at ?? null,
    });
  }
  return result;
}

export async function createMeasurementSite(
  db: D1Database,
  input: { lineAccountId: string; label: string; domains: string[] },
): Promise<MeasurementSiteWithDomains> {
  const id = `site_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO measurement_sites (id, line_account_id, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, input.lineAccountId, input.label.trim(), now, now)
    .run();
  for (const host of input.domains) {
    await db
      .prepare(`INSERT INTO measurement_site_domains (site_id, host, created_at) VALUES (?, ?, ?)`)
      .bind(id, host, now)
      .run();
  }
  const sites = await listMeasurementSites(db, input.lineAccountId);
  return sites.find((s) => s.id === id)!;
}

export async function getMeasurementSite(
  db: D1Database,
  siteId: string,
): Promise<MeasurementSite | null> {
  return db
    .prepare(`SELECT * FROM measurement_sites WHERE id = ?`)
    .bind(siteId)
    .first<MeasurementSite>();
}

export async function updateMeasurementSiteDomains(
  db: D1Database,
  siteId: string,
  domains: string[],
  label?: string,
): Promise<void> {
  const now = jstNow();
  if (label !== undefined) {
    await db
      .prepare(`UPDATE measurement_sites SET label = ?, updated_at = ? WHERE id = ?`)
      .bind(label.trim(), now, siteId)
      .run();
  }
  if (domains.length > 0 || label === undefined) {
    await db.prepare(`DELETE FROM measurement_site_domains WHERE site_id = ?`).bind(siteId).run();
    for (const host of domains) {
      await db
        .prepare(`INSERT INTO measurement_site_domains (site_id, host, created_at) VALUES (?, ?, ?)`)
        .bind(siteId, host, now)
        .run();
    }
  }
  await db
    .prepare(`UPDATE measurement_sites SET updated_at = ? WHERE id = ?`)
    .bind(now, siteId)
    .run();
}

/**
 * 計測を止める。行は消さず、サイトと許可ドメイン・これまでの
 * 記録は残る。止めると公開口は成果を受け付けなくなる。
 * すでに止まっているサイトへの重ねがけは 'already_stopped' を返す。
 */
export async function stopMeasurementSite(
  db: D1Database,
  siteId: string,
  reason: string,
): Promise<'stopped' | 'already_stopped'> {
  const now = jstNow();
  const result = await db
    .prepare(
      `UPDATE measurement_sites
          SET stopped_at = ?, stopped_reason = ?, updated_at = ?
        WHERE id = ? AND stopped_at IS NULL`,
    )
    .bind(now, reason.trim(), now, siteId)
    .run();
  return result.meta.changes > 0 ? 'stopped' : 'already_stopped';
}

/** 止めた計測をもう一度受け付ける。止まっていなければ 'not_stopped'。 */
export async function resumeMeasurementSite(
  db: D1Database,
  siteId: string,
): Promise<'resumed' | 'not_stopped'> {
  const result = await db
    .prepare(
      `UPDATE measurement_sites
          SET stopped_at = NULL, stopped_reason = NULL, updated_at = ?
        WHERE id = ? AND stopped_at IS NOT NULL`,
    )
    .bind(jstNow(), siteId)
    .run();
  return result.meta.changes > 0 ? 'resumed' : 'not_stopped';
}

/** 許可ドメインか。www あり/なしは同一サイトとみなす。 */
export async function siteAllowsHost(
  db: D1Database,
  siteId: string,
  host: string,
): Promise<boolean> {
  const bare = normalizeSiteHost(host);
  if (!bare) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM measurement_site_domains
        WHERE site_id = ? AND (host = ? OR host = ?)`,
    )
    .bind(siteId, bare, `www.${bare}`)
    .first<{ ok: number }>();
  return row !== null;
}

/** 許可外ドメインからの送信。件数と最後の来た先だけを残す。 */
export async function recordDomainRejection(
  db: D1Database,
  siteId: string,
  host: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO measurement_domain_rejections (site_id, host, rejected_count, last_seen_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(site_id, host) DO UPDATE SET
         rejected_count = rejected_count + 1,
         last_seen_at = excluded.last_seen_at`,
    )
    .bind(siteId, host, now)
    .run();
}

/** 匿名の成果を1日ごとの合計へ足す(地点が匿名を数える設定のときだけ呼ぶ)。 */
export async function recordAnonymousConversionDay(
  db: D1Database,
  conversionPointId: string,
): Promise<void> {
  const day = jstDateString();
  await db
    .prepare(
      `INSERT INTO conversion_anonymous_days (conversion_point_id, day, anonymous_count, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(conversion_point_id, day) DO UPDATE SET
         anonymous_count = anonymous_count + 1,
         updated_at = excluded.updated_at`,
    )
    .bind(conversionPointId, day, jstNow())
    .run();
}

export interface ConversionReversal {
  id: string;
  conversion_event_id: string;
  kind: 'reverse' | 'restore';
  reason: string;
  actor_id: string | null;
  actor_name: string | null;
  created_at: string;
}

/** 成果1件の取消履歴。新しい順。 */
export async function listConversionReversals(
  db: D1Database,
  conversionEventId: string,
): Promise<ConversionReversal[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM conversion_event_reversals
        WHERE conversion_event_id = ? ORDER BY created_at DESC, rowid DESC`,
    )
    .bind(conversionEventId)
    .all<ConversionReversal>();
  return rows.results;
}

/** いま取り消されているか(最新の行が reverse なら真)。 */
export async function isConversionEventReversed(
  db: D1Database,
  conversionEventId: string,
): Promise<boolean> {
  const latest = await db
    .prepare(
      `SELECT kind FROM conversion_event_reversals
        WHERE conversion_event_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(conversionEventId)
    .first<{ kind: string }>();
  return latest?.kind === 'reverse';
}

/** 複数行の取消状態を1回で取る(一覧表示用)。 */
export async function getReversedEventIds(
  db: D1Database,
  eventIds: string[],
): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  const placeholders = sqlIdSet(eventIds).sql;
  const rows = await db
    .prepare(
      `SELECT conversion_event_id, kind FROM conversion_event_reversals r
        WHERE conversion_event_id IN (${placeholders})
          AND NOT EXISTS (
            SELECT 1 FROM conversion_event_reversals newer
             WHERE newer.conversion_event_id = r.conversion_event_id
               AND (newer.created_at > r.created_at
                 OR (newer.created_at = r.created_at AND newer.rowid > r.rowid))
          )`,
    )
    .bind(...(eventIds.length ? sqlIdSet(eventIds).binds : []))
    .all<{ conversion_event_id: string; kind: string }>();
  return new Set(
    rows.results.filter((r) => r.kind === 'reverse').map((r) => r.conversion_event_id),
  );
}

/**
 * 取消/取消の取消を追記する。元の成果行は消さない。
 * kind=reverse の連投や、取り消されていない成果への restore は受け付けない
 * (台帳が「往復の履歴」として読めるようにするため)。
 */
export async function appendConversionReversal(
  db: D1Database,
  input: {
    conversionEventId: string;
    kind: 'reverse' | 'restore';
    reason: string;
    actorId?: string | null;
    actorName?: string | null;
    expectedReversalId?: string | null;
    expectedApprovalStatus?: 'pending' | 'approved' | 'rejected' | null;
    expectedApprovalRevision?: number;
    expectedCancelled?: boolean;
  },
): Promise<ConversionReversal> {
  const currentlyReversed = await isConversionEventReversed(db, input.conversionEventId);
  if (input.kind === 'reverse' && currentlyReversed) {
    throw new Error('conversion_event_already_reversed');
  }
  if (input.kind === 'restore' && !currentlyReversed) {
    throw new Error('conversion_event_not_reversed');
  }
  const id = crypto.randomUUID();
  const now = jstNow();
  const conditional = input.expectedReversalId !== undefined;
  const hasRevision = conditional && await hasConversionApprovalRevision(db);
  const checkRevision = hasRevision && input.expectedApprovalRevision !== undefined;
  const tables = conditional ? await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('affiliate_adjustments','affiliate_reward_entries')").all<{ name: string }>() : null;
  const names = new Set(tables?.results.map((row) => row.name) ?? []);
  const affiliateCancelled = names.has('affiliate_adjustments') && names.has('affiliate_reward_entries')
    ? `EXISTS (SELECT 1 FROM affiliate_reward_entries re JOIN affiliate_adjustments aa ON aa.source_entry_id = re.id WHERE re.conversion_event_id = ce.id AND aa.reason_type = 'cancel')`
    : '0';
  const result = await db
    .prepare(
      `INSERT INTO conversion_event_reversals
         (id, conversion_event_id, kind, reason, actor_id, actor_name, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       ${conditional ? `WHERE (SELECT r.id FROM conversion_event_reversals r
         WHERE r.conversion_event_id = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) IS ?
       AND EXISTS (SELECT 1 FROM conversion_events ce WHERE ce.id = ? AND ce.approval_status IS ?
         ${!checkRevision ? '' : 'AND ce.approval_revision = ?'}
         AND (COALESCE((SELECT r.kind FROM conversion_event_reversals r WHERE r.conversion_event_id = ce.id ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) = 'reverse', 0) OR ${affiliateCancelled}) = ?)` : ''}`,
    )
    .bind(
      id, input.conversionEventId, input.kind, input.reason.trim(),
      input.actorId ?? null, input.actorName ?? null, now,
      ...(conditional ? [input.conversionEventId, input.expectedReversalId, input.conversionEventId, input.expectedApprovalStatus, ...(checkRevision ? [input.expectedApprovalRevision] : []), input.expectedCancelled ? 1 : 0] : []),
    )
    .run();
  if (conditional && result.meta.changes === 0) throw new Error('conversion_event_stale');
  return (await db
    .prepare(`SELECT * FROM conversion_event_reversals WHERE id = ?`)
    .bind(id)
    .first<ConversionReversal>())!;
}

/**
 * 地点ごとの取消件数と金額(取り消されている成果だけを数える)。
 * 匿名成果は行が無いため含まない。
 */
export async function getReversalMetricsByPoint(
  db: D1Database,
  pointIds: string[],
): Promise<Map<string, { count: number; value: number }>> {
  if (pointIds.length === 0) return new Map();
  const placeholders = sqlIdSet(pointIds).sql;
  const rows = await db
    .prepare(
      `SELECT ce.conversion_point_id, COUNT(*) AS cnt,
              COALESCE(SUM(ce.value_snapshot), 0) AS val
         FROM conversion_events ce
        WHERE ce.conversion_point_id IN (${placeholders})
          AND EXISTS (
            SELECT 1 FROM conversion_event_reversals r
             WHERE r.conversion_event_id = ce.id AND r.kind = 'reverse'
               AND NOT EXISTS (
                 SELECT 1 FROM conversion_event_reversals newer
                  WHERE newer.conversion_event_id = r.conversion_event_id
                    AND (newer.created_at > r.created_at
                      OR (newer.created_at = r.created_at AND newer.rowid > r.rowid))
               )
          )
        GROUP BY ce.conversion_point_id`,
    )
    .bind(...(pointIds.length ? sqlIdSet(pointIds).binds : []))
    .all<{ conversion_point_id: string; cnt: number; val: number }>();
  return new Map(
    rows.results.map((r) => [r.conversion_point_id, { count: Number(r.cnt), value: Number(r.val) }]),
  );
}

/** 許可ドメイン・同意済みの受信。URLや訪問者情報は保存しない。 */
export async function recordMeasurementSiteReceipt(db: D1Database, siteId: string, lineAccountId: string, at = jstNow()): Promise<void> {
  await db.prepare(`UPDATE measurement_sites SET last_received_at = ?
    WHERE id = ? AND line_account_id = ? AND stopped_at IS NULL
      AND (last_received_at IS NULL OR julianday(last_received_at) < julianday(?))`)
    .bind(at, siteId, lineAccountId, at).run();
}
