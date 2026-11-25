import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context, MiddlewareHandler } from 'hono';
import type { ApiFieldErrors } from '@line-crm/shared';

/** JSONの鍵を使う。欄を特定できない本文全体の誤りは fields を空にする。 */
export function inputError<T extends Record<string, unknown>>(
  c: Context,
  payload: T,
  status: ContentfulStatusCode,
  keys: readonly string[] = [],
  validationReason?: string,
) {
  if (!['POST', 'PUT', 'PATCH'].includes(c.req.method) || (status !== 400 && status !== 422)) return c.json(payload, status);
  const legacyError = typeof payload.error === 'string' ? payload.error : '入力内容を確認してください';
  const isCode = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(legacyError);
  const error = isCode ? inputErrorMessage(legacyError) : legacyError;
  const explicitFields = typeof payload.field === 'string'
    || (payload.fields && typeof payload.fields === 'object' && !Array.isArray(payload.fields))
    || (payload.errors && typeof payload.errors === 'object' && !Array.isArray(payload.errors));
  // 必須欄が複数ある検査でも、すでに入っている欄は赤にしない。
  const body = c.get('validatedInputBody') as Record<string, unknown> | undefined;
  // failで文言を言い換えた場合も、必須欄の判定には元の理由を使う。
  const missingKeys = body && /required|必須/i.test(validationReason ?? legacyError)
    ? keys.filter(key => body[key] === undefined || body[key] === null || body[key] === '')
    : [];
  const affectedKeys = missingKeys.length ? missingKeys : keys;
  const fields: ApiFieldErrors = Object.fromEntries((explicitFields ? [] : affectedKeys).map(key => [key, error]));
  if (typeof payload.field === 'string') fields[payload.field] = error;
  if (payload.errors && typeof payload.errors === 'object' && !Array.isArray(payload.errors)) {
    for (const [key, reason] of Object.entries(payload.errors)) {
      if (typeof reason === 'string') fields[key] = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(reason) ? inputErrorMessage(reason) : reason;
    }
  }
  if (payload.fields && typeof payload.fields === 'object' && !Array.isArray(payload.fields)) {
    for (const [key, reason] of Object.entries(payload.fields)) {
      if (typeof reason === 'string') fields[key] = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(reason) ? inputErrorMessage(reason) : reason;
    }
  }
  return c.json({ ...payload, ...(isCode && payload.code === undefined ? { code: legacyError } : {}), error, fields }, status);
}

/** パーサー例外が各ルートの500に飲み込まれる前に、壊れたJSONを400にする。 */
export function inputJsonBoundary(shape: InputShape = {}, options: { maxBytes?: number; tooLarge?: { error: string; code?: string } } = {}): MiddlewareHandler {
  return async (c, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(c.req.method)
      && (c.req.raw.body !== null || options.maxBytes !== undefined)
      && !/\/(receive|webhook|callback|ingest)(?:\/|$)|^\/api\/integrations\/(eccube|ai-loop|codex-slack|slack|stripe)(?:\/|$)/.test(c.req.path)
      && (options.maxBytes !== undefined || /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(c.req.header('content-type') ?? ''))) {
      try {
        // 上限のある口では clone へ全文を貯めず、元のストリームを上限まで読む。
        // 上限内の本文だけを後続の Hono json/text に渡す。
        let body: unknown;
        if (options.maxBytes !== undefined) {
          const text = await readBoundedText(c.req.raw, options.maxBytes);
          if (text === null) return c.json({ success: false, ...(options.tooLarge ?? { error: '送信内容が大きすぎます' }) }, 413);
          c.req.raw = new Request(c.req.raw, { body: text || '{}' });
          body = text === '' ? {} : JSON.parse(text);
        } else {
          body = await c.req.raw.clone().json();
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return inputError(c, { success: false, error: '入力内容はJSONのオブジェクトで指定してください' }, 400);
        }
        c.set('validatedInputBody', body);
        const fields = inputShapeErrors(body as Record<string, unknown>, shape);
        if (Object.keys(fields).length) return inputError(c, { success: false, error: '入力内容の形式を確認してください', fields }, 400);
      } catch {
        return inputError(c, { success: false, code: 'INVALID_JSON', error: '送信内容のJSONが正しくありません' }, 400);
      }
    }
    await next();
  };
}

/**
 * inputJsonBoundary が読んで検査し終えた本文。
 * この口を通ったルートが本文を使うときは、自分で読み直さずこれを使う。
 * 読み直すと clone で分けた同じ本文を二度読むことになり、
 * 中身は正しいのに読み取りの失敗で 400 になる余地が残る。
 * この口を通らない（本文が無い・JSON以外・除外パス）場合は undefined。
 */
export function validatedInputBody(c: Context): Record<string, unknown> | undefined {
  return c.get('validatedInputBody') as Record<string, unknown> | undefined;
}

/** 宣言値でも実バイト数でも止める。超過時は残りを読まず、本文を保持しない。 */
export async function readBoundedText(request: Pick<Request, 'headers' | 'body'>, maxBytes: number): Promise<string | null> {
  const bytes = await readBoundedBytes(request, maxBytes);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/** 巨大なアップロードをすべてメモリへ置かないよう、許可したバイト数だけを読む。 */
export async function readBoundedBytes(request: Pick<Request, 'headers' | 'body'>, maxBytes: number): Promise<Uint8Array | null> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    for (const part of contentLength.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const declared = Number(trimmed);
      if (Number.isFinite(declared) && declared > maxBytes) return null;
    }
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // cancel の完了を待つと tee 済みの本文で停滞することがある。
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export type InputKind = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

/** 解析・復号より前に、バイナリと JSON/base64 のサイズを制限する。 */
export function boundedUploadBody(maxBinaryBytes: number): MiddlewareHandler {
  return async (c, next) => {
    const json = /^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '');
    const max = json ? Math.ceil(maxBinaryBytes / 3) * 4 + 4096 : maxBinaryBytes;
    const bytes = await readBoundedBytes(c.req.raw, max);
    if (bytes === null) return c.json({ success: false, code: 'upload_too_large', error: 'ファイルが大きすぎます' }, 413);
    c.req.raw = new Request(c.req.raw, { body: bytes });
    await next();
  };
}
export type InputShape = Record<string, readonly InputKind[]>;

