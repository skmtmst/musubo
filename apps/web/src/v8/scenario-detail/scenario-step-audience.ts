/*
 * コンテンツ表の「配信対象」の桁に出す1行。
 *
 * 設計（bV5Vs）は通ごとに配る相手を桁で見せる。実装は絞り込みを通の編集を
 * 開かないと読めず、**表からは「誰に送る通なのか」が分からなかった**。
 * 通が増えるほど、全員向けと絞り込み済みの通が見分けられなくなる。
 *
 * 決まりごと：
 *   - 絞り込みが無い通は `—` ではない。「購読中の全員」という**決まっている値**。
 *   - タグ1つだけの絞り込みは、タグの名前で言う。
 *   - 名前が引けないタグは**件数で言う**。内部IDは画面に出さない。
 *   - 書きかけの行は数えない（保存前の行が件数に混ざると数が食い違う）。
 */

import {
  isEmptyCondition,
  pruneCondition,
  type SegmentCondition,
} from '@/lib/segment-condition'

export interface AudienceTagName {
  id: string
  name: string
}

/** タグ1つだけの絞り込みなら、そのタグIDを返す。 */
function soleTagId(condition: SegmentCondition): string | null {
  if ((condition.groups ?? []).some((g) => g.rules.length > 0)) return null
  if (condition.rules.length !== 1) return null
  const rule = condition.rules[0]
  if (rule.type !== 'tag_exists') return null
  return typeof rule.value === 'string' && rule.value !== '' ? rule.value : null
}

/**
 * 保存されている値が条件の形をしているか。
 *
 * `targetCondition` は `unknown` で来る（DBのJSON列そのまま）。形が違う古い
 * 行を素通しすると `rules.filter is not a function` で**画面ごと落ちる**。
 * 読めない値は、絞り込みなしと区別して表示する。
 */
function asCondition(raw: unknown): SegmentCondition | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<SegmentCondition>
  if (!Array.isArray(value.rules)) return null
  if (value.groups !== undefined && !Array.isArray(value.groups)) return null
  if (value.operator !== undefined && value.operator !== 'AND' && value.operator !== 'OR') return null
  if (value.rules.some((rule) => !rule || typeof rule !== 'object' || typeof rule.type !== 'string')) return null
  const groups = (value.groups ?? []).map((g) => asCondition(g))
  if (groups.some((g) => g === null)) return null
  return {
    operator: value.operator ?? 'AND',
    rules: value.rules,
    groups: groups.filter((g): g is SegmentCondition => g !== null),
  }
}

/**
 * 1通の配信対象を1行で言い表す。
 *
 * `tags` に名前が無いタグ（消された・別アカウントのもの）は、IDを出さずに
 * 件数の言い方へ落とす。
 */
export function describeStepAudience(
  raw: unknown,
  tags: readonly AudienceTagName[],
): string {
  const parsed = asCondition(raw)
  if (raw != null && parsed === null) return '配信対象を確認できません'
  const condition = pruneCondition(parsed)
  if (condition === null || isEmptyCondition(condition)) return '購読中の全員'

  const tagId = soleTagId(condition)
  if (tagId) {
    const name = tags.find((t) => t.id === tagId)?.name
    if (name) return `タグ「${name}」`
  }

  const rules = condition.rules.length
  const groups = (condition.groups ?? []).filter((g) => g.rules.length > 0).length
  return groups === 0 ? `詳細条件 ${rules} 件` : `詳細条件 ${rules} 件 ＋ or条件 ${groups}組`
}

/**
 * 送ったあとどうするか、を1行で言い表す。
 *
 * 既定の `continue` は**決まっている値**なので `—` にしない。`—` は
 * 「取れていない」の印で、そこに既定値を混ぜると読み手が区別できなくなる。
 */
export function describeAfterSend(afterSend: unknown): {
  label: string
  paused: boolean
} {
  if (afterSend === 'pause') return { label: '配信後に止める', paused: true }
  if (afterSend === 'continue' || afterSend == null) return { label: '配信後：続ける', paused: false }
  return { label: '配信後の処理を確認できません', paused: false }
}

/*
 * R215: 一覧の「内容」「種別」の桁に出す見出し。
 *
 * 質問の通は messageContent が空（' '）のまま残る。質問文を見出しにし、
 * 種別は「質問・分岐」と出す。空の本文で代用しない。
 */
export function stepQuestionHeading(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const text = ((raw as { text?: unknown }).text ?? '').toString().trim().split('\n')[0].slice(0, 60)
  return text || null
}

/** 一覧の「内容」の桁。テンプレ名 → 質問文 → 本文1行目の順で出す。 */
export function stepListTitle(
  step: { messageContent: string; question?: unknown },
  templateName: string | null,
): string {
  if (templateName) return templateName
  const bodyLine = (step.messageContent || '').split('\n')[0].slice(0, 60).trim()
  return stepQuestionHeading(step.question) || bodyLine || '（空）'
}

/** 一覧の「種別」の桁。質問がある通は「質問・分岐」と出す。 */
export function stepKindLabel(
  step: { question?: unknown },
  templateName: string | null,
  fallbackLabel: string,
): string {
  if (templateName) return 'テンプレート'
  if (stepQuestionHeading(step.question)) return '質問・分岐'
  return fallbackLabel
}
