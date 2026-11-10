'use client'

import { AddGrid,blockIcon } from './content-add-grid';

import { japaneseDetailOf } from '@/components/shared/api-error-message';
import Card from '@/components/shared/card';

import BlockEditor from '@/components/forms/block-editor';
import { formJumpsInto } from '@/components/forms/form-definition-operations';
import type { FormRefs } from '@/components/forms/form-refs';
import Button from '@/components/shared/button';
import Toggle from '@/components/shared/toggle';
import Dialog from '@/components/shared/dialog';
import { EntityKindField } from '@/components/shared/entity-picker-sources';
import EntitySelect from '@/components/shared/entity-select';
import { Field,FieldError } from '@/components/shared/form-controls';
import FormFileSettings from '@/components/shared/form-file-settings';
import ImageFrame from '@/components/shared/image-frame';
import InlineSettings from '@/components/shared/inline-settings';
import { uploadImageFile,uploadToMediaLibrary } from '@/components/shared/media-library-upload';
import MediaPickerDialog from '@/components/shared/media-picker-dialog';
import { DragHandle,RowActions } from '@/components/shared/row-actions';
import { SaveErrorField,SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors';
import Select from '@/components/shared/select';
import { TextArea,TextField } from '@/components/shared/text-field';
import TextLink from '@/components/shared/text-link';
import UriTapActionField from '@/components/shared/uri-tap-action-field';
import { api } from '@/lib/api';
import { useStaffRole, canManageRole } from '@/lib/staff-role';
import { FIXED_FRIEND_FIELDS,fixedFieldForBlock,newBlockId,type FormBlock,type FormInputBlock,type FormLayout } from '@line-crm/shared';
import {
CalendarCheck,
Plus,
X
} from 'lucide-react';
import { useEffect,useMemo,useRef,useState,type DragEvent,type KeyboardEvent,type ReactNode } from 'react';
import styles from './edit.module.css';
import { useFormEditAttempted } from './field-issues';
import { blockKindLine,blockTitleKind,blockTitleLine,inputTypeLabel,isChoiceType } from './model';
import type { FormRouting } from './routing-model';
import RoutingSection from './routing-section';

/*
 * 「中身」のタブ（・・・・ の左の列）。
 * ページの札、ページのブロック（畳んだ行と開いた設定）、ブロックを足す欄。
 */

type Props = {
  readOnly?: boolean
  nameField?: ReactNode
  layout: FormLayout
  page: number
  blocks: FormBlock[]
  refs: FormRefs
  selectedBlockId: string | null
  inputCount: number
  accountId: string | null
  /** 統括のひな形（host.ts）：配った先の ID に直せない画像（登録メディア・画像の URL）は足せない。 */
  portable?: boolean
  onSelectPage: (index: number) => void
  onAddPage: () => void
  onRenamePage: (index: number, name: string) => boolean
  onDuplicatePage: (index: number) => void
  onRemovePage: (index: number) => void
  canUndoPageRemoval?: boolean
  onSelectBlock: (id: string | null) => void
  onAddBlock: (block: FormBlock) => void
  onPatchBlock: (id: string, patch: Partial<FormBlock>) => void
  onMoveBlock: (id: string, to: number) => void
  onDuplicateBlock: (id: string) => void
  onRemoveBlock: (id: string) => void
  /** 答えで予約の行き先を分ける（B6）。決まりは回答フォームの版に含める。 */
  routing?: FormRouting
  onChangeRouting?: (next: FormRouting) => void
}

export function ContentTab(props: Props) {
  const { layout, page, blocks } = props
  const [renaming, setRenaming] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const section = layout.sections[page]

  const askRemoveSection = (index: number) => {
    if (props.readOnly || layout.sections.length <= 1 || !section) return
    setRemoving(true)
  }

  return (
    <>
      {props.nameField ? <Card layout="vertical" contentPadding="var(--tpl-fe-card-pad)" gap="var(--tpl-fe-card-gap)">{props.nameField}</Card> : null}
      <Card layout="vertical" contentPadding="var(--tpl-fe-card-pad)" gap="var(--tpl-fe-card-gap)" aria-labelledby="fe-pages-title">
        <div className={styles.cardHead}>
          <span className={styles.cardHeadText}>
            <h2 id="fe-pages-title" className={styles.cardTitle}>ページ</h2>
            <p className={styles.cardNote}>ページごとに「次へ」で進みます</p>
          </span>
          {props.readOnly ? null : <RowActions
            subjectName={`ページ「${section?.name ?? ''}」`}
            menuItems={[
              { id: 'rename', label: '名前を変える', onSelect: () => setRenaming(section?.name ?? '') },
              { id: 'duplicate', label: '複製する', onSelect: () => props.onDuplicatePage(page) },
            ]}
            destructiveItem={layout.sections.length > 1 ? {
              id: 'remove',
              label: 'このページを消す',
              onSelect: () => askRemoveSection(page),
            } : undefined}
          />}
        </div>
        <div className={styles.pageChips}>
          {layout.sections.map((s, index) => (
            <button
              key={s.id}
              type="button"
              className={styles.pageChip}
              data-current={index === page || undefined}
              aria-pressed={index === page}
              onClick={() => props.onSelectPage(index)}
            >
              {index + 1} {s.name}
            </button>
          ))}
          {props.readOnly ? null : <Button variant="text" onClick={props.onAddPage}>
            <Plus size={16} aria-hidden="true" />
            ページを足す
          </Button>}
        </div>
      </Card>

      {props.onChangeRouting ? <RoutingSection blocks={layout.sections.flatMap((s) => s.blocks)} refs={props.refs} routing={props.routing} readOnly={props.readOnly} onChange={props.onChangeRouting} /> : null}

      <Card layout="vertical" contentPadding="var(--tpl-fe-card-pad)" gap="var(--tpl-fe-card-gap)" aria-labelledby="fe-blocks-title">
        <div className={styles.cardHeadText}>
          <h2 id="fe-blocks-title" className={styles.cardTitle}>{`ページ${page + 1} のブロック`}</h2>
          <p className={styles.cardNote}>つまみで並べ替え。押すと設定が開きます</p>
        </div>
        {blocks.length === 0 ? (
          <p className={styles.emptyBlocks}>下の「ブロックを足す」から作ってください</p>
        ) : (
          blocks.map((block, index) =>
            props.readOnly ? (
              <div key={block.id} className={styles.blockRow}>
                <span className={styles.blockText}>
                  <span className={styles.blockTitle}>{blockTitleLine(block)}</span>
                  <span className={styles.blockKind}>{blockKindLine(block)}</span>
                </span>
              </div>
            ) : block.id === props.selectedBlockId ? (
              <OpenBlock key={block.id} block={block} index={index} {...props} />
            ) : (
              <BlockRow key={block.id} block={block} index={index} {...props} />
            ),
          )
        )}
        {props.readOnly ? null : <AddGrid hide={props.portable ? PORTABLE_HIDDEN_CARDS : undefined} onAdd={(make) => props.onAddBlock(make(props.inputCount))} />}
      </Card>

      <RenameDialog
        value={props.readOnly ? null : renaming}
        onCancel={() => setRenaming(null)}
        onSave={(next) => {
          if (props.onRenamePage(page, next)) setRenaming(null)
        }}
      />
      <Dialog
        open={!props.readOnly && removing}
        title="このページを消す"
        description={`「${section?.name ?? ''}」と、その中のブロック${section?.blocks.length ?? 0} 個を消します。${props.canUndoPageRemoval ? '保存する前なら「元に戻す」で戻せます。' : 'この操作は元に戻せません。'}`}
        confirmLabel="消す"
        onConfirm={() => {
          setRemoving(false)
          props.onRemovePage(page)
        }}
        onCancel={() => setRemoving(false)}
      >
        <p>集まった回答は消えません。</p>
        <p>このページへの分岐{section ? formJumpsInto(layout, section.id) : 0}件は「次へ進む」に戻します。</p>
      </Dialog>
    </>
  )
}

function RenameDialog({ value, onCancel, onSave }: { value: string | null; onCancel: () => void; onSave: (next: string) => void }) {
  const [draft, setDraft] = useState('')
  const [openedWith, setOpenedWith] = useState<string | null>(null)
  if (value !== openedWith) {
    setOpenedWith(value)
    setDraft(value ?? '')
  }
  return (
    <Dialog open={value !== null} title="ページの名前" confirmLabel="この名前にする" onConfirm={() => onSave(draft)} onCancel={onCancel}>
      <SaveErrorField names={["draft"]}><TextField aria-label="ページの名前" value={draft} onChange={(e) => setDraft(e.target.value)} /></SaveErrorField>
    </Dialog>
  )
}

/* ---------------- ブロックの行 ---------------- */

type RowProps = Props & { block: FormBlock; index: number }

/** つまみ：矢印キーで上下へ、つかんで落とす先の行へ。 */
function useRowDrag(props: RowProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      props.onMoveBlock(props.block.id, props.index + (event.key === 'ArrowUp' ? -1 : 1))
    }
  }
  const dragProps = {
    onDragOver: (event: DragEvent) => {
      if (event.dataTransfer.types.includes('text/x-form-block')) event.preventDefault()
    },
    onDrop: (event: DragEvent) => {
      const id = event.dataTransfer.getData('text/x-form-block')
      if (id) {
        event.preventDefault()
        props.onMoveBlock(id, props.index)
      }
    },
  }
  const handleProps = {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.setData('text/x-form-block', props.block.id)
      event.dataTransfer.effectAllowed = 'move'
    },
    onKeyDown,
  }
  return { dragProps, handleProps }
}

