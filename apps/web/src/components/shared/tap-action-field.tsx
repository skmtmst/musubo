'use client'
import TextLink from '@/components/shared/text-link'
import type { TapActionSourceItem, TapActionSources } from './tap-action-source-types'
export type { TapActionSourceItem, TapActionSources } from './tap-action-source-types'

/*
 * 「押したら」の共通の欄（オーナー採用 ・Pen YPzmo・2026-10-09）。
 *
 * 左に「押したら」（6つ＋画面が足す種類。開いた一覧は印＋名前＋1行の説明）、右に「中身」
 * （種類ごとに変わる）。カルーセル・リッチメッセージ・リッチメニュー・統括のひな形などが同じ部品を使う。
 * - URL＝URL の入力／テキスト＝文字の入力
 * - 予約・回答フォーム・来店スタンプ＝「選んだもの＋［選ぶ］／［変える］」の1行。押すと窓で選ぶ
 *   （予約メニュー・スタンプカードは任意。空なら予約ページの最初・ふつうのカード）
 * - 予約履歴＝中身なし（「押した人の予約の一覧が開きます」）
 * - 店に LIFF が無いとき：6つとも選べる。LIFF が要る4つを選ぶと、中身の欄に
 *   「この動きは LIFF の設定が要ります」［設定を開く］（統括は配るときに各店の LIFF に置き換えるので出さない）
 * - 閲覧のみ（readOnly）：選ぶ・変えるボタンを置かず、選んでいる値を文字で見せる
 *
 * 種類の定数と URL の組み立て・読み戻しは lib/tap-actions.ts（ここでは持たない）。
 * 保存の形は画面ごとに今のまま（この部品は値 TapActionValue を返すだけ）。
 *
 * 作ってあるものを選ぶ窓は共通の選ぶ窓（EntityPicker・Pen dJZ7Q）。下の `TapTargetPicker` で呼ぶ。
 */
import { useId, useMemo, useState, type ReactNode } from 'react'
import { CalendarCheck, ClipboardList, ExternalLink, History, Info, MessageSquare, Stamp, type LucideIcon } from 'lucide-react'
import { TAP_ACTION_DEFS, TAP_ACTION_KINDS, tapActionDef, type TapActionKind, type TapActionValue } from '@/lib/tap-actions'
import TapExtrasField from './tap-extras-field'
import { EntityPickerSummary, EntityPickerDialog, type EntityPickerItem } from './entity-picker'
import { ENTITY_KINDS, EntityKindDialog, type EntityKind } from './entity-picker-sources'
import Select from './select'
import { TextField } from './text-field'
import styles from './tap-action-field.module.css'
import { Field } from './form-controls'
import Notice from '@/components/shared/notice'

export const TAP_ACTION_ICONS: Record<TapActionKind, LucideIcon> = {
  uri: ExternalLink,
  message: MessageSquare,
  booking: CalendarCheck,
  form: ClipboardList,
  booking_history: History,
  visit_stamp: Stamp,
}

/** 画面が足す種類（リッチメニューの「テンプレートを送る」・カルーセルの「動きを実行する」など）。 */
export interface TapActionExtraKind {
  value: string
  label: string
  description?: string
  icon: LucideIcon
}

