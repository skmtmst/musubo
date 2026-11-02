'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import dynamic from 'next/dynamic'
import TagPickerField from './tag-picker-field'
import {
  Bell, BookOpen, CalendarDays, ClipboardList, FileText, LayoutGrid, Tag as TagIcon, UserRound, Workflow, type LucideIcon,
} from 'lucide-react'
import type { FormLayout } from '@line-crm/shared'
import { api } from '@/lib/api'
import * as accountContext from '@/contexts/account-context'
import { LinePreviewFlex as FlexPreview } from '@/components/shared/line-preview'
import LinePreview, { LinePreviewMessage } from './line-preview'
import ListState from './list-state'
import { buildTemplatePreview, EMPTY_TEMPLATE_REFERENCES } from '../templates/template-preview-model'
import { EntityPickerDialog, EntityPickerField, type EntityPickerCategory, type EntityPickerFolder, type EntityPickerItem } from './entity-picker'
import { ENTITY_KINDS, TEMPLATE_CATEGORIES, toPickerItems, useEntityFolders, useMaybeAccount, type EntityKind, type EntityLike } from './entity-picker-data'

/*
 * 作ってあるものを選ぶ窓（EntityPicker）の、種類ごとの決まり。
 * - 名前・印・作る画面へのリンク・フォルダの読み込み口（一覧と同じ API）
 * - 候補の変換（API の行 → EntityPickerItem）
 * - 中身の見本（テンプレート＝LINE のトークのスマホ、回答フォーム＝お客さまのスマホ）。
 *   見本の無い種類（シナリオ・タグなど）は見本の列を出さない。
 * データは今の画面が読んでいる行をそのまま渡す。窓を開いたときだけフォルダ・見本を読む。
 */

const FormPhone = dynamic(() => import('../../v8/form-edit/phone/index').then((mod) => mod.FormPhone), { ssr: false, loading: () => <ListState kind="loading" /> })

export { ENTITY_KINDS, TEMPLATE_CATEGORIES, toPickerItems, useEntityFolders } from './entity-picker-data'
export type { EntityKind,EntityLike
    } from './entity-picker-data'

/** テンプレートの中身の見本（LINE のトーク画面のスマホ）。 */
export function TemplatePreviewPhone({ templateId, accountName }: { templateId: string | null; accountName?: string }) {
  const [state, setState] = useState<{ id: string; type: string; content: string } | 'loading' | 'error' | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!templateId) { setState(null); return }
    let current = true
    setState('loading')
    Promise.resolve().then(() => api.templates.get(templateId))
      .then((res) => {
        if (!current) return
        if (!res?.success) throw new Error('template')
        setState({ id: templateId, type: res.data.messageType, content: res.data.messageContent })
      })
      .catch(() => { if (current) setState('error') })
    return () => { current = false }
  }, [templateId, attempt])
  const name = accountName || '公式アカウント'
  return <LinePreview fit title="中身の見本" accountName={name} empty={!templateId ? '候補を選ぶと LINE での見え方が出ます' : false}>
    {state === 'loading' ? <ListState kind="loading" />
      : state === 'error' ? <ListState kind="error" error={new Error('template')} onRetry={() => setAttempt((value) => value + 1)} />
      : state === null ? null
      : state.type === 'flex' || state.type === 'carousel' ? <FlexPreview content={state.content} />
      : state.type === 'text' ? <LinePreviewMessage accountName={name} avatar={name.slice(0, 1)} time="10:00">{buildTemplatePreview(state.content, EMPTY_TEMPLATE_REFERENCES).content || '（本文なし）'}</LinePreviewMessage>
      : <LinePreviewMessage accountName={name} avatar={name.slice(0, 1)} time="10:00">{`${TEMPLATE_CATEGORIES.find((c) => c.id === state.type)?.label ?? 'メッセージ'}を送ります`}</LinePreviewMessage>}
  </LinePreview>
}