function rowMenu(props: RowProps, opened: boolean) {
  const { block, index, blocks } = props
  return {
    menuItems: [
      ...(opened ? [] : [{ id: 'open', label: '設定を開く', onSelect: () => props.onSelectBlock(block.id) }]),
      { id: 'duplicate', label: '複製する', onSelect: () => props.onDuplicateBlock(block.id) },
      { id: 'up', label: '上へ', disabled: index === 0, onSelect: () => props.onMoveBlock(block.id, index - 1) },
      { id: 'down', label: '下へ', disabled: index === blocks.length - 1, onSelect: () => props.onMoveBlock(block.id, index + 1) },
    ],
    destructiveItem: { id: 'remove', label: '消す', onSelect: () => props.onRemoveBlock(block.id) },
  }
}

function BlockRow(props: RowProps) {
  const { block } = props
  const { dragProps, handleProps } = useRowDrag(props)
  const title = blockTitleLine(block)
  return (
    <div className={styles.blockRow} {...dragProps}>
      <DragHandle label={`「${title}」を並べ替える`} className={styles.grip} {...handleProps} />
      <button type="button" className={styles.blockOpen} onClick={() => props.onSelectBlock(block.id)} aria-label={`「${title}」の設定を開く`}>
        <span className={styles.blockIcon}>{blockIcon(block)}</span>
        <span className={styles.blockText}>
          <span className={styles.blockTitle} title={title}>{title}</span>
          <span className={styles.blockKind}>{blockKindLine(block)}</span>
        </span>
      </button>
      <RowActions className={styles.more} subjectName={`「${title}」`} {...rowMenu(props, false)} />
    </div>
  )
}

