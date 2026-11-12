/*
 * 回答フォームの編集（V8）で使う決まりごと。
 * 今までの画面（app/form-submissions/edit）の処理を写したもの。src/v8 からは
 * 古い画面ファイルを import できないので、同じ中身をここに持つ（動きは同じ）。
 */
import { makeFormBlock } from '@/components/forms/form-definition-operations'
import type { FormRefs } from '@/components/forms/form-refs'
import { formatDateTime } from '@/lib/format'
import type { FormAction,FormBlock,FormInputBlock,FormInputType,FormLayout } from '@line-crm/shared'
import { DEFAULT_ALLERGY_OPTIONS,FIXED_FRIEND_FIELDS,fixedFieldForBlock } from '@line-crm/shared'

/* ---------------- 競合（409）の言い方：form-conflict-message.ts と同じ ---------------- */

/** 相手がいつ保存したか。読めない値なら何も言わない（嘘の時刻を出さない）。 */
export function formatSavedAt(updatedAt: string): string {
  if (!updatedAt) return ''
  const parsed = new Date(updatedAt)
  if (Number.isNaN(parsed.getTime())) return ''
  return formatDateTime(parsed)
}

export function conflictMessage(updatedAt: string): string {
  const when = formatSavedAt(updatedAt)
  return when
    ? `ほかの人が${when}に先に保存しました。最新の内容を読み込んでから、もう一度お試しください。`
    : 'ほかの人が先に保存しました。最新の内容を読み込んでから、もう一度お試しください。'
}

/** 帯の題。だれが保存したかは返事に無いので「ほかの人」と言う。 */
export function conflictTitle(updatedAt: string, formName: string): string {
  const when = formatSavedAt(updatedAt)
  const name = formName.trim() ? `フォーム「${formName.trim()}」` : 'このフォーム'
  return when ? `ほかの人が ${when} に${name}を保存しました` : `ほかの人が先に${name}を保存しました`
}

/* ---------------- 再送の見分け：form-save-reconcile.ts と同じ ---------------- */

