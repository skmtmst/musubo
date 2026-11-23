import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { toJstParts, type HolidayRule } from '@line-crm/shared';

import { hasAutoReplyHitForFriend } from '@line-crm/db';
import { holidaysOfYear } from '../../services/jp-holidays.js';
import { matchesCondition, parseCondition } from '../../services/segment-query.js';

/**
 * 祝日かどうか。
 *
 * 共有の祝日表（`packages/shared`・年ごとに手で足す形）は2026年までで、
 * 2027年の元日を誤判定する。ここでは祝日法の規則を計算で再現する
 * `jp-holidays.ts`（2000〜2099年・内閣府の公開表と照合済み）を使う。
 * 年を手で足す運用をやめ、範囲の外は祝日ではない日として扱ったうえで
 * 警告を出す（黙って誤判定しないための保険は残す）。
 */
const HOLIDAY_YEAR_MIN = 2000;
const HOLIDAY_YEAR_MAX = 2099;

function isHolidayOn(isoDate: string): boolean {
  const year = Number(isoDate.slice(0, 4));
  if (!Number.isInteger(year) || year < HOLIDAY_YEAR_MIN || year > HOLIDAY_YEAR_MAX) {
    logger.warn("services_auto_reply_conditions_warn");
    return false;
  }
  return holidaysOfYear(year).some((holiday) => holiday.date === isoDate);
}

/**
 * 自動応答を「返すかどうか」の判定。
 *
 * キーワードが一致しても返さない場合が3つある:
 *   1. 時間帯の外（営業時間外だけ返す、など）
 *   2. 直前に自動応答を返したばかり（連投の抑制）
 *   3. 担当者が対応中のトーク
 *
 * 時間帯の判定だけを純粋な関数として切り出しているのは、日をまたぐ設定
 * （22:00〜06:00）の扱いが一番間違えやすいところで、DBを用意せずに
 * 確かめられるようにしたいため。
 */

export interface AutoReplyConditionRow {
  id: string;
  active_from: string | null;
  active_until: string | null;
  cooldown_minutes: number | null;
  skip_when_operator_active: number;
  /** 応答する曜日（0=日 … 6=土）の JSON 配列。NULL なら曜日を問わない。 */
  response_weekdays_json?: string | null;
  /** 'ignore' | 'include' | 'exclude'。NULL なら 'ignore'。 */
  response_holiday_rule?: string | null;
  /** 1人につき1回だけ応答する。 */
  once_per_friend?: number;
  reply_delay_seconds?: number | null;
  /** 友だちの絞り込み（一斉配信・シナリオと同じ形）。NULL なら絞らない。 */
  friend_conditions_json?: string | null;
}

