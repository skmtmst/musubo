import { tracedFetch as fetch } from '@line-crm/shared/server';
import { encryptCredential, decryptCredential } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { detectImageMeta } from '../lib/image-validator.js';
export class InstagramError extends Error {
  constructor(
    public code: string,
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 502 | 503 = 502,
    /**
     * Meta が返した失敗の中身（種別・番号・説明）。原因調べのためにサーバー記録へ残すだけで、
     * 画面と応答には出さない（`instagram.onError` は `code` しか返さない）。
     */
    public detail?: string,
  ) {
    super(code);
  }
}
/**
 * Meta が `error.type` に入れてくる種別名。応答の中身は Meta が自由に決められるため、
 * この一覧に載っている名前だけをそのまま使い、載っていない名前は `other` に置き換える。
 * 名前の形（英字だけ等）で見分けるやり方は使わない。たとえば英小文字と数字から成る
 * 32文字の合鍵のような値も「ありそうな形」に当てはまってしまい、守り切れないため。
 */
const META_ERROR_TYPES = new Set([
  'OAuthException',
  'FacebookApiException',
  'GraphMethodException',
  'GraphBatchException',
  'IGApiException',
]);
/** 一覧に無い種別名・検査を通らない値の置き換え先。固定の文言。 */
const OTHER = 'other';
/**
 * `fetch` 自体が失敗したとき（応答が返らなかったとき）の呼び名。
 *
 * - `TimeoutError` … `AbortSignal.timeout` の時間切れ。Meta が遅い／通信が出られない。
 * - `TypeError` … つなげなかった（名前が引けない・接続できない・要求の指定が実行環境に無い）。
 * - `AbortError` … 途中で打ち切られた。
 *
 * この呼び名も `Error` の `name` という**応答側の値ではない**が、投げられる中身は
 * 実行環境や上流の都合で変わるため、`error.type` と同じく許可一覧で絞る。
 * 自由文である `message` は読まない。
 */
const FETCH_ERROR_NAMES = new Set([
  'TimeoutError',
  'TypeError',
  'AbortError',
  'DOMException',
  'Error',
]);
/** 投げられた失敗から呼び名だけを取り出す。一覧に無ければ `other`。 */
function fetchErrorName(e: unknown): string {
  const name = (e as { name?: unknown } | null)?.name;
  return typeof name === 'string' && FETCH_ERROR_NAMES.has(name)
    ? name
    : OTHER;
}
/**
 * 受け取った応答が転送（リダイレクト）かどうか。
 *
 * `redirect: 'manual'` では転送を追わず、3xx の応答がそのまま返る。実行環境によっては
 * 中身を読めない応答（`type` が `opaqueredirect`、状態番号は 0）になることもあるため、
 * 番号と種類の両方で見分ける。
 */
function isRedirectResponse(response: Response): boolean {
  return (
    // 型の上では Workers に `opaqueredirect` は無いが、実行環境ごとの違いに備えて見る。
    (response.type as string) === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400)
  );
}
/**
 * Meta のエラー本文から、原因調べに使う安全な項目だけを短く取り出す。
 *
 * `error.message` は Meta が書く自由な文章で、要求に渡した値（合鍵・アプリシークレット・
 * 認可コード）がそのまま、あるいは URL エンコード・二重エンコードなど様々な形で混ざって
 * 返ってくる可能性がある。どの形で混ざるかを網羅して消す（伏せ字処理を重ねる）やり方は
 * 新しい表現が見つかるたびに後追いになり守り切れないため、`message` 自体を記録に出さない。
 *
 * `type` / `code` / `subcode` も Meta の応答の一部で、好きな中身を入れられる。
 * そのため「自由な文章ではない項目」という理由だけで通さず、
 * `type` は上の一覧に載る名前だけ、`code` と `subcode` は整数だけに限る。
 * `status` はこちらが受け取った応答の番号で、Meta の本文には由来しない。
 *
 * エラー本文の形は口によって2通りある。Graph は `error` の中に入れ子で返すが、
 * 認可コードの引き換え（`api.instagram.com/oauth/access_token`）は
 * `error_type` / `code` / `error_message` を素のまま返す。後者を読み落とすと
 * この口の失敗で状態番号しか残らず、原因が分からなくなるため両方読む。
 */