export interface TapActionFieldProps {
  id?: string
  invalid?: boolean
  'aria-describedby'?: string
  /** 読み上げ名の頭（「カード1のボタン1」「面 A」）。 */
  name: string
  value: TapActionValue
  /** 変わった所だけ渡す。種類を変えたときは refId を空にして渡す。 */
  onChange: (patch: Partial<TapActionValue>) => void
  /** 出す6つの種類（既定は全部）。並びは絵の順のまま。 */
  kinds?: readonly TapActionKind[]
  /** 6つの後ろに足す種類。中身は renderBody で描く。 */
  extraKinds?: readonly TapActionExtraKind[]
  /**
   * 中身を画面が描く（足した種類の中身・リッチメニューの計測リンクなど）。undefined を返した種類は部品の既定の中身。
   * LIFF の案内が出る場合は案内が先。
   */
  renderBody?: (kind: string) => ReactNode | undefined
  /** 店か統括か。統括は LIFF の案内を出さない（配るときに各店の LIFF に置き換える）。 */
  scope?: 'shop' | 'hq'
  /** 店のアカウントに LIFF があるか。 */
  hasLiff: boolean
  /** ［設定を開く］の行き先（アカウントの設定）。 */
  liffSettingsHref?: string
  readOnly?: boolean
  /** 作ってあるものの候補。読み込み中・読めないときは渡さない（窓に「読み込めませんでした」）。 */
  sources?: TapActionSources
  /** 'row'＝押したら・中身を横に並べる（ボタンの行）。'stack'＝縦に積む（狭い右の列）。 */
  layout?: 'row' | 'stack'
  /** ボタンの文字などを種類・中身と同じ行へ置く。指定時だけ3列にする。 */
  labelControl?: ReactNode
  /** 作成の面で種類を直接選ぶ。指定しない欄は既存のSelect。 */
  kindPresentation?: 'select' | 'grid'
  /** テキストを送るの文字数の上限（LINE の決まりは画面ごとに違う）。 */
  textMax?: number
  /** URL の欄の薄い字（既定 https://example.com）。 */
  uriPlaceholder?: string
  /** 押したらのプルダウンの読み上げ名（既定「〇〇を押したら」）。幅は持たない（呼び出し側の箱で決める）。 */
  kindLabel?: string
  allowExtras?: boolean
  accountId?: string | null
  extrasUnavailable?: string
  extrasError?: string | null
}

function kindOptionsOf(kinds: readonly TapActionKind[], extras: readonly TapActionExtraKind[], current: string) {
  const base = TAP_ACTION_DEFS.filter((def) => kinds.includes(def.kind) || def.kind === current).map((def) => ({
    value: def.kind as string,
    label: def.label,
    description: def.description,
    icon: TAP_ACTION_ICONS[def.kind],
  }))
  return [...base, ...extras.map((extra) => ({ value: extra.value, label: extra.label, description: extra.description, icon: extra.icon }))]
}

