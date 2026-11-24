/**
 * Google ビジネス接続を「1件」に決める正本。
 *
 * なぜ要るか。772 は同じ店舗に複数のGoogle接続を持てる形へ変えたが、互換索引
 * （`idx_rt_google_connections_store_compat_772` など）が残るあいだは2件目が入らないので、
 * `WHERE store_id=?` だけの `.first()` でも結果は1通りだった。773 でその索引を外すと
 * 同じ店舗に2件目が入るため、`store_id` だけの読み取りは**どの接続が返るか決まらない**。
 *
 * そこで並べ方をこのファイル1か所に置き、接続を読む場所すべてここを通す。
 * 画面に出す一覧（`connectionsFor`）と、接続IDを省略したときの操作対象（`connectionForEnv`）と、
 * 営業時間・写しの読み取りが、同じ1件を指すことを仕組みで保証する。
 *
 * 並べ方: 主連携 → `sort_order` → `connected_at`（昇順。`COALESCE` で空は先） → `id`。
 * 772 から使っている `connectionForEnv()` と同じ順序に揃えてある。
 * `sort_order` が同じなら、つないだ日時が記録されていない接続が先に来る。
 * 主連携は列を持たず `account_settings` に置く（`sns-connection-ports.ts` と同じ鍵）。
 */

/** 主連携の正本の鍵。列は持たず account_settings に置く。 */
export const GOOGLE_PRIMARY_KEY = 'sns.google.primary_connection';

/**
 * 接続を1件に決める ORDER BY の本体。`alias` は `rt_google_connections` の別名。
 * この断片は `?` を1つ使う（`GOOGLE_PRIMARY_KEY`）。`storeId` の `?` より後に並べる。
 */
export function googleConnectionOrderBySql(alias = 'c'): string {
  return `CASE WHEN ${alias}.id = (
          SELECT json_extract(a.value, '$.data.connectionId') FROM account_settings a
          JOIN rt_stores s ON s.id = ${alias}.store_id
          WHERE a.line_account_id = s.line_account_id AND a.key = ?
        ) THEN 0 ELSE 1 END,
      ${alias}.sort_order, COALESCE(${alias}.connected_at, ''), ${alias}.id`;
}

/**
 * 操作対象の接続1件を取る SELECT。`?` は storeId, GOOGLE_PRIMARY_KEY の順。
 * `columns` は `c.` 付きで書く（例: `c.*`、`c.id, c.status`）。
 */
export function googleConnectionPickSql(columns = 'c.*'): string {
  return `SELECT ${columns} FROM rt_google_connections c
     WHERE c.store_id = ?
     ORDER BY ${googleConnectionOrderBySql('c')}
     LIMIT 1`;
}

/** 画面に出す全件。並べ方は {@link googleConnectionPickSql} と同じなので先頭が操作対象と一致する。 */
export function googleConnectionListSql(columns = 'c.*'): string {
  return `SELECT ${columns} FROM rt_google_connections c
     WHERE c.store_id = ?
     ORDER BY ${googleConnectionOrderBySql('c')}`;
}

/** 接続の素の行。写し・営業時間の判定に要る列だけ。 */
export interface PrimaryConnection {
  id: string;
  status: string;
  location_name: string | null;
}

/**
 * この店舗で操作対象になる接続を1件返す。
 * `connectionId` を渡した場合はその接続だけを見る（別の店舗の接続IDでは null）。
 * 省略した場合は主連携を優先し、無ければ決まった順の先頭を返す。
 */
export async function primaryGoogleConnection(
  db: D1Database,
  storeId: string,
  connectionId?: string | null,
): Promise<PrimaryConnection | null> {
  if (connectionId) {
    return db
      .prepare('SELECT id, status, location_name FROM rt_google_connections WHERE id = ? AND store_id = ? LIMIT 1')
      .bind(connectionId, storeId)
      .first<PrimaryConnection>();
  }
  return db
    .prepare(googleConnectionPickSql('c.id, c.status, c.location_name'))
    .bind(storeId, GOOGLE_PRIMARY_KEY)
    .first<PrimaryConnection>();
}

/**
 * 接続1件に紐づく写しを読む条件。
 * 772 の移行で既存の写しは店舗の先頭の接続へ割り当てるが、接続行が消えた場合は
 * `connection_id` が NULL で残り得る。NULL の行は「どの接続の写しか分からない」ので
 * 最後に回し、接続に紐づいた写しがあればそちらを使う（`restaurant-google-profile.ts` と同じ形）。
 * `?` は storeId, connectionId の順。
 */
export const PROFILE_FOR_CONNECTION_SQL =
  `FROM rt_google_profiles WHERE store_id = ? AND (connection_id = ? OR connection_id IS NULL)
     ORDER BY CASE WHEN connection_id IS NULL THEN 1 ELSE 0 END LIMIT 1`;