export type FormSavedContent = {
  name: string
  description: string | null
  layout: FormLayout
  onSubmitTagId: string | null
  isActive: boolean
  ogTitle: string | null
  ogDescription: string | null
  ogImageUrl: string | null
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 送った中身と保存されている中身が同じなら true（自分の再送）。 */
export function formSavedContentMatches(sent: FormSavedContent, current: FormSavedContent): boolean {
  return canonicalize(sent) === canonicalize(current)
}

/* ---------------- カードの画像URL：form-validate.ts と同じ ---------------- */

export const OG_IMAGE_URL_ERROR = 'カードの画像URLは https:// で始まるURLを入れてください'

export function ogImageUrlError(url: string | null | undefined): string {
  const trimmed = (url ?? '').trim()
  if (!trimmed) return ''
  return /^https:\/\//i.test(trimmed) ? '' : OG_IMAGE_URL_ERROR
}

/* ---------------- 違いの言い方：form-conflict-diff.ts と同じ ---------------- */

export type ConflictSide = { name: string; description: string; layout: FormLayout }
export type ConflictDiffLine = { kind: 'add' | 'remove' | 'change'; text: string }

function blockTitle(block: FormBlock): string {
  if (block.kind === 'input' || block.kind === 'button') return block.label || '（タイトルなし）'
  if (block.kind === 'heading' || block.kind === 'text') return block.text || '（本文なし）'
  return '画像'
}

const KIND_WORD: Record<FormBlock['kind'], string> = { input: '質問', button: 'ボタン', heading: '見出し', text: '文章', image: '画像' }

/**
 * 2つの中身の違いを、運用者が読める文にする。競合の「違いを比べる」と、
 * 公開の確かめの「変わること」で使う。
 */
export function describeConflictDiff(mine: ConflictSide, incoming: ConflictSide, maxLines = 20): { lines: ConflictDiffLine[]; omitted: number } {
  const lines: ConflictDiffLine[] = []
  const push = (kind: ConflictDiffLine['kind'], text: string) => lines.push({ kind, text })
  if (mine.name !== incoming.name) push('change', `フォーム名が違います（最新「${incoming.name}」／あなた「${mine.name}」）`)
  if ((mine.description ?? '') !== (incoming.description ?? '')) push('change', 'フォームの説明が違います')

  const mineSections = new Map(mine.layout.sections.map((s) => [s.id, s]))
  const incomingSections = new Map(incoming.layout.sections.map((s) => [s.id, s]))
  for (const section of mine.layout.sections) {
    const other = incomingSections.get(section.id)
    if (!other) push('add', `「${section.name}」のページを足そうとしています`)
    else if (other.name !== section.name) push('change', `ページの名前が違います（最新「${other.name}」／あなた「${section.name}」）`)
  }
  for (const section of incoming.layout.sections) {
    if (!mineSections.has(section.id)) push('remove', `「${section.name}」のページを消そうとしています（最新にあります）`)
  }
  const sectionNameOf = (id: string): string => {
    if (id === '') return '共通ヘッダ'
    return [...mineSections.values(), ...incomingSections.values()].find((s) => s.id === id)?.name ?? 'ページ'
  }
  const collect = (layout: FormLayout) => {
    const map = new Map<string, { block: FormBlock; sectionId: string }>()
    for (const block of layout.header) map.set(block.id, { block, sectionId: '' })
    for (const section of layout.sections) for (const block of section.blocks) map.set(block.id, { block, sectionId: section.id })
    return map
  }
  const mineBlocks = collect(mine.layout)
  const incomingBlocks = collect(incoming.layout)
  for (const [blockId, entry] of mineBlocks) {
    const other = incomingBlocks.get(blockId)
    if (!other) push('add', `「${sectionNameOf(entry.sectionId)}」に${KIND_WORD[entry.block.kind]}「${blockTitle(entry.block)}」を足そうとしています`)
    else if (other.block.kind !== entry.block.kind || blockTitle(other.block) !== blockTitle(entry.block)) {
      push('change', `「${sectionNameOf(entry.sectionId)}」の${KIND_WORD[entry.block.kind]}「${blockTitle(other.block)}」の中身を変えようとしています`)
    }
  }
  for (const [blockId, entry] of incomingBlocks) {
    if (!mineBlocks.has(blockId)) push('remove', `「${sectionNameOf(entry.sectionId)}」の${KIND_WORD[entry.block.kind]}「${blockTitle(entry.block)}」を消そうとしています（最新にあります）`)
  }
  if (JSON.stringify(mine.layout.options) !== JSON.stringify(incoming.layout.options)) {
    push('change', '答え終わったあと・受付のきまり・見た目の言葉のどれかが違います')
  }
  if (lines.length <= maxLines) return { lines, omitted: 0 }
  return { lines: lines.slice(0, maxLines), omitted: lines.length - maxLines }
}

/**
 * 公開の確かめの「変わること」。いま保存されている下書きから、
 * 画面で直したところを「＋ 足した／－ 消した／・ 変えた」で言う。
 */
export function describePublishChanges(saved: ConflictSide | null, current: ConflictSide): ConflictDiffLine[] {
  if (!saved) return []
  const { lines } = describeConflictDiff(current, saved, 6)
  return lines.map((line) => ({
    kind: line.kind,
    text: line.text
      .replace(/を足そうとしています$/, 'を足した')
      .replace(/を消そうとしています（最新にあります）$/, 'を消した')
      .replace(/の中身を変えようとしています$/, 'を変えた'),
  }))
}

/* ---------------- ブロックの名前・足す欄 ---------------- */

export const INPUT_TYPE_LABEL: Record<FormInputType, string> = {
  text: '1行で書く', textarea: '自由に書く', radio: 'ラジオボタン', checkbox: 'チェックボックス',
  select: 'プルダウン', file: 'ファイル', date: '日付', prefecture: '都道府県',
  rating: '5段階の評価', address: '住所', booking: '予約を入れる',
}

/** 1行で書く欄のうち、形を決めたもの（時刻・メール・電話）は名前を分ける。 */
export function inputTypeLabel(block: FormInputBlock): string {
  const fixed = FIXED_FRIEND_FIELDS.find(f => f.key === fixedFieldForBlock(block))
  if (fixed) return fixed.label
  if (block.type === 'text') {
    const format = block.limit?.format
    if (format === 'time') return '時刻'
    if (format === 'email') return 'メール'
    if (format === 'tel') return '電話'
  }
  return INPUT_TYPE_LABEL[block.type]
}

/** 畳んだ行の2行目（「飾り・見出し1」「入力・5段階」など）。 */
export function blockKindLine(block: FormBlock): string {
  switch (block.kind) {
    case 'image': return '飾り・画像'
    case 'heading': return `飾り・見出し${block.level ?? 2}`
    case 'text': return '飾り・本文'
    case 'button': return '飾り・ボタン'
    default: return block.type === 'rating' ? '入力・5段階' : `入力・${inputTypeLabel(block)}`
  }
}

/** 畳んだ行の1行目。中身が空なら種類の名前。 */
export function blockTitleLine(block: FormBlock): string {
  switch (block.kind) {
    case 'image': return '画像'
    case 'heading': return block.text.trim() || '見出し'
    case 'text': return block.text.trim() || 'テキスト'
    case 'button': return block.label.trim() || 'ボタン'
    default: return block.label.trim() || inputTypeLabel(block)
  }
}

export type AddCard = { key: string; label: string; hint: string; fresh?: boolean; make: (count: number) => FormBlock }

const input = (type: FormInputType, patch: Partial<FormInputBlock> = {}) => (count: number): FormBlock => {
  const block = makeFormBlock('input', type, count) as FormInputBlock
  return { ...block, ...patch }
}

/**
 * 足す欄の4組（・・）。
 * メール・電話・住所・日付・時刻・ファイルは、足したときに質問文へその名前を入れておく（オーナー 2026-10-08：空のままだと何の欄か分からない）。
 */
export const ADD_GROUPS: { title: string; cards: AddCard[] }[] = [
  { title: '選んでもらう', cards: [
    { key: 'radio', label: 'ラジオボタン', hint: '1つだけ選ぶ', make: input('radio') },
    { key: 'checkbox', label: 'チェックボックス', hint: 'いくつでも選ぶ', make: input('checkbox') },
    { key: 'select', label: 'プルダウン', hint: 'たくさんの中から1つ', make: input('select') },
    { key: 'rating', label: '5段階の評価', hint: '★で答える', make: input('rating') },
  ] },
  { title: '書いてもらう', cards: [
    { key: 'text', label: '1行で書く', hint: '名前・会員番号など', make: input('text') },
    { key: 'textarea', label: '自由に書く', hint: '長い文を書く', make: input('textarea') },
    // メールと電話は分ける（オーナー 2026-10-08：「メールアドレスと電話番号を分けよう」）。
    { key: 'contact', label: 'メール', hint: 'メールの形をチェック', make: input('text', { label: 'メールアドレス', fixedField: 'email', placeholder: '例：sample@example.com', limit: { format: 'email' } }) },
    { key: 'tel', label: '電話', hint: '番号の形をチェック', make: input('text', { label: '電話番号', fixedField: 'tel', placeholder: '例：090-0000-5678', limit: { format: 'tel' } }) },
    { key: 'address', label: '住所', hint: '郵便番号から自動で', make: input('address', { label: '住所', fixedField: 'address' }) },
    ...FIXED_FRIEND_FIELDS.filter(f => ['name', 'kana', 'birthday', 'age'].includes(f.key)).map(f => ({
      key: f.key, label: f.label, hint: '友だちの決まった欄に入る',
      make: input(f.type, { label: f.label, fixedField: f.key, limit: { format: f.format } }),
    })),
    { key: 'allergy', label: 'アレルギー', hint: 'いくつでも選ぶ・書き足せる', make: input('checkbox', { label: 'アレルギーはありますか', fixedField: 'allergy', inline: true, choices: [...DEFAULT_ALLERGY_OPTIONS.map((label, i) => ({ id: `allergy-${i}`, label })), { id: 'allergy-other', label: 'そのほか（自由に書く）', isOther: true }] }) },
  ] },
  { title: '飲食の情報', cards: FIXED_FRIEND_FIELDS.filter(f=>['anniversary','seat_preference'].includes(f.key)).map(f=>({key:f.key,label:f.label,hint:'友だちの決まった欄に入る',make:input(f.type,{label:f.label,fixedField:f.key,limit:{format:f.format}})})) },
  { title: '日にち・予約', cards: [
    { key: 'date', label: '日付', hint: 'カレンダーで選ぶ', make: input('date', { label: '日付' }) },
    { key: 'time', label: '時刻', hint: '時計で選ぶ', make: input('text', { label: '時刻', limit: { format: 'time' } }) },
    { key: 'booking', label: '予約を入れる', hint: '空いている枠から選ぶ', fresh: true, make: input('booking', { booking: null }) },
    { key: 'file', label: 'ファイル', hint: '写真・書類を送る', make: input('file', { label: 'ファイル' }) },
  ] },
  { title: '飾り', cards: [
    { key: 'image', label: '画像', hint: 'ロゴ・写真', make: () => makeFormBlock('image') },
    { key: 'heading', label: '見出し', hint: '区切りの題', make: () => makeFormBlock('heading') },
    { key: 'text-deco', label: 'テキスト', hint: '説明の文', make: () => makeFormBlock('text') },
    { key: 'button', label: 'ボタン', hint: '別のページを開く', make: () => makeFormBlock('button') },
  ] },
]

/** 選択肢を持つ種類。 */
export const isChoiceType = (type: FormInputType) => type === 'radio' || type === 'checkbox' || type === 'select'

/* ---------------- 答え終わったら行うこと ---------------- */

export function emptyAction(kind: Exclude<FormAction['kind'], 'research_action'>): FormAction {
  switch (kind) {
    case 'send_text': return { kind: 'send_text', text: '' }
    case 'send_template': return { kind: 'send_template', templateId: '' }
    case 'tag': return { kind: 'tag', op: 'add', tagIds: [] }
    case 'friend_field': return { kind: 'friend_field', fieldId: '', value: '' }
    case 'scenario': return { kind: 'scenario', op: 'start', scenarioId: '' }
    case 'reminder': return { kind: 'reminder', reminderId: '' }
  }
}

/** 足すボタン（ の下の列）。 */
export const ACTION_ADDERS: { kind: Exclude<FormAction['kind'], 'research_action'>; label: string }[] = [
  { kind: 'send_text', label: 'テキスト' },
  { kind: 'send_template', label: 'テンプレート' },
  { kind: 'tag', label: 'タグ' },
  { kind: 'friend_field', label: '友だち情報' },
  { kind: 'scenario', label: 'シナリオ' },
  { kind: 'reminder', label: 'リマインダ' },
]

/** 行の文。「テキストを送る「〇〇」」のように、何をするかを1行で。 */
export function describeAfterAction(action: FormAction, refs: FormRefs): string {
  const nameOf = (list: { id: string; name: string }[], id: string, missing: string) => list.find((x) => x.id === id)?.name ?? missing
  switch (action.kind) {
    case 'research_action': return 'リサーチで設定した回答後の動作'
    case 'send_text': return action.text.trim() ? `テキストを送る「${action.text.trim()}」` : 'テキストを送る（本文が未設定）'
    case 'send_template': return action.templateId ? `テンプレート「${nameOf(refs.templates, action.templateId, '消えたテンプレート')}」を送る` : 'テンプレートを送る（未選択）'
    case 'tag': {
      if (action.tagIds.length === 0) return 'タグを付ける・外す（未選択）'
      const names = action.tagIds.map((id) => `「${nameOf(refs.tags, id, '消えたタグ')}」`).join('・')
      return action.op === 'remove' ? `タグ${names}を外す` : `タグ${names}を付ける`
    }
    case 'friend_field': return action.fieldId ? `友だち情報「${nameOf(refs.friendFields, action.fieldId, '消えた項目')}」に書く` : '友だち情報に書く（未選択）'
    case 'scenario': {
      if (!action.scenarioId) return 'シナリオを始める・止める（未選択）'
      const name = nameOf(refs.scenarios, action.scenarioId, '消えたシナリオ')
      return action.op === 'stop' ? `シナリオ「${name}」を止める` : `シナリオ「${name}」を始める`
    }
    case 'reminder': return action.reminderId ? `リマインダ「${nameOf(refs.reminders, action.reminderId, '消えたリマインダ')}」に登録` : 'リマインダに登録（未選択）'
  }
}

/* ---------------- URL の指定 ---------------- */

export type EditTab = 'content' | 'after' | 'appearance'

/**
 * `?tab=` を読む。V8 の3つの名前に加えて、今までの名前も同じ場所へ寄せる
 * （`basic`→中身、`options`→答え終わったあと、`design`→受付と見た目）。
 */
export function readTab(value: string | null): EditTab {
  if (value === 'after' || value === 'options') return 'after'
  if (value === 'appearance' || value === 'design') return 'appearance'
  return 'content'
}

/** `?page=`（1から）を添字にする。範囲外は 0。 */
export function readPage(value: string | null, count: number): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > count) return 0
  return n - 1
}

/** ページを開いたときに設定を開いておくブロック（最初の質問。無ければ閉じたまま）。 */
export function firstInputBlockId(blocks: FormBlock[]): string | null {
  return blocks.find((b) => b.kind === 'input')?.id ?? null
}

export function blockTitleKind(block: FormBlock): string {
  return { image: '画像', heading: '見出し', text: 'テキスト', button: 'ボタン', input: '入力' }[block.kind]
}
