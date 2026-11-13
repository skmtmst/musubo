'use client'
import TextLink from '@/components/shared/text-link'
import FilterLink from '@/components/shared/filter-link'
import HelpTip from '@/components/shared/help-tip'
import Link from '@/components/shared/list-navigation'
import { ArrowUpRight, Lock } from 'lucide-react'
import { BASIC_FRIEND_FIELDS, ageFromBirthday, type FriendField } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import DateField, { formatLabel as formatDateLabel } from '@/components/shared/date-field'
import Select from '@/components/shared/select'
import { FIELD_TYPE_LABELS } from '@/components/friend-fields/field-list'
import { TextArea, TextField } from '@/components/shared/text-field'
import type { FriendDetailState } from './use-friend-detail'
import type { FriendDetailPermissions } from './permissions'
import { fixedFieldValue } from '@/components/shared/fixed-friend-field-values'
import styles from './detail.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { DetailLoading } from '@/components/templates/detail-page'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import ListState from '@/components/shared/list-state'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import AllergyField from '@/components/shared/allergy-field'
import Notice from '@/components/shared/notice'
import { formatNumber } from '@/lib/format'

/*
 * 情報欄タブ（ の 4.）。その人について決めた項目を2列に並べ、最後に1回保存する。
 * 分類（すべて・基本・フォルダ）は URL の group で選ぶ（FRIEND-21・今と同じ指定）。
 * 権限が無い人は欄を読み取りだけにし、保存ボタンを置かずに理由だけ出す（N-045）。
 */

/** 種類の名前は絵では出さない。ラベルの title で読めるようにする。 */
export const BASIC_GROUP = 'basic'
export const ALL_GROUP = 'all'
export const DINING_GROUP = '__dining__'
export const UNFILED_GROUP = '__unfiled__'

function FieldInput({ field, value, onChange, disabled, computed = false, id }: {
  field: FriendField
  value: string
  onChange: (v: string) => void
  disabled: boolean
  /** ほかの値から計算した値（年齢＝生年月日から）。灰色の読むだけの欄で見せる。 */
  computed?: boolean
  id: string
}) {
  // 変えられないとき（権限が無い・ECが正本の項目）は、押せない部品を置かずに読み取りだけの欄で見せる（2026-10-06 オーナー決定）。
  const readOnly = disabled || !!field.ecIsMaster
  if (field.fixedKey === 'allergy') return <AllergyField showEmptyValue={readOnly} value={value} options={field.options ?? undefined} readOnly={readOnly} onChange={onChange} />
  if (field.type === 'textarea') {
    return <SaveErrorField names={["value"]}><TextArea id={id} rows={3} value={value} readOnly={readOnly} aria-readonly={readOnly || undefined} onChange={(e) => onChange(e.target.value)} /></SaveErrorField>
  }
  if (field.type === 'multi_select') {
    // 複数選択を単一選択で保存すると既存の複数値が黙って上書きされる（#496-16）。読むだけ。
    const parts = value ? value.split(/[,、]\s*/).filter(Boolean) : []
    return (
      <div className={styles.multi} aria-labelledby={`${id}-label`}>
        {parts.length ? parts.map((p) => <span key={p} className={styles.tag}>{p}</span>) : <span className={styles.faint}>{emptyValue('unconfigured')}</span>}
      </div>
    )
  }
  if (readOnly && (field.type === 'select' || field.type === 'checkbox' || field.type === 'date')) {
    // 選ぶ部品は置かず、選んでいる値を文字で見せる。
    const ymd = field.type === 'date' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null
    // 日付はほかの日付の欄と同じ「2026年9月15日（火）」の書き方で見せる。
    const shown = field.type === 'checkbox' ? (value === '1' ? 'はい' : 'いいえ') : ymd ? formatDateLabel(new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))) : (value || emptyValue('unconfigured'))
    // EC が正本の値は、年齢と同じ灰色の読むだけの欄にする。
    return <SaveErrorField names={["shown"]}><TextField id={id} value={field.type === 'checkbox' || value ? shown : ''} placeholder="（未設定）" readOnly disabled={!!field.ecIsMaster} aria-readonly="true" aria-label={`${field.name}の値`} title={shown} /></SaveErrorField>
  }
  if (field.type === 'select') {
    return (
      <SaveErrorField names={["value"]}><Select
        id={id}
        size="full"
        value={value}
        onChange={(v) => onChange(v)}
        aria-label={`${field.name}の値`}
        options={[{ value: '', label: '— 未設定 —' }, ...(field.options ?? []).map((o) => ({ value: o, label: o }))]}
      /></SaveErrorField>
    )
  }
  if (field.type === 'checkbox') {
    return (
      <SaveErrorField names={["value"]}><Checkbox id={id} checked={value === '1'} onCheckedChange={(c) => onChange(c ? '1' : '')} aria-label={`${field.name}：はい`}>はい</Checkbox></SaveErrorField>
    )
  }
  if (field.type === 'date') {
    return <SaveErrorField names={["value"]}><DateField id={id} value={value} onChange={onChange} aria-labelledby={`${id}-label`} placeholder="（未設定）" /></SaveErrorField>
  }
  if (computed) return <TextField id={id} value={value} disabled readOnly aria-readonly="true" placeholder="（未設定）" />
  const inputType = field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : field.type === 'tel' ? 'tel' : field.type === 'email' ? 'email' : 'text'
  return <SaveErrorField names={["value"]}><TextField id={id} type={inputType} value={value} readOnly={readOnly} disabled={!!field.ecIsMaster} aria-readonly={readOnly || undefined} placeholder="（未設定）" onChange={(e) => onChange(e.target.value)} /></SaveErrorField>
}