async function metaErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {
      error?: {
        type?: unknown;
        code?: unknown;
        error_subcode?: unknown;
      };
      error_type?: unknown;
      code?: unknown;
    };
    const e = body?.error ?? {
      type: body?.error_type,
      code: body?.code,
      error_subcode: undefined,
    };
    if (!body || (!body.error && e.type === undefined && e.code === undefined))
      return undefined;
    const type =
      typeof e.type === 'string' && e.type !== ''
        ? META_ERROR_TYPES.has(e.type)
          ? e.type
          : OTHER
        : '';
    return [
      `status=${response.status}`,
      type ? `type=${type}` : '',
      Number.isInteger(e.code) ? `code=${e.code as number}` : '',
      Number.isInteger(e.error_subcode)
        ? `subcode=${e.error_subcode as number}`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
  } catch {
    // 本文が読めなくても、どの状態で落ちたかだけは残す。
    return `status=${response.status}`;
  }
}
/**
 * 失敗の手がかりを、利用者に見える戻り先URLへ載せてよい形だけに絞り直す。
 *
 * 受け取った文字列をそのまま通さず、こちらが決めた形に合う部分を**組み立て直す**。
 * `metaErrorDetail` で絞ったあとの値を、URLへ出す直前にもう一度ここで確かめることで、
 * 取り出し側の作りが将来変わっても、Meta の応答の中身がURLへ出ない状態を保つ。
 *
 * 通すのは次の5つだけ。
 * - 要求の種別と宛先（`GET v21.0/me/accounts` など。こちらのコードが決める形のみ）
 * - `fetch` … 応答が返らなかったときの呼び名（`FETCH_ERROR_NAMES` の一覧のみ）
 * - `status` … 3桁の数字
 * - `redirect` … 転送を受けて止めたときの状態番号（3桁まで）
 * - `type` … 上の一覧に載る名前（載っていなければ `other`）
 * - `code` / `subcode` … 数字
 */
export function instagramUrlDetail(
  detail: string | null | undefined,
): string | null {
  if (typeof detail !== 'string' || detail.length > 200) return null;
  const parts: string[] = [];
  const step =
    /^(GET|POST|DELETE) (v[0-9]{1,3}\.[0-9]{1,3}|api|graph)\/(me(?:\/[a-z_]{1,24})?|oauth\/access_token|access_token|refresh_access_token|[0-9]{1,24}(?:\/[a-z_]{1,24})?)(?= |$)/.exec(
      detail,
    );
  if (step) parts.push(`${step[1]} ${step[2]}/${step[3]}`);
  const fetchError = /(?:^| )fetch=([A-Za-z]{1,40})(?= |$)/.exec(detail);
  if (fetchError)
    parts.push(
      `fetch=${FETCH_ERROR_NAMES.has(fetchError[1]) ? fetchError[1] : OTHER}`,
    );
  const status = /(?:^| )status=([0-9]{3})(?= |$)/.exec(detail);
  if (status) parts.push(`status=${status[1]}`);
  // 転送を受けて止めたときの状態番号だけ。中身を読めない応答では 0 になる。
  const redirect = /(?:^| )redirect=([0-9]{1,3})(?= |$)/.exec(detail);
  if (redirect) parts.push(`redirect=${redirect[1]}`);
  const type = /(?:^| )type=([A-Za-z]{1,40})(?= |$)/.exec(detail);
  if (type)
    parts.push(`type=${META_ERROR_TYPES.has(type[1]) ? type[1] : OTHER}`);
  const code = /(?:^| )code=([0-9]{1,9})(?= |$)/.exec(detail);
  if (code) parts.push(`code=${code[1]}`);
  const subcode = /(?:^| )subcode=([0-9]{1,9})(?= |$)/.exec(detail);
  if (subcode) parts.push(`subcode=${subcode[1]}`);
  return parts.length ? parts.join(' ') : null;
}
/**
 * 失敗の種類名を戻り先URLへ載せてよい形だけに絞る。
 * この値は `InstagramError` を投げるときにこちらのコードが書いた固定の文言で、
 * Meta の応答から入り込む経路が無い。それでも念のため、英小文字と `_` だけの形に限る。
 */
