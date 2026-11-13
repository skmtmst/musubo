/**
 * 受入条件11（申請文と本番機能の不一致を検出する回帰テスト）／受入条件2・8・9。
 *
 * Google Business Profile API の利用審査では、申請文・公開ページ・デモ動画・本番実装が
 * 一致している必要がある（審査のために事実と異なる説明は書かない）。
 * ここでは「文書だけ直して実装が置き去りになる」ことと、その逆を防ぐため、
 * 文書と実装を突き合わせて次を固定する。
 *
 * 1. 本番コードが呼ぶGoogle APIは、すべて機能対応表に載っている。
 * 2. 裏側の定期再同期は読み取り関数しか読み込まない（自動書き込みが混ざらない）。
 * 3. 「提供しない」と書いた機能のコードが存在しない。
 * 4. 公開ページ（privacy/terms/トップ）が組み立てる本文が実装の定数と一致している。
 *
 * 書き込み4機能の明示確認と役割、ログインセッション限定、許可の確かめは、
 * 口を実際に叩く restaurant-google*.test.ts が持つ。外部通信はしない。
 */
import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, GOOGLE_BUSINESS_SCOPES } from '../services/google-business.js';
import { GOOGLE_CONTENT_RETENTION_LIMIT_DAYS, GOOGLE_CONTENT_PURGE_AFTER_DAYS } from '../services/google-business-retention.js';

const authorization = () => new URL(buildAuthorizeUrl({
  clientId: 'fixture', redirectUri: 'https://example.test/callback', state: 'state', codeChallenge: 'challenge',
}));

const GOOGLE_SERVICE_FILES = [
  'google-business.ts',
  'google-business-profile.ts',
  'google-business-posts.ts',
  'google-business-performance.ts',
] as const;

async function readRepoFile(relativeToRoot: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  // here = apps/worker/src/routes/
  return readFileSync(`${here}../../../../${relativeToRoot}`, 'utf8');
}

type MusuboSite = {
  config: unknown;
  legalBody: (kind: string, config: unknown, production: boolean) => string;
  home: (config: unknown, production: boolean) => string;
};

/** 公開サイト（sites/musubo）の組み立て関数。別アプリなので Worker の型検査には含めない。 */
async function loadMusuboSite(): Promise<MusuboSite> {
  const { fileURLToPath } = await import('node:url');
  const root = new URL('../../../../sites/musubo/', import.meta.url);
  const [{ default: config }, { legalBody }, { home }] = await Promise.all([
    import(fileURLToPath(new URL('site.config.mjs', root))),
    import(fileURLToPath(new URL('src/legal.mjs', root))),
    import(fileURLToPath(new URL('src/home.mjs', root))),
  ]);
  return { config, legalBody, home };
}

async function readServiceFile(file: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  return readFileSync(`${here}../services/${file}`, 'utf8');
}