export default function InfoTab({ friendId, group, data, perms }: {
  friendId: string
  group: string
  data: FriendDetailState
  perms: FriendDetailPermissions
}) {
  const { fields, values, setValues, fieldsStatus, fieldFolders, fieldFoldersStatus, hiddenPersonalCount } = data
  // 保存前の入力があれば、ほかの画面・タブへ移る前に共通の確認を出す（ほかの編集画面と同じ番兵）。
  const dirty = fieldsStatus === 'ready' && fields.some((field) => (field.value ?? '') !== (values[field.id] ?? ''))
  const resetValues = () => setValues(Object.fromEntries(fields.map((field) => [field.id, field.value ?? ''])))
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: data.saving, onDiscard: resetValues })
  const leaveDialog = <UnsavedLeaveDialog open={leaveTarget !== null} subject="情報欄への変更" onConfirm={confirmLeave} onCancel={cancelLeave} />

  if (fieldsStatus === 'loading' || fieldsStatus === 'idle') {
    return <div className={`${styles.pane} ${styles.infoPane}`}><DetailLoading /></div>
  }
  if (fieldsStatus === 'error') {
    return (
      <ListState kind="error" title="情報欄を読み込めませんでした。" description="" action={<><Button onClick={() => data.loadFields()} busyLabel="処理中…">もう一度読み込む</Button></>} />
    )
  }

  const isBasic = (field: FriendField) => BASIC_FRIEND_FIELDS.some(spec => spec.key === field.fixedKey)
  const basic = BASIC_FRIEND_FIELDS.flatMap(spec => fields.filter(field => field.fixedKey === spec.key))
  const others = fields.filter(field => !isBasic(field))
  const isDining = (field: FriendField) => !isBasic(field) && !!field.fixedKey
  const inGroup = group === ALL_GROUP ? [...basic,...others] : group === BASIC_GROUP ? basic : group === DINING_GROUP ? others.filter(isDining) : others.filter(field => !isDining(field) && (group === UNFILED_GROUP ? !field.folderId : field.folderId === group))
  const ordered = inGroup.filter(field => field.status !== 'archived')
  const groups = [...new Set(ordered.map(field => isBasic(field) ? 'basic' : field.fixedKey ? 'dining' : field.folderId || 'unfiled'))]
  const groupName = (key: string) => key === 'basic' ? '基本（決まった欄）' : key === 'dining' ? '飲食の情報' : key === 'unfiled' ? '未分類' : fieldFolders.find(folder => folder.id === key)?.name ?? '分類'
  /* 読み上げ名（区切りの名前）は今までどおり。 */
  const groupAria = (key: string) => key === 'basic' ? '基本' : key === 'dining' ? '飲食の情報' : `お店が作った項目（${groupName(key)}）`
  /* ：題の横の補足。決まった欄は回答フォームの答え、ほかはお店が作った項目。 */
  const groupNote = (key: string) => key === 'basic' ? '名前や連絡先などの基本情報' : key === 'dining' ? '飲食を使うアカウントの決まった欄' : 'お店が作った項目・分類ごとに出ます'
  const firstShopGroup = groups.find(key => key !== 'basic' && key !== 'dining')
  // 「情報欄を管理」はお店が作った分類の頭に出す。お店の分類が無いときは最初の分類の頭に出す。
  const manageGroup = firstShopGroup ?? groups[0]
  const groupOf = (field: FriendField) => isBasic(field) ? 'basic' : field.fixedKey ? 'dining' : field.folderId || 'unfiled'

  const folderCount = new Map<string, number>()
  let basicCount = 0
  let diningCount = 0
  let unfiledCount = 0
  const visibleFields = fields.filter(field => field.status !== 'archived')
  for (const f of visibleFields) {
    if (isBasic(f)) basicCount += 1
    else if (isDining(f)) diningCount += 1
    else if (!f.folderId) unfiledCount += 1
    else folderCount.set(f.folderId, (folderCount.get(f.folderId) ?? 0) + 1)
  }
  const folderIds = new Set(fieldFolders.map((f) => f.id))
  const orphan = [...folderCount.keys()].filter((id) => !folderIds.has(id))
  const chips = [
    { id: ALL_GROUP, label: 'すべて', count: visibleFields.length },
    { id: BASIC_GROUP, label: '基本', count: basicCount },
    ...(diningCount ? [{ id: DINING_GROUP, label: '飲食', count: diningCount }] : []),
    ...(unfiledCount ? [{ id: UNFILED_GROUP, label: '未分類', count: unfiledCount }] : []),
    ...fieldFolders.map((f) => ({ id: f.id, label: f.name, count: folderCount.get(f.id) ?? 0 })),
    ...orphan.map((id) => ({ id, label: '分類', count: folderCount.get(id) ?? 0 })),
  ]
  const groupKnown = group === BASIC_GROUP || group === ALL_GROUP || group === DINING_GROUP || group === UNFILED_GROUP || folderIds.has(group) || folderCount.has(group) || fieldFoldersStatus !== 'ready'
  const base = `/friends/detail?id=${encodeURIComponent(friendId)}&tab=info`

  return (
    <div className={`${styles.pane} ${styles.infoPane}`}>
      <div className={styles.chips} role="group" aria-label="情報欄の分類">
        {chips.map((chip) => (
          <FilterLink
            key={chip.id}
            href={chip.id === ALL_GROUP ? base : `${base}&group=${encodeURIComponent(chip.id)}`}
            aria-current={group === chip.id ? 'true' : undefined}
          >
            {`${chip.label} ${chip.count}`}
          </FilterLink>
        ))}
      </div>

      {!groupKnown ? (
        <p className={styles.paneNote}>
          この分類は削除されたか、見つかりません。
          <TextLink inline href={base}>基本の項目を見る</TextLink>
        </p>
      ) : ordered.length === 0 ? (
        <div className={styles.centered}>
          {hiddenPersonalCount > 0 ? <p className={styles.hiddenNote}>個人情報の項目が {formatNumber(hiddenPersonalCount)} 件あります。表示には個人情報の閲覧権限が要ります。</p> : null}
          <p className={styles.paneNote}>
            {fields.length === 0 && hiddenPersonalCount === 0
              ? '情報欄の項目がまだありません。'
              : group === BASIC_GROUP || group === ALL_GROUP ? '表示できる項目がありません。' : 'この分類の項目はまだありません。'}
          </p>
          {perms.manage && hiddenPersonalCount === 0 ? <Button href={`/tags/fields/new?back=/friends/detail?id=${friendId}`}>項目を作る</Button> : null}
        </div>
      ) : (
        <>
          {groups.map(groupKey => {
          const groupFields = ordered.filter(field => groupOf(field) === groupKey)
          const hasPersonal = groupFields.some(field => field.isPersonal)
          return <section key={groupKey} className={styles.infoGroup} aria-label={groupAria(groupKey)}>
          <div className={styles.infoGroupHead}>
            <h3 className={styles.infoGroupTitle}>{groupName(groupKey)}<HelpTip label={`${groupName(groupKey)}の説明`}>{groupNote(groupKey)}</HelpTip>{hasPersonal ? <span className={styles.faint}>個人情報を含む</span> : null}</h3>
            {groupKey === manageGroup ? <Link className={styles.manageLink} href="/tags?tab=fields">情報欄を管理<ArrowUpRight size={16} aria-hidden="true" /></Link> : null}
          </div>
          <div className={styles.fieldGrid}>
            {groupFields.map((field) => {
              const id = `ff-${field.id}`
              const fixed = field.fixedKey ? fixedFieldValue(fields.map(f => ({ ...f, value: values[f.id] ?? f.value, valueSource: (values[f.id] ?? '') === (f.value ?? '') ? f.valueSource : null })), field.fixedKey) : null
              const spec = BASIC_FRIEND_FIELDS.find(spec => spec.key === field.fixedKey)
              const age = field.fixedKey === 'birthday' ? ageFromBirthday(values[field.id] ?? field.value) : null
              const label = spec ? spec.label + (age !== null ? `（${age}歳）` : '') : field.name
              const changed = (field.value ?? '') !== (values[field.id] ?? '')
              return (
                <div key={field.id} className={styles.field} data-changed={changed || undefined}>
                  <label htmlFor={id} id={`${id}-label`} className={styles.fieldLabel} title={`${label}（${FIELD_TYPE_LABELS[field.type] ?? field.type}）`}>
                    {field.isStarred ? <span aria-label="★つき">★</span> : null}
                    <span className={styles.fieldLabelText}>{label}</span>
                    {/* 値の出どころ（手で入れた・回答フォーム…）は題の横に1行で（vX3wQ）。全文は title。 */}
                    {fixed?.label ? <span className={styles.fieldSource} title={fixed.source ?? undefined}>{fixed.label}</span> : null}
                  </label>
                  <FieldInput
                    id={id}
                    field={field}
                    value={fixed?.derived ? fixed.value ?? '' : values[field.id] ?? ''}
                    onChange={(v) => setValues((prev) => ({ ...prev, [field.id]: v }))}
                    disabled={!perms.canEditField(field) || !!fixed?.derived}
                    computed={!!fixed?.derived}
                  />
                  {field.type === 'multi_select' && field.fixedKey !== 'allergy' ? <p className={styles.fieldNote}>複数選択の項目はこの画面では変更できません。</p> : null}
                  {field.ecIsMaster ? <p className={styles.fieldNote}>EC で登録された値です。ここでは変えられません。</p> : null}
                </div>
              )
            })}
          </div></section>})}

          {hiddenPersonalCount > 0 ? <p className={styles.hiddenNote}>個人情報の項目が {formatNumber(hiddenPersonalCount)} 件あります。表示には個人情報の閲覧権限が要ります。</p> : null}
              {data.warnings.length > 0 ? <Notice tone="warn">
                <ul>{data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
              </Notice> : null}

          {/* 下の帯：［キャンセル］［保存する］を真ん中に（絵 vX3wQ）。項目を作るのは「情報欄を管理」から。 */}
          {perms.saveFields ? (
            <div className={styles.saveBar}>
              {data.saveError ? <p className={styles.saveNote}><span className={styles.danger} role="alert">{data.saveError}</span></p>
                : data.saveNotice ? <p className={styles.saveNote}><span className={styles.success} role="status">{data.saveNotice}</span></p>
                : !dirty && !data.saving ? <p className={styles.saveNote}>変更した項目はありません。</p> : null}
              <div className={styles.saveActions}>
                <Button variant="secondary" onClick={resetValues} disabled={data.saving || !dirty}>キャンセル</Button>
                <Button variant="primary" onClick={() => void data.saveFields()} disabled={data.saving || !dirty} busy={data.saving} busyLabel="保存中…">保存する</Button>
              </div>
            </div>
          ) : (
            <p className={styles.saveNote}><Lock size={16} aria-hidden />保存できるのはオーナー・管理者、または個人情報の編集権限を持つスタッフです。</p>
          )}
        </>
      )}
      {leaveDialog}
    </div>
  )
}
