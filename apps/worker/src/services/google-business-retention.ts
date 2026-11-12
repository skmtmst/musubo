/**
 * 飲食店向け「Googleビジネス」：Googleから受け取った内容の保存期限の掃除。
 *
 * なぜ必要か。Google Business Profile APIのポリシー
 * （https://developers.google.com/my-business/content/policies、2026-08-28更新）は
 * 受信した内容を無期限に持つことを禁じ、一時保存する場合の条件を
 * 「no more than 30 calendar days」「stored securely」「cannot be manipulated or
 * aggregated」と定めている。つまり口コミ本文・プロフィール・指標などの
 * 受信コピーは、暦日で30日を超えて残してはいけない。
 *
 * 区別するもの。
 * - Googleから受け取った内容（口コミ本文、投稿者の表示名、プロフィールJSON、
 *   取り込んだGoogle投稿、日次指標、店舗候補）→ 期限が来たら行ごと削除する。
 * - 自分たちの操作記録（送信履歴 rt_google_write_log、変更案 rt_google_changes）
 *   → 行は残す。ただしGoogle由来のスナップショット列（before_text / before_json）だけ
 *     消す。「記録は削除できません」という画面の説明と、受信内容を持ち続けない義務を
 *     どちらも守るための線引きである。
 * - 認可の途中状態 rt_google_oauth_states → 使用済み・期限切れになった時点で削除する。
 *   暗号化したPKCEのverifierを持つ行なので30日待つ理由がない。
 *
 * しきい値を28日にする理由。6時間レーンで回るので最大6時間遅れる。さらに
 * rt_google_posts と rt_google_metrics_daily の時刻列はJST（`+9 hours`）で、
 * ほかはUTCなので最大9時間ずれる。30日ちょうどで切ると、この遅れとずれの分だけ
 * 30日を超える行が残りうる。28日で切れば 28日 + 6時間 + 9時間 < 30日 になり、
 * どの列の書き方でも上限を超えない。
 */
/** この掃除が必要とする結び付け先。テストで本物のSQLiteを当てられるよう最小にする。 */
export interface GoogleRetentionEnv {
  DB: D1Database;
}

/** 公開文書に書く上限。Googleのポリシー上の限度そのもの。 */
export const GOOGLE_CONTENT_RETENTION_LIMIT_DAYS = 30;

/** 実際に削除を始める経過日数。上限より短くとり、tickの遅れと時刻列のずれを吸収する。 */
export const GOOGLE_CONTENT_PURGE_AFTER_DAYS = 28;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GoogleRetentionResult {
  /** 削除した口コミの行数 */
  reviews: number;
  /** 削除したプロフィールの行数 */
  profiles: number;
  /** 削除したGoogle取り込み投稿の行数 */
  importedPosts: number;
  /** 削除した日次指標の行数 */
  metrics: number;
  /** 削除した店舗候補の行数 */
  locationCandidates: number;
  /** 削除した認可途中状態の行数 */
  oauthStates: number;
  /** before_text を消した送信履歴の行数 */
  redactedWriteLogs: number;
  /** before_json を消した変更案の行数 */
  redactedChanges: number;
  /** Googleが返した状態の写しを消した自作投稿の行数 */
  redactedPostState: number;
}

function cutoffIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

async function changedRows(db: D1Database, sql: string, ...binds: string[]): Promise<number> {
  const result = await db.prepare(sql).bind(...binds).run();
  return result.meta?.changes ?? 0;
}

/**
 * 期限切れのGoogle受信内容を削除する。6時間レーンから呼ぶ。
 *
 * 機能スイッチでは止めない。保存期限は機能のon/offと関係なく守る義務であり、
 * 機能をoffにした店舗の古いコピーが残り続けるほうが問題になる。
 * ログは件数だけ。口コミ本文・店舗名・トークンは出さない。
 */