export function instagramUrlCode(code: string | null | undefined): string {
  return typeof code === 'string' && /^[a-z]+(?:_[a-z]+)*$/.test(code)
    ? code
    : OTHER;
}
/**
 * 許可された権限の名前を戻り先URLへ載せてよい形だけに絞る。
 *
 * 名前は Instagram の応答（合鍵の引き換えで返る `permissions`）由来なので、
 * 知っている権限名の一覧に載っている名前だけを通す。形で見分けるやり方は使わない
 * （`META_ERROR_TYPES` と同じ理由）。
 * 一覧に無い名前は中身を出さず、`other2` のように件数だけを添える。
 */
export function instagramUrlScopes(
  scopes: string | null | undefined,
): string | null {
  if (typeof scopes !== 'string' || scopes === '') return null;
  const known: string[] = [];
  let others = 0;
  for (const s of scopes.split(',')) {
    if (s === '') continue;
    if ((INSTAGRAM_KNOWN_SCOPES as readonly string[]).includes(s)) {
      if (!known.includes(s)) known.push(s);
    } else others++;
  }
  if (others) known.push(`${OTHER}${others}`);
  return known.length ? known.join(',') : null;
}
export type InstagramConfig = {
  /** Instagram アプリID。Facebook アプリIDとは別の番号で、Instagram のログイン設定にある。 */
  appId: string;
  /** Instagram アプリシークレット。 */
  appSecret: string;
  redirectUri: string;
  version: string;
  encryptionKey: string;
};
export function instagramConfig(env: Env['Bindings']): InstagramConfig | null {
  const {
    INSTAGRAM_APP_ID: appId,
    INSTAGRAM_APP_SECRET: appSecret,
    META_REDIRECT_URI: redirectUri,
    META_GRAPH_API_VERSION: version,
    META_TOKEN_ENCRYPTION_KEY: encryptionKey,
  } = env;
  if (
    !appId ||
    !appSecret ||
    !redirectUri ||
    !version ||
    !encryptionKey ||
    !/^v\d+\.\d+$/.test(version)
  )
    return null;
  try {
    const key = encryptionKey.trim().replace(/-/g, '+').replace(/_/g, '/');
    if (atob(key.padEnd(Math.ceil(key.length / 4) * 4, '=')).length !== 32)
      return null;
    const u = new URL(redirectUri);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      return null;
  } catch {
    return null;
  }
  return { appId, appSecret, redirectUri, version, encryptionKey };
}
export async function instagramHash(s: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(s),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
/**
 * 要求の宛先。Instagram直接ログイン方式では入口を3つ使い分ける。
 *
 * - `graph` … `graph.instagram.com/<版>/<path>`（プロフィール・投稿・同時投稿）
 * - `graph_root` … `graph.instagram.com/<path>`（長期の合鍵への交換と更新。版を付けない）
 * - `api_root` … `api.instagram.com/<path>`（認可コードの引き換え。版を付けない）
 */
export type InstagramHost = 'graph' | 'graph_root' | 'api_root';
export async function instagramGraph<T>(
  config: InstagramConfig,
  path: string,
  token: string | null,
  query: Record<string, string> = {},
  method = 'GET',
  host: InstagramHost = 'graph',
): Promise<T> {
  const origin =
    host === 'api_root'
      ? 'https://api.instagram.com'
      : 'https://graph.instagram.com';
  const url = new URL(
    `${origin}/${host === 'graph' ? `${config.version}/` : ''}${path}`,
  );
  // 手がかりに出す宛先。こちらが書いた固定の文字列だけで、秘密値も上流の値も含まない。
  const step = `${method} ${
    host === 'graph' ? config.version : host === 'api_root' ? 'api' : 'graph'
  }/${path}`;
  // 認可コードの引き換えだけは、アプリシークレットと認可コードをURLへ載せないため本文で送る。
  const body =
    host === 'api_root' && method === 'POST' ? new URLSearchParams(query) : null;
  if (!body)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      // Workers の実行環境は転送の扱いに `follow` と `manual` しか受け付けず、
      // `error` を渡すと**通信する前に** TypeError で弾かれる（転送が起きたかに関係ない）。
      // そのため Meta への要求が1本も出ず、接続が必ず失敗していた。
      // `manual` は転送を追わないので、合鍵や認可コードを別の宛先へ渡さない点は同じ。
      // 受け取った転送応答は下で失敗として扱う。
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    // 応答が返らなかった場合。どの要求で止まったかと呼び名だけを残す。
    // これが無いと「つながらなかった」ことしか分からず、時間切れと接続不可を見分けられない。
    throw new InstagramError(
      'meta_unavailable',
      502,
      `${step} fetch=${fetchErrorName(e)}`,
    );
  }
  // 転送応答は追わない。追えば合鍵・アプリシークレット・認可コードを
  // Meta 以外の宛先へ渡してしまうため、ここで失敗にする。
  // 転送先（`Location`）は手がかりに出さない。渡した値がそのまま入っている場合があるため。
  if (isRedirectResponse(response))
    throw new InstagramError(
      'meta_request_failed',
      502,
      `${step} redirect=${response.status}`,
    );
  if (!response.ok)
    throw new InstagramError(
      response.status === 401 || response.status === 403
        ? 'meta_authorization_failed'
        : 'meta_request_failed',
      502,
      `${step} ${await metaErrorDetail(response)}`,
    );
  return response.json() as Promise<T>;
}
/**
 * 認可コードの引き換えで返る中身。
 *
 * 手引きの例では `permissions` はカンマ区切りの文字列だが、実際には一覧（配列）で返ることが
 * あり、名前が `scopes` になっている場合もある。どちらで来ても読めるようにしておく。
 */
