import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * LIFF の画像の alt の見張り。
 *
 * LIFF は lint が CI に無いので、ここで見る。<img> には必ず alt を書く
 * （意味のある画像は中身、飾りは alt=""）。イベントの画像は中身なので空にしない。
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files(full, out);
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

export function imgTagsWithoutAlt(source: string): string[] {
  const tags = source.match(/<img\b[^>]*?\/?>/gs) ?? [];
  return tags.filter((tag) => !/\balt=/.test(tag));
}

describe('LIFF の画像の alt', () => {
  it('見張りが alt の無い <img> を拾う', () => {
    expect(imgTagsWithoutAlt('<img src={a} className="x" />')).toHaveLength(1);
    expect(imgTagsWithoutAlt('<img\n  src={a}\n  alt=""\n/>')).toHaveLength(0);
  });

  it('すべての <img> に alt がある', () => {
    const missing = files(SRC).flatMap((f) => imgTagsWithoutAlt(readFileSync(f, 'utf8')).map(() => relative(SRC, f)));
    expect(missing).toEqual([]);
  });

});
