'use client'

import { knownValue } from '@/lib/known-value'

import CloseButton from '@/components/shared/close-button'
import type {
  FormBlock,
  FormInputBlock,
  FormInputFormat,
  FormInputType,
  FormSection,
} from '@line-crm/shared'
import { newBlockId, PREFECTURES } from '@line-crm/shared'
import ChoiceTable from './choice-table'
import FormFileSettings from '@/components/shared/form-file-settings'
import Checkbox from '@/components/shared/checkbox'
import Select from '@/components/shared/select'
import DateField from '@/components/shared/date-field'
import { describeInputUpdates } from './form-update-summary'
import { cellInput, fieldInput, type FormRefs } from './form-refs'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { TextField as SharedTextField, TextArea as SharedTextArea } from '@/components/shared/text-field'


/**
 * ブロック1つぶんの設定。
 *
 * 種類ごとに出す項目が違う。共通で出せるもの（タイトル・必須・非表示）は
 * 上に固定し、その種類にしかないもの（入力制限・選択肢・リマインダ）を
 * 下に足していく。並びを固定しているのは、ブロックを見比べるときに
 * 目が同じ位置を追えるようにするため。
 *
 * 「回答の登録先」は複数選べる。同じ回答を本名と情報欄の両方に入れたい、
 * という運用が実際にあるため。
 */

export const BLOCK_MENU: { kind: string; type?: FormInputType; label: string; group: string }[] = [
  { kind: 'image', label: '画像', group: '飾り' },
  { kind: 'heading', label: '見出し', group: '飾り' },
  { kind: 'text', label: 'テキスト', group: '飾り' },
  { kind: 'button', label: 'ボタン', group: '飾り' },
  { kind: 'input', type: 'text', label: '単一行 入力', group: '入力' },
  { kind: 'input', type: 'textarea', label: '複数行 入力', group: '入力' },
  { kind: 'input', type: 'radio', label: 'ラジオ ボタン', group: '入力' },
  { kind: 'input', type: 'checkbox', label: 'チェック ボックス', group: '入力' },
  { kind: 'input', type: 'select', label: 'プルダウン', group: '入力' },
  { kind: 'input', type: 'file', label: 'ファイル', group: '入力' },
  { kind: 'input', type: 'date', label: '日付', group: '入力' },
  { kind: 'input', type: 'prefecture', label: '都道府県', group: '入力' },
  { kind: 'input', type: 'rating', label: '5段階評価', group: '入力' },
  { kind: 'input', type: 'address', label: '住所', group: '入力' },
  { kind: 'input', type: 'booking', label: '予約を入れる', group: '入力' },
]

const INPUT_TYPE_LABEL: Record<FormInputType, string> = {
  text: '単一行',
  textarea: '複数行',
  radio: 'ラジオボタン',
  checkbox: 'チェックボックス',
  select: 'プルダウン',
  file: 'ファイル',
  date: '日付',
  prefecture: '都道府県',
  // F11で shared の FormInputType に足された種類。名称は shared の型注釈に合わせる。
  address: '住所',
  rating: '5段階評価',
  booking: '予約を入れる',
}

const FORMATS: { value: FormInputFormat; label: string }[] = [
  { value: 'none', label: '指定なし' },
  { value: 'kana', label: 'カナ' },
  { value: 'email', label: 'メールアドレス' },
  { value: 'tel', label: '電話番号' },
  { value: 'integer', label: '整数' },
  { value: 'time', label: '時刻' },
  { value: 'zip', label: '郵便番号' },
]

/** ブロックの肩に出す名前。 */
export function blockTypeLabel(block: FormBlock): string {
  if (block.kind !== 'input') {
    return { image: '画像', heading: '見出し', text: 'テキスト', button: 'ボタン' }[block.kind]
  }
  return knownValue(INPUT_TYPE_LABEL, block.type, '種類を確認できません')
}