type InstagramShortTokenBody = {
  access_token?: string;
  user_id?: string | number;
  permissions?: unknown;
  scopes?: unknown;
};
/**
 * 許可された権限の名前を取り出す。
 *
 * カンマ区切りの文字列でも一覧でも読む。ここで読み落とすと、実際には許可されていても
 * 「同時投稿の許可が無い」と判定して接続が必ず失敗するため、形の違いで落とさない。
 * 中身の正しさ（知っている権限名かどうか）は、記録とURLへ出す直前に
 * `instagramUrlScopes` が別途絞るので、ここでは空でない文字列だけに限る。
 */
function instagramGrantedScopes(body: InstagramShortTokenBody): string[] {
  const raw = body.permissions ?? body.scopes;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const scopes: string[] = [];
  for (const s of list) {
    if (typeof s !== 'string') continue;
    const name = s.trim();
    if (name !== '' && !scopes.includes(name)) scopes.push(name);
  }
  return scopes;
}
/**
 * 認可コードを短期の合鍵へ引き換える。
 *
 * 入口は `api.instagram.com/oauth/access_token`（版を付けない）で、
 * アプリシークレットと認可コードをURLへ載せないため本文で送る。
 * 応答は `data` の1件目に合鍵・Instagram の利用者ID・許可された権限が入る。
 * Facebook ページを一切見ないので、ページがつながっていない
 * プロアカウントでもそのまま接続できる。
 */