describe('申請文と本番実装の一致（受入条件11）', () => {
  it('本番コードが呼ぶGoogle APIはすべて機能対応表に載っている', async () => {
    const matrix = await readRepoFile('docs/manuals/google-business-feature-matrix.md');
    const literals = new Set<string>();
    for (const file of GOOGLE_SERVICE_FILES) {
      const source = await readServiceFile(file);
      for (const match of source.matchAll(
        /https:\/\/[a-z0-9.\-]*(?:googleapis\.com|accounts\.google\.com)[A-Za-z0-9._/\-]*/g,
      )) {
        literals.add(match[0]);
      }
    }
    expect(literals.size).toBeGreaterThan(0);
    const missing = [...literals].filter((literal) => !matrix.includes(literal));
    expect(missing).toEqual([]);
  });

  it('機能対応表は申請文から参照されている', async () => {
    const application = await readRepoFile('docs/manuals/google-business-verification-application.md');
    expect(application).toContain('docs/manuals/google-business-feature-matrix.md');
  });

  it('使用スコープは business.manage と openid / email だけ', async () => {
    const source = await readServiceFile('google-business.ts');
    const scopes = authorization().searchParams.get('scope')!.split(' ');
    expect(scopes).toEqual([...GOOGLE_BUSINESS_SCOPES]);
    expect(scopes).toEqual(['https://www.googleapis.com/auth/business.manage', 'openid', 'email']);
    // 読み取り専用スコープは存在しないため、ほかのGoogleスコープを増やしていないことを固定する。
    const extraScopes = [...source.matchAll(/https:\/\/www\.googleapis\.com\/auth\/[A-Za-z0-9._\-]+/g)]
      .map((match) => match[0])
      .filter((scope) => scope !== 'https://www.googleapis.com/auth/business.manage');
    expect(extraScopes).toEqual([]);
  });

  it('認可URLに include_granted_scopes を付けない', async () => {
    expect(authorization().searchParams.has('include_granted_scopes')).toBe(false);
  });

  it('審査対象クライアントにSheetsのコールバックURLを登録させない手順になっている', async () => {
    // `services/google-sheets.ts` は Sheets 専用の値が無いときビジネス用クライアントを共用する。
    // そのため審査対象のクライアントに Sheets のコールバックを登録すると、
    // そのクライアントから `.../auth/spreadsheets`（機密スコープ）を要求できる状態になり、
    // 申請文の「要求するスコープは3つだけ」と食い違う。
    // 登録が無ければGoogleは同意画面の前に redirect_uri_mismatch で止めるので、
    // ここでは「手順の囲みに書かれているURL」だけを見て、登録対象が1本であることを固定する。
    const sheetsCallback = '/api/integrations/google-sheets/oauth/callback';
    const businessCallback = 'https://api.musubo.jp/api/restaurant-test/google/oauth/callback';

    const setup = await readRepoFile('docs/manuals/google-business-oauth-setup.md');
    const chapterStart = setup.indexOf('## 6. 実運用環境のクライアントを作る');
    expect(chapterStart).toBeGreaterThan(-1);
    const chapter = setup.slice(chapterStart);
    const registered = [...chapter.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
    expect(registered.length).toBeGreaterThan(0);
    const registeredUrls = registered.join('\n');
    expect(registeredUrls).toContain(businessCallback);
    expect(registeredUrls).not.toContain(sheetsCallback);
    // 「登録しない」理由が手順の本文に残っていること。
    expect(chapter).toContain(sheetsCallback);
    expect(chapter).toContain('このクライアントに登録しない');

    const application = await readRepoFile('docs/manuals/google-business-verification-application.md');
    const todoStart = application.indexOf('## 5. 残っている作業と担当');
    expect(todoStart).toBeGreaterThan(-1);
    const todo = application.slice(todoStart);
    expect(todo).toContain(sheetsCallback);
    expect(todo).toContain('登録しない');
    expect(todo).toContain('https://www.googleapis.com/auth/spreadsheets');
  });

  // 接続と更新で business.manage の許可を確かめることは、口を実際に叩いて見る
  // （restaurant-google.test.ts の「business.manage を外した同意」「business.manage だけ取り消された」）。
});

/*
 * 書き込み4つ（口コミ返信・店舗情報の送信・投稿の公開・投稿の削除）が明示確認と
 * owner/admin を要求することは、口を実際に叩いて見る。
 * 確認なし→400 confirmation_required：restaurant-google.test.ts・restaurant-google-posts.test.ts・
 * restaurant-google-profile.test.ts。担当者→403：同じ3ファイルの権限の試験。
 */
describe('定期処理は自動で書き込まない（受入条件5・9）', () => {
  it('定期再同期は読み取り関数しか読み込まない', async () => {
    const source = await readServiceFile('google-business-resync.ts');
    const imports = source.slice(0, source.indexOf('const HOURLY_STALE_MS'));
    for (const writeFn of [
      'updateReviewReply',
      'patchProfile',
      'createMedia',
      'deleteMedia',
      'createLocalPost',
      'deleteLocalPost',
    ]) {
      expect(imports, `${writeFn} が定期処理に読み込まれている`).not.toContain(writeFn);
    }
    // 読み取り3種（口コミ・投稿・指標）を実際に呼んで取り込むことは
    // google-business-resync.test.ts が Google への通信を見て確かめる。
  });
});

describe('今回提供しない機能のコードが存在しない（タスク2・受入条件9）', () => {
  it('Pub/Sub通知・店舗確認の開始・動画の取り扱いがない', async () => {
    for (const file of GOOGLE_SERVICE_FILES) {
      const source = await readServiceFile(file);
      const lowered = source.toLowerCase();
      expect(lowered, `${file} に Pub/Sub の実装がある`).not.toContain('pubsub');
      expect(lowered, `${file} に通知設定の実装がある`).not.toContain('notificationsetting');
      expect(lowered, `${file} に店舗確認（verification）の実装がある`).not.toContain('verifications');
      expect(source, `${file} に動画アップロードの実装がある`).not.toContain("mediaFormat: 'VIDEO'");
    }
  });

  it('口コミ返信の削除と投稿の更新を行わない', async () => {
    const reviews = await readServiceFile('google-business.ts');
    // 返信はPUT（作成・修正）のみ。PUT で送ることは google-business.test.ts が通信を見て確かめる。
    expect(reviews).not.toMatch(/\/reply`,\s*\{\s*\n\s*method: '(?!PUT')[A-Z]+'/);
    expect(reviews).not.toContain("/reply`, { method: 'DELETE' }");

    // 投稿は作成(POST)と削除(DELETE)だけ。どちらも restaurant-google-posts.test.ts が通信を見て確かめる。
    const posts = await readServiceFile('google-business-posts.ts');
    expect(posts).not.toMatch(/method: '(?:PATCH|PUT)'/);
  });

  // Googleルートがログインセッション限定であることは、4ファイルを1つずつ載せて
  // APIキーで叩いて見る（restaurant-google.test.ts の「だけを載せても、APIキーは403で止まる」）。
});

describe('保存期間の実装と公開文書が一致している（受入条件7）', () => {
  it('削除は30暦日の上限より手前で動く', async () => {
    const limit = GOOGLE_CONTENT_RETENTION_LIMIT_DAYS;
    const purge = GOOGLE_CONTENT_PURGE_AFTER_DAYS;
    expect(Number.isInteger(limit)).toBe(true);
    expect(Number.isInteger(purge)).toBe(true);
    expect(limit).toBeLessThanOrEqual(30);
    expect(purge).toBeLessThan(limit);
  });

  it('プライバシーポリシーと利用規約が実装どおりの説明になっている', async () => {
    // 公開サイトが実際に組み立てる2ページの本文で見る（本番の組み立て）。
    const site = await loadMusuboSite();
    const legal = ['privacy', 'terms'].map((kind) => site.legalBody(kind, site.config, true)).join('\n');
    for (const phrase of [
      '28日',
      '30暦日',
      'Limited Use',
      '当社が自動で送信することはありません',
      '自動の口コミ返信、定期投稿、店舗情報の自動変更',
      'Google側で行われた変更を自動で元に戻す機能は提供しません',
      '長期間有効なAPIキーを用いた外部プログラムからの利用はできません',
    ]) {
      expect(legal, `公開文書に「${phrase}」がない`).toContain(phrase);
    }
  });

  it('トップページの連携説明が自動送信しないことを明記している', async () => {
    const site = await loadMusuboSite();
    expect(site.home(site.config, true)).toContain('自動で送ることはありません');
  });

  it('保存期間の日数が機能対応表にも書かれている', async () => {
    const matrix = await readRepoFile('docs/manuals/google-business-feature-matrix.md');
    expect(matrix).toContain('GOOGLE_CONTENT_PURGE_AFTER_DAYS = 28');
    expect(matrix).toContain('GOOGLE_CONTENT_RETENTION_LIMIT_DAYS = 30');
  });
});