export default function TapActionField({
  id, invalid, 'aria-describedby': saveDescription,
  name, value, onChange, kinds = TAP_ACTION_KINDS, extraKinds = [], renderBody,
  scope = 'shop', hasLiff, liffSettingsHref = '/accounts', readOnly = false, sources,
  layout = 'row', labelControl, kindPresentation = 'select', textMax, kindLabel, allowExtras = false, accountId, extrasUnavailable, extrasError, uriPlaceholder = 'https://example.com',
}: TapActionFieldProps) {
  const options = useMemo(() => kindOptionsOf(kinds, extraKinds, value.kind), [kinds, extraKinds, value.kind])
  const current = options.find((option) => option.value === value.kind)
  const CurrentIcon = current?.icon
  const def = tapActionDef(value.kind)
  const [picking, setPicking] = useState(false)
  const kindName = useId()
  const changeKind = (next: string) => { if (next !== value.kind) onChange({ kind: next, refId: '' }) }

  const kindControl = readOnly ? (
    <span className={styles.readKind} aria-label={`${kindLabel ?? `${name}を押したら`}：${current?.label ?? ''}`}>
      {CurrentIcon ? <CurrentIcon className={styles.icon} aria-hidden="true" /> : null}
      <span className={styles.readText}>{current?.label?.trim() ? current.label : '—'}</span>
    </span>
  ) : kindPresentation === 'grid' ? (
    <fieldset className={styles.choices} data-shared-part="tap-action-choices">
      <legend className="sr-only">{kindLabel ?? `${name}を押したら`}</legend>
      <div className={styles.choiceGrid}>{options.map(({ value: optionValue, label, description, icon: Icon }) => (
        <label key={optionValue} className={styles.choice} title={description}>
          <input className={styles.choiceInput} type="radio" name={kindName} value={optionValue} aria-label={label} checked={value.kind === optionValue} onChange={() => changeKind(optionValue)} />
          <Icon className={styles.icon} aria-hidden="true" />
          <span className={styles.readText}>{label}</span>
        </label>
      ))}</div>
    </fieldset>
  ) : (
    <Select
      size="full"
      aria-label={kindLabel ?? `${name}を押したら`}
      value={value.kind}
      icon={CurrentIcon ? <CurrentIcon className={styles.icon} /> : undefined}
      onChange={changeKind}
      options={options.map(({ value: optionValue, label, description, icon: Icon }) => ({
        value: optionValue,
        label,
        description,
        leading: <Icon className={styles.icon} />,
      }))}
    />
  )

  const liffMissing = Boolean(def?.needsLiff) && scope === 'shop' && !hasLiff
  const custom = liffMissing ? undefined : renderBody?.(value.kind)
  let body: ReactNode
  if (custom !== undefined) {
    body = custom
  } else if (!def) {
    body = null
  } else if (liffMissing) {
    body = (
      <Notice tone="info" role="note" icon={<Info aria-hidden="true" />} action={<>
        {readOnly ? null : <TextLink inline href={liffSettingsHref}>設定を開く</TextLink>}
      </>}>
        <span className={styles.liffText}>この動きは LIFF の設定が要ります</span>

      </Notice>
    )
  } else if (def.kind === 'uri') {
    body = readOnly
      ? <span className={styles.readBody} title={value.uri}>{value.uri || '—'}</span>
      : <TextField type="url" value={value.uri} placeholder={uriPlaceholder} aria-label={`${name}のURL`} onChange={(event) => onChange({ uri: event.target.value })} />
  } else if (def.kind === 'message') {
    const over = textMax !== undefined && [...value.text].length > textMax
    body = readOnly
      ? <span className={styles.readBody} title={value.text}>{value.text || '—'}</span>
      : <TextField value={value.text} placeholder={textMax ? `押した人が送る文（${textMax}文字まで）` : '押した人が送る文'} aria-label={`${name}の送る文`} aria-invalid={over || undefined} title={value.text || undefined} onChange={(event) => onChange({ text: event.target.value })} />
  } else if (def.kind === 'booking_history') {
    body = <span className={styles.fixed}>中身は要りません。押した人の予約の一覧（変更・取り消し）が開きます</span>
  } else {
    const target = def.target!
    const items = sources?.[def.kind as 'form' | 'booking' | 'visit_stamp']
    const picked = items?.find((item) => item.id === value.refId)
    const Icon = TAP_ACTION_ICONS[def.kind]
    const emptyText = target.required
      ? `（${target.noun}を選んでください）`
      : def.kind === 'booking' ? 'メニューを決めずに開く（予約ページの最初）' : 'ふつうのスタンプカードを開く'
    body = (
      <>
        {readOnly ? <span className={styles.readBody}>{picked?.name ?? emptyText}{picked?.note ? <small>{picked.note}</small> : null}</span> : <EntityPickerSummary
          label={`${name}の${target.noun}`} noun={target.noun} icon={Icon}
          name={value.refId ? picked?.name ?? `保存してある${target.noun}` : undefined}
          meta={picked?.note} placeholder={emptyText}
          id={id} invalid={invalid} describedBy={saveDescription} ariaLabel={`${name}の${target.noun}を${value.refId ? '変更する' : '選択する'}`} onOpen={() => setPicking(true)} />}
        {picking ? (
          <TapTargetPicker
            tapKind={def.kind}
            noun={target.noun}
            required={target.required}
            emptyLabel={emptyText}
            items={items}
            initialId={value.refId}
            onConfirm={(id) => { onChange({ refId: id }); setPicking(false) }}
            onCancel={() => setPicking(false)}
          />
        ) : null}
      </>
    )
  }

  return (
    <div id={id} aria-invalid={invalid || undefined} aria-describedby={saveDescription} style={invalid ? { outline: '1px solid var(--color-danger)' } : undefined} className={styles.withExtras}><div className={`${styles.root} ${labelControl ? styles.labeledRow : kindPresentation === 'grid' ? styles.grid : layout === 'stack' ? styles.stack : styles.row}`} data-tap-kind={value.kind} data-tap-action-columns={labelControl ? '3' : undefined}>
      {labelControl ?? null}
      <div className={styles.kind}>{labelControl ? <Field label="押したら">{kindControl}</Field> : kindControl}</div>
      <div className={styles.body}>{labelControl ? <Field label="中身">{body}</Field> : body}</div>
    </div>
    {allowExtras ? <TapExtrasField name={name} value={value.tapExtras} onChange={tapExtras => onChange({ tapExtras })} accountId={accountId} readOnly={readOnly} unavailable={extrasUnavailable} error={extrasError} /> : null}
    </div>
  )
}