/* ---------------- 開いたブロック ---------------- */

function OpenBlock(props: RowProps) {
  const { block, refs } = props
  const { dragProps, handleProps } = useRowDrag(props)
  const patch = (next: Partial<FormBlock>) => props.onPatchBlock(block.id, next)
  const input = block.kind === 'input' ? block : null
  const typeLabel = input ? inputTypeLabel(input) : blockTitleKind(block)
  const [detailOpen, setDetailOpen] = useState(false)
  const menu = rowMenu(props, true)
  const menuItems = [
    { id: 'close', label: '設定を閉じる', onSelect: () => props.onSelectBlock(null) },
    ...(input ? [{ id: 'detail', label: '詳しい設定（分岐・入力の形・説明）', onSelect: () => setDetailOpen(true) }] : []),
    ...menu.menuItems,
  ]
  return (
    <div className={styles.blockOpenCard} {...dragProps} data-block-kind={block.kind}>
      <div className={styles.openHead}>
        <DragHandle label={`「${blockTitleLine(block)}」を並べ替える`} className={styles.grip} {...handleProps} />
        <span className={styles.openType}>{typeLabel}</span>
        {input?.type === 'booking' ? <span className={styles.newBadge}>新</span> : null}
        <span className={styles.spacer} />
        {input ? (
          <label className={styles.required}>
            <span className={styles.requiredLabel}>必須</span>
            <SaveErrorField names={["required","input.required"]}><Toggle checked={input.required ?? false} onChange={(required) => patch({ required } as Partial<FormBlock>)} label="必須" /></SaveErrorField>
          </label>
        ) : null}
        <RowActions className={styles.more} subjectName={`「${blockTitleLine(block)}」`} menuItems={menuItems} destructiveItem={menu.destructiveItem} />
      </div>
      {input ? <InputFields block={input} refs={refs} patch={patch} accountId={props.accountId} portable={props.portable} /> : <DecoFields block={block} patch={patch} accountId={props.accountId} />}
      {input ? (
        <InlineSettings open={detailOpen} title={`「${blockTitleLine(block)}」の詳しい設定`} onClose={() => setDetailOpen(false)}>
          <BlockEditor block={block} index={props.index} sections={props.layout.sections} refs={refs} selected onSelect={() => {}} onChange={patch} />
        </InlineSettings>
      ) : null}
    </div>
  )
}

