'use client'

import Button from '@/components/shared/button'
import { useMemo, useState } from 'react'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import {
  musuboConditionPreview,
  validateMusuboCondition,
  type MusuboConditionDefinition,
} from '@line-crm/shared'
import styles from './billing-condition-editor.module.css'

interface Props {
  conditions: MusuboConditionDefinition[]
  onSave: (definition: MusuboConditionDefinition) => Promise<void>
  onCreate: () => void
}

const money = (yen: number) => '¥' + new Intl.NumberFormat('ja-JP').format(yen)
const todayJst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const clone = (condition: MusuboConditionDefinition): MusuboConditionDefinition => ({
  ...condition,
  trialPeriod: { ...condition.trialPeriod },
  schedule: { ...condition.schedule },
})

export default function BillingConditionEditor({ conditions, onSave, onCreate }: Props) {
  const [selectedId, setSelectedId] = useState(conditions[0]?.id ?? '')
  const selected = conditions.find((condition) => condition.id === selectedId) ?? conditions[0]
  const [draft, setDraft] = useState<MusuboConditionDefinition | null>(selected ? clone(selected) : null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const saveErrors = useSaveFormErrors()
  const preview = useMemo(() => {
    if (!draft) return null
    try { return musuboConditionPreview(draft) } catch { return null }
  }, [draft])

  const change = (patch: Partial<MusuboConditionDefinition>) => {
    setDraft((current) => current ? { ...current, ...patch } : current)
    setError('')
  }
  const changePrice = (key: keyof MusuboConditionDefinition['schedule'], value: number) => {
    setDraft((current) => current ? { ...current, schedule: { ...current.schedule, [key]: value } } : current)
    setError('')
  }
  const choose = (condition: MusuboConditionDefinition) => {
    if (busy) return
    setSelectedId(condition.id)
    setDraft(clone(condition))
    setError('')
  }
  const save = async () => {
    if (!draft || busy) return
    try {
      validateMusuboCondition(draft)
      setBusy(true)
      setError('')
      await onSave(draft)
    } catch (caught) {
      if (!saveErrors.capture(caught)) setError(caught instanceof RangeError ? '入力された料金・期間・会社名を確認してください。' : '利用条件を保存できませんでした。時間をおいて再度お試しください。')
    } finally {
      setBusy(false)
    }
  }

  return <SaveErrorScope errors={saveErrors}><div className={styles.page}>
    <div className={styles.heading}>
      <div><h1>利用条件</h1><p>承認時に会社へ付与する料金・無料期間を作成し、管理します。</p></div>
      <button type="button" className={styles.primary} onClick={onCreate}>＋ 新しい条件</button>
    </div>
    <div className={styles.columns}>
      <section className={styles.listCard} aria-labelledby="conditions-heading">
        <h2 id="conditions-heading">登録済みの条件</h2>
        <div className={styles.conditionList}>
          {conditions.map((condition) => <button type="button" key={condition.id}
            className={condition.id === selectedId ? styles.conditionSelected : styles.condition}
            onClick={() => choose(condition)}>
            <strong>{condition.internalName}</strong>
            <span>{condition.trialPeriod.value}{condition.trialPeriod.unit === 'months' ? 'か月' : '日'}無料・LINE基本料金{condition.lineBasicDiscountPercent}%オフ</span>
            <small>{condition.status === 'active' ? '有効' : '無効'}</small>
          </button>)}
        </div>
        <p className={styles.help}>承認画面には「有効」の条件だけを表示します。変更履歴は監査ログに記録します。</p>
      </section>
      {draft && <section className={styles.editorCard} aria-labelledby="editor-heading">
        <div className={styles.editorHeading}><h2 id="editor-heading">{draft.internalName || '新しい条件'}</h2>
          <span className={draft.status === 'active' ? styles.active : styles.inactive}>{draft.status === 'active' ? '有効' : '無効'}</span></div>
        <div className={styles.grid}>
          <label className={styles.field}><span>名称（運営用）</span>
            <TextField value={draft.internalName} maxLength={80} onChange={(event) => change({ internalName: event.target.value })} /></label>
          <div className={styles.field}><span>状態</span>
            <Select aria-label="状態" size="full" value={draft.status}
              onChange={(value) => change({ status: value as MusuboConditionDefinition['status'] })}
              options={[{ value: 'active', label: '有効' }, { value: 'inactive', label: '無効' }]} /></div>
          <div className={styles.field}><span>無料期間（初回LINE有効化から）</span>
            <span className={styles.inlineFields}>
              <TextField type="number" aria-label="無料期間の長さ" min={1} max={draft.trialPeriod.unit === 'months' ? 12 : 365}
                value={draft.trialPeriod.value} onChange={(event) => change({ trialPeriod: { ...draft.trialPeriod, value: Number(event.target.value) } })} />
              <Select aria-label="無料期間の単位" size="content" value={draft.trialPeriod.unit}
                onChange={(value) => change({ trialPeriod: { unit: value as 'days' | 'months', value: draft.trialPeriod.value } })}
                options={[{ value: 'days', label: '日' }, { value: 'months', label: 'か月' }]} />
            </span></div>
          <label className={styles.field}><span>LINE基本料金の割引率</span>
            <span className={styles.percent}><TextField type="number" min={0} max={100} value={draft.lineBasicDiscountPercent}
              onChange={(event) => change({ lineBasicDiscountPercent: Number(event.target.value) })} /><span>%</span></span></label>
          <div className={styles.field}><span>割引期間</span>
            <Select aria-label="割引期間" size="full" value={draft.discountEndsOn === null ? 'forever' : 'date'}
              onChange={(value) => change({ discountEndsOn: value === 'forever' ? null : todayJst() })}
              options={[{ value: 'forever', label: '期限なし' }, { value: 'date', label: '終了日を指定' }]} />
            {draft.discountEndsOn !== null && <input type="date" value={draft.discountEndsOn}
              aria-label="割引終了日" onChange={(event) => change({ discountEndsOn: event.target.value })} />}
          </div>
          <div className={styles.field}><span>承認に使える期限</span>
            <Select aria-label="承認に使える期限" size="full" value={draft.approvalUseUntil === null ? 'forever' : 'date'}
              onChange={(value) => change({ approvalUseUntil: value === 'forever' ? null : todayJst() })}
              options={[{ value: 'forever', label: '期限なし' }, { value: 'date', label: '期限を指定' }]} />
            {draft.approvalUseUntil !== null && <input type="date" value={draft.approvalUseUntil}
              aria-label="承認に使える期限日" onChange={(event) => change({ approvalUseUntil: event.target.value })} />}
          </div>
          <label className={styles.field}><span>適用できる会社名（任意）</span>
            <TextField value={draft.allowedCompanyName ?? ''} placeholder="特定の会社だけに使う場合"
              onChange={(event) => change({ allowedCompanyName: event.target.value || null })} />
            <small>入力した場合、承認する会社名が一致するときだけ選べます。</small>
          </label>
          <div className={styles.field}><span>割引対象</span><div className={styles.locked}>LINEアカウント基本料金のみ（固定）</div>
            <small>統括機能・超過料金・その他オプションは対象外です。</small></div>
        </div>
        <div className={styles.priceSection}>
          <h3>月額単価（税込）</h3>
          <p>通常料金を初期値として表示します。変更した単価は、この条件を承認後に適用する会社だけに使います。</p>
          <div className={styles.grid}>
            {([
              ['firstLineYen', 'LINE 1個目の基本料金'],
              ['secondToFifthLineYen', 'LINE 2〜5個目の基本料金（1個あたり）'],
              ['sixthToTenthLineYen', 'LINE 6〜10個目の基本料金（1個あたり）'],
              ['headquartersYen', '統括機能'],
              ['linkedAccountSlotYen', '追加連携枠（1枠あたり）'],
            ] as const).map(([key, label]) => <label className={styles.field} key={key}>
              <span>{label}</span>
              <span className={styles.yen}><TextField type="number" min={0} step={1} value={draft.schedule[key]}
                onChange={(event) => changePrice(key, Number(event.target.value))} /><span>円／月</span></span>
            </label>)}
          </div>
        </div>
        <div className={styles.preview}><h3>料金プレビュー（月払い・税込）</h3>
          {preview ? <p>LINE 1個　{money(preview.oneLineMonthlyYen)}／月　　LINE 2個　{money(preview.twoLineMonthlyYen)}／月</p>
            : <p>入力を確認すると料金例を表示します。</p>}
          <small>2個目の料金には統括機能 {money(draft.schedule.headquartersYen)}（割引対象外）を含みます。</small>
        </div>
        <p className={styles.help}>保存後の変更は、承認済みの会社に自動で遡及しません。</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.footer}><Button type="button" variant="primary" className={styles.primary} busy={busy} busyLabel="保存中…" disabled={!preview}
          onClick={() => void save()}>変更を保存</Button></div>
      </section>}
    </div>
  </div></SaveErrorScope>
}