export async function instagramShortToken(
  config: InstagramConfig,
  code: string,
): Promise<{
  token: string;
  /** 投稿に使う Instagram の利用者ID。形がおかしければ空文字にしてプロフィール側で拾う。 */
  userId: string;
  /** 利用者が実際に許可した範囲。公開に必要な許可が無ければ同時投稿はできない。 */
  scopes: string[];
}> {
  const r = await instagramGraph<{
    data?: Array<InstagramShortTokenBody>;
  } & InstagramShortTokenBody>(
    config,
    'oauth/access_token',
    null,
    {
      client_id: config.appId,
      client_secret: config.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
      code,
    },
    'POST',
    'api_root',
  );
  // 応答の形が「1件の配列」から「素の物」へ変わっても読めるようにしておく。
  const d = Array.isArray(r.data) ? (r.data[0] ?? {}) : r;
  if (typeof d.access_token !== 'string' || d.access_token === '')
    throw new InstagramError('invalid_meta_token');
  // Meta can return a numeric user_id larger than Number.MAX_SAFE_INTEGER.
  // Converting that parsed number to a string would save a rounded, unusable ID.
  const userId =
    typeof d.user_id === 'string'
      ? d.user_id
      : typeof d.user_id === 'number' && Number.isSafeInteger(d.user_id)
        ? String(d.user_id)
        : '';
  const scopes = instagramGrantedScopes(d);
  return {
    token: d.access_token,
    userId: /^\d{1,24}$/.test(userId) ? userId : '',
    // 公式ドキュメント上、成功した引き換え応答には許可名（permissions）が必ず入る前提になっている。
    // 読めなかった場合に「要求した許可で接続済み」とみなすと、実際には許可されていない接続まで
    // 通してしまう（受入条件「許可されていなければ失敗として残す」に反する）。認可URLには
    // force_reauth を付けて毎回フルの同意画面を強制しているので、読めない＝応答の形が想定外、
    // として空のまま返し、呼び出し側の許可チェックで失敗させる。
    scopes,
  };
}
/** 長期（60日）の合鍵とその期限。 */
export type InstagramLongToken = {
  token: string;
  expiresAt: string;
  /**
   * Instagram直接ログインには合鍵の期限とは別枠の「データ参照の期限」が無いため常に null。
   * 画面と期限切れの判定は null を許す作りのままで動く。
   */
  dataAccessExpiresAt: null;
};
async function instagramTokenExchange(
  config: InstagramConfig,
  path: 'access_token' | 'refresh_access_token',
  query: Record<string, string>,
): Promise<InstagramLongToken> {
  const r = await instagramGraph<{
    access_token?: string;
    expires_in?: number;
  }>(config, path, null, query, 'GET', 'graph_root');
  if (typeof r.access_token !== 'string' || r.access_token === '')
    throw new InstagramError('invalid_meta_token');
  const expires = r.expires_in
    ? Math.floor(Date.now() / 1000) + r.expires_in
    : 0;
  if (!expires || expires <= Date.now() / 1000)
    throw new InstagramError('meta_token_expired', 409);
  return {
    token: r.access_token,
    expiresAt: new Date(expires * 1000).toISOString(),
    dataAccessExpiresAt: null,
  };
}
/** 短期の合鍵を長期（60日）の合鍵へ交換する。サーバー側でしか呼べない。 */
export async function instagramLongToken(
  config: InstagramConfig,
  token: string,
): Promise<InstagramLongToken> {
  return instagramTokenExchange(config, 'access_token', {
    grant_type: 'ig_exchange_token',
    client_secret: config.appSecret,
    access_token: token,
  });
}
/**
 * 長期の合鍵の期限を延ばす。発行から24時間以上たっていて、まだ切れていないものだけ。
 * 60日間延ばさなかった合鍵は切れてしまい、延ばせない（再接続が必要）。
 */