export default function BlockEditor({
  block,
  index,
  sections,
  refs,
  inHeader = false,
  selected,
  onSelect,
  onChange,
}: {
  block: FormBlock
  index: number
  sections: FormSection[]
  refs: FormRefs
  /** 共通ヘッダ内のブロックか。共通ヘッダは全ページに出るため分岐の起点にできない */
  inHeader?: boolean
  selected: boolean
  onSelect: () => void
  onChange: (patch: Partial<FormBlock>) => void
}) {
  const patchInput = (patch: Partial<FormInputBlock>) => onChange(patch as Partial<FormBlock>)

  /**
   * 入力欄の種類を変える。
   *
   * 選択肢を持つ種類へ変えるときは、空のまま置かない（選択肢ゼロの
   * ラジオボタンは、回答画面で「答えようがない欄」になる）。逆に
   * 選択肢を持たない種類へ変えても、選択肢は消さずに残す。戻したときに
   * 打ち直しになるため。
   */
  const changeInputType = (type: FormInputType) => {
    if (block.kind !== 'input') return
    const nextIsChoice = type === 'radio' || type === 'checkbox' || type === 'select'
    if (nextIsChoice && (block.choices ?? []).length === 0) {
      patchInput({
        type,
        choiceMode: block.choiceMode ?? 'tag',
        choices: [
          { id: newBlockId('c'), label: '選択肢1' },
          { id: newBlockId('c'), label: '選択肢2' },
        ],
      })
      return
    }
    patchInput({ type })
  }

  return (
    <section
      onFocus={onSelect}
      onClick={onSelect}
      data-block-kind={block.kind}
      className={`rounded-card border p-4 transition-colors ${
        selected ? 'border-accent bg-canvas' : 'border-hairline bg-canvas'
      }`}
    >
      <div className="mb-3 flex items-start gap-3">
        <div className="shrink-0 text-center">
          <span className="bg-accent-deep text-on-accent rounded-control inline-block px-2 py-0.5 text-xs font-medium tabular-nums">
            {index + 1}
          </span>
          <span className="text-ink-faint mt-1 block text-micro leading-tight whitespace-nowrap">
            {blockTypeLabel(block)}
          </span>
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          {/* ---- 飾りのブロック ---- */}
          {block.kind === 'heading' && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-[16rem] flex-1">
                <span className="text-ink-secondary mb-1 block text-xs font-medium">見出し</span>
                <SaveErrorField names={["text","block.text"]}><SharedTextField
                  type="text"
                  value={block.text}
                  onChange={(e) => onChange({ text: e.target.value } as Partial<FormBlock>)}
                  className={fieldInput}
                /></SaveErrorField>
              </label>
              <label>
                <span className="text-ink-secondary mb-1 block text-xs font-medium">大きさ</span>
                <SaveErrorField names={["level","block.level"]}><Select
                  aria-label="大きさ"
                  value={String(block.level ?? 2)}
                  onChange={(value) =>
                    onChange({ level: Number(value) as 1 | 2 | 3 } as Partial<FormBlock>)
                  }
                  options={[
                    { value: '1', label: '見出し1' },
                    { value: '2', label: '見出し2' },
                    { value: '3', label: '見出し3' },
                  ]}
                /></SaveErrorField>
              </label>
            </div>
          )}

          {block.kind === 'text' && (
            <label className="block">
              <span className="text-ink-secondary mb-1 block text-xs font-medium">本文</span>
              <SaveErrorField names={["text","block.text"]}><SharedTextArea
                rows={3}
                value={block.text}
                onChange={(e) => onChange({ text: e.target.value } as Partial<FormBlock>)}
                className={`${fieldInput} resize-y`}
              /></SaveErrorField>
            </label>
          )}

          {block.kind === 'image' && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-[18rem] flex-1">
                <span className="text-ink-secondary mb-1 block text-xs font-medium">
                  画像のURL
                </span>
                <SaveErrorField names={["mediaUrl","block.mediaUrl","media_url","block.media_url"]}><SharedTextField
                  type="url"
                  value={block.mediaUrl}
                  onChange={(e) => onChange({ mediaUrl: e.target.value } as Partial<FormBlock>)}
                  placeholder="https://..."
                  className={fieldInput}
                /></SaveErrorField>
              </label>
              <label>
                <span className="text-ink-secondary mb-1 block text-xs font-medium">幅</span>
                <SaveErrorField names={["size","block.size"]}><Select
                  aria-label="幅"
                  value={block.size ?? 'normal'}
                  onChange={(value) =>
                    onChange({ size: value as 'normal' | 'full' } as Partial<FormBlock>)
                  }
                  options={[
                    { value: 'normal', label: '通常' },
                    { value: 'full', label: '画面いっぱい' },
                  ]}
                /></SaveErrorField>
              </label>
              <label className="min-w-[14rem] flex-1">
                <span className="text-ink-secondary mb-1 block text-xs font-medium">
                  押したときに開くURL（任意）
                </span>
                <SaveErrorField names={["linkUrl","block.linkUrl","link_url","block.link_url"]}><SharedTextField
                  type="url"
                  value={block.linkUrl ?? ''}
                  onChange={(e) => onChange({ linkUrl: e.target.value } as Partial<FormBlock>)}
                  className={fieldInput}
                /></SaveErrorField>
              </label>
            </div>
          )}

          {block.kind === 'button' && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-[12rem] flex-1">
                <span className="text-ink-secondary mb-1 block text-xs font-medium">
                  ボタンの文字
                </span>
                <SaveErrorField names={["label","block.label"]}><SharedTextField
                  type="text"
                  value={block.label}
                  onChange={(e) => onChange({ label: e.target.value } as Partial<FormBlock>)}
                  className={fieldInput}
                /></SaveErrorField>
              </label>
              <label className="min-w-[16rem] flex-1">
                <span className="text-ink-secondary mb-1 block text-xs font-medium">開くURL</span>
                <SaveErrorField names={["url","block.url"]}><SharedTextField
                  type="url"
                  value={block.url}
                  onChange={(e) => onChange({ url: e.target.value } as Partial<FormBlock>)}
                  placeholder="https://..."
                  className={fieldInput}
                /></SaveErrorField>
              </label>
              <label>
                <span className="text-ink-secondary mb-1 block text-xs font-medium">見た目</span>
                <SaveErrorField names={["style","block.style"]}><Select
                  aria-label="見た目"
                  value={block.style ?? 'default'}
                  onChange={(value) =>
                    onChange({
                      style: value as 'default' | 'outline',
                    } as Partial<FormBlock>)
                  }
                  options={[
                    { value: 'default', label: '塗り' },
                    { value: 'outline', label: '枠のみ' },
                  ]}
                /></SaveErrorField>
              </label>
            </div>
          )}

          {/* ---- 入力のブロック ---- */}
          {block.kind === 'input' && (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <label>
                  <span className="text-ink-secondary mb-1 block text-xs font-medium">タイプ</span>
                  <SaveErrorField names={["type","block.type"]}><Select
                    aria-label="タイプ"
                    value={block.type}
                    onChange={(value) => changeInputType(value as FormInputType)}
                    options={(Object.keys(INPUT_TYPE_LABEL) as FormInputType[]).map((t) => ({
                      value: t,
                      label: INPUT_TYPE_LABEL[t],
                    }))}
                  /></SaveErrorField>
                </label>

                <label className="min-w-[16rem] flex-1">
                  <span className="text-ink-secondary mb-1 block text-xs font-medium">
                    タイトル
                  </span>
                  <SaveErrorField names={["label","block.label"]}><SharedTextField
                    type="text"
                    value={block.label}
                    onChange={(e) => patchInput({ label: e.target.value })}
                    placeholder="質問の見出し"
                    className={fieldInput}
                  /></SaveErrorField>
                </label>

                {block.type === 'date' && (
                  <label>
                    <span className="text-ink-secondary mb-1 block text-xs font-medium">
                      入力の形
                    </span>
                    <SaveErrorField names={["dateStyle","block.dateStyle","date_style","block.date_style"]}><Select
                      aria-label="入力の形"
                      value={block.dateStyle ?? 'calendar'}
                      onChange={(value) =>
                        patchInput({ dateStyle: value as 'calendar' | 'ymd' })
                      }
                      options={[
                        { value: 'calendar', label: 'カレンダー' },
                        { value: 'ymd', label: '年月日を入力' },
                      ]}
                    /></SaveErrorField>
                  </label>
                )}

                {block.type === 'file' && <FormFileSettings block={block} onChange={patchInput} />}

                {block.type === 'booking' && (
                  <div className="flex-1 space-y-3" data-design-node="ijxur">
                    <label className="block">
                      <span className="text-ink-secondary mb-1 block text-xs font-medium">
                        予約メニュー
                      </span>
                      <SaveErrorField names={["menuId","block.booking?.menuId","booking?.menuId","menu_id","block.booking?.menu_id","booking?.menu_id"]}><EntitySelect kind="booking_menu"
                        aria-label="予約メニュー"
                        value={block.booking?.menuId ?? ''}
                        onChange={(value) =>
                          patchInput({
                            booking: {
                              menuId: value,
                              staffId: null,
                              daysAhead: block.booking?.daysAhead ?? 14,
                            },
                          })
                        }
                        options={[
                          { value: '', label: '選んでください' },
                          ...(refs.bookingMenus ?? []).map((menu) => ({ ...entityOptionMetadata(menu),
                            value: menu.id,
                            label: `${menu.name}・${menu.durationMinutes}分`,
                          })),
                        ]}
                      /></SaveErrorField>
                    </label>
                    <label className="block">
                      <span className="text-ink-secondary mb-1 block text-xs font-medium">
                        担当
                      </span>
                      <SaveErrorField names={["staffId","block.booking?.staffId","booking?.staffId","staff_id","block.booking?.staff_id","booking?.staff_id"]}><EntitySelect
                        aria-label="担当"
                        value={block.booking?.staffId ?? ''}
                        disabled={!block.booking?.menuId}
                        onChange={(value) =>
                          patchInput({
                            booking: {
                              menuId: block.booking?.menuId ?? '',
                              staffId: value === '' ? null : value,
                              daysAhead: block.booking?.daysAhead ?? 14,
                            },
                          })
                        }
                        options={[
                          { value: '', label: 'だれでも' },
                          ...(block.booking?.menuId
                            ? (refs.bookingMenuStaff?.[block.booking.menuId] ?? [])
                            : []
                          ).map((staff) => ({ ...entityOptionMetadata(staff), value: staff.id, label: staff.name })),
                        ]}
                      /></SaveErrorField>
                    </label>
                    <label className="block">
                      <span className="text-ink-secondary mb-1 block text-xs font-medium">
                        選べる期間（今日から）
                      </span>
                      <SaveErrorField names={["daysAhead","block.booking?.daysAhead","booking?.daysAhead","days_ahead","block.booking?.days_ahead","booking?.days_ahead"]}><Select
                        aria-label="選べる期間"
                        value={String(block.booking?.daysAhead ?? 14)}
                        onChange={(value) =>
                          patchInput({
                            booking: {
                              menuId: block.booking?.menuId ?? '',
                              staffId: block.booking?.staffId ?? null,
                              daysAhead: Number(value),
                            },
                          })
                        }
                        options={[
                          { value: '7', label: '7日' },
                          { value: '14', label: '14日' },
                          { value: '30', label: '30日' },
                          { value: '60', label: '60日' },
                        ]}
                      /></SaveErrorField>
                    </label>
                    <p className="text-ink-faint text-xs">
                      予約は「未承認」で入り、店が承認します。公開にはメニューが必要です。
                    </p>
                  </div>
                )}
              </div>

              {/* 回答の登録先 */}
              <div>
                <span className="text-ink-secondary mb-1 block text-xs font-medium">
                  回答の登録先（複数可）
                </span>
                <p className="text-ink-faint mb-1.5 text-xs">
                  友だち情報欄で定義した項目から選びます。決めると、友だち詳細に出て
                  テンプレートで差し込めます。
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <EntitySelect
                    value=""
                    onChange={(value) => {
                      if (!value) return
                      const current = block.destinations?.friendFieldIds ?? []
                      if (current.includes(value)) return
                      patchInput({
                        destinations: {
                          ...block.destinations,
                          friendFieldIds: [...current, value],
                        },
                      })
                    }}
                    aria-label="友だち情報欄を足す"
                    options={[
                      { value: '', label: '＋ 友だち情報欄' },
                      ...refs.friendFields.map((f) => ({ ...entityOptionMetadata(f),
                        value: f.id,
                        label: f.ecIsMaster ? `${f.name}（EC側が正）` : f.name,
                        disabled: f.ecIsMaster,
                      })),
                    ]}
                  />

                  {(['realName', 'displayName', 'note'] as const)
                    .filter(
                      (key) =>
                        // 複数行を本名・システム表示名に入れる運用は無い
                        block.type !== 'textarea' || key === 'note',
                    )
                    .map((key) => (
                      <Checkbox
                        key={key}
                        checked={block.destinations?.[key] ?? false}
                        onCheckedChange={(checked) =>
                          patchInput({
                            destinations: { ...block.destinations, [key]: checked },
                          })
                        }
                      >
                        {{ realName: '本名', displayName: 'システム表示名', note: 'メモ' }[key]}
                      </Checkbox>
                    ))}
                </div>

                {(block.destinations?.friendFieldIds ?? []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(block.destinations?.friendFieldIds ?? []).map((id) => {
                      const field = refs.friendFields.find((f) => f.id === id)
                      return (
                        <span
                          key={id}
                          className="bg-accent-soft text-accent-deep rounded-pill inline-flex items-center gap-1 px-2 py-0.5 text-xs"
                        >
                          {field?.name ?? '（消えた項目）'}
                          <CloseButton aria-label={`${field?.name ?? ''}を外す`} onClick={() =>
                              patchInput({
                                destinations: {
                                  ...block.destinations,
                                  friendFieldIds: (
                                    block.destinations?.friendFieldIds ?? []
                                  ).filter((x) => x !== id),
                                },
                              })
                            } />
                        </span>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* 選択肢 */}
              {(block.type === 'radio' ||
                block.type === 'checkbox' ||
                block.type === 'select') && (
                <ChoiceTable
                  block={block}
                  sections={sections}
                  refs={refs}
                  inHeader={inHeader}
                  onChange={patchInput}
                />
              )}

              {/* 説明文・初期値・プレースホルダ */}
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-ink-secondary mb-1 block text-xs font-medium">
                    説明文
                  </span>
                  <SaveErrorField names={["description","block.description"]}><SharedTextField
                    type="text"
                    value={block.description ?? ''}
                    onChange={(e) => patchInput({ description: e.target.value })}
                    placeholder="例：西暦でご入力ください"
                    className={fieldInput}
                  /></SaveErrorField>
                </label>

                {(block.type === 'text' || block.type === 'textarea') && (
                  <label className="block">
                    <span className="text-ink-secondary mb-1 block text-xs font-medium">
                      うすい文字（プレースホルダ）
                    </span>
                    <SaveErrorField names={["placeholder","block.placeholder"]}><SharedTextField
                      type="text"
                      value={block.placeholder ?? ''}
                      onChange={(e) => patchInput({ placeholder: e.target.value })}
                      className={fieldInput}
                    /></SaveErrorField>
                  </label>
                )}

                {/*
                  R196: 初期値はその欄の形で入れる。単一行のまま入れると
                  メール・日付・都道府県と矛盾する値が作れてしまい、
                  公開前の検査で止まる（回答者が送信できなくなるため）。
                */}
                {block.type === 'textarea' ? (
                  <label className="block">
                    <span className="text-ink-secondary mb-1 block text-xs font-medium">初期値</span>
                    <SaveErrorField names={["defaultValue","block.defaultValue","default_value","block.default_value"]}><SharedTextArea
                      rows={2}
                      value={block.defaultValue ?? ''}
                      onChange={(e) => patchInput({ defaultValue: e.target.value })}
                      placeholder="はじめから入れておく値"
                      className={`${fieldInput} resize-y`}
                    /></SaveErrorField>
                  </label>
                ) : block.type === 'date' ? (
                  <label className="block">
                    <span className="text-ink-secondary mb-1 block text-xs font-medium">初期値</span>
                    <SaveErrorField names={["defaultValue","block.defaultValue","default_value","block.default_value"]}><DateField
                      aria-label="日付の初期値"
                      value={block.defaultValue ?? ''}
                      onChange={(defaultValue) => patchInput({ defaultValue })}
                    /></SaveErrorField>
                  </label>
                ) : block.type === 'prefecture' ? (
                  <label className="block">
                    <span className="text-ink-secondary mb-1 block text-xs font-medium">初期値</span>
                    <SaveErrorField names={["defaultValue","block.defaultValue","default_value","block.default_value"]}><Select
                      aria-label="初期値"
                      value={block.defaultValue ?? ''}
                      onChange={(value) => patchInput({ defaultValue: value })}
                      options={[
                        { value: '', label: '— 入れない —' },
                        ...PREFECTURES.map((name) => ({ value: name, label: name })),
                      ]}
                    /></SaveErrorField>
                  </label>
                ) : block.type === 'rating' ? (
                  // F-11：5段階評価の初期値。1〜5のちょうどの数だけ
                  // （"3.0" は保存・平均の数え方と合わないため入れない）。
                  <label className="block">
                    <span className="text-ink-secondary mb-1 block text-xs font-medium">初期値</span>
                    <SaveErrorField names={["defaultValue","block.defaultValue","default_value","block.default_value"]}><Select
                      aria-label="初期値"
                      value={block.defaultValue ?? ''}
                      onChange={(value) => patchInput({ defaultValue: value })}
                      options={[
                        { value: '', label: '— 入れない —' },
                        { value: '1', label: '★1' },
                        { value: '2', label: '★2' },
                        { value: '3', label: '★3' },
                        { value: '4', label: '★4' },
                        { value: '5', label: '★5' },
                      ]}
                    /></SaveErrorField>
                  </label>
                ) : block.type === 'address' ? (
                  // F-11：住所の初期値は入れない。文字列の初期値を置くと
                  // 回答側で文字列が入り、検証で弾かれてしまうため。
                  <p className="text-ink-faint text-xs">
                    初期値は入れられません。お客さまが郵便番号から入力します。
                  </p>
                ) : (
                  <label className="block">
                    <span className="text-ink-secondary mb-1 block text-xs font-medium">初期値</span>
                    <SaveErrorField names={["defaultValue","block.defaultValue","default_value","block.default_value"]}><SharedTextField
                      type="text"
                      value={block.defaultValue ?? ''}
                      onChange={(e) => patchInput({ defaultValue: e.target.value })}
                      placeholder="はじめから入れておく値"
                      className={fieldInput}
                    /></SaveErrorField>
                  </label>
                )}
              </div>

              {/* 入力制限 */}
              {(block.type === 'text' || block.type === 'textarea') && (
                <div className="border-hairline rounded-control bg-canvas-sunken border p-3">
                  <span className="text-ink-secondary mb-2 block text-xs font-medium">
                    入力制限
                  </span>
                  <div className="flex flex-wrap items-center gap-3">
                    {block.type === 'text' && (
                      <label className="text-ink-secondary flex items-center gap-1.5 text-xs">
                        形式
                        <SaveErrorField names={["format","block.limit?.format","limit?.format"]}><Select
                          aria-label="形式"
                          value={block.limit?.format ?? 'none'}
                          onChange={(value) =>
                            patchInput({
                              limit: { ...block.limit, format: value as FormInputFormat },
                            })
                          }
                          options={FORMATS.map((f) => ({ value: f.value, label: f.label }))}
                        /></SaveErrorField>
                      </label>
                    )}
                    <label className="text-ink-secondary flex items-center gap-1.5 text-xs">
                      <SaveErrorField names={["min","block.limit?.min","limit?.min"]}><SharedTextField
                        type="number"
                        min={0}
                        value={block.limit?.min ?? ''}
                        onChange={(e) =>
                          patchInput({
                            limit: {
                              ...block.limit,
                              min: e.target.value === '' ? undefined : Number(e.target.value),
                            },
                          })
                        }
                        className={`${cellInput} w-20`}
                        placeholder="下限"
                      /></SaveErrorField>
                      〜
                      <SaveErrorField names={["max","block.limit?.max","limit?.max"]}><SharedTextField
                        type="number"
                        min={0}
                        value={block.limit?.max ?? ''}
                        onChange={(e) =>
                          patchInput({
                            limit: {
                              ...block.limit,
                              max: e.target.value === '' ? undefined : Number(e.target.value),
                            },
                          })
                        }
                        className={`${cellInput} w-20`}
                        placeholder="上限"
                      /></SaveErrorField>
                      文字
                    </label>
                    <SaveErrorField names={["hideCounter","block.limit?.hideCounter","limit?.hideCounter","hide_counter","block.limit?.hide_counter","limit?.hide_counter"]}><Checkbox
                      checked={block.limit?.hideCounter ?? false}
                      onCheckedChange={(checked) =>
                        patchInput({ limit: { ...block.limit, hideCounter: checked } })
                      }
                    >
                      文字数を出さない
                    </Checkbox></SaveErrorField>
                  </div>
                </div>
              )}

              {/* 日付からリマインダ */}
              {block.type === 'date' && (
                <div className="border-hairline rounded-control bg-canvas-sunken border p-3">
                  <Checkbox
                    checked={!!block.reminder}
                    onCheckedChange={(checked) =>
                      patchInput({
                        reminder: checked
                          ? { reminderId: '', time: '09:00' }
                          : null,
                      })
                    }
                  >
                    この日付からリマインダを起動する
                  </Checkbox>

                  {block.reminder && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <SaveErrorField names={["reminderId","block.reminder.reminderId","reminder.reminderId","reminder_id","block.reminder.reminder_id","reminder.reminder_id"]}><EntitySelect kind="reminder"
                        aria-label="リマインダ"
                        value={block.reminder.reminderId}
                        onChange={(value) =>
                          patchInput({
                            reminder: { ...block.reminder!, reminderId: value },
                          })
                        }
                        options={[
                          { value: '', label: '— リマインダ —' },
                          ...refs.reminders.map((r) => ({ ...entityOptionMetadata(r), value: r.id, label: r.name })),
                        ]}
                      /></SaveErrorField>
                      <span className="text-ink-faint text-xs">
                        友だちが入力した日付を起点にします
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* 共通のチェック */}
              <div className="border-hairline flex flex-wrap gap-4 border-t pt-3">
                <SaveErrorField names={["required","block.required"]}><Checkbox
                  checked={block.required ?? false}
                  onCheckedChange={(checked) => patchInput({ required: checked })}
                >
                  必須
                </Checkbox></SaveErrorField>
                {(block.type === 'radio' || block.type === 'checkbox') && (
                  <SaveErrorField names={["inline","block.inline"]}><Checkbox
                    checked={block.inline ?? false}
                    onCheckedChange={(checked) => patchInput({ inline: checked })}
                  >
                    横並び
                  </Checkbox></SaveErrorField>
                )}
                <SaveErrorField names={["hidden","block.hidden"]}><Checkbox
                  checked={block.hidden ?? false}
                  onCheckedChange={(checked) => patchInput({ hidden: checked })}
                >
                  非表示
                </Checkbox></SaveErrorField>
                <span className="text-ink-faint ml-auto text-xs">
                  回答データの見出し：{block.name}
                </span>
              </div>

              {/*
                送信時にこの質問が更新する情報と条件。登録先の設定は上の
                入力欄に散らばっているので、保存して公開すると実際に何が
                起きるかをここで読み取れるようにする（表示専用）。
              */}
              {(() => {
                const updates = describeInputUpdates(block, refs, { inHeader })
                if (updates.length === 0) return null
                return (
                  <div className="border-hairline rounded-control bg-canvas-sunken border p-3">
                    <span className="text-ink-secondary block text-xs font-medium">
                      送信時に更新する情報
                    </span>
                    <ul className="text-ink-faint mt-1 list-disc space-y-0.5 pl-4 text-xs">
                      {updates.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                )
              })()}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
