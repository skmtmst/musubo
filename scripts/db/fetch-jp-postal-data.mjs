#!/usr/bin/env node
/**
 * 日本郵便の公開郵便番号データを取り込み、`postal_codes` へ入れる種を作る。
 *
 * 取得元（公式）:
 * - https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html
 * - 形式説明 https://www.post.japanpost.jp/service/search/zipcode/download/utf-readme.html
 *
 * 使い方:
 *   node scripts/db/fetch-jp-postal-data.mjs --fetch --url <zipの直URL> [--out data/postal]
 *   node scripts/db/fetch-jp-postal-data.mjs --from-file <csv> [--source <名>] [--out <dir>]
 *
 * --fetch は公式配布のzipを落とし、解凍し、CSVを読み、重複・不正行を除き、
 * 取り込み用SQL（postal_codes＋完了記録postal_import_manifest）と
 * manifest.json（入力SHA・件数・時点）を出す。生CSV・zipは置き場に残すが
 * ソースへは入れない（.gitignoreのdata/postal一度きり*）。
 * manifest.jsonとPROVENANCEへの転記だけをコミットする。
 *
 * --fetch に直URLは必須（--url か環境変数 JP_POSTAL_ZIP_URL）。
 * 配布ページの自動解析はしない。直URLは配布ページ
 * https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html
 * で人が確認して渡す。URLなしの --fetch 単体はRC2で止まる。
 *
 * 取込SQLの分割設計（D1の文長上限 100KB 対応）:
 * - 由来 https://developers.cloudflare.com/d1/platform/limits/
 *   「Maximum SQL statement length 100,000 bytes」。1文のINSERTに
 *   全行を連結すると上限を超えるため、1文が80KBを超えないよう
 *   行数ではなくバイト数で区切って複文のINSERTにする。
 * - (1) 開始3文で旧完了記録と旧本体を消し、新完了記録を row_count=-1
 *   （取込中）で置く。(2) 本体の複文を順に入れる。(3) 末尾1文で完了記録を
 *   全件数に更新。どれも INSERT OR REPLACE・DELETE のため再適用は冪等。
 *   順に適用し、途中で失敗したら止める。
 * - 途中（開始だけ・1文だけ・失敗）は完了記録が -1 のため readiness は
 *   false のまま。旧全国版と同件数の新データでも、旧本体を先に消すため
 *   途中一致で全国版と誤認しない。末尾まで来て初めて件数一致が全国版。
 * - 実D1への適用は番号ごとの明示承認後。勝手に適用しない。
 *
 * 注意:
 * - 公式公開データの取得は開発時のみ。顧客の郵便番号・住所を外部へ送らない。
 * - 利用時の検索は取り込んだ表だけを読み、外部通信はしない。
 * - 実DBへの適用は番号ごとの明示承認後。勝手に適用しない。
 * - 7桁は文字列で持つ（先頭0保持）。同じ番号の複数行は残す。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

const DEFAULT_PAGE = 'https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html';

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function halfWidthDigits(value) {
  return value.replace(/[０-９]/g, (ch) => String('０１２３４５６７８９'.indexOf(ch)));
}

/** 1行のCSVを割る（"引用"と,区切りだけの簡易形。日本郵便の配布形に足りる）。 */
export function splitCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

export function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
  const half = halfWidthDigits(trimmed);
  if (!/^[0-9]{3}-?[0-9]{4}$/.test(half)) return null;
  return half.replace('-', '');
}

/**
 * 日本郵便CSV（15列: 2=7桁番号, 6=都道府県, 7=市区町村, 8=町域）を読む。
 * 不正行は数えて落とし、完全重複は1つにまとめる。順序は番号・住所順。
 */