export async function instagramRefreshToken(
  config: InstagramConfig,
  token: string,
): Promise<InstagramLongToken> {
  return instagramTokenExchange(config, 'refresh_access_token', {
    grant_type: 'ig_refresh_token',
    access_token: token,
  });
}
/**
 * 接続のときに要求する権限の一覧（認可画面へ渡す順そのまま）。
 *
 * Instagram直接ログイン方式の権限名で、Facebook ページ向けの `pages_*` は使わない。
 * 用途に入っていない権限を混ぜると認可画面そのものが断られるため、
 * 同時投稿と DM に必要な権限を要求する。
 */
export const INSTAGRAM_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_messages',
] as const;
/**
 * 戻り先URLへ載せてよい権限名の許可一覧。
 * 要求していない権限が付いて返ってきたときも名前で分かるように、
 * この方式で使われる権限名をまとめて載せる。
 */
export const INSTAGRAM_KNOWN_SCOPES = [
  ...INSTAGRAM_SCOPES,
  'instagram_business_manage_comments',
] as const;
/** 同時投稿に必要な許可。足りない接続は画面で「認可が切れています」にして再接続へ誘導する。 */
export const INSTAGRAM_PUBLISH_SCOPE = 'instagram_business_content_publish';
export function instagramCanPublish(scopes: string): boolean {
  return scopes.split(',').includes(INSTAGRAM_PUBLISH_SCOPE);
}
export async function subscribeInstagramMessages(config: InstagramConfig, token: string, metaAppId?: string): Promise<{ echoSubscribed: boolean }> {
  const path = 'me/subscribed_apps';
  let fields: string[];
  try {
    const current = await instagramGraph<{ data: { id: string; subscribed_fields: string[] }[]; paging?: { next?: string } }>(
      config, path, token, { fields: 'id,subscribed_fields' });
    if (!Array.isArray(current.data)) throw new Error('invalid_subscription_list');
    const own = current.data.find(app => app.id === config.appId || app.id === metaAppId);
    if (own && !Array.isArray(own.subscribed_fields)) throw new Error('invalid_fields');
    if (!own && current.paging?.next) throw new Error('subscription_list_incomplete');
    fields = own?.subscribed_fields ?? [];
    if (!fields.includes('messages')) {
      const result = await instagramGraph<{ success: boolean }>(config, path, token, {
        subscribed_fields: [...new Set([...fields, 'messages'])].join(','),
      }, 'POST');
      if (result.success !== true) throw new Error('subscription_rejected');
      fields = [...fields, 'messages'];
    }
  } catch (error) {
    throw new InstagramError('instagram_webhook_subscription_failed', 502, error instanceof InstagramError ? error.detail : undefined);
  }
  if (fields.includes('message_echoes')) return { echoSubscribed: true };
  try {
    const result = await instagramGraph<{ success: boolean }>(config, path, token, {
      subscribed_fields: [...new Set([...fields, 'message_echoes'])].join(','),
    }, 'POST');
    return { echoSubscribed: result.success === true };
  } catch {
    return { echoSubscribed: false };
  }
}

export function instagramCanMessage(scopes: string): boolean {
  return scopes.split(',').includes('instagram_business_manage_messages');
}
/**
 * 写真つき投稿を Instagram へ出す（GB-4 の同時投稿）。
 * Meta は画像を自分で取りに来るため imageUrl は公開URLでなければならない。
 * コンテナを作ってから公開する2段で、1段目で落ちたときは公開していない。
 */
