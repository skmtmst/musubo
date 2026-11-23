import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { type Context } from 'hono';
import type { Env } from '../../worker-env.js';

// ---- Bookings (requests) ----

/**
 * 台帳一覧とCSV書出しで共用する絞り込み条件の組み立て。
 * 画面の「よく使う」タブ・担当者・種別・期間・検索語が、そのまま WHERE 句に
 * なる。一覧とCSVで条件がずれると「画面と違うCSVが出た」になるので、
 * 条件はこの1か所だけで作る。
 */
export const BOOKING_REQUEST_SOURCES = new Set(['liff', 'phone', 'counter', 'operator', 'import']);

export const BOOKING_LEDGER_JOINS = `FROM bookings b
    INNER JOIN menus m ON m.id = b.menu_id
    INNER JOIN staff s ON s.id = b.staff_id
    LEFT JOIN friends f ON f.id = b.friend_id
    LEFT JOIN booking_customers bc ON bc.id = b.booking_customer_id`;

export function bookingLedgerFilter(c: Context<Env>, accountId: string, ignoreStatus = false): { where: string; values: unknown[] } {
  const status = c.req.query('status') || 'requested';
  const conditions = ['b.line_account_id = ?'];
  const values: unknown[] = [accountId];
  if (!ignoreStatus && status !== 'all') { conditions.push('b.status = ?'); values.push(status); }
  const customerQuery = c.req.query('query')?.trim();
  if (customerQuery) {
    conditions.push("LOWER(COALESCE(f.display_name, bc.display_name, '')) LIKE ? ESCAPE '\\'");
    values.push(`%${customerQuery.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
  }
  const menuName = c.req.query('menu_name')?.trim();
  if (menuName) { conditions.push('m.name = ?'); values.push(menuName); }
  // 担当者は id で絞る。画面の担当者選び口は staff 一覧から id を渡す。
  const staffId = c.req.query('staff_id')?.trim();
  if (staffId) { conditions.push('b.staff_id = ?'); values.push(staffId); }
  // 種別(予約経路)。CHECK 制約と同じ語彙だけ受け付け、それ以外は無視する
  // （変な値で0件になっても誤解を招くので、無効値は条件にしない）。
  const source = c.req.query('source')?.trim();
  if (source && BOOKING_REQUEST_SOURCES.has(source)) { conditions.push('b.source = ?'); values.push(source); }
  const from = c.req.query('from')?.trim();
  const to = c.req.query('to')?.trim();
  if (from) { conditions.push('b.starts_at >= ?'); values.push(from); }
  if (to) { conditions.push('b.starts_at < ?'); values.push(to); }
  return { where: `WHERE ${conditions.join(' AND ')}`, values };
}

// CSV の行上限。台帳は日々増えるので、上限を越える分は次の期間へ分けて
// 出してもらう。先頭の注記行にこの上限と絞り込み条件を書き、範囲が一目で
// 分かるようにする。
export const BOOKING_CSV_EXPORT_LIMIT = 5000;

export const BOOKING_CSV_STATUS_LABEL: Record<string, string> = {
  requested: 'リクエスト',
  confirmed: '確定',
  rejected: '拒否',
  expired: '期限切れ',
  cancelled: 'キャンセル',
  completed: '完了',
  no_show: '無断',
};

export const BOOKING_CSV_SOURCE_LABEL: Record<string, string> = {
  liff: 'LINE',
  phone: '電話',
  counter: '店頭',
  operator: 'スタッフ入力',
  import: '取り込み',
};

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  // CSVを開いた表計算ソフトで式として実行させない。先頭のタブ・空白も
  // 一部のソフトでは式と解釈されるため危険接頭辞に含める。
  if (/^[\s=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * 注記行へ埋め込む値の改行・制御文字を落とす。注記行はクォートなしの
 * 生テキストなので、クエリ値に %0D%0A=… を仕込まれるとそのまま別の
 * CSV行として混入し、式注入防御を迂回する。
 */
export function csvNoteValue(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, '');
}

export function csvTimestamp(iso: string | null): string {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  // 台帳をExcel等で開いたときに読みやすいよう JST 表記で出す。
  return japanCalendar(new Date(time)).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * 旧表 (booking_reminders) の未送信を止める。
 *
 * 再送でも同じ結果になるよう1文にまとめ、本線と再送枝の両方から呼ぶ。
 * 一時失敗の 'failed' も止める: 取消ずみの予約は送らないため、'pending' だけ
 * 止めると管理画面に未取消の予定が残り続ける (expirer も両方止めている)。
 * fence の成功後にだけ呼ぶ (409 では旧表も含めて巻き戻す)。
 */
export async function cancelLegacyBookingReminders(db: D1Database, bookingId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE booking_reminders SET status='cancelled'
        WHERE booking_id = ? AND status IN ('pending', 'failed')`,
    )
    .bind(bookingId)
    .run();
}

/**
 * 終端状態への遷移が確定したら、意味を失った確認通知の未成功行を
 * 止める。詳細画面の再送ボタンに反映され、古い確定案内の再送を防ぐ。
 * 送信中 (queued) の初回送信は触らない (送り始めているため)。
 */
export async function cancelObsoleteConfirmationRuns(
  db: D1Database,
  bookingId: string,
  lineAccountId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE booking_operation_runs SET status = 'cancelled', updated_at = ?
        WHERE booking_id = ? AND line_account_id = ? AND kind = 'confirmation_line'
          AND status IN ('retry_wait', 'permanent_failed')`,
    )
    .bind(new Date().toISOString(), bookingId, lineAccountId)
    .run();
}