export function parsePostalCsv(text) {
  const rows = [];
  let skipped = 0;
  const seen = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, '');
    if (line.trim() === '') continue;
    const cols = splitCsvLine(line);
    if (cols.length < 9) {
      skipped += 1;
      continue;
    }
    const code = normalizeCode(cols[2]);
    const prefecture = (cols[6] ?? '').trim();
    const city = (cols[7] ?? '').trim();
    const town = (cols[8] ?? '').trim();
    if (code === null || prefecture === '' || city === '') {
      skipped += 1;
      continue;
    }
    const key = `${code}|${prefecture}|${city}|${town}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    rows.push({ code, prefecture: prefecture, city, town });
  }
  rows.sort((a, b) => (a.code + a.prefecture + a.city + a.town < b.code + b.prefecture + b.city + b.town ? -1 : 1));
  return { rows, skipped };
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export const IMPORT_SQL_MAX_STATEMENT_BYTES = 80000;

export function splitImportBatches(rows, sourceUrl, importedAt, maxBytes = IMPORT_SQL_MAX_STATEMENT_BYTES) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  for (const row of rows) {
    const text = `(${[row.code, row.prefecture, row.city, row.town, sourceUrl, importedAt].map(sqlQuote).join(', ')})`;
    const size = Buffer.byteLength(text, 'utf8') + 2;
    if (current.length > 0 && currentBytes + size > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push({ row, text });
    currentBytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export const IMPORT_SENTINEL_ROW_COUNT = -1;

export function buildImportSql({ rows, sourceUrl, inputSha256, inputBytes, manifestId, importedAt }) {
  const batches = splitImportBatches(rows, sourceUrl, importedAt);
  const lines = [
    `-- 日本郵便の公開郵便番号データの取り込み（生成物）。実DB適用は承認後。`,
    `-- 由来: ${sourceUrl} / 入力SHA256: ${inputSha256} / ${rows.length}件 / ${importedAt}`,
    `-- D1の1文上限100KBに合わせ、本体は${batches.length}文に分割（各80KB以内）。`,
    `-- 適用順と途中readyの防止:`,
    `-- (1) 開始3文で旧完了記録と旧本体を消し、新完了記録を row_count=-1（取込中）で置く。`,
    `--     旧全国版と同件数の新データでも、旧件数と新完了記録の一致で全国版と誤認しない。`,
    `-- (2) 本体 ${batches.length} 文を順に入れる。どれも INSERT OR REPLACE のため再適用は冪等。`,
    `-- (3) 末尾1文で完了記録を ${rows.length} に更新。ここまで来て初めて件数一致が全国版。`,
    `--     途中（開始だけ・1文だけ・失敗）では row_count=-1 のため readiness は false のまま。`,
    `DELETE FROM postal_import_manifest;`,
    `DELETE FROM postal_codes;`,
    `INSERT INTO postal_import_manifest (id, source_url, input_sha256, input_bytes, row_count, imported_at)`,
    `  VALUES (${sqlQuote(manifestId)}, ${sqlQuote(sourceUrl)}, ${sqlQuote(inputSha256)}, ${inputBytes}, ${IMPORT_SENTINEL_ROW_COUNT}, ${sqlQuote(importedAt)});`,
  ];
  for (const batch of batches) {
    lines.push(`INSERT OR REPLACE INTO postal_codes (postal_code, prefecture, city, town, source_name, imported_at) VALUES`);
    lines.push(`${batch.map((b) => `  ${b.text}`).join(',\n')};`);
  }
  lines.push(`UPDATE postal_import_manifest SET row_count = ${rows.length} WHERE id = ${sqlQuote(manifestId)};`);
  return `${lines.join('\n')}\n`;
}

function jstStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
  return `${parts.replace(' ', 'T')}+09:00`;
}

async function download(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`取得に失敗: HTTP ${res.status} ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const { writeFileSync: write } = await import('node:fs');
  write(destPath, bytes);
  return bytes;
}

function unzipFirstCsv(zipPath, destDir) {
  execFileSync('unzip', ['-o', '-j', zipPath, '-d', destDir], { stdio: 'pipe' });
  const names = readdirSync(destDir).filter((n) => n.toLowerCase().endsWith('.csv'));
  if (names.length === 0) throw new Error('zipの中にCSVがありません');
  names.sort();
  return join(destDir, names[0]);
}