/** 回答フォームの中身の見本（お客さまのスマホ・LINE で開いた時）。 */
export function FormPreviewPhone({ formId, accountId, accountName }: { formId: string | null; accountId?: string | null; accountName?: string }) {
  const [state, setState] = useState<{ name: string; layout: FormLayout } | 'loading' | 'error' | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!formId || !accountId) { setState(null); return }
    let current = true
    setState('loading')
    Promise.resolve().then(() => api.forms.get(formId, accountId))
      .then((res) => { if (!current) return; if (!res?.success) throw new Error('form'); setState({ name: res.data.name, layout: res.data.layout }) })
      .catch(() => { if (current) setState('error') })
    return () => { current = false }
  }, [formId, accountId, attempt])
  if (!formId) return <p className="text-ink-secondary text-xs">候補を選ぶと、お客さまのスマホでの見え方が出ます。</p>
  if (state === 'loading' || state === null) return <ListState kind="loading" />
  if (state === 'error') return <ListState kind="error" error={new Error('form')} onRetry={() => setAttempt((value) => value + 1)} />
  return <FormPhone formName={state.name} layout={state.layout} pageIndex={0} accountName={accountName || '公式アカウント'} bookingMenus={[]} />
}

type KindFieldBase = {
  kind: EntityKind
  label: string
  options: ReadonlyArray<EntityLike>
  candidatesStatus?: 'loading' | 'ready' | 'error'
  onRetryCandidates?: () => void
  /** 右の補足を差し替える（既定は更新日・停止中）。 */
  meta?: (row: EntityLike) => string | undefined
  /** フォルダの読み込み先のアカウント（既定は上のバーで選んでいるアカウント）。 */
  accountId?: string | null
  placeholder?: string
  disabled?: boolean
  disabledReason?: string
  lockedReason?: string
  canChangeNow?: () => boolean
  /** タグを作る権限は、既存のタグを選ぶ権限とは別に渡す。 */
  createDisabled?: boolean
  createLockedReason?: string
  canCreateNow?: () => boolean
  readOnly?: boolean
  invalid?: boolean
  description?: string
  id?: string
  /** 中身の見本を出さない（狭い所・中身の無い種類）。 */
  noPreview?: boolean
  /** 'label'＝狭い列で「変える」の文字を外し › だけ残す。 */
  actionHidden?: boolean | 'label'
  /** 誤りの欄へ移るときに［選ぶ］ボタンをつかむ。 */
  buttonRef?: Ref<HTMLButtonElement>
  /** 欄の下の誤り・説明の id。 */
  describedBy?: string
  'aria-describedby'?: string
}

/**
 * 種類を渡すだけで使える欄。名前・印・作る画面・フォルダ・中身の見本は種類から決める。
 * 保存する値（ID）は今と同じ形で返す。
 */