function Labeled({ label, htmlFor, required, children }: { label: string; htmlFor?: string; required?: boolean; children: ReactNode }) {
  return <Field label={label} htmlFor={htmlFor} required={required}>{children}</Field>
}

function InputFields({ block, refs, patch, accountId, portable = false }: { block: FormInputBlock; refs: FormRefs; patch: (next: Partial<FormBlock>) => void; accountId: string | null; portable?: boolean }) {
  const set = (next: Partial<FormInputBlock>) => patch(next as Partial<FormBlock>)
  const labelId = `fe-q-${block.id}`
  /* 保存を押したあと、質問文が空なら欄を赤くして真下に理由を出す。 */
  const labelError = useFormEditAttempted() && !block.label.trim() ? '質問文を入れてください' : null
  return (
    <>
      <Labeled label="質問文" htmlFor={labelId} required>
        <SaveErrorField names={["label","block.label"]}><TextField id={labelId} value={block.label} placeholder="質問の文" invalid={Boolean(labelError)} aria-describedby={labelError ? `${labelId}-error` : undefined} onChange={(e) => set({ label: e.target.value })} /></SaveErrorField>
        <FieldError id={`${labelId}-error`}>{labelError}</FieldError>
      </Labeled>
      {['text', 'textarea', 'address', 'date'].includes(block.type) ? (
        <Labeled label="参考の文字（入力欄の中に薄く出る）" htmlFor={`${labelId}-placeholder`}>
          <SaveErrorField names={["placeholder","block.placeholder"]}><TextField id={`${labelId}-placeholder`} value={block.placeholder ?? ''} placeholder="例：見本 141" onChange={(e) => set({ placeholder: e.target.value })} /></SaveErrorField>
        </Labeled>
      ) : null}
      {block.type === 'file' ? <FormFileSettings block={block} onChange={set} /> : null}
      {isChoiceType(block.type) ? <ChoiceFields block={block} set={set} /> : null}
      {block.fixedField === 'allergy' && accountId ? <AllergyOptionsSave accountId={accountId} block={block} set={set} /> : null}
      {block.type === 'booking' ? <BookingFields block={block} refs={refs} set={set} portable={portable} /> : <SaveTo block={block} refs={refs} set={set} />}
    </>
  )
}