function discoverZipUrl(pageUrl) {
  return process.env.JP_POSTAL_ZIP_URL ?? null;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const outDir = get('--out') ?? 'data/postal';
  mkdirSync(outDir, { recursive: true });

  if (args.includes('--fetch')) {
    const explicit = get('--url');
    const discovered = explicit ?? discoverZipUrl(DEFAULT_PAGE);
    if (!discovered) {
      console.log(`公式配布の直URLが決まりません。--url でzipのURLを渡してください。`);
      console.log(`配布ページ: ${DEFAULT_PAGE}`);
      console.log(`または環境変数 JP_POSTAL_ZIP_URL に設定してください。`);
      process.exitCode = 2;
      return;
    }
    const stamp = jstStamp().slice(0, 10).replaceAll('-', '');
    const zipPath = join(outDir, `jp-postal-${stamp}.zip`);
    console.log(`取得: ${discovered}`);
    const bytes = await download(discovered, zipPath);
    const csvPath = unzipFirstCsv(zipPath, outDir);
    await buildFromCsv(csvPath, bytes, discovered, outDir, stamp);
    return;
  }

  const fromFile = get('--from-file');
  if (fromFile) {
    if (!existsSync(fromFile)) {
      console.error(`CSVがありません: ${fromFile}`);
      process.exitCode = 1;
      return;
    }
    const bytes = readFileSync(fromFile);
    const stamp = jstStamp().slice(0, 10).replaceAll('-', '');
    const dest = join(outDir, basename(fromFile));
    if (fromFile !== dest) copyFileSync(fromFile, dest);
    await buildFromCsv(dest, bytes, get('--source') ?? `fixture:${basename(fromFile)}`, outDir, stamp);
    return;
  }

  console.log('使い方:');
  console.log('  node scripts/db/fetch-jp-postal-data.mjs --fetch --url <zipの直URL> [--out data/postal]');
  console.log('  node scripts/db/fetch-jp-postal-data.mjs --from-file <csv> [--source <名>] [--out <dir>]');
  console.log(`配布ページ: ${DEFAULT_PAGE}`);
}

async function buildFromCsv(csvPath, inputBytes, sourceUrl, outDir, stamp) {
  const raw = readFileSync(csvPath);
  let text = raw.toString('utf8');
  if (text.includes('�') && !/[぀-ヿ一-鿿]/.test(text)) {
    const decoded = new TextDecoder('shift_jis').decode(raw);
    if (decoded.includes('都') || decoded.includes('道') || decoded.includes('府') || decoded.includes('県')) {
      text = decoded;
    }
  }
  const { rows, skipped } = parsePostalCsv(text);
  const inputSha256 = sha256Bytes(inputBytes);
  const importedAt = jstStamp();
  const manifestId = `jp-${stamp}`;
  const manifest = {
    id: manifestId,
    sourceUrl,
    inputFile: basename(csvPath),
    inputSha256,
    inputBytes: inputBytes.length,
    rowCount: rows.length,
    skippedRows: skipped,
    format: 'jp-post-utf-15col',
    importedAt,
    importBatches: splitImportBatches(rows, sourceUrl, importedAt).length,
    statementByteBudget: IMPORT_SQL_MAX_STATEMENT_BYTES,
    statementByteLimit: 100000,
  };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(outDir, `import-${manifestId}.sql`),
    buildImportSql({ rows, sourceUrl, inputSha256, inputBytes: inputBytes.length, manifestId, importedAt }),
  );
  console.log(`由来: ${sourceUrl}`);
  console.log(`入力SHA256: ${inputSha256} (${inputBytes.length} bytes)`);
  console.log(`件数: ${rows.length}件（除外 ${skipped}行）/ ${importedAt}`);
  console.log(`生成: ${outDir}/manifest.json, ${outDir}/import-${manifestId}.sql`);
  console.log('PROVENANCEへ上4行を転記し、manifest.jsonだけコミットしてください。SQLと生CSVは置き場に残します。');
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  await main();
}