export function EntityKindField(props: KindFieldBase & ({ multiple?: false; value: string | null | undefined; onChange: (id: string) => void; clearable?: boolean } | { multiple: true; value: string[]; onChange: (ids: string[]) => void; allowEmpty?: boolean })) {
  const { kind, label, options, meta, placeholder, disabled, disabledReason, readOnly, invalid, description, id, noPreview, buttonRef, describedBy: suppliedDescription } = props
  const describedBy = [suppliedDescription, props['aria-describedby']].filter(Boolean).join(' ') || undefined
  const account = useMaybeAccount()
  const accountId = props.accountId === undefined ? account?.selectedAccountId ?? null : props.accountId
  const accountName = account?.selectedAccount?.name
  const def = ENTITY_KINDS[kind]
  const items = useMemo(() => toPickerItems(kind, options, meta), [kind, options, meta])
  const hasFolderInfo = items.some((item) => item.folderId !== undefined)
  const { folders, failed, load } = useEntityFolders(kind, accountId)
  const candidatesPending = props.candidatesStatus === 'loading' || props.candidatesStatus === 'error'
  const common = {
    label, noun: def.noun, icon: def.icon, items, candidatesStatus: props.candidatesStatus, folders: hasFolderInfo ? folders : undefined, foldersFailed: hasFolderInfo && failed,
    onOpen: hasFolderInfo ? load : undefined, placeholder, disabled, disabledReason, readOnly, invalid, description, id, buttonRef, describedBy,
    state: props.candidatesStatus === 'loading' ? <ListState kind="loading" /> : props.candidatesStatus === 'error' ? <ListState kind="error" title={`${def.noun}を読み込めませんでした`} onRetry={props.onRetryCandidates} /> : undefined,
    createHref: candidatesPending ? undefined : def.createHref, createLabel: def.createLabel, actionHidden: props.actionHidden, lockedReason: props.lockedReason, canChangeNow: props.canChangeNow,
  }
  if (kind === 'tag') {
    return <TagPickerField id={id} buttonRef={buttonRef} describedBy={describedBy} multiple={Boolean(props.multiple)} label={label} options={options.map(row => ({ id: row.id, name: row.name ?? row.label ?? '', groupId: row.groupId }))} accountId={accountId} value={props.multiple ? props.value : props.value ? [props.value] : []} onChange={ids => props.multiple ? props.onChange(ids) : props.onChange(ids[0] ?? '')} disabled={disabled} disabledReason={disabledReason} readOnly={readOnly} invalid={invalid} lockedReason={props.lockedReason} canChangeNow={props.canChangeNow} createDisabled={props.createDisabled} createLockedReason={props.createLockedReason} canCreateNow={props.canCreateNow} />
  }
  if (props.multiple) {
    return <EntityPickerField {...common} multiple value={props.value} onChange={props.onChange} unit={def.unit} allowEmpty={props.allowEmpty ?? true} />
  }
  const preview: ((item: EntityPickerItem | null) => ReactNode) | undefined = noPreview ? undefined
    : kind === 'template' ? (item) => <TemplatePreviewPhone templateId={item?.id ?? null} accountName={accountName} />
    : kind === 'form' ? (item) => <FormPreviewPhone formId={item?.id ?? null} accountId={accountId} accountName={accountName} />
    : undefined
  const categories = kind === 'template' ? TEMPLATE_CATEGORIES.filter((c) => items.some((item) => item.category === c.id)) : undefined
  return <EntityPickerField {...common} value={props.value} onChange={props.onChange} clearable={props.clearable} preview={preview} categories={categories && categories.length > 1 ? categories : undefined} />
}

/** 欄を使わず窓だけを開く（「テンプレートを選択」ボタンから本文へ入れる など）。 */
export function EntityKindDialog({ kind, options, initialId = '', confirmLabel, accountId: givenAccountId, onConfirm, onCancel, confirmDisabled, confirmLockedReason, canChangeNow }: {
  kind: EntityKind
  options: ReadonlyArray<EntityLike>
  initialId?: string
  confirmLabel?: string
  confirmDisabled?: boolean
  confirmLockedReason?: string
  canChangeNow?: () => boolean
  accountId?: string | null
  onConfirm: (id: string) => void
  onCancel: () => void
}) {
  const account = useMaybeAccount()
  const accountId = givenAccountId ?? account?.selectedAccountId ?? null
  const def = ENTITY_KINDS[kind]
  const items = useMemo(() => toPickerItems(kind, options), [kind, options])
  const { folders, failed, load } = useEntityFolders(kind, accountId)
  const hasFolderInfo = items.some((item) => item.folderId !== undefined)
  useEffect(() => { if (hasFolderInfo) load() }, [hasFolderInfo, load])
  const preview = kind === 'template' ? (item: EntityPickerItem | null) => <TemplatePreviewPhone templateId={item?.id ?? null} accountName={account?.selectedAccount?.name} />
    : kind === 'form' ? (item: EntityPickerItem | null) => <FormPreviewPhone formId={item?.id ?? null} accountId={accountId} accountName={account?.selectedAccount?.name} />
    : undefined
  const categories = kind === 'template' ? TEMPLATE_CATEGORIES.filter((c) => items.some((item) => item.category === c.id)) : []
  return <EntityPickerDialog title={`${def.noun}を選ぶ`} items={items} folders={hasFolderInfo ? folders : undefined} foldersFailed={hasFolderInfo && failed}
    categories={categories.length > 1 ? categories : undefined} initialId={initialId} preview={preview} confirmLabel={confirmLabel} confirmDisabled={confirmDisabled} confirmLockedReason={confirmLockedReason} canChangeNow={canChangeNow}
    description={kind === 'form' ? 'ボタンを押したときに開く回答フォームを1つ選びます。' : undefined} searchPlaceholder={kind === 'form' ? `${def.noun}名で探す` : undefined}
    createHref={def.createHref} createLabel={def.createLabel} designNode="dJZ7Q" onConfirm={onConfirm} onCancel={onCancel} />
}
