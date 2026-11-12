import { tracedFetch as fetch } from '@line-crm/shared/server';
import { jstNow } from '@line-crm/db';
import { isFinalMediaKey } from './media-upload-storage.js';
import { imageDimensions } from '../features/media/media-metadata/index.js';
import { allowedFileScanEndpoint, isFileScanSecretRef } from '../lib/file-scan-policy.js';
import { UNLOCKED_SCAN_SQL } from './file-deletion-lock.js';

/*
 * 危険なファイルの検査。
 *
 * 上げる口（メディア・写真の投稿・フォームの添付・友だち属性の画像/PDF）で
 * 保存の前後にこの検査を通す。状態は pending → clean / rejected / quarantined。
 * clean になるまで配信・公開・審査・LIFF に出さない。検査が動かない時は
 * pending のまま置き、自動で再試行する。clean に格上げはしない。
 */

export type FileScanStatus = 'pending' | 'clean' | 'rejected' | 'quarantined';

export type FileScanSubjectKind =
  | 'media' | 'media_version' | 'upload_session' | 'photo'
  | 'form_file' | 'broadcast_asset' | 'generic_image';

export interface FileScanRow {
  id: string;
  confirmation_revision?: number;
  line_account_id: string;
  subject_kind: FileScanSubjectKind;
  subject_id: string;
  media_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  status: FileScanStatus;
  reason_code: string | null;
  reason_detail: string | null;
  attempts: number;
  next_retry_at: string | null;
  scanned_at: string | null;
  quarantined_at: string | null;
  released_at: string | null;
  release_reason: string | null;
  released_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FileScanConfig {
  line_account_id: string;
  confirmation_revision?: number;
  external_provider: string | null;
  external_endpoint_url: string | null;
  external_secret_ref: string | null;
  external_timeout_ms: number;
  max_bytes_override: number | null;
  max_pixels_override: number | null;
  stopped_notified_at: string | null;
  updated_by: string | null;
  updated_at: string;
}

/** 理由コードは画面にそのまま出す。利用者の言葉で短く。 */
export const FILE_SCAN_REASON_LABELS: Record<string, string> = {
  signature_mismatch: '中身が画像ではありませんでした',
  format_not_allowed: '使えない形式です',
  too_large: '大きすぎます',
  unreadable: '読み取れませんでした',
  trailing_data: '画像の後ろに別のデータがあります',
  pdf_active_content: '危険な仕掛けが見つかりました',
  office_macro: 'マクロが見つかりました',
  executable_signature: '実行ファイルの印があります',
  external_flagged: '外部の検査で問題が見つかりました',
  scan_attempts_exhausted: '検査が終わらなかったため、使えません',
  scan_unavailable: '検査が止まっています',
};

export interface BuiltinScanInput {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  /**
   * ファイルの末尾（R2 の range で取った最後の 64KB など）。
   * 大きいファイルは先頭だけでは後ろの余計なデータを見られないため、
   * ある時は末尾の検査にこちらを使う。無い時は先頭バイト全体で見る。
   */
  tail?: Uint8Array | null;
}

/** 先頭 256KB＋末尾 64KB。R2 の range 読みでまかなえる量。 */
export const FILE_SCAN_HEAD_BYTES = 256 * 1024;
export const FILE_SCAN_TAIL_BYTES = 64 * 1024;

export type BuiltinScanVerdict =
  | { verdict: 'clean' }
  | { verdict: 'rejected' | 'quarantined'; reasonCode: string; detail: string };

const ALLOWED_MIME: Record<string, { ext: string[]; maxBytes: number }> = {
  'image/jpeg': { ext: ['jpg', 'jpeg'], maxBytes: 10 * 1024 * 1024 },
  'image/png': { ext: ['png'], maxBytes: 10 * 1024 * 1024 },
  'image/gif': { ext: ['gif'], maxBytes: 10 * 1024 * 1024 },
  'image/webp': { ext: ['webp'], maxBytes: 10 * 1024 * 1024 },
  'image/heic': { ext: ['heic'], maxBytes: 10 * 1024 * 1024 },
  'image/heif': { ext: ['heif'], maxBytes: 10 * 1024 * 1024 },
  'video/mp4': { ext: ['mp4'], maxBytes: 200 * 1024 * 1024 },
  'audio/mpeg': { ext: ['mp3'], maxBytes: 200 * 1024 * 1024 },
  'audio/mp4': { ext: ['m4a'], maxBytes: 200 * 1024 * 1024 },
  'application/pdf': { ext: ['pdf'], maxBytes: 20 * 1024 * 1024 },
};

const MAX_PIXELS_SIDE = 20000;

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function asciiAt(bytes: Uint8Array, start: number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(bytes[start + i] ?? 0);
  return text;
}

function hasSignature(bytes: Uint8Array, mimeType: string): boolean {
  switch (mimeType) {
    case 'image/png':
      return bytes.length >= 8
        && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v);
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif':
      return asciiAt(bytes, 0, 6) === 'GIF87a' || asciiAt(bytes, 0, 6) === 'GIF89a';
    case 'image/webp':
      return asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP';
    case 'image/heic':
    case 'image/heif': {
      // ftyp のブランドで見る。iPhone の既定形式。
      if (bytes.length < 12 || asciiAt(bytes, 4, 4) !== 'ftyp') return false;
      const brand = asciiAt(bytes, 8, 4);
      return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand);
    }
    case 'video/mp4':
    case 'audio/mp4':
      return bytes.length >= 12 && asciiAt(bytes, 4, 4) === 'ftyp';
    case 'audio/mpeg':
      return asciiAt(bytes, 0, 3) === 'ID3'
        || (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0);
    case 'application/pdf':
      return asciiAt(bytes, 0, 5) === '%PDF-';
    default:
      return false;
  }
}

function findBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1;
  outer: for (let i = from; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function endBytes(head: Uint8Array, tail: Uint8Array | null | undefined): Uint8Array {
  return tail && tail.length > 0 ? tail : head;
}

function pngTrailingData(head: Uint8Array, tail: Uint8Array | null | undefined): boolean {
  const iend = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  const end = endBytes(head, tail);
  const at = findBytes(end, Uint8Array.from(iend));
  // 末尾の IEND より後ろに何かあればしまう。小さいファイルは先頭全体が末尾。
  if (at >= 0) return at + iend.length < end.length;
  // IEND が末尾 64KB に無い＝壊れているか、後ろに大量の別データ。後者は tail の
  // 先頭が別データの途中になる。どちらも「読めるか」で落とすためここでは通す。
  return false;
}

function jpegTrailingData(head: Uint8Array, tail: Uint8Array | null | undefined): boolean {
  // EOI (FF D9) の後ろに余計なデータがあればしまう。
  // 最後の EOI より後ろを見る。末尾がある時は末尾だけを見る。
  const end = endBytes(head, tail);
  let last = -1;
  for (let i = 0; i + 1 < end.length; i += 1) {
    if (end[i] === 0xff && end[i + 1] === 0xd9) last = i;
  }
  return last >= 0 && last + 2 < end.length;
}

function gifTrailingData(head: Uint8Array, tail: Uint8Array | null | undefined): boolean {
  // トレイラ 0x3B の後ろに1バイトでもあればしまう。
  const end = endBytes(head, tail);
  const at = end.lastIndexOf(0x3b);
  return at >= 0 && at + 1 < end.length;
}

function latin1(bytes: Uint8Array): string {
  // PDF / Office の検査は ASCII 範囲の印だけ見る。全文デコードはしない。
  const limit = Math.min(bytes.length, 4 * 1024 * 1024);
  let text = '';
  for (let i = 0; i < limit; i += 1) {
    const b = bytes[i] ?? 0;
    text += b < 128 ? String.fromCharCode(b) : '�';
  }
  return text;
}

function pdfThreat(head: Uint8Array, tail: Uint8Array | null | undefined): string | null {
  // 仕掛けは末尾の xref 以降に書かれることが多い。先頭＋末尾の両方を見る。
  const text = tail && tail.length > 0 ? `${latin1(head)}\n${latin1(tail)}` : latin1(head);
  if (/\/JavaScript|\/JS\b|\/EmbeddedFiles|\/EmbeddedFile|\/Launch|\/XFA\b/.test(text)) {
    return 'PDF の中に JavaScript・埋め込みファイル・起動の指示があります';
  }
  return null;
}

function officeMacroThreat(bytes: Uint8Array): string | null {
  // 旧形式 (OLE) の印。新形式 (OOXML) は zip の印。
  // 許可形式に Office は無いので、ここに来た時点で偽装か混入。拡張子は見ない。
  const isOle = bytes.length >= 8
    && [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((v, i) => bytes[i] === v);
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!isOle && !isZip) return null;
  const text = latin1(bytes);
  if (isOle || /vbaProject\.bin|Macros\/|activeX/i.test(text)) {
    return 'Office ファイルの中にマクロがあります';
  }
  return null;
}

/**
 * 内蔵の簡易検査。①形と拡張子・MIME の一致 ②許可形式 ③大きさ・画素の上限
 * ④読めるか（寸法を読めるか）⑤危険な中身、の順に見る。
 */
export function builtinFileScan(
  bytes: Uint8Array,
  input: BuiltinScanInput,
  overrides?: { maxBytes?: number | null; maxPixels?: number | null },
): BuiltinScanVerdict {
  const allowed = ALLOWED_MIME[input.mimeType];
  if (!allowed) {
    return { verdict: 'rejected', reasonCode: 'format_not_allowed', detail: '許可されていない形式です' };
  }
  // 実行ファイル・Office の印は形の一致より先にしまう。
  // 偽装拡張子の実行体・マクロ付き文書を「使えません」で逃がさない。
  if (
    (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a)
    || (bytes.length >= 4 && bytes[0] === 0x7f && asciiAt(bytes, 1, 3) === 'ELF')
  ) {
    return { verdict: 'quarantined', reasonCode: 'executable_signature', detail: '実行ファイルの印があります' };
  }
  const macro = officeMacroThreat(bytes);
  if (macro) return { verdict: 'quarantined', reasonCode: 'office_macro', detail: macro };
  const ext = extensionOf(input.filename);
  if (!allowed.ext.includes(ext) || !hasSignature(bytes, input.mimeType)) {
    return {
      verdict: 'rejected',
      reasonCode: 'signature_mismatch',
      detail: `名前は .${ext || '（拡張子なし）'} ですが、中身は別の形式です`,
    };
  }
  const maxBytes = overrides?.maxBytes ?? allowed.maxBytes;
  if (input.sizeBytes > maxBytes || bytes.byteLength > maxBytes) {
    return { verdict: 'rejected', reasonCode: 'too_large', detail: '上限の大きさを超えています' };
  }
  if (input.mimeType.startsWith('image/')) {
    const maxSide = overrides?.maxPixels ?? MAX_PIXELS_SIDE;
    if (
      (input.width != null && (input.width < 1 || input.width > maxSide))
      || (input.height != null && (input.height < 1 || input.height > maxSide))
    ) {
      return { verdict: 'rejected', reasonCode: 'too_large', detail: '画素の上限を超えています' };
    }
    // heic/heif は箱の構造が複雑で寸法を安く読めない。形の一致と脅威だけ見る。
    const dimsOptional = input.mimeType === 'image/heic' || input.mimeType === 'image/heif';
    if (!dimsOptional && (input.width == null || input.height == null)) {
      return { verdict: 'rejected', reasonCode: 'unreadable', detail: '画像の寸法を読めませんでした' };
    }
    if (input.mimeType === 'image/png' && pngTrailingData(bytes, input.tail)) {
      return { verdict: 'quarantined', reasonCode: 'trailing_data', detail: '画像の後ろに別のデータがあります' };
    }
    if (input.mimeType === 'image/jpeg' && jpegTrailingData(bytes, input.tail)) {
      return { verdict: 'quarantined', reasonCode: 'trailing_data', detail: '画像の後ろに別のデータがあります' };
    }
    if (input.mimeType === 'image/gif' && gifTrailingData(bytes, input.tail)) {
      return { verdict: 'quarantined', reasonCode: 'trailing_data', detail: '画像の後ろに別のデータがあります' };
    }
  }
  if (input.mimeType === 'application/pdf') {
    const threat = pdfThreat(bytes, input.tail);
    if (threat) return { verdict: 'quarantined', reasonCode: 'pdf_active_content', detail: threat };
  }
  return { verdict: 'clean' };
}

/**
 * 差し替えられる検査の口。外の検査サービスや別の判定器は
 * この形で足す。内蔵の簡易検査が既定。
 */
export interface ThreatScanner {
  readonly name: string;
  scan(
    bytes: Uint8Array,
    context: { filename: string; mimeType: string; sizeBytes: number },
  ): Promise<'clean' | 'quarantined'>;
}

export const FORM_FILE_SCAN_MAX_ATTEMPTS = 5;
export function isPrivateFormDocumentScan(scan: Pick<FileScanRow, 'subject_kind' | 'subject_id'>): boolean {
  return scan.subject_kind === 'form_file' && scan.subject_id.startsWith('private/form-documents/');
}
export class ScanRetryableError extends Error {}

export function nextFileScanRetryAt(attempts: number, nowMs: number): string {
  // 1分→5分→15分→1時間→6時間で頭打ち。pending のまま置き続ける。
  const delays = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
  const delay = delays[Math.min(Math.max(attempts, 0), delays.length - 1)] ?? 6 * 60 * 60_000;
  return new Date(nowMs + delay).toISOString();
}

type ScanDb = Pick<D1Database, 'prepare'>;

export async function createFileScan(
  db: ScanDb,
  input: {
    lineAccountId: string | null;
    subjectKind: FileScanSubjectKind;
    subjectId: string;
    mediaId?: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  },
): Promise<FileScanRow> {
  const now = jstNow();
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO media_file_scans
      (id, line_account_id, subject_kind, subject_id, media_id, filename, mime_type, size_bytes,
       status, attempts, next_retry_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  ).bind(
    id, input.lineAccountId, input.subjectKind, input.subjectId, input.mediaId ?? null,
    input.filename, input.mimeType, input.sizeBytes, now, now, now,
  ).run();
  const row = await db.prepare(`SELECT * FROM media_file_scans WHERE id = ?`).bind(id)
    .first<FileScanRow>();
  if (!row) throw new Error('file scan row is unavailable');
  return row;
}

export async function getFileScanBySubject(
  db: ScanDb,
  subjectKind: FileScanSubjectKind,
  subjectId: string,
): Promise<FileScanRow | null> {
  return db.prepare(
    `SELECT * FROM media_file_scans WHERE subject_kind = ? AND subject_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(subjectKind, subjectId).first<FileScanRow>();
}

export async function getLatestMediaScan(
  db: ScanDb,
  mediaId: string,
): Promise<FileScanRow | null> {
  return db.prepare(
    `SELECT * FROM media_file_scans WHERE media_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(mediaId).first<FileScanRow>();
}

/** clean の時だけ true。pending / rejected / quarantined / 行なしは使わせない。 */
export async function isMediaUsable(db: ScanDb, mediaId: string): Promise<boolean> {
  const row = await getLatestMediaScan(db, mediaId);
  return row?.status === 'clean';
}

export async function markFileScanClean(db: ScanDb, id: string): Promise<boolean> {
  const now = jstNow();
  const changed = await db.prepare(
    `UPDATE media_file_scans
        SET status = 'clean', confirmation_revision=confirmation_revision+1, reason_code = NULL, reason_detail = NULL,
            scanned_at = ?, next_retry_at = NULL, updated_at = ?
      WHERE id = ? AND ${UNLOCKED_SCAN_SQL}`,
  ).bind(now, now, id).run();
  return Number(changed.meta.changes ?? 0) === 1;
}

export async function markFileScanRejected(
  db: ScanDb, id: string, reasonCode: string, detail: string,
): Promise<void> {
  const now = jstNow();
  await db.prepare(
    `UPDATE media_file_scans
        SET status = 'rejected', confirmation_revision=confirmation_revision+1, reason_code = ?, reason_detail = ?,
            scanned_at = ?, next_retry_at = NULL, updated_at = ?
      WHERE id = ? AND ${UNLOCKED_SCAN_SQL}`,
  ).bind(reasonCode, detail, now, now, id).run();
}

export async function markFileScanQuarantined(
  db: ScanDb, id: string, reasonCode: string, detail: string,
): Promise<void> {
  const now = jstNow();
  await db.prepare(
    `UPDATE media_file_scans
        SET status = 'quarantined', confirmation_revision=confirmation_revision+1, reason_code = ?, reason_detail = ?,
            scanned_at = ?, quarantined_at = ?, next_retry_at = NULL, updated_at = ?
      WHERE id = ? AND status != 'quarantined' AND ${UNLOCKED_SCAN_SQL}`,
  ).bind(reasonCode, detail, now, now, now, id).run();
}

export async function markFileScanPendingRetry(db: ScanDb, id: string, attempts: number, maxAttempts?: number): Promise<FileScanStatus> {
  const now = jstNow();
  if (maxAttempts !== undefined && attempts + 1 >= maxAttempts) {
    await db.prepare(`UPDATE media_file_scans SET attempts = ?, confirmation_revision=confirmation_revision+1 WHERE id = ? AND ${UNLOCKED_SCAN_SQL}`).bind(attempts + 1, id).run();
    await markFileScanRejected(db, id, 'scan_attempts_exhausted', `検査を${maxAttempts}回試しても終わりませんでした`);
    return 'rejected';
  }
  await db.prepare(
    `UPDATE media_file_scans
        SET status = 'pending', confirmation_revision=confirmation_revision+1, attempts = ?, next_retry_at = ?, updated_at = ?
      WHERE id = ? AND ${UNLOCKED_SCAN_SQL}`,
  ).bind(attempts + 1, nextFileScanRetryAt(attempts, Date.now()), now, id).run();
  return 'pending';
}

/** 内蔵検査を回して行を進める。外の検査は呼び出し側が ThreatScanner で足す。 */
export async function runBuiltinScanAndStore(
  db: ScanDb,
  scan: FileScanRow,
  bytes: Uint8Array,
  input: BuiltinScanInput,
  overrides?: { maxBytes?: number | null; maxPixels?: number | null },
): Promise<FileScanRow> {
  const result = builtinFileScan(bytes, input, overrides);
  if (result.verdict === 'clean') {
    if (!await markFileScanClean(db, scan.id)) {
      return await db.prepare('SELECT * FROM media_file_scans WHERE id=?').bind(scan.id).first<FileScanRow>() ?? { ...scan, status: 'pending' };
    }
    return { ...scan, status: 'clean', scanned_at: jstNow() };
  }
  if (result.verdict === 'quarantined') {
    await markFileScanQuarantined(db, scan.id, result.reasonCode, result.detail);
    return { ...scan, status: 'quarantined', reason_code: result.reasonCode, reason_detail: result.detail };
  }
  await markFileScanRejected(db, scan.id, result.reasonCode, result.detail);
  return { ...scan, status: 'rejected', reason_code: result.reasonCode, reason_detail: result.detail };
}

/** R2 の実体。range 読みだけ使うので構造型で受ける。 */
export interface ScanObjectStore {
  get(
    key: string,
    options?: { range?: { offset: number; length?: number } | { suffix: number }; onlyIf?: { etagMatches: string } },
  ): Promise<{ etag?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null>;
}

async function readSlice(
  store: ScanObjectStore,
  key: string,
  range: { offset: number; length?: number } | { suffix: number },
  etag?: string,
): Promise<Uint8Array | null> {
  try {
    const obj = await store.get(key, { range, ...(etag ? { onlyIf: { etagMatches: etag } } : {}) });
    if (!obj?.arrayBuffer) return null;
    return new Uint8Array(await obj.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * R2 から先頭＋末尾だけ読んで内蔵検査を回す。読めなければ pending のまま
 * 置いて再試行に回す（clean に格上げしない）。
 */
export async function runScanForStoredObject(
  db: ScanDb,
  store: ScanObjectStore,
  scan: FileScanRow,
  r2Key: string,
  dims?: { width?: number | null; height?: number | null },
  overrides?: { maxBytes?: number | null; maxPixels?: number | null },
  etag?: string,
): Promise<FileScanRow> {
  const head = await readSlice(store, r2Key, { offset: 0, length: FILE_SCAN_HEAD_BYTES }, etag);
  if (!head || head.length === 0) {
    const status = await markFileScanPendingRetry(db, scan.id, scan.attempts, isPrivateFormDocumentScan(scan) ? FORM_FILE_SCAN_MAX_ATTEMPTS : undefined);
    return { ...scan, status, attempts: scan.attempts + 1 };
  }
  const tail = scan.size_bytes > head.length
    ? await readSlice(store, r2Key, { suffix: FILE_SCAN_TAIL_BYTES }, etag)
    : null;
  if (scan.size_bytes > head.length && !tail) {
    const status = await markFileScanPendingRetry(db, scan.id, scan.attempts, isPrivateFormDocumentScan(scan) ? FORM_FILE_SCAN_MAX_ATTEMPTS : undefined);
    return { ...scan, status, attempts: scan.attempts + 1 };
  }
  const measured = scan.mime_type.startsWith('image/') ? imageDimensions(head, scan.mime_type) : null;
  return runBuiltinScanAndStore(db, scan, head, {
    filename: scan.filename,
    mimeType: scan.mime_type,
    sizeBytes: scan.size_bytes,
    width: dims?.width ?? measured?.width ?? null,
    height: dims?.height ?? measured?.height ?? null,
    tail,
  }, overrides);
}

export type MediaGateResult =
  | { allowed: true; etag?: string }
  | { allowed: false; code: 'file_scan_pending' | 'file_scan_blocked'; message: string };

export interface MediaGateInfo {
  lineAccountId: string | null;
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

/** 公開URL用の軽い行だけを取る。getMediaLiveTarget が返さない分を補う。 */
export async function getMediaGateInfo(db: ScanDb, id: string): Promise<MediaGateInfo | null> {
  const row = await db.prepare(
    `SELECT line_account_id, size_bytes, width, height FROM media WHERE id = ?`,
  ).bind(id).first<{
    line_account_id: string | null; size_bytes: number; width: number | null; height: number | null;
  }>();
  if (!row) return null;
  return {
    lineAccountId: row.line_account_id,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
  };
}

/**
 * 配信・公開・審査・LIFF に出す前の門番。clean の時だけ通す。
 * 行が無ければ（検査の導入より前のファイル）その場で作って回す。
 * 検査が動かない時は pending のまま置き、通さない。
 */
export async function checkMediaGate(
  db: ScanDb,
  store: ScanObjectStore,
  media: {
    id: string;
    lineAccountId: string | null;
    r2Key: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    width?: number | null;
    height?: number | null;
  },
): Promise<MediaGateResult> {
  const pending: MediaGateResult = { allowed: false, code: 'file_scan_pending', message: '確かめています。確かめ終わるまで使えません' };
  // 代替画像が安全でも、親メディアの隔離を上書きしない。
  const parent = await getFileScanBySubject(db, 'media', media.id);
  if (parent?.status === 'pending') return pending;
  if (parent && (parent.status === 'quarantined' || parent.status === 'rejected')) {
    return { allowed: false, code: 'file_scan_blocked', message: '確認のため使えません。管理者が確かめるまで、どこにも出ません' };
  }
  const session = await db.prepare(
    `SELECT id, status, expires_at, filename FROM media_upload_sessions
      WHERE r2_key = ? AND line_account_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(media.r2Key, media.lineAccountId).first<{ id: string; status: string; expires_at: string; filename: string }>();
  if (session && (session.status !== 'completed'
    || (!isFinalMediaKey(media.r2Key) && Date.parse(session.expires_at) > Date.now()))) return pending;
  const version = await db.prepare(`SELECT id, etag FROM media_versions WHERE media_id = ? AND r2_key = ? AND published_at IS NOT NULL LIMIT 1`)
    .bind(media.id, media.r2Key).first<{ id: string; etag: string | null }>();
  // 署名 URL が期限後に完了しても、最初に検証した版へすべての検査と読取を固定する。
  const etag = session && !isFinalMediaKey(media.r2Key) ? version?.etag?.replace(/^"|"$/g, '') : undefined;
  if (session && !isFinalMediaKey(media.r2Key) && !etag) return pending;
  // verified は形式確認だけなので、別の版の安全判定を再利用せず、実際のバイトごとに結果を付ける。
  const subjectKind = session && isFinalMediaKey(media.r2Key) ? 'upload_session' : version ? 'media_version' : 'media';
  const subjectId = subjectKind === 'upload_session' ? session!.id : subjectKind === 'media_version' ? version!.id : media.id;
  let scanFilename = session?.filename ?? media.filename;
  if (!session) {
    const current = version && !media.r2Key.startsWith('banner/')
      ? await db.prepare('SELECT r2_key FROM media WHERE id = ?').bind(media.id).first<{ r2_key: string }>()
      : null;
    // 元の名前がない過去ファイルの形式を、後からの代替ファイル名で決めない。現在のアップロード検査は緩めない。
    if (media.r2Key.startsWith('banner/') || (version && current?.r2_key !== media.r2Key)) {
      const basename = media.r2Key.slice(media.r2Key.lastIndexOf('/') + 1);
      const spec = ALLOWED_MIME[media.mimeType];
      scanFilename = spec?.ext.includes(extensionOf(basename)) ? basename : spec ? `stored.${spec.ext[0]}` : scanFilename;
    }
  }
  let scan = await getFileScanBySubject(db, subjectKind, subjectId);
  if (!scan) {
    scan = await createFileScan(db, {
      lineAccountId: media.lineAccountId,
      subjectKind,
      subjectId,
      mediaId: media.id,
      filename: scanFilename,
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
    });
    scan = await runScanForStoredObject(db, store, scan, media.r2Key, {
      width: media.width ?? null, height: media.height ?? null,
    }, undefined, etag);
  }
  if (scan.status === 'clean') return { allowed: true, ...(etag ? { etag } : {}) };
  if (scan.status === 'pending') {
    return {
      allowed: false, code: 'file_scan_pending',
      message: '確かめています。確かめ終わるまで使えません',
    };
  }
  if (scan.status === 'rejected') {
    const label = FILE_SCAN_REASON_LABELS[scan.reason_code ?? ''] ?? '確認が必要です';
    return {
      allowed: false, code: 'file_scan_blocked',
      message: `使えません（${label}）。画像を選び直してください`,
    };
  }
  return {
    allowed: false, code: 'file_scan_blocked',
    message: '確認のため使えません。管理者が確かめるまで、どこにも出ません',
  };
}

/** R2 キー直結の素材（フォーム添付・配信用画像）の門番。subject_id がキー。 */
export async function checkKeyGate(
  db: ScanDb,
  store: ScanObjectStore,
  subjectKind: 'form_file' | 'broadcast_asset',
  r2Key: string,
): Promise<MediaGateResult> {
  const scan = await getFileScanBySubject(db, subjectKind, r2Key);
  if (!scan) return { allowed: true };
  if (scan.status === 'clean') return { allowed: true };
  if (scan.status === 'pending') {
    const next = await runScanForStoredObject(db, store, scan, r2Key, {}).catch(() => null);
    if (next && next.status === 'clean') return { allowed: true };
    return {
      allowed: false, code: 'file_scan_pending',
      message: '確かめています。確かめ終わるまで使えません',
    };
  }
  return {
    allowed: false, code: 'file_scan_blocked',
    message: '確認のため使えません。管理者が確かめるまで、どこにも出ません',
  };
}

export async function claimDueFileScans(db: ScanDb, nowIso: string, limit = 20): Promise<FileScanRow[]> {
  const rows = await db.prepare(
    `SELECT * FROM media_file_scans
      WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY next_retry_at ASC NULLS FIRST, created_at ASC
      LIMIT ?`,
  ).bind(nowIso, limit).all<FileScanRow>();
  return rows.results ?? [];
}

export async function getFileScanConfig(db: ScanDb, lineAccountId: string): Promise<FileScanConfig | null> {
  return db.prepare(`SELECT * FROM file_scan_configs WHERE line_account_id = ?`)
    .bind(lineAccountId).first<FileScanConfig>();
}

/**
 * 不許可の古い設定も null（内蔵検査だけ）。運営が許可した宛先と
 * 検査専用の名前の同じ組を確認し終わるまで、選択された環境値を読まない。
 */
export function resolveExternalScanner(
  env: Record<string, string | undefined>,
  config: FileScanConfig | null,
): ThreatScanner | null {
  const endpoint = config?.external_endpoint_url?.trim();
  if (!config?.external_provider || !endpoint) return null;
  const secretRef = config.external_secret_ref?.trim();
  if (!isFileScanSecretRef(secretRef)) return null;
  const url = allowedFileScanEndpoint(endpoint, env.FILE_SCAN_ALLOWED_PAIRS, secretRef);
  if (!url) return null;
  const timeoutMs = Math.max(1000, config.external_timeout_ms || 10000);
  return {
    name: config.external_provider,
    async scan(bytes, context) {
      const headers: Record<string, string> = { 'content-type': context.mimeType };
      const token = env[secretRef];
      if (token) headers.authorization = `Bearer ${token}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url.href, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            ...headers,
            'x-file-scan-filename': encodeURIComponent(context.filename),
            'x-file-scan-mime': context.mimeType,
            'x-file-scan-size': String(context.sizeBytes),
          },
          body: bytes as unknown as BodyInit,
          signal: controller.signal,
        });
        // Workerの型はtypeをdefault/errorに限定する。互換fetchのopaque転送も拒否する。
        if (String(res.type) === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
          throw new ScanRetryableError('external scanner redirect refused');
        }
        if (!res.ok) throw new ScanRetryableError(`external scanner responded ${res.status}`);
        const data = await res.json<{ verdict?: unknown }>().catch(() => null);
        if (data?.verdict === 'clean') return 'clean';
        if (data?.verdict === 'quarantined') return 'quarantined';
        throw new ScanRetryableError('external scanner returned an unknown verdict');
      } catch (err) {
        if (err instanceof ScanRetryableError) throw err;
        // fetch例外にはURLや資格情報が含まれる可能性があるので記録へ持ち込まない。
        throw new ScanRetryableError('external scanner failed');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