function AllergyOptionsSave({accountId, block, set}: {accountId: string; block: FormInputBlock; set: (next: Partial<FormInputBlock>) => void}) {
  const saveErrors = useSaveFormErrors()
  const role = useStaffRole()
  const [version, setVersion] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const setRef = useRef(set); setRef.current = set
  useEffect(() => {
    let active = true
    setVersion(null); setMessage('')
    api.accountSettings.getAllergyOptions(accountId).then(result => {
      if (!active) return
      if (!result.success) throw new Error(result.error)
      setVersion(result.data.version)
      setRef.current({choices: [...result.data.options.map((label, i) => ({id: `allergy-${i}`, label})), {id: 'allergy-other', label: 'そのほか（自由に書く）', isOther: true}]})
    }).catch(() => { if (active) setMessage('店の選択肢を読み込めませんでした') })
    return () => { active = false }
  }, [accountId])
  return <SaveErrorScope errors={saveErrors}><p className={styles.cardNote}>この店の回答フォームと顧客情報で使う選択肢です。「そのほか」は自由に書けます。</p>
    {canManageRole(role) ? <Button disabled={version === null} busy={busy} onClick={async () => {
      if (version === null) return
      setBusy(true); setMessage('')
      try {
        const result = await api.accountSettings.saveAllergyOptions(accountId, (block.choices ?? []).filter(choice => !choice.isOther).map(choice => choice.label), version)
        if (!result.success || !result.data) throw new Error(result.error ?? '保存できませんでした。時間をおいて、もう一度お試しください。')
        setVersion(result.data.version); setMessage('店の選択肢を保存しました')
      } catch (error) { if(!saveErrors.capture(error)) setMessage(japaneseDetailOf(error) || '保存できませんでした。時間をおいて、もう一度お試しください。') }
      finally { setBusy(false) }
    }}>店の選択肢を保存する</Button> : null}
    {message ? <p role="status" className={styles.cardNote}>{message}</p> : null}</SaveErrorScope>
}

