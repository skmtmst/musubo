'use client'

import dynamic from 'next/dynamic'
import { useId } from 'react'
import type { ReactNode } from 'react'
import { EntityPickerField, type EntityPickerFolder } from './entity-picker'
import { ENTITY_KINDS, useEntityFolders, useMaybeAccount, type EntityKind } from './entity-picker-data'

const TemplatePreviewPhone = dynamic(() => import('./entity-picker-sources').then((module) => module.TemplatePreviewPhone), { ssr: false })
const FormPreviewPhone = dynamic(() => import('./entity-picker-sources').then((module) => module.FormPreviewPhone), { ssr: false })
import { isAllOption, splitOptionHeads } from './select-menu'
import type { SelectOption } from './select'
import selectStyles from './select.module.css'

export type EntitySelectOption = SelectOption & {
  color?: string | null
  hint?: string
  locked?: boolean
  folderId?: string | null
  folderName?: string
  folderColor?: string | null
  content?: string
}

/** 呼び出し元の一覧が持っているフォルダと本文を、選ぶ窓へ落とさず渡す。 */
export function entityOptionMetadata(row: object): Pick<EntitySelectOption, 'folderId' | 'folderName' | 'folderColor' | 'content'> {
  const data = row as Record<string, unknown>
  const folder = data.folderId ?? data.folder_id ?? data.groupId
  const hasFolder = 'folderId' in data || 'folder_id' in data || 'groupId' in data
  return {
    ...(hasFolder ? { folderId: typeof folder === 'string' ? folder : null } : {}),
    folderName: typeof data.folderName === 'string' ? data.folderName : typeof data.groupName === 'string' ? data.groupName : undefined,
    folderColor: typeof data.folderColor === 'string' ? data.folderColor : typeof data.groupColor === 'string' ? data.groupColor : undefined,
    content: typeof data.messageContent === 'string' && (data.messageType === 'text' || data.type === 'text') ? data.messageContent : undefined,
  }
}

type CommonProps = {
  'aria-label': string
  'aria-describedby'?: string
  options: EntitySelectOption[]
  kind?: EntityKind
  noun?: string
  className?: string
  disabled?: boolean
  disabledReason?: string
  lockedReason?: string
  readOnly?: boolean
  /** 移行前のComboboxなど、任意の選択を空へ戻せる欄。 */
  clearable?: boolean
  error?: string
  invalid?: boolean
  id?: string
  name?: string
  label?: string
  /** 絞り込みの欄で、選んだ値の前に項目名を残す。窓の候補名は変えない。 */
  valuePrefix?: string
  placeholder?: string
  loading?: boolean
  candidatesStatus?: 'loading' | 'ready' | 'error'
  createLabel?: (query: string) => string
  onCreate?: (query: string) => void
  defaultOpen?: boolean
  size?: 'standard' | 'page-size' | 'full' | 'content'
  width?: number
  /** 選択した名前が長い小さな設定欄だけ、札を小さい口で出す。 */
  compact?: boolean
  /** 狭い頭の欄（会話の頭の担当 ）：欄全体が押す口なので「変える ›」を出さず、名前の札だけにする。 */
  actionHidden?: boolean
  /** 呼び出し元の印は欄に入れず、窓を開く操作の意味を共通にする。 */
  icon?: ReactNode
  /** 移行前のSelectと同じ呼び出し口。 */
  treatment?: 'box' | 'text' | 'pill'
  menuHeading?: string
}
export type EntitySelectProps = CommonProps & ({
  value: string
  onChange: (value: string) => void
  values?: never
} | {
  values: string[]
  onChange: (values: string[]) => void
  value?: never
})

/** 作ってある物専用の選択欄。値と保存処理はSelectと同じ、確定までは下書き。 */
export default function EntitySelect(props: EntitySelectProps) {
  const { 'aria-label': label, options, kind, disabled, readOnly, error, invalid, className, id, name, loading, size = props.values !== undefined ? 'full' : 'standard', width } = props
  const account = useMaybeAccount()
  const errorId = `${useId()}-error`
  const { folders: loadedFolders, failed, load } = useEntityFolders(kind ?? 'staff', account?.selectedAccountId)
  const heads = splitOptionHeads(options, props.label)
  const items = options.map((option) => ({ id: option.value, name: heads.labelOf(option), color: option.color, disabled: option.disabled, locked: option.locked,
    folderId: option.folderId, content: option.content, meta: option.description ?? option.hint }))
  const localFolders: EntityPickerFolder[] = [...new Map(options.filter((option) => option.folderId && option.folderName)
    .map((option) => [option.folderId!, { id: option.folderId!, name: option.folderName!, color: option.folderColor }])).values()]
  const hasFolderInfo = items.some((item) => item.folderId !== undefined)
  const noun = props.noun ?? (kind ? ENTITY_KINDS[kind].noun : props.label ?? label.replace(/で絞り込む.*$|を変える$|を選ぶ$/, ''))
  const common = {
    compact: props.compact, label, ariaLabel: label, noun, items, candidatesStatus: props.candidatesStatus, createHref: kind ? ENTITY_KINDS[kind].createHref : undefined, createLabel: kind ? ENTITY_KINDS[kind].createLabel : undefined, folders: loadedFolders ?? localFolders, foldersFailed: failed,
    onOpen: hasFolderInfo && kind ? load : undefined, disabled, disabledReason: props.disabledReason, lockedReason: props.lockedReason, readOnly, invalid: Boolean(error) || invalid, id,
    placeholder: props.placeholder ?? options.find((option) => option.value === '')?.label ?? `${noun}を選ぶ`,
    state: loading ? <p role="status">読み込んでいます。</p> : undefined,
    describedBy: [props['aria-describedby'], error ? errorId : undefined].filter(Boolean).join(' ') || undefined, defaultOpen: props.defaultOpen, valuePrefix: props.valuePrefix, actionHidden: props.actionHidden,
  }
  const defaultValue = props.values === undefined && (options.some(option => option.value === props.value && isAllOption(option)) || (!props.value && /すべて/.test(props.placeholder ?? '')))
  return <div className={[selectStyles.root, selectStyles[size === 'page-size' ? 'pageSize' : size], className].filter(Boolean).join(' ')} style={width ? { width, maxWidth: '100%', flexShrink: 0 } : undefined} data-entity-picker-field data-entity-default={defaultValue || undefined} data-entity-content={size === 'content' || undefined}>
    {name ? <input type="hidden" name={name} value={props.values ? props.values.join(',') : props.value} disabled={disabled} /> : null}
    {props.values !== undefined ? <EntityPickerField key={account?.selectedAccountId ?? 'unscoped'} {...common} multiple value={props.values} onChange={props.onChange} />
      : <EntityPickerField key={account?.selectedAccountId ?? 'unscoped'} {...common} value={props.value} onChange={props.onChange} clearable={props.clearable}
        createAction={props.onCreate ? { onCreate: props.onCreate, label: props.createLabel ?? ((query) => `「${query}」を作る`) } : undefined}
        preview={kind === 'template' ? (item) => item?.id ? <TemplatePreviewPhone templateId={item.id} accountName={account?.selectedAccount?.name} /> : null
          : kind === 'form' ? (item) => item?.id ? <FormPreviewPhone formId={item.id} accountId={account?.selectedAccountId} accountName={account?.selectedAccount?.name} /> : null : undefined} />}
    {error ? <p className={selectStyles.error} id={errorId} role="alert">{error}</p> : null}
  </div>
}