/** 任意の窓で「選ばない（予約ページの最初・ふつうのカード）」を表す仮の行。 */
const NONE_ID = '__tap_none__'

/**
 * 作ってあるもの（回答フォーム・予約メニュー・スタンプカード）を選ぶ窓。共通の「作ってあるものを選ぶ窓」
 * （EntityPicker・Pen dJZ7Q・）を使う。窓の中は仮選択で、［選ぶ］でだけ値を変える（キャンセル・Esc では変えない）。
 * - 回答フォーム（必ず選ぶ）は EntityKindDialog（フォルダの列・見え方のスマホつき）
 * - 予約メニュー・スタンプカード（任意）は先頭に「選ばない」の行を置いた EntityPickerDialog
 * - 候補を読めなかったときは一覧の代わりに理由を出す
 */
export function TapTargetPicker({ tapKind, noun, required, emptyLabel, items, initialId, onConfirm, onCancel }: {
  /** どの種類の中身か（作る画面への文字リンク・見え方の出し分けに使う）。 */
  tapKind?: string
  noun: string
  required: boolean
  emptyLabel: string
  /** undefined＝読めなかった。 */
  items: TapActionSourceItem[] | undefined
  initialId: string
  onConfirm: (id: string) => void
  onCancel: () => void
}) {
  const entity: EntityKind | undefined = tapKind === 'form' ? 'form' : tapKind === 'booking' ? 'booking_menu' : undefined
  const usable = (items ?? []).filter((item) => !item.disabled || item.id === initialId)
  if (required && entity && items !== undefined) {
    return <EntityKindDialog kind={entity} options={usable.map((item) => ({ id: item.id, name: item.name, folderId: item.folderId, updatedAt: item.updatedAt }))} initialId={initialId} onConfirm={onConfirm} onCancel={onCancel} />
  }
  const def = entity ? ENTITY_KINDS[entity] : undefined
  const rows: EntityPickerItem[] = [
    ...(required ? [] : [{ id: NONE_ID, name: emptyLabel }]),
    ...usable.map((item) => ({ id: item.id, name: item.name, meta: item.note })),
  ]
  return (
    <EntityPickerDialog
      title={`${noun}を選ぶ`}
      items={rows}
      initialId={initialId || (required ? '' : NONE_ID)}
      state={items === undefined ? <p className={styles.pickerEmpty} role="alert">{`${noun}を読み込めませんでした。開き直してください。`}</p> : undefined}
      searchPlaceholder={`${noun}の名前で探す`}
      createHref={def?.createHref}
      createLabel={def?.createLabel}
      designNode="dJZ7Q"
      onConfirm={(id) => onConfirm(id === NONE_ID ? '' : id)}
      onCancel={onCancel}
    />
  )
}