function ChoiceFields({ block, set }: { block: FormInputBlock; set: (next: Partial<FormInputBlock>) => void }) {
  const choices = block.choices ?? []
  const dragFrom = useRef<number | null>(null)
  const move = (from: number, to: number) => {
    if (to < 0 || to >= choices.length || from === to) return
    const next = [...choices]
    const [row] = next.splice(from, 1)
    next.splice(to, 0, row)
    set({ choices: next })
  }
  return (
    <>
      <p className={styles.subLabel}>選択肢</p>
      {choices.map((choice, index) => (
        <div
          key={choice.id}
          className={styles.choiceRow}
          onDragOver={(e) => { if (dragFrom.current !== null) e.preventDefault() }}
          onDrop={(e) => {
            e.preventDefault()
            if (dragFrom.current !== null) move(dragFrom.current, index)
            dragFrom.current = null
          }}
        >
          <DragHandle
            label={`選択肢「${choice.label}」を並べ替える`}
            className={styles.grip}
            draggable
            onDragStart={() => { dragFrom.current = index }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault()
                move(index, index + (e.key === 'ArrowUp' ? -1 : 1))
              }
            }}
          />
          <SaveErrorField names={[`choices.${index}.label`,"label","choice.label"]}><TextField
            aria-label={`選択肢${index + 1}`}
            className={styles.choiceInput}
            value={choice.label}
            readOnly={block.fixedField === 'allergy' && choice.isOther}
            onChange={(e) => set({ choices: choices.map((c, i) => (i === index ? { ...c, label: e.target.value } : c)) })}
          /></SaveErrorField>
          <button
            type="button"
            className={styles.choiceRemove}
            aria-label={`選択肢「${choice.label}」を消す`}
            disabled={choices.length <= 1 || (block.fixedField === 'allergy' && choice.isOther)}
            title={block.fixedField === 'allergy' && choice.isOther ? '自由に書く選択肢は、アレルギーの書き足しに使うため消せません' : choices.length <= 1 ? '選択肢を1つ以上残してください' : undefined}
            onClick={() => set({ choices: choices.filter((_, i) => i !== index) })}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
      <span>
        <Button variant="text" onClick={() => set({ choices: [...choices, { id: newBlockId('c'), label: `選択肢${choices.length + 1}` }] })}>
          <Plus size={16} aria-hidden="true" />
          選択肢を足す
        </Button>
      </span>
    </>
  )
}

/** 答えを保存する先（友だち情報の項目）。本名・表示名・メモへの保存は「詳しい設定」。 */
function SaveTo({ block, refs, set }: { block: FormInputBlock; refs: FormRefs; set: (next: Partial<FormInputBlock>) => void }) {
  const fixedKey = block.fixedField ?? (block.destinations?.realName ? undefined : fixedFieldForBlock(block))
  // 決まった欄は変えられない。ほかの保存先と同じ欄の形で、読むだけで出す。
  if (fixedKey) {
    const fixedLabel = `${FIXED_FRIEND_FIELDS.find(f => f.key === fixedKey)?.label ?? ''}（決まった欄）`
    return <div className={styles.saveTo}>
      <span className={styles.fieldLabel}>答えを保存する先</span>
      <span className={styles.saveSelect}>
        <EntitySelect aria-label="答えを保存する先" size="full" readOnly actionHidden value={fixedKey} onChange={() => {}} options={[{ value: fixedKey, label: fixedLabel }]} />
      </span>
    </div>
  }
  const current = block.destinations?.friendFieldIds?.[0] ?? ''
  const options = [
    { value: '', label: '保存しない' },
    ...refs.friendFields.map((f) => ({ value: f.id, label: `友だち情報「${f.name}」`, disabled: f.ecIsMaster })),
  ]
  if (current && !refs.friendFields.some((f) => f.id === current)) options.push({ value: current, label: '友だち情報「（消えた項目）」', disabled: false })
  return (
    <div className={styles.saveTo}>
      <span className={styles.fieldLabel}>答えを保存する先</span>
      <span className={styles.saveSelect}>
        <SaveErrorField names={["current"]}><EntitySelect
          aria-label="答えを保存する先"
          size="full"
          value={current}
          onChange={(value) => {
            const rest = (block.destinations?.friendFieldIds ?? []).slice(1)
            set({ destinations: value ? { ...block.destinations, friendFieldIds: [value, ...rest.filter((id) => id !== value)] } : { friendFieldIds: [] } })
          }}
          options={options}
        /></SaveErrorField>
      </span>
    </div>
  )
}

const DAYS_AHEAD = [7, 14, 30, 60]
const noMeta = () => undefined

function BookingFields({ block, refs, set, portable = false }: { block: FormInputBlock; refs: FormRefs; set: (next: Partial<FormInputBlock>) => void; portable?: boolean }) {
  const booking = block.booking ?? null
  const menus = refs.bookingMenus ?? []
  const staff = booking?.menuId ? (refs.bookingMenuStaff?.[booking.menuId] ?? []) : []
  const days = booking?.daysAhead ?? 14
  const menuOptions = useMemo(() => menus.map((menu) => ({ ...menu, name: `${menu.name}・${menu.durationMinutes}分` })), [menus])
  const setBooking = (next: Partial<NonNullable<FormInputBlock['booking']>>) =>
    set({ booking: { ...booking, menuId: booking?.menuId ?? '', staffId: booking?.staffId ?? null, daysAhead: days, ...next } })
  return (
    <>
      <div className={styles.bookingRow}>
        <Labeled label="メニュー">
          {/* 統括のひな形（N4T9mO）：メニューは店ごとにあり、統括の口には一覧が無い（機能待ち）。読み込み中で止めず、押せない形で決まりを書く。 */}
          {portable ? <EntityKindField kind="booking_menu" label="メニュー" options={[]} value="" onChange={() => {}} disabled disabledReason="配った先の店のメニューから選びます" placeholder="配った先の店のメニューから選びます" meta={noMeta} /> :
          <SaveErrorField names={["menuId","booking?.menuId","booking"]}><EntityKindField
            kind="booking_menu"
            label="メニュー"
            /* 絵 ：欄は「名前・かかる時間」の1つの札（横の補足は出さず、狭い列でも名前を残す）。 */
            options={menuOptions}
            value={booking?.menuId ?? ''}
            onChange={(menuId) => setBooking({ menuId, staffId: null })}
            placeholder={menus.length ? '（メニューを選ぶ）' : '（メニューがありません）'}
            meta={noMeta}
            actionHidden="label"
          /></SaveErrorField>}
        </Labeled>
        <Labeled label="担当">
          <SaveErrorField names={["staffId","booking?.staffId","booking"]}><EntityKindField
            kind="staff"
            label="担当"
            options={staff}
            value={booking?.staffId ?? ''}
            onChange={(staffId) => setBooking({ staffId: staffId || null })}
            clearable
            placeholder="（だれでも）"
          /></SaveErrorField>
        </Labeled>
        <Labeled label="選べる期間">
          <SaveErrorField names={["days","booking","daysAhead"]}><Select
            aria-label="選べる期間"
            size="full"
            value={String(days)}
            onChange={(value) => setBooking({ daysAhead: Number(value) })}
            options={(DAYS_AHEAD.includes(days) ? DAYS_AHEAD : [...DAYS_AHEAD, days].sort((a, b) => a - b)).map((d) => ({ value: String(d), label: `今日から ${d}日` }))}
          /></SaveErrorField>
        </Labeled>
      </div>
      {/* 保存済みの決まりを案内する。切替を足す場合は回答側の選択画面も合わせる。 */}
      <p className={styles.bookingRule}>
        <span>メニューを選んでもらう</span>
        <span className={styles.bookingRuleValue}>上のメニューで決まり</span>
      </p>
      <p className={styles.bookingRule}>
        <span>予約は「未承認」で入れて、店が承認する</span>
        <span className={styles.bookingRuleValue}>{booking?.requireApproval === true ? '店が承認します' : '予約の設定どおり'}</span>
      </p>
      <div className={styles.bookingInfo}>
        <CalendarCheck size={16} aria-hidden="true" className={styles.bookingInfoIcon} />
        <p className={styles.bookingInfoText}>空いている枠は「予約」の営業時間と担当の予定から出します。入った予約は予約の一覧に入り、リマインダも動きます。</p>
        <TextLink external href="/booking/menus" className={styles.bookingLink}>

          予約メニューへ
        </TextLink>
      </div>
    </>
  )
}

/* リンクのボタンの押したら（共通の欄・YPzmo・）。保存は今のまま開く URL の文字だけ。 */
function ButtonTapField({ id, url, accountId, onChange, name = 'このボタン' }: { id: string; url: string; accountId: string | null; onChange: (url: string) => void; name?: string }) {
  return (
    <div className={`${styles.field} ${styles.decoTap}`} id={`${id}-url`}>
      <span className={styles.fieldLabel}>押したら</span>
      <UriTapActionField name={name} url={url} accountId={accountId} onChange={onChange} />
    </div>
  )
}

function DecoFields({ block, patch, accountId }: { block: FormBlock; patch: (next: Partial<FormBlock>) => void; accountId: string | null }) {
  const [picking, setPicking] = useState(false)
  const id = `fe-deco-${block.id}`
  switch (block.kind) {
    case 'heading':
      return (
        <div className={styles.decoRow}>
          <Labeled label="見出し" htmlFor={id}>
            <SaveErrorField names={["text","block.text"]}><TextField id={id} value={block.text} onChange={(e) => patch({ text: e.target.value } as Partial<FormBlock>)} /></SaveErrorField>
          </Labeled>
          <Labeled label="大きさ">
            <SaveErrorField names={["level","block.level"]}><Select aria-label="大きさ" value={String(block.level ?? 2)} onChange={(v) => patch({ level: Number(v) as 1 | 2 | 3 } as Partial<FormBlock>)} options={[{ value: '1', label: '見出し1' }, { value: '2', label: '見出し2' }, { value: '3', label: '見出し3' }]} /></SaveErrorField>
          </Labeled>
        </div>
      )
    case 'text':
      return (
        <Labeled label="本文" htmlFor={id}>
          <SaveErrorField names={["text","block.text"]}><TextArea id={id} rows={3} value={block.text} onChange={(e) => patch({ text: e.target.value } as Partial<FormBlock>)} /></SaveErrorField>
        </Labeled>
      )
    case 'button':
      return (
        <div className={styles.decoRow}>
          <Labeled label="ボタンの文字" htmlFor={id}>
            <SaveErrorField names={["label","block.label"]}><TextField id={id} value={block.label} onChange={(e) => patch({ label: e.target.value } as Partial<FormBlock>)} /></SaveErrorField>
          </Labeled>
          <ButtonTapField id={id} url={block.url} accountId={accountId} onChange={(url) => patch({ url } as Partial<FormBlock>)} />
        </div>
      )
    case 'image':
      return (
        <>
          <div className={styles.decoRow}>
            <SaveErrorField names={["mediaUrl","block.mediaUrl","media_url","block.media_url"]}><ImageFrame
              title="画像を追加"
              previewAlt={block.alt || "フォームの画像"}
              value={block.mediaUrl || null}
              accept="image/jpeg,image/png,image/gif,image/webp"
              upload={async (file, progress) => accountId ? (await uploadToMediaLibrary(file, accountId, 'image', progress)).url : uploadImageFile(file)}
              onChange={(url) => patch({ mediaUrl: url ?? '' } as Partial<FormBlock>)}
              onMediaPick={() => setPicking(true)}
              urlEntry={{ value: block.mediaUrl, onChange: (url) => patch({ mediaUrl: url } as Partial<FormBlock>), label: '画像のURL', placeholder: 'https://...' }}
            /></SaveErrorField>
            <Labeled label="代わりの文" htmlFor={`${id}-alt`}>
              <SaveErrorField names={["linkUrl","block.linkUrl","link_url","block.link_url"]}><TextField id={`${id}-alt`} value={block.alt ?? ''} onChange={(e) => patch({ alt: e.target.value } as Partial<FormBlock>)} /></SaveErrorField>
            </Labeled>
            <ButtonTapField id={`${id}-link`} name="この画像" url={block.linkUrl ?? ''} accountId={accountId} onChange={url => patch({ linkUrl: url } as Partial<FormBlock>)} />
          </div>
          <MediaPickerDialog
            open={picking}
            accountId={accountId}
            kind="image"
            onClose={() => setPicking(false)}
            onSelect={(item) => {
              patch({ mediaUrl: item.url } as Partial<FormBlock>)
              setPicking(false)
            }}
          />
        </>
      )
    default:
      return null
  }
}

/** 統括も画像を追加できる。固有の参照は保存前に別途確認する。 */
const PORTABLE_HIDDEN_CARDS: ReadonlySet<string> = new Set()
