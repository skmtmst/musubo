/*
 * V6R-S3-c: 件数の分かる一覧を、2ページ目以降は同時に取る。
 *
 * 1回目の応答で全体の件数（total）が分かるので、残りのページはまとめて頼める。
 * 以前は予約カレンダーが100件ずつ前の応答を待ってから次を頼み、予約が500件の週は
 * 5往復を順番に待っていた。
 *
 * - 並びはページの順（offset の小さい順）に戻して返す
 * - 1ページ目のあと `stillWanted` が false なら、残りを頼まずに null を返す
 *   （アカウントを切り替えたあとに前のアカウントの行を集め続けない。#963）
 */
export async function fetchAllPages<T>(
  fetchPage: (offset: number) => Promise<{ requests: T[]; total: number }>,
  pageSize: number,
  stillWanted: () => boolean,
): Promise<T[] | null> {
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize <= 0) {
    throw new RangeError('pageSize must be a positive integer')
  }
  const first = await fetchPage(0)
  if (!stillWanted()) return null
  if (!first || !Array.isArray(first.requests)) {
    throw new Error('一覧の形式を確認できませんでした')
  }
  if (typeof first.total !== 'number' || !Number.isFinite(first.total) || first.total < 0) {
    throw new Error('件数を確認できませんでした')
  }
  const collected = [...first.requests]
  if (first.requests.length === 0 || collected.length >= first.total) return collected
  const offsets: number[] = []
  for (let offset = first.requests.length; offset < first.total; offset += pageSize) offsets.push(offset)
  const rest = await Promise.all(offsets.map((offset) => fetchPage(offset)))
  if (!stillWanted()) return null
  for (const page of rest) {
    if (!page || !Array.isArray(page.requests)) {
      throw new Error('一覧の形式を確認できませんでした')
    }
    collected.push(...page.requests)
  }
  return collected
}