/** JSTの現在時刻を "HH:MM" で返す。 */
export function jstHhmm(now: Date): string {
  const jst = japanCalendar(now);
  const h = String(jst.getUTCHours()).padStart(2, '0');
  const m = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * 時間帯の中かどうか。
 *
 * 片方だけ設定されている場合は、設定された側だけを見る
 * （「18:00以降ずっと」「06:00までずっと」を書けるようにするため）。
 *
 * from > until のときは日をまたぐ指定として扱う。22:00〜06:00 を
 * 「22時から6時まで」と読むのは自然だが、単純な範囲比較だと
 * 常に偽になってしまう。営業時間外の自動応答はまさにこの形なので、
 * ここを取り違えると機能が丸ごと動かない。
 *
 * 境界は from を含み until を含まない。09:00〜18:00 と 18:00〜22:00 を
 * 並べたときに 18:00 が両方に入らないようにするため。
 */
export function isWithinActiveWindow(
  rule: Pick<AutoReplyConditionRow, 'active_from' | 'active_until'>,
  nowHhmm: string,
): boolean {
  const from = rule.active_from;
  const until = rule.active_until;
  if (!from && !until) return true;
  if (from && !until) return nowHhmm >= from;
  if (!from && until) return nowHhmm < until;
  // ここに来る時点で両方ある。
  if (from! < until!) return nowHhmm >= from! && nowHhmm < until!;
  if (from! > until!) return nowHhmm >= from! || nowHhmm < until!;
  // from === until。24時間を表すのか一瞬を表すのか読めないので、
  // 問い合わせへの応答が止まらないよう、「時間帯を指定していない」と同じ扱いにする。
  return true;
}

/**
 * 応答する曜日か。祝日の扱いもここで見る。
 *
 * 判定は日本時間の暦日で行う。Workers は UTC で動くので、ローカルの
 * getDay を使うと深夜0時前後で曜日が1日ずれる。
 *
 * 日をまたぐ時間帯（22:00〜02:00）のときは、**始まった側の曜日**で見る。
 * 「金曜 22:00〜02:00」なら土曜の 01:00 も応答する。店主の頭の中では
 * 「金曜の夜」なので、そちらに合わせる。
 */
export function isOnRespondingDay(
  rule: Pick<
    AutoReplyConditionRow,
    'response_weekdays_json' | 'response_holiday_rule' | 'active_from' | 'active_until'
  >,
  now: Date,
): boolean {
  const weekdays = parseWeekdays(rule.response_weekdays_json);
  const holidayRule = (rule.response_holiday_rule ?? 'ignore') as HolidayRule;
  if (weekdays.length === 0 && holidayRule === 'ignore') return true;

  // 日をまたぐ帯で、いまが「翌日側」にいるなら、前日の曜日で見る。
  const from = rule.active_from;
  const until = rule.active_until;
  const crossesMidnight = Boolean(from && until && from > until);
  const nowHhmm = jstHhmm(now);
  const inCarryOver = crossesMidnight && until != null && nowHhmm < until;
  const target = inCarryOver ? new Date(now.getTime() - 24 * 60 * 60 * 1000) : now;

  const { date, weekday } = toJstParts(target);
  const weekdayOk = weekdays.length === 0 || weekdays.includes(weekday);
  if (holidayRule === 'ignore') return weekdayOk;
  const holiday = isHolidayOn(date);
  if (holidayRule === 'include') return weekdayOk || holiday;
  return weekdayOk && !holiday;
}

function parseWeekdays(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => Number.isInteger(v) && v >= 0 && v <= 6);
  } catch {
    // 読めない設定で応答が止まると、問い合わせに何も返らなくなる。
    // 「曜日を問わない」に倒す。
    return [];
  }
}

/**
 * この人に、このルールで一度でも応答したか（「1人につき1回だけ」の判定）。
 *
 * cooldown_minutes（N分空ける）とは別のもの。あちらは間隔、こちらは一生に1回。
 */
export async function hasAlreadyRepliedOnce(
  db: D1Database,
  rule: Pick<AutoReplyConditionRow, 'id' | 'once_per_friend' | 'reply_delay_seconds'>,
  friendId: string,
): Promise<boolean> {
  if (rule.once_per_friend !== 1) return false;
  if (await hasAutoReplyHitForFriend(db, rule.id, friendId)) return true;
  const completed=await db.prepare(`SELECT 1 FROM auto_reply_evaluations
    WHERE winning_auto_reply_id=? AND friend_id=? AND status='completed' AND reply_status='accepted' LIMIT 1`)
    .bind(rule.id,friendId).first();
  if(completed) return true;
  // 旧版の待機・不明行も守る。今の設定から遅延を外しても忘れない。
  const row = await db.prepare(`SELECT 1 FROM auto_reply_deliveries d JOIN auto_reply_versions v ON v.id=d.version_id
    WHERE d.friend_id=? AND v.auto_reply_id=? AND (d.status IN ('pending','claimed') OR (d.status='accepted' AND COALESCE(json_extract(d.action_summary,'$.failed'),0)=0) OR d.error_code='delayed_delivery_unknown') LIMIT 1`).bind(friendId,rule.id).first();
  return row != null;
}

/**
 * 連投抑制にかかっているか。
 *
 * 「このルールで前回返してから N 分」ではなく「この人へ自動応答を
 * 返してから N 分」で見る。ルールごとの送信記録を持っていないという
 * 事情もあるが、そもそも抑制の目的が「相手を機械の返信で埋めない」
 * ことなので、人単位で数えるのが目的に合う。
 */