/** 型の違う値を .trim 等へ渡して500にしない。必須・範囲・相関の検証は各ルートで行う。 */
export function inputShapeErrors(body: Record<string, unknown>, shape: InputShape): ApiFieldErrors {
  const fields: ApiFieldErrors = {};
  for (const [key, kinds] of Object.entries(shape)) {
    if (!(key in body) || body[key] === undefined) continue;
    const value = body[key];
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!kinds.includes(kind as InputKind)) fields[key] = '入力内容の形式を確認してください';
  }
  return fields;
}

/** 旧来の error に入っていた機械コードは code に残し、本文は人向けの文にする。 */
export function inputErrorMessage(code: string, fallback = '入力内容を確認してください'): string {
  const messages: Record<string, string> = {
    INVALID_INPUT: '入力内容の形式を確認してください',
    INVALID_FOLDER_KIND: 'フォルダの種類を確認してください',
    INVALID_FOLDER_NAME: 'フォルダ名は1〜100文字で入力してください',
    INVALID_FOLDER_COLOR: 'フォルダの色を確認してください',
    INVALID_FOLDER_ORDER: '入れ替えるフォルダと版の番号を確認してください',
    INVALID_REVISION: '読み込んだ版の番号を指定してください',
    INVALID_FOLDER: '利用できるフォルダを選んでください',
    account_required: 'LINE公式アカウントを選んでください',
    missing_account_id: 'LINE公式アカウントを選んでください',
    account_id_required: 'LINE公式アカウントを選んでください',
    invalid_starts_at: '開始日時の形式を確認してください',
    past_datetime: '日時は現在より先を指定してください',
    slot_not_available: '選んだ日時では予約できません。別の日時を選んでください',
    invalid_auto_tag_id: '予約時に付けるタグの指定を確認してください',
    tag_not_found: '利用できるタグを選んでください',
    menu_not_offered: '受付中の予約メニューを選んでください',
    missing_lock_version: '読み込んだ版の番号を指定してください',
    invalid_time: '時刻の形式を確認してください',
    invalid_hour_before: 'お知らせを送る時間を確認してください',
    invalid_duration_seconds: '視聴時間は0より大きい秒数で指定してください',
    invalid_json: '送信内容のJSONが正しくありません',
    break_overlap: '休憩時間が重ならないように指定してください',
    break_outside_working_hours: '休憩時間は勤務時間の中で指定してください',
    invalid_time_range: '開始と終了の時刻を確認してください',
    invalid_params: '入力内容の形式を確認してください',
    missing_params: '必要な項目を入力してください',
    missing_idempotency_key: '操作を確認するキーがありません。画面を開き直してください',
    line_notification_unavailable: 'LINE連携済みの予約だけLINE通知を送れます',
    invalid_duration: '視聴時間は0より大きい秒数で指定してください',
    invalid_version: '読み込んだ版の番号を指定してください',
    scheduled_at_invalid: '配信日時の形式を確認してください',
    title_required: 'タイトルを入力してください',
    title_invalid: 'タイトルの長さと形式を確認してください',
    invalid_slug: 'ページの識別名は使用できる文字で指定してください',
    invalid_settings: '設定内容を確認してください',
    invalid_comment: 'コメントの時刻、名前、本文を確認してください',
    invalid_cta: '案内ボタンの内容を確認してください',
    invalid_url: 'リンク先のURLを確認してください',
    video_media_not_video: '動画ファイルを選んでください',
    video_media_not_found: 'このアカウントで利用できる動画を選んでください',
    ambiguous_video_source: '動画の指定方法は1つにしてください',
    dst_gap: '夏時間への切り替えで存在しない時刻です。別の時刻を選んでください',
  };
  return Object.hasOwn(messages, code) ? messages[code]! : fallback;
}

/** フォルダの口で使うJSONの鍵を、DB側の共通エラーへ対応させる。 */
export function folderInputError(
  c: Context,
  failure: { code: string; status: ContentfulStatusCode },
  versionKeys: readonly [string, string] = ['expectedRevision', 'withExpectedRevision'],
) {
  const keys: Record<string, string[]> = {
    INVALID_INPUT: [], INVALID_FOLDER_KIND: ['kind'], INVALID_FOLDER_NAME: ['name'],
    INVALID_FOLDER_COLOR: ['color'], INVALID_REVISION: [versionKeys[0]], INVALID_FOLDER: ['folderId'],
  };
  let affected = keys[failure.code] ?? [];
  if (failure.code === 'INVALID_FOLDER_ORDER') {
    const body = c.get('validatedInputBody') as Record<string, unknown> | undefined;
    affected = body ? [
      ...(typeof body.withId !== 'string' || !body.withId || body.withId === c.req.param('id') ? ['withId'] : []),
      ...versionKeys.filter(key => !Number.isSafeInteger(body[key])),
    ] : ['withId', ...versionKeys];
    if (!affected.length) affected = ['withId'];
  }
  return inputError(c, { success: false, error: failure.code }, failure.status, affected);
}