export async function instagramPublish(
  config: InstagramConfig,
  instagramId: string,
  pageToken: string,
  input: { imageUrl: string; caption: string },
): Promise<{ mediaId: string; permalink: string | null }> {
  const container = await instagramGraph<{ id?: string }>(
    config,
    `${instagramId}/media`,
    pageToken,
    { image_url: input.imageUrl, caption: input.caption },
    'POST',
  );
  if (!container.id) throw new InstagramError('meta_request_failed');
  const published = await instagramGraph<{ id?: string }>(
    config,
    `${instagramId}/media_publish`,
    pageToken,
    { creation_id: container.id },
    'POST',
  );
  if (!published.id) throw new InstagramError('meta_request_failed');
  // 投稿自体は済んでいるので、見に行く先の取得だけ失敗しても成功として扱う。
  let permalink: string | null = null;
  try {
    const detail = await instagramGraph<{ permalink?: string }>(
      config,
      published.id,
      pageToken,
      { fields: 'permalink' },
    );
    permalink = detail.permalink ?? null;
  } catch {
    permalink = null;
  }
  return { mediaId: published.id, permalink };
}
/** Instagram は JPEG しか受け取らないうえ、容量は8MBまで。 */
const INSTAGRAM_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * 登録メディアの画像を Instagram が取りに来られる JPEG の公開URLにする。
 * JPEG でも投稿可能な縦横比（4:5〜1.91:1）や最大幅を外れた場合は、
 * 写真を切らずに余白を足して変換する。PNG も JPEG に変換して置き直す。
 * 元ファイルは読むだけで、変換結果は別のキーに入れる。
 */
export async function instagramImageUrl(
  env: Env['Bindings'],
  input: { r2Key: string; sourceUrl: string; origin: string },
): Promise<string> {
  const object = await env.IMAGES.get(input.r2Key);
  if (!object) throw new InstagramError('instagram_image_unavailable', 422);
  const bytes = new Uint8Array(await object.arrayBuffer());
  const meta = detectImageMeta(bytes);
  if (!meta) throw new InstagramError('instagram_image_unsupported', 422);
  if (meta.format === 'jpeg' && bytes.byteLength > INSTAGRAM_IMAGE_MAX_BYTES)
    throw new InstagramError('instagram_image_too_large', 422);
  if (meta.width < 1 || meta.height < 1)
    throw new InstagramError('instagram_image_unsupported', 422);
  const ratio = meta.width / meta.height;
  const needsPadding = ratio < 0.8 || ratio > 1.91;
  if (meta.format === 'jpeg' && !needsPadding && meta.width <= 1440)
    return input.sourceUrl;
  if (!env.CF_IMAGES) throw new InstagramError('instagram_images_unconfigured', 503);
  const width = Math.min(meta.width, 1440);
  const transform = needsPadding
    ? {
        width,
        height: ratio < 0.8 ? Math.floor(width / 0.8) : Math.ceil(width / 1.91),
        fit: 'pad' as const,
        background: 'white',
      }
    : { width };
  const output = await env.CF_IMAGES.input(new Blob([bytes]).stream())
    .transform(transform)
    .output({ format: 'image/jpeg' });
  const converted = await new Response(output.image()).arrayBuffer();
  if (!converted.byteLength || converted.byteLength > INSTAGRAM_IMAGE_MAX_BYTES)
    throw new InstagramError('instagram_image_too_large', 422);
  const key = `instagram-jpeg/${crypto.randomUUID()}.jpg`;
  await env.IMAGES.put(key, converted, {
    httpMetadata: { contentType: 'image/jpeg' },
  });
  return `${input.origin.replace(/\/+$/, '')}/images/${key}`;
}
export {
  encryptCredential as encryptInstagramCredential,
  decryptCredential as decryptInstagramCredential,
};
export async function verifyInstagramSignature(
  raw: string,
  header: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!header || !/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const sig = Uint8Array.from(header.slice(7).match(/../g)!, (p) =>
    parseInt(p, 16),
  );
  return crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(raw));
}
export async function purgeInstagramTransientData(
  db: D1Database,
  now = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - 90 * 86400000).toISOString();
  await db.batch([
    db
      .prepare('DELETE FROM instagram_oauth_states WHERE expires_at<=?')
      .bind(now.toISOString()),
    db
      .prepare('DELETE FROM instagram_messages WHERE created_at<?')
      .bind(cutoff),
    db.prepare('DELETE FROM instagram_outbound_messages WHERE created_at<?').bind(cutoff),
    db.prepare('DELETE FROM instagram_inbox_reads WHERE last_read_at<?').bind(cutoff),
  ]);
}