export async function isCoolingDown(
  db: D1Database,
  friendId: string,
  cooldownMinutes: number | null,
  now: Date,
): Promise<boolean> {
  if (!cooldownMinutes || cooldownMinutes <= 0) return false;
  // messages_log.created_at は JST の文字列。比較する境界も同じ形にする。
  const since = japanCalendar(new Date(now.getTime() - cooldownMinutes * 60 * 1000))
    .toISOString()
    .replace('Z', '');
  // idx_messages_log_friend_source があるので friend_id + source は索引で引ける。
  const row = await db
    .prepare(
      `SELECT 1 FROM messages_log
        WHERE friend_id = ? AND source = 'auto_reply' AND created_at > ?
        LIMIT 1`,
    )
    .bind(friendId, since)
    .first<{ 1: number }>();
  return row != null;
}

/**
 * 担当者が対応中か。
 *
 * 「未読」は対応中ではない。誰も見ていないのに自動応答まで止まると、
 * 問い合わせが放置されたまま何も返らなくなる。
 */
export async function isOperatorHandling(
  db: D1Database,
  friendId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT status FROM chats WHERE friend_id = ? LIMIT 1`)
    .bind(friendId)
    .first<{ status: string }>();
  return row?.status === 'in_progress';
}

/**
 * 応答する相手か（友だちの絞り込み）。
 *
 * 一斉配信・シナリオと同じ条件の形をそのまま使う。自動応答専用の条件は作らない。
 *
 * 読めない条件は「絞らない」ではなく**応答しない**に倒す。絞ったつもりの
 * ルールが全員に返るほうが、返らないより取り返しがつかない。
 * （時間帯や曜日を「読めないなら通す」にしているのと逆なのは、こちらが
 *   「誰に返すか」を決めるものだから。）
 */
export async function matchesFriendConditions(
  db: D1Database,
  rule: Pick<AutoReplyConditionRow, 'friend_conditions_json'>,
  friendId: string,
): Promise<boolean> {
  const raw = rule.friend_conditions_json;
  if (!raw) return true;
  const condition = parseCondition(raw);
  if (!condition) {
    logger.error("auto_reply_unreadable_friend_conditions_json_skipped_the_rule");
    return false;
  }
  return matchesCondition(db, friendId, condition);
}

/**
 * 条件をまとめて見る。返す場合だけ true。
 *
 * 順番は「安い順」。時間帯と曜日は問い合わせが要らないので先に見る。
 * そのあとが1クエリずつのもの。設定されていなければ引かない。
 */
export async function shouldReply(
  db: D1Database,
  rule: AutoReplyConditionRow,
  friendId: string,
  now: Date,
): Promise<boolean> {
  return (await evaluateAutoReplyConditions(db, rule, friendId, now)).matches;
}

export type AutoReplyConditionReasonCode =
  | 'outside_active_window'
  | 'weekday_not_allowed'
  | 'operator_handling'
  | 'already_replied_once'
  | 'cooldown_active'
  | 'friend_conditions_not_met';

/**
 * shouldReply と同じ判定を、履歴・テスト画面で説明できる形にする。
 * 安い条件から順に見て、最初に止めた理由だけを返すため本番の評価順も変わらない。
 */
export async function evaluateAutoReplyConditions(
  db: D1Database,
  rule: AutoReplyConditionRow,
  friendId: string,
  now: Date,
): Promise<{ matches: boolean; reasonCodes: AutoReplyConditionReasonCode[] }> {
  if (!isWithinActiveWindow(rule, jstHhmm(now))) {
    return { matches: false, reasonCodes: ['outside_active_window'] };
  }
  if (!isOnRespondingDay(rule, now)) {
    return { matches: false, reasonCodes: ['weekday_not_allowed'] };
  }
  if (rule.skip_when_operator_active === 1 && (await isOperatorHandling(db, friendId))) {
    return { matches: false, reasonCodes: ['operator_handling'] };
  }
  if (await hasAlreadyRepliedOnce(db, rule, friendId)) {
    return { matches: false, reasonCodes: ['already_replied_once'] };
  }
  if (await isCoolingDown(db, friendId, rule.cooldown_minutes, now)) {
    return { matches: false, reasonCodes: ['cooldown_active'] };
  }
  if (!(await matchesFriendConditions(db, rule, friendId))) {
    return { matches: false, reasonCodes: ['friend_conditions_not_met'] };
  }
  return { matches: true, reasonCodes: [] };
}
