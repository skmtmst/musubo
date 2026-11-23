import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(import.meta.dirname, '..', 'migrations', '772_sns_multi_connections.sql'),
  'utf8',
);
// 772 は「足すだけ」。旧Workerの ON CONFLICT が当たる互換索引（末尾 `_compat_772`）を
// 残してあるので、2件目の接続が入るようになるのは 773 を当てた後。
// 773 は新しいWorkerを配り終えてから当てるぶんで、同じ `migrations/` に置いてある
// （置き場を移した条件は `migrations-pending/README.md`）。
// ここでは 773 も読んで、当てた後の形も合わせて確かめる。
const dropCompat = readFileSync(
  join(import.meta.dirname, '..', 'migrations', '773_sns_multi_connections_drop_compat.sql'),
  'utf8',
);

// 772 を当てる直前の形（446/447/511/512/603/611/754/757/769 まで適用済み）
function before(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE line_accounts(id TEXT PRIMARY KEY, tenant_id TEXT);
    INSERT INTO line_accounts VALUES('a1','t1'),('a2','t1'),('a3','t2');
    CREATE TABLE rt_stores(id TEXT PRIMARY KEY);
    INSERT INTO rt_stores VALUES('s1'),('s2');
    CREATE TABLE account_settings(
      id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      confirmation_revision INTEGER NOT NULL DEFAULT 1, UNIQUE(line_account_id, key));
    INSERT INTO account_settings(id,line_account_id,key,value)
      VALUES('as1','a1','sns.google.primary_connection','{"version":3,"data":{"connectionId":"gc1"}}');

    CREATE TABLE rt_google_connections (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL UNIQUE REFERENCES rt_stores(id) ON DELETE CASCADE,
      line_account_id TEXT REFERENCES line_accounts(id),
      google_account_email TEXT, location_name TEXT, location_title TEXT, location_maps_url TEXT,
      refresh_token_enc TEXT, access_token_enc TEXT, access_token_expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'disconnected'
        CHECK (status IN ('pending_location','connected','expired','no_permission','disconnected')),
      connected_by_staff_id TEXT, connected_at TEXT, disconnected_at TEXT,
      last_synced_at TEXT, last_sync_error TEXT, average_rating REAL, total_review_count INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_posts_synced_at TEXT, last_metrics_synced_at TEXT,
      confirmation_revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE rt_google_profiles (
      store_id TEXT PRIMARY KEY REFERENCES rt_stores(id) ON DELETE CASCADE,
      location_name TEXT NOT NULL, profile_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
      fetched_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE rt_google_metrics_daily (
      store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE, date TEXT NOT NULL,
      impressions_desktop_maps INTEGER, impressions_desktop_search INTEGER,
      impressions_mobile_maps INTEGER, impressions_mobile_search INTEGER,
      direction_requests INTEGER, call_clicks INTEGER, website_clicks INTEGER,
      menu_clicks INTEGER, bookings INTEGER, food_orders INTEGER,
      fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
      PRIMARY KEY (store_id, date));
    CREATE INDEX idx_rt_google_metrics_daily_store_date ON rt_google_metrics_daily(store_id, date DESC);
    CREATE TABLE rt_google_reviews (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
      review_name TEXT NOT NULL, star_rating INTEGER NOT NULL, comment TEXT,
      create_time TEXT NOT NULL,
      reply_status TEXT NOT NULL DEFAULT 'unreplied', reply_comment TEXT,
      UNIQUE(store_id, review_name));
    CREATE TABLE rt_google_posts (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
      google_post_name TEXT, content_fingerprint TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE UNIQUE INDEX idx_rt_google_posts_google_name
      ON rt_google_posts(store_id, google_post_name) WHERE google_post_name IS NOT NULL;
    CREATE INDEX idx_rt_google_posts_fingerprint
      ON rt_google_posts(store_id, content_fingerprint) WHERE content_fingerprint IS NOT NULL;
    CREATE TABLE rt_google_changes (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE rt_google_write_log (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, result TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE rt_google_oauth_states (
      state TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
      staff_id TEXT NOT NULL, mode TEXT NOT NULL, code_verifier_enc TEXT NOT NULL,
      expires_at TEXT NOT NULL);
    -- 446_restaurant_google_business.sql:45-53 と同じ列をそろえる。
    -- address_text と created_at を省くと 772 の移送SELECT（d.address_text / d.created_at）が
    -- 「no such column」で落ち、移行の中身ではなく土台の写し間違いで試験が赤くなる。
    CREATE TABLE rt_google_location_candidates (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES rt_stores(id) ON DELETE CASCADE,
      location_name TEXT NOT NULL, location_title TEXT NOT NULL,
      address_text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(store_id, location_name));

    CREATE TABLE instagram_connections (
      line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id), page_id TEXT NOT NULL,
      instagram_id TEXT NOT NULL, page_name TEXT NOT NULL, username TEXT,
      page_token_encrypted TEXT NOT NULL, user_token_encrypted TEXT NOT NULL,
      expires_at TEXT NOT NULL, data_access_expires_at TEXT, profile_json TEXT, posts_json TEXT,
      refreshed_at TEXT NOT NULL, synced_at TEXT, connected_by TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, scopes TEXT NOT NULL DEFAULT '');
    CREATE INDEX idx_instagram_connections_instagram_id ON instagram_connections(instagram_id);
    CREATE TABLE instagram_messages (
      id TEXT NOT NULL, line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
      instagram_id TEXT NOT NULL, sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
      content TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attachments_json)),
      received_at TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(line_account_id, id));
    CREATE INDEX idx_instagram_messages_account_time_754 ON instagram_messages(line_account_id,received_at,id);
    CREATE TABLE instagram_oauth_states (
      state_hash TEXT PRIMARY KEY, line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
      staff_id TEXT NOT NULL, phase TEXT NOT NULL, candidates_encrypted TEXT,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TRIGGER instagram_connection_tenant_insert BEFORE INSERT ON instagram_connections WHEN EXISTS(SELECT 1 FROM instagram_connections existing JOIN line_accounts old_account ON old_account.id=existing.line_account_id JOIN line_accounts new_account ON new_account.id=NEW.line_account_id WHERE existing.instagram_id=NEW.instagram_id AND existing.line_account_id<>NEW.line_account_id AND COALESCE(old_account.tenant_id,'00000000-0000-4000-8000-000000000001')<>COALESCE(new_account.tenant_id,'00000000-0000-4000-8000-000000000001')) BEGIN SELECT RAISE(ABORT,'instagram_cross_tenant'); END;

    INSERT INTO rt_google_connections(id,store_id,line_account_id,google_account_email,location_name,location_title,
      refresh_token_enc,access_token_enc,status,connected_at,last_synced_at,average_rating,total_review_count,
      created_at,updated_at,last_posts_synced_at,last_metrics_synced_at,confirmation_revision)
      VALUES('gc1','s1','a1','owner@example.com','locations/111','既存の店','v1.refresh','v1.access','connected',
      '2026-01-01','2026-02-01',4.5,12,'2026-01-01','2026-02-01','2026-02-01','2026-02-01',7);
    INSERT INTO rt_google_profiles VALUES('s1','locations/111','{"title":"既存の店"}','fp1','2026-02-01','2026-02-01');
    INSERT INTO rt_google_metrics_daily(store_id,date,call_clicks) VALUES('s1','2026-02-01',9);
    INSERT INTO rt_google_reviews(id,store_id,review_name,star_rating,comment,create_time,reply_status,reply_comment)
      VALUES('rv1','s1','locations/111/reviews/r1',5,'よかった','2026-02-01','replied','ありがとうございます');
    INSERT INTO rt_google_posts(id,store_id,kind,summary,status,google_post_name,content_fingerprint)
      VALUES('po1','s1','standard','既存の投稿','published','locations/111/localPosts/p1','fp-post');
    INSERT INTO rt_google_changes(id,store_id,kind,summary,status) VALUES('ch1','s1','profile','既存の変更','applied');
    INSERT INTO rt_google_write_log(id,store_id,kind,result) VALUES('wl1','s1','connect','accepted');
    INSERT INTO rt_google_oauth_states(state,store_id,staff_id,mode,code_verifier_enc,expires_at)
      VALUES('st1','s1','staff1','reconnect','v1.verifier','2030-01-01');
    INSERT INTO rt_google_location_candidates(id,store_id,location_name,location_title,address_text,created_at)
      VALUES('lc1','s1','locations/222','候補の店','東京都渋谷区1-1-1','2026-02-01');

    INSERT INTO instagram_connections(line_account_id,page_id,instagram_id,page_name,username,
      page_token_encrypted,user_token_encrypted,expires_at,profile_json,refreshed_at,synced_at,connected_by,version,scopes)
      VALUES('a1','page1','ig1','既存ページ','existing_shop','v1.page','v1.user','2030-01-01',
      '{"username":"existing_shop"}','2026-02-01','2026-02-01','staff1',4,'instagram_basic');
    INSERT INTO instagram_messages(id,line_account_id,instagram_id,sender_id,recipient_id,content,received_at,created_at)
      VALUES('m1','a1','ig1','customer','ig1','既存のDM','2026-02-01','2026-02-01');
    INSERT INTO instagram_oauth_states VALUES('sh1','a1','staff1','selecting','v1.candidates','2030-01-01','2026-02-01');
  `);
  return db;
}

describe('772＋773 Googleビジネス・Instagram の複数連携', () => {
  let db: Database.Database;

  // 移行が全部済んだ形（772 → 新しいWorker → 773 まで進んだ状態）で確かめる。
  // 途中の形（772 だけ当てた状態）は後ろの「段階移行」の節で別に確かめる。
  beforeEach(() => {
    db = before();
    db.exec(migration);
    db.exec(dropCompat);
  });

  it('既存の接続・履歴・暗号化された認証情報・主連携設定を引き継ぐ', () => {
    expect(
      db
        .prepare(
          `SELECT id,store_id,line_account_id,google_account_email,location_name,refresh_token_enc,
                  access_token_enc,status,average_rating,total_review_count,
                  last_posts_synced_at,confirmation_revision,sort_order
             FROM rt_google_connections`,
        )
        .all(),
    ).toEqual([
      {
        id: 'gc1',
        store_id: 's1',
        line_account_id: 'a1',
        google_account_email: 'owner@example.com',
        location_name: 'locations/111',
        refresh_token_enc: 'v1.refresh',
        access_token_enc: 'v1.access',
        status: 'connected',
        average_rating: 4.5,
        total_review_count: 12,
        last_posts_synced_at: '2026-02-01',
        confirmation_revision: 7,
        sort_order: 0,
      },
    ]);

    expect(db.prepare('SELECT code_verifier_enc FROM rt_google_oauth_states').get()).toEqual({
      code_verifier_enc: 'v1.verifier',
    });
    expect(db.prepare('SELECT reply_comment FROM rt_google_reviews WHERE id=?').get('rv1')).toEqual({
      reply_comment: 'ありがとうございます',
    });
    expect(db.prepare('SELECT summary FROM rt_google_posts WHERE id=?').get('po1')).toEqual({
      summary: '既存の投稿',
    });
    expect(db.prepare('SELECT call_clicks FROM rt_google_metrics_daily').get()).toEqual({ call_clicks: 9 });
    expect(db.prepare('SELECT fingerprint FROM rt_google_profiles').get()).toEqual({ fingerprint: 'fp1' });
    expect(db.prepare('SELECT COUNT(*) n FROM rt_google_changes').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM rt_google_write_log').get()).toEqual({ n: 1 });

    expect(
      db
        .prepare(
          `SELECT id,line_account_id,page_id,instagram_id,username,page_token_encrypted,
                  user_token_encrypted,profile_json,version,scopes,sort_order
             FROM instagram_connections`,
        )
        .all(),
    ).toEqual([
      {
        id: 'igc_a1',
        line_account_id: 'a1',
        page_id: 'page1',
        instagram_id: 'ig1',
        username: 'existing_shop',
        page_token_encrypted: 'v1.page',
        user_token_encrypted: 'v1.user',
        profile_json: '{"username":"existing_shop"}',
        version: 4,
        scopes: 'instagram_basic',
        sort_order: 0,
      },
    ]);
    expect(db.prepare('SELECT content FROM instagram_messages WHERE id=?').get('m1')).toEqual({
      content: '既存のDM',
    });
    expect(db.prepare('SELECT candidates_encrypted FROM instagram_oauth_states').get()).toEqual({
      candidates_encrypted: 'v1.candidates',
    });

    // 主連携の正本は account_settings のまま。版は value のJSON内（src/account-settings.ts）なので
    // 移行で値の文字列ごと変えないことを確かめる
    expect(db.prepare('SELECT value FROM account_settings WHERE key=?').get('sns.google.primary_connection')).toEqual({
      value: '{"version":3,"data":{"connectionId":"gc1"}}',
    });
  });

  it('既存行が既存の接続へ割り当てられる', () => {
    for (const table of [
      'rt_google_profiles',
      'rt_google_metrics_daily',
      'rt_google_reviews',
      'rt_google_posts',
      'rt_google_changes',
      'rt_google_write_log',
    ]) {
      expect(db.prepare(`SELECT connection_id FROM ${table}`).all(), table).toEqual([{ connection_id: 'gc1' }]);
    }
    expect(db.prepare('SELECT connection_id FROM instagram_messages').all()).toEqual([
      { connection_id: 'igc_a1' },
    ]);
  });

  it('同じ店舗に2件目のGoogle接続を作れる（446の一意制約が外れている）', () => {
    db.prepare(
      `INSERT INTO rt_google_connections(id,store_id,line_account_id,location_name,status,sort_order)
         VALUES('gc2','s1','a1','locations/222','connected',1)`,
    ).run();
    expect(db.prepare('SELECT COUNT(*) n FROM rt_google_connections WHERE store_id=?').get('s1')).toEqual({ n: 2 });

    // 同じ店舗に同じロケーションは二重に接続できない
    expect(() =>
      db
        .prepare(
          `INSERT INTO rt_google_connections(id,store_id,location_name,status)
             VALUES('gc3','s1','locations/222','connected')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
    // ロケーション未確定の行は何件でも作れる
    db.prepare(`INSERT INTO rt_google_connections(id,store_id,status) VALUES('gc4','s1','pending_location')`).run();
    db.prepare(`INSERT INTO rt_google_connections(id,store_id,status) VALUES('gc5','s1','pending_location')`).run();
  });

  it('接続ごとにプロフィールと数値を別々に持てる', () => {
    db.prepare(
      `INSERT INTO rt_google_connections(id,store_id,location_name,status,sort_order)
         VALUES('gc2','s1','locations/222','connected',1)`,
    ).run();
    db.prepare(
      `INSERT INTO rt_google_profiles(store_id,connection_id,location_name,profile_json,fingerprint,fetched_at,updated_at)
         VALUES('s1','gc2','locations/222','{"title":"2号店"}','fp2','2026-02-02','2026-02-02')`,
    ).run();
    db.prepare(
      `INSERT INTO rt_google_metrics_daily(store_id,connection_id,date,call_clicks) VALUES('s1','gc2','2026-02-01',3)`,
    ).run();

    expect(db.prepare('SELECT COUNT(*) n FROM rt_google_profiles WHERE store_id=?').get('s1')).toEqual({ n: 2 });
    expect(
      db.prepare('SELECT call_clicks FROM rt_google_metrics_daily WHERE connection_id=? AND date=?').get('gc2', '2026-02-01'),
    ).toEqual({ call_clicks: 3 });

    // 同じ接続で同じ日・同じプロフィールは1行だけ
    expect(() =>
      db
        .prepare(
          `INSERT INTO rt_google_metrics_daily(store_id,connection_id,date,call_clicks) VALUES('s1','gc2','2026-02-01',4)`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO rt_google_profiles(store_id,connection_id,location_name,profile_json,fingerprint,fetched_at,updated_at)
             VALUES('s1','gc2','locations/222','{}','fp3','2026-02-03','2026-02-03')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('同じ内容の投稿を接続ごとに持てる', () => {
    db.prepare(
      `INSERT INTO rt_google_connections(id,store_id,location_name,status) VALUES('gc2','s1','locations/222','connected')`,
    ).run();
    db.prepare(
      `INSERT INTO rt_google_posts(id,store_id,connection_id,kind,summary,status,google_post_name,content_fingerprint)
         VALUES('po2','s1','gc2','standard','既存の投稿','published','locations/222/localPosts/p1','fp-post')`,
    ).run();
    expect(db.prepare('SELECT COUNT(*) n FROM rt_google_posts WHERE content_fingerprint=?').get('fp-post')).toEqual({ n: 2 });
  });

  it('接続を1件消しても他の接続の取り込みと履歴が残る', () => {
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare(
      `INSERT INTO rt_google_connections(id,store_id,location_name,status) VALUES('gc2','s1','locations/222','connected')`,
    ).run();
    db.prepare(
      `INSERT INTO rt_google_profiles(store_id,connection_id,location_name,profile_json,fingerprint,fetched_at,updated_at)
         VALUES('s1','gc2','locations/222','{}','fp2','2026-02-02','2026-02-02')`,
    ).run();
    db.prepare(
      `INSERT INTO rt_google_reviews(id,store_id,connection_id,review_name,star_rating,create_time,reply_status)
         VALUES('rv2','s1','gc2','locations/222/reviews/r1',4,'2026-02-02','unreplied')`,
    ).run();

    db.prepare('DELETE FROM rt_google_connections WHERE id=?').run('gc2');

    expect(db.prepare('SELECT id FROM rt_google_connections').all()).toEqual([{ id: 'gc1' }]);
    expect(db.prepare('SELECT fingerprint FROM rt_google_profiles').all()).toEqual([{ fingerprint: 'fp1' }]);
    // 1件目の口コミと返信はそのまま。削除した接続の行は履歴として残り、帰属だけ外れる
    expect(db.prepare('SELECT id,connection_id FROM rt_google_reviews ORDER BY id').all()).toEqual([
      { id: 'rv1', connection_id: 'gc1' },
      { id: 'rv2', connection_id: null },
    ]);
  });

  it('同じLINEアカウントに2件目のInstagram接続を作れる（603/754の主キーが外れている）', () => {
    db.prepare(
      `INSERT INTO instagram_connections(id,line_account_id,page_id,instagram_id,page_name,
         page_token_encrypted,user_token_encrypted,expires_at,refreshed_at,connected_by,sort_order)
         VALUES('igc2','a1','page2','ig2','2号店','v1.page2','v1.user2','2030-01-01','2026-02-02','staff1',1)`,
    ).run();
    expect(db.prepare('SELECT COUNT(*) n FROM instagram_connections WHERE line_account_id=?').get('a1')).toEqual({ n: 2 });

    // 同じアカウントに同じInstagramは二重に接続できない
    expect(() =>
      db
        .prepare(
          `INSERT INTO instagram_connections(id,line_account_id,page_id,instagram_id,page_name,
             page_token_encrypted,user_token_encrypted,expires_at,refreshed_at,connected_by)
             VALUES('igc3','a1','page2','ig2','重複','v1.p','v1.u','2030-01-01','2026-02-02','staff1')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('Instagram接続のidはNULLにならない（渡さなければ既定値、明示NULLは拒否）', () => {
    // SQLiteは非INTEGERの主キーにNULLを通し、NULL同士を別物として扱う。放っておくと
    // id を渡さない既存コード（apps/worker/src/routes/instagram.ts）が静かにid=NULLの行を増やす。
    // 772 は NOT NULL と既定値の両方を置いて、どちらの書き方でもNULL行ができないようにしている。
    db.prepare(
      `INSERT INTO instagram_connections(line_account_id,page_id,instagram_id,page_name,
         page_token_encrypted,user_token_encrypted,expires_at,refreshed_at,connected_by)
         VALUES('a1','page2','ig2','接続ID無し','v1.p','v1.u','2030-01-01','2026-02-02','staff1')`,
    ).run();
    expect(db.prepare(`SELECT COUNT(*) n FROM instagram_connections WHERE id LIKE 'igc_%'`).get()).toEqual({ n: 2 });

    expect(() =>
      db
        .prepare(
          `INSERT INTO instagram_connections(id,line_account_id,page_id,instagram_id,page_name,
             page_token_encrypted,user_token_encrypted,expires_at,refreshed_at,connected_by)
             VALUES(NULL,'a1','page3','ig3','明示NULL','v1.p','v1.u','2030-01-01','2026-02-02','staff1')`,
        )
        .run(),
    ).toThrow(/NOT NULL/);
    expect(db.prepare('SELECT COUNT(*) n FROM instagram_connections WHERE id IS NULL').get()).toEqual({ n: 0 });
  });

  it('同じ統括なら共有でき、別の統括は拒否し続ける', () => {
    const add = db.prepare(
      `INSERT INTO instagram_connections(id,line_account_id,page_id,instagram_id,page_name,
         page_token_encrypted,user_token_encrypted,expires_at,refreshed_at,connected_by)
         VALUES(?,?,'page1','ig1','共有','v1.p','v1.u','2030-01-01','2026-02-02','staff1')`,
    );
    add.run('igc_a2', 'a2');
    expect(() => add.run('igc_a3', 'a3')).toThrow('instagram_cross_tenant');
    expect(() => db.prepare('UPDATE instagram_connections SET line_account_id=? WHERE id=?').run('a3', 'igc_a2')).toThrow(
      'instagram_cross_tenant',
    );
  });

  it('接続ごとにDMを分けて引ける', () => {
    db.prepare(
      `INSERT INTO instagram_connections(id,line_account_id,page_id,instagram_id,page_name,
         page_token_encrypted,user_token_encrypted,expires_at,refreshed_at,connected_by)
         VALUES('igc2','a1','page2','ig2','2号店','v1.p','v1.u','2030-01-01','2026-02-02','staff1')`,
    ).run();
    db.prepare(
      `INSERT INTO instagram_messages(id,line_account_id,connection_id,instagram_id,sender_id,recipient_id,content,received_at,created_at)
         VALUES('m2','a1','igc2','ig2','customer','ig2','2号店へのDM','2026-02-02','2026-02-02')`,
    ).run();
    expect(db.prepare('SELECT content FROM instagram_messages WHERE connection_id=?').all('igc_a1')).toEqual([
      { content: '既存のDM' },
    ]);
    expect(db.prepare('SELECT content FROM instagram_messages WHERE connection_id=?').all('igc2')).toEqual([
      { content: '2号店へのDM' },
    ]);
  });

  it('他の店舗の接続IDを取り込み・履歴に混ぜる書き込みを拒否する', () => {
    // 外部キーは「接続が実在するか」しか見ない。s2 の接続を s1 の行に挿せると、
    // 統括をまたいでデータが混ざる経路になるのでトリガーで止める
    db.prepare(
      `INSERT INTO rt_google_connections(id,store_id,location_name,status)
         VALUES('gc2','s2','locations/222','connected')`,
    ).run();

    const tables: Array<[string, string]> = [
      ['rt_google_reviews', `INSERT INTO rt_google_reviews(id,store_id,connection_id,review_name,star_rating,create_time)
         VALUES('rv9','s1','gc2','locations/222/reviews/r9',5,'2026-02-02')`],
      ['rt_google_posts', `INSERT INTO rt_google_posts(id,store_id,connection_id,kind)
         VALUES('po9','s1','gc2','standard')`],
      ['rt_google_changes', `INSERT INTO rt_google_changes(id,store_id,connection_id,kind,summary)
         VALUES('ch9','s1','gc2','profile','越境')`],
      ['rt_google_write_log', `INSERT INTO rt_google_write_log(id,store_id,connection_id,kind,result)
         VALUES('wl9','s1','gc2','connect','accepted')`],
      ['rt_google_oauth_states', `INSERT INTO rt_google_oauth_states(state,store_id,connection_id,staff_id,mode,code_verifier_enc,expires_at)
         VALUES('st9','s1','gc2','staff1','reconnect','v1.v','2030-01-01')`],
      ['rt_google_location_candidates', `INSERT INTO rt_google_location_candidates(id,store_id,connection_id,location_name,location_title)
         VALUES('lc9','s1','gc2','locations/999','越境の候補')`],
      ['rt_google_profiles', `INSERT INTO rt_google_profiles(store_id,connection_id,location_name,profile_json,fingerprint,fetched_at)
         VALUES('s1','gc2','locations/222','{}','fp9','2026-02-02')`],
      ['rt_google_metrics_daily', `INSERT INTO rt_google_metrics_daily(store_id,connection_id,date,call_clicks)
         VALUES('s1','gc2','2026-02-02',3)`],
    ];
    for (const [table, sql] of tables) {
      expect(() => db.prepare(sql).run(), table).toThrow('google_connection_store_mismatch');
    }

    // 既にある行を別店舗の接続へ付け替えるのも止める
    expect(() =>
      db.prepare('UPDATE rt_google_reviews SET connection_id=? WHERE id=?').run('gc2', 'rv1'),
    ).toThrow('google_connection_store_mismatch');
    // 自分の店舗の接続なら通る
    expect(() =>
      db.prepare('UPDATE rt_google_reviews SET connection_id=? WHERE id=?').run('gc1', 'rv1'),
    ).not.toThrow();
  });

  it('他のLINEアカウントの接続IDを受信・OAuth状態に混ぜる書き込みを拒否する', () => {
    db.prepare(
      `INSERT INTO instagram_connections(id,line_account_id,page_id,instagram_id,page_name,
         page_token_encrypted,user_token_encrypted,expires_at,refreshed_at,connected_by)
         VALUES('igc_a2','a2','page2','ig2','別アカウント','v1.p','v1.u','2030-01-01','2026-02-02','staff1')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO instagram_messages(id,line_account_id,connection_id,instagram_id,sender_id,recipient_id,content,received_at,created_at)
             VALUES('m9','a1','igc_a2','ig2','customer','ig2','越境のDM','2026-02-02','2026-02-02')`,
        )
        .run(),
    ).toThrow('instagram_connection_account_mismatch');

    expect(() =>
      db
        .prepare(
          `INSERT INTO instagram_oauth_states(state_hash,line_account_id,connection_id,staff_id,phase,expires_at,created_at)
             VALUES('sh9','a1','igc_a2','staff1','selecting','2030-01-01','2026-02-02')`,
        )
        .run(),
    ).toThrow('instagram_connection_account_mismatch');

    expect(() =>
      db.prepare('UPDATE instagram_messages SET connection_id=? WHERE id=?').run('igc_a2', 'm1'),
    ).toThrow('instagram_connection_account_mismatch');
  });
});

// 配備の順番は「DBを先、Workerを後」（docs/migration-runbook.md）。772 を当ててから
// 新しいWorkerが行き渡るまでは、旧Workerと新Workerが同じDBへ同時に書く時間帯ができる。
// その時間帯に両方の書き込みが通ることと、2件目の接続が入るのは 773 の後になることを確かめる。
describe('772 だけ当てた段階移行の途中（旧Workerと新Workerが同時に動く時間帯）', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = before();
    db.exec(migration);
  });

  // 以下のSQLは分岐点 efc5d25c45 の旧Workerから conflict target をそのまま写したもの。
  it('旧Workerの upsert が5か所すべてそのまま通る', () => {
    // apps/worker/src/routes/restaurant-google.ts: ON CONFLICT(store_id)
    db.prepare(
      `INSERT INTO rt_google_connections
         (id, store_id, line_account_id, google_account_email, location_name, location_title,
          refresh_token_enc, access_token_enc, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store_id) DO UPDATE SET
         confirmation_revision = rt_google_connections.confirmation_revision + 1,
         line_account_id = excluded.line_account_id,
         location_name = excluded.location_name,
         refresh_token_enc = excluded.refresh_token_enc,
         status = excluded.status,
         updated_at = excluded.updated_at`,
    ).run('gc1', 's1', 'a1', 'owner@example.com', 'locations/111', '既存の店', 'v2.refresh', 'v2.access', 'connected', '2026-03-01');
    expect(
      db.prepare('SELECT confirmation_revision r, refresh_token_enc t FROM rt_google_connections WHERE id=?').get('gc1'),
    ).toEqual({ r: 8, t: 'v2.refresh' });

    // apps/worker/src/routes/restaurant-google-profile.ts と
    // apps/worker/src/services/google-business-resync.ts: ON CONFLICT(store_id)
    db.prepare(
      `INSERT INTO rt_google_profiles (store_id, location_name, profile_json, fingerprint, fetched_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(store_id) DO UPDATE SET location_name = excluded.location_name, profile_json = excluded.profile_json,
         fingerprint = excluded.fingerprint, fetched_at = excluded.fetched_at, updated_at = excluded.updated_at`,
    ).run('s1', 'locations/111', '{"title":"更新後"}', 'fp-new', '2026-03-01', '2026-03-01');
    // 引き継いだ接続IDは消えず、同じ1行が書き換わる
    expect(db.prepare('SELECT connection_id c, fingerprint f FROM rt_google_profiles').all()).toEqual([
      { c: 'gc1', f: 'fp-new' },
    ]);

    // apps/worker/src/services/google-business-resync.ts: ON CONFLICT(store_id, date)
    db.prepare(
      `INSERT INTO rt_google_metrics_daily (store_id, date, call_clicks, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(store_id, date) DO UPDATE SET call_clicks = excluded.call_clicks, fetched_at = excluded.fetched_at`,
    ).run('s1', '2026-02-01', 21, '2026-03-01');
    expect(db.prepare('SELECT connection_id c, call_clicks n FROM rt_google_metrics_daily').all()).toEqual([
      { c: 'gc1', n: 21 },
    ]);

    // apps/worker/src/routes/restaurant-google.ts: INSERT OR IGNORE
    db.prepare(
      `INSERT OR IGNORE INTO rt_google_location_candidates (id, store_id, location_name, location_title, address_text)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('lc2', 's1', 'locations/222', '候補の店', '東京都渋谷区1-1-1');
    expect(db.prepare('SELECT COUNT(*) n FROM rt_google_location_candidates WHERE store_id=?').get('s1')).toEqual({ n: 1 });

    // apps/worker/src/routes/instagram.ts: ON CONFLICT(line_account_id)。id を渡さない形
    const result = db
      .prepare(
        `INSERT INTO instagram_connections(line_account_id,page_id,instagram_id,page_name,username,page_token_encrypted,user_token_encrypted,expires_at,data_access_expires_at,scopes,profile_json,refreshed_at,connected_by) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM instagram_connections WHERE line_account_id=?) ON CONFLICT(line_account_id) DO UPDATE SET page_id=excluded.page_id,instagram_id=excluded.instagram_id,page_name=excluded.page_name,username=excluded.username,page_token_encrypted=excluded.page_token_encrypted,user_token_encrypted=excluded.user_token_encrypted,expires_at=excluded.expires_at,data_access_expires_at=excluded.data_access_expires_at,scopes=excluded.scopes,profile_json=excluded.profile_json,posts_json=NULL,synced_at=NULL,refreshed_at=excluded.refreshed_at,connected_by=excluded.connected_by,version=version+1 WHERE version=?`,
      )
      .run(
        'a1', 'ig1', 'ig1', '既存ページ', 'existing_shop', 'v2.page', 'v2.user', '2030-01-01', null,
        'instagram_basic', '{"username":"existing_shop"}', '2026-03-01', 'staff1',
        4, 'a1', 4,
      );
    // 版の衝突判定（!result.meta.changes で 409）が段階移行中も効く形で1行書き換わる
    expect(result.changes).toBe(1);
    expect(db.prepare('SELECT id,version,page_token_encrypted t FROM instagram_connections').all()).toEqual([
      { id: 'igc_a1', version: 5, t: 'v2.page' },
    ]);
  });

  it('新Workerの upsert も同じ時間帯にそのまま通る', () => {
    // apps/worker/src/routes/restaurant-google-profile.ts と google-business-resync.ts の新しい形
    db.prepare(
      `INSERT INTO rt_google_profiles (store_id, connection_id, location_name, profile_json, fingerprint, fetched_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(COALESCE(connection_id, 'store:' || store_id)) DO UPDATE SET location_name = excluded.location_name,
         profile_json = excluded.profile_json, fingerprint = excluded.fingerprint, fetched_at = excluded.fetched_at,
         updated_at = excluded.updated_at`,
    ).run('s1', 'gc1', 'locations/111', '{"title":"新Worker"}', 'fp-conn', '2026-03-02', '2026-03-02');
    expect(db.prepare('SELECT connection_id c, fingerprint f FROM rt_google_profiles').all()).toEqual([
      { c: 'gc1', f: 'fp-conn' },
    ]);

    db.prepare(
      `INSERT INTO rt_google_metrics_daily (store_id, connection_id, date, call_clicks, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(COALESCE(connection_id, 'store:' || store_id), date) DO UPDATE SET
         call_clicks = excluded.call_clicks, fetched_at = excluded.fetched_at`,
    ).run('s1', 'gc1', '2026-02-01', 33, '2026-03-02');
    expect(db.prepare('SELECT connection_id c, call_clicks n FROM rt_google_metrics_daily').all()).toEqual([
      { c: 'gc1', n: 33 },
    ]);

    // apps/worker/src/routes/instagram.ts の新しい形: ON CONFLICT(id)
    const result = db
      .prepare(
        `INSERT INTO instagram_connections(id,line_account_id,page_id,instagram_id,page_name,page_token_encrypted,user_token_encrypted,expires_at,refreshed_at,connected_by)
         VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id,page_token_encrypted=excluded.page_token_encrypted,
           refreshed_at=excluded.refreshed_at,version=version+1 WHERE version=?`,
      )
      .run('igc_a1', 'a1', 'page1', 'ig1', '既存ページ', 'v3.page', 'v3.user', '2030-01-01', '2026-03-02', 'staff1', 4);
    expect(result.changes).toBe(1);
    expect(db.prepare('SELECT version,page_token_encrypted t FROM instagram_connections').all()).toEqual([
      { version: 5, t: 'v3.page' },
    ]);
  });

  it('互換索引が残っているあいだは2件目の接続行が入らない', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO rt_google_connections(id,store_id,location_name,status) VALUES('gc2','s1','locations/222','connected')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO instagram_connections(id,line_account_id,page_id,instagram_id,page_name,
             page_token_encrypted,user_token_encrypted,expires_at,refreshed_at,connected_by)
             VALUES('igc2','a1','page2','ig2','2号店','v1.p','v1.u','2030-01-01','2026-02-02','staff1')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('773 で互換索引を外すと2件目の接続行が入る', () => {
    db.exec(dropCompat);

    db.prepare(
      `INSERT INTO rt_google_connections(id,store_id,location_name,status,sort_order)
         VALUES('gc2','s1','locations/222','connected',1)`,
    ).run();
    db.prepare(
      `INSERT INTO instagram_connections(id,line_account_id,page_id,instagram_id,page_name,
         page_token_encrypted,user_token_encrypted,expires_at,refreshed_at,connected_by,sort_order)
         VALUES('igc2','a1','page2','ig2','2号店','v1.p','v1.u','2030-01-01','2026-02-02','staff1',1)`,
    ).run();

    expect(db.prepare('SELECT id FROM rt_google_connections WHERE store_id=? ORDER BY sort_order').all('s1')).toEqual([
      { id: 'gc1' },
      { id: 'gc2' },
    ]);
    expect(db.prepare('SELECT id FROM instagram_connections WHERE line_account_id=? ORDER BY sort_order').all('a1')).toEqual([
      { id: 'igc_a1' },
      { id: 'igc2' },
    ]);

    // 773 の後も新Workerの当たり先は変わらない（接続ごとに1行の鍵は残る）
    db.prepare(
      `INSERT INTO rt_google_profiles (store_id, connection_id, location_name, profile_json, fingerprint, fetched_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(COALESCE(connection_id, 'store:' || store_id)) DO UPDATE SET fingerprint = excluded.fingerprint`,
    ).run('s1', 'gc2', 'locations/222', '{}', 'fp2', '2026-03-03', '2026-03-03');
    expect(db.prepare('SELECT connection_id c, fingerprint f FROM rt_google_profiles ORDER BY c').all()).toEqual([
      { c: 'gc1', f: 'fp1' },
      { c: 'gc2', f: 'fp2' },
    ]);
  });
});