export async function purgeExpiredGoogleContent(
  env: GoogleRetentionEnv,
  input: { now: string },
): Promise<GoogleRetentionResult> {
  const now = new Date(input.now);
  const cutoff = cutoffIso(now, GOOGLE_CONTENT_PURGE_AFTER_DAYS);
  const nowIso = now.toISOString();
  const db = env.DB;

  // Googleから受け取った内容そのもの。行ごと消す。
  const reviews = await changedRows(db, 'DELETE FROM rt_google_reviews WHERE updated_at < ?', cutoff);
  const profiles = await changedRows(db, 'DELETE FROM rt_google_profiles WHERE fetched_at < ?', cutoff);
  // origin='google' はGoogle側にあった投稿の取り込みコピー。'admin' は自分たちが作った
  // 投稿の記録なので消さない（送信済みかどうかの履歴として要る）。
  const importedPosts = await changedRows(
    db,
    "DELETE FROM rt_google_posts WHERE origin = 'google' AND updated_at < ?",
    cutoff,
  );
  const metrics = await changedRows(db, 'DELETE FROM rt_google_metrics_daily WHERE fetched_at < ?', cutoff);
  const locationCandidates = await changedRows(
    db,
    'DELETE FROM rt_google_location_candidates WHERE created_at < ?',
    cutoff,
  );

  // 認可の途中状態。使い終わった・期限が切れた時点で消す（30日は待たない）。
  const oauthStates = await changedRows(
    db,
    'DELETE FROM rt_google_oauth_states WHERE used_at IS NOT NULL OR expires_at < ?',
    nowIso,
  );

  // 自分たちの操作記録。行は残し、Google由来のスナップショット列だけ消す。
  const redactedWriteLogs = await changedRows(
    db,
    'UPDATE rt_google_write_log SET before_text = NULL WHERE before_text IS NOT NULL AND created_at < ?',
    cutoff,
  );
  const redactedChanges = await changedRows(
    db,
    'UPDATE rt_google_changes SET before_json = NULL WHERE before_json IS NOT NULL AND updated_at < ?',
    cutoff,
  );
  // 自分たちが作った投稿（origin='admin'）は記録として残すが、Googleが返した状態の写しは
  // 受信内容なので同じ期限で消す。google_post_name は自分たちの送信記録なので残す。
  const redactedPostState = await changedRows(
    db,
    `UPDATE rt_google_posts
        SET confirmation_revision = confirmation_revision + 1, google_state = NULL, search_url = NULL, google_create_time = NULL, google_update_time = NULL
      WHERE origin = 'admin' AND updated_at < ?
        AND (google_state IS NOT NULL OR search_url IS NOT NULL
             OR google_create_time IS NOT NULL OR google_update_time IS NOT NULL)`,
    cutoff,
  );

  return {
    reviews,
    profiles,
    importedPosts,
    metrics,
    locationCandidates,
    oauthStates,
    redactedWriteLogs,
    redactedChanges,
    redactedPostState,
  };
}

/** 掃除した合計件数。ログを出すかどうかの判定に使う。 */
export function totalRetentionActions(result: GoogleRetentionResult): number {
  return (
    result.reviews +
    result.profiles +
    result.importedPosts +
    result.metrics +
    result.locationCandidates +
    result.oauthStates +
    result.redactedWriteLogs +
    result.redactedChanges +
    result.redactedPostState
  );
}

/**
 * 連携解除・店舗切り替えのときに、その店舗のGoogle受信内容を消す。
 *
 * 公開中の個人情報の取扱い第6項が「接続を解除した場合は保存している連携情報を
 * 削除します」と約束しているので、解除時点で受信コピーを残さない。
 * 残すのは rt_google_write_log（自分たちの送信履歴。before_text は下で消す）と
 * rt_google_connections の行（status='disconnected' の記録）だけ。
 */
export function deleteGoogleContentStatements(db: D1Database, storeId: string): D1PreparedStatement[] {
  const statements = [
    'DELETE FROM rt_google_reviews WHERE store_id = ?',
    'DELETE FROM rt_google_profiles WHERE store_id = ?',
    'DELETE FROM rt_google_changes WHERE store_id = ?',
    "DELETE FROM rt_google_posts WHERE store_id = ? AND origin = 'google'",
    'DELETE FROM rt_google_metrics_daily WHERE store_id = ?',
    'DELETE FROM rt_google_location_candidates WHERE store_id = ?',
    'DELETE FROM rt_google_oauth_states WHERE store_id = ?',
    // 自分たちが作った投稿の記録は残すが、Googleが返した状態の写しは消す。
    // google_post_name は「どの投稿を送ったか」という自分たちの記録なので残す。
    `UPDATE rt_google_posts
        SET confirmation_revision = confirmation_revision + 1, google_state = NULL, search_url = NULL, google_create_time = NULL, google_update_time = NULL
      WHERE store_id = ? AND origin = 'admin'`,
    // 送信履歴の行は残す。Google由来の送信前スナップショットだけ消す。
    'UPDATE rt_google_write_log SET before_text = NULL WHERE store_id = ?',
  ];
  return statements.map((sql) => db.prepare(sql).bind(storeId));
}

export async function deleteGoogleContentForStore(db: D1Database, storeId: string): Promise<void> {
  for (const statement of deleteGoogleContentStatements(db, storeId)) await statement.run();
}
