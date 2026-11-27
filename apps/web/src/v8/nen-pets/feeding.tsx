'use client'
import { DetailColumns } from '@/components/templates/detail-columns'
import { notifySaved } from '@/components/shared/toast'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Trash2 } from 'lucide-react'
import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import IconButton from '@/components/shared/icon-button'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import StickyBar from '@/components/shared/sticky-bar'
import { TextField } from '@/components/shared/text-field'
import { FieldError } from '@/components/shared/form-controls'
import { useFieldValidation } from '@/lib/use-field-validation'
import { describeApiFailure, isForbiddenOrRateLimited } from '@/components/shared/api-error-message'
import { ApiError } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { nenRanksApi, type NenFeedingData, type NenFeedingKind } from '@/lib/nen-ranks-api'
import { Pill } from './parts'
import styles from './pets.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { Field } from '@/components/shared/form-controls'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'


/*
 * ★V8-B ごはんの目安。
 * 左に「主食」「然の商品（おやつ・トッピング）＋おやつの上限」の2枚、右に「今日の目安の計算」。
 * 保存・キャンセルは画面の下に張り付く帯（中央）。保存していない変更は離れる前に確かめる。
 * 口は今の画面と同じ（GET/PUT /api/nen/feeding-products）。
 * 行は文字で見せ、商品名を押すとその行だけ入力欄になる（足した行は最初から入力欄）。
 */

/** 係数の説明（Worker `services/nen-feeding.ts` の ENERGY_FACTORS と同じ値）。 */
const FACTOR_ROWS: Array<{ label: string; dog: string; cat: string }> = [
  { label: '子犬・子猫（4か月未満）', dog: '3.0', cat: '2.5' },
  { label: '子犬・子猫（12か月未満）', dog: '2.0', cat: '2.5' },
  { label: '成犬・成猫（避妊去勢済み）', dog: '1.6', cat: '1.2' },
  { label: '成犬・成猫（していない）', dog: '1.8', cat: '1.4' },
  { label: 'シニア（避妊去勢済み）', dog: '1.4', cat: '1.1' },
  { label: 'シニア（していない）', dog: '1.6', cat: '1.3' },
  { label: '活動量「多め」「少なめ」', dog: '±0.2', cat: '±0.1' },
]

const FORMULAS: Array<{ label: string; value: string }> = [
  { label: '安静時エネルギー', value: '70 × 体重（kg） の 0.75 乗' },
  { label: '1日の必要カロリー', value: '安静時エネルギー × 係数' },
  { label: '1日の目安（g）', value: '必要カロリー ÷ 主食の kcal/100g × 100' },
  { label: '然の鹿肉の目安（g）', value: '必要カロリー × 上限% ÷ 然商品の kcal/100g × 100' },
]

const MAX_PRODUCTS = 20

type FeedingDraft = { key: string; id: string | null; name: string; kcal: string; isDefault: boolean; kind: NenFeedingKind; editing: boolean }

let draftSeq = 0
const fromData = (next: NenFeedingData): FeedingDraft[] =>
  next.products.map((p) => ({ key: p.id, id: p.id, name: p.name, kcal: String(p.kcalPer100g), isDefault: p.isDefault, kind: p.kind === 'nen' ? 'nen' : 'staple', editing: false }))

export default function FeedingV8({ accountId, canEdit }: { accountId: string; canEdit: boolean }) {
  const [formulaExpanded, setFormulaExpanded] = useState(false)
  const saveErrors = useSaveFormErrors()
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading')
  const [data, setData] = useState<NenFeedingData | null>(null)
  const [drafts, setDrafts] = useState<FeedingDraft[]>([])
  const [treatLimit, setTreatLimit] = useState('10')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loadError, setLoadError] = useState<unknown>(null)
  const [dataAccountId, setDataAccountId] = useState(accountId)
  const fields = useFieldValidation(drafts.flatMap((row) => [
    ...(!row.name.trim() ? [{ id: `feeding-name-${row.key}`, message: '商品名を入れるか、行を消してください。' }] : []),
    ...(!Number.isFinite(Number(row.kcal.replace(/[,，]/g, ''))) || Number(row.kcal.replace(/[,，]/g, '')) <= 0
      ? [{ id: `feeding-kcal-${row.key}`, message: '100gあたりのカロリーを0より大きい数で入れてください。' }] : []),
  ]))
  const generationRef = useRef(0)
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy })

  if (dataAccountId !== accountId) {
    const hadUnsaved = dirty
    generationRef.current += 1
    setDataAccountId(accountId)
    setData(null)
    setDrafts([])
    setTreatLimit('10')
    setDirty(false)
    setBusy(false)
    setError('')
    setLoadError(null)
    setStatus('loading')
    cancelLeave()
    setNotice(hadUnsaved ? 'LINEアカウントを切り替えたため、保存していない変更は破棄しました。' : '')
  }

  const load = useCallback(async () => {
    const generation = ++generationRef.current
    setStatus('loading')
    setLoadError(null)
    try {
      const res = await nenRanksApi.feeding(accountId)
      if (!res.success) throw new Error(res.error)
      if (generationRef.current !== generation) return
      setData(res.data)
      setDrafts(fromData(res.data))
      setTreatLimit(String(res.data.treatLimitPercent ?? 10))
      setDirty(false)
      setStatus('ready')
    } catch (caught) {
      if (generationRef.current !== generation) return
      saveErrors.capture(caught);
      setLoadError(caught)

      setStatus(caught instanceof ApiError && caught.status === 403 ? 'forbidden' : 'error')
    }
  }, [accountId, saveErrors])

  useEffect(() => {
    void load()
  }, [load])

  const touch = () => { setDirty(true); setNotice('') }
  const update = (key: string, patch: Partial<FeedingDraft>) => {
    setDrafts((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
    touch()
  }
  // 既定（主食）・目安に使う（然の商品）は、それぞれの種類で1つだけ。
  const setDefault = (key: string) => {
    setDrafts((current) => {
      const target = current.find((row) => row.key === key)
      return target ? current.map((row) => (row.kind === target.kind ? { ...row, isDefault: row.key === key } : row)) : current
    })
    touch()
  }
  const remove = (key: string) => {
    setDrafts((current) => {
      const removed = current.find((row) => row.key === key)
      const next = current.filter((row) => row.key !== key)
      if (removed && !next.some((row) => row.kind === removed.kind && row.isDefault)) {
        const first = next.findIndex((row) => row.kind === removed.kind)
        if (first >= 0) next[first] = { ...next[first], isDefault: true }
      }
      return next
    })
    touch()
  }
  const add = (kind: NenFeedingKind) => {
    draftSeq += 1
    setDrafts((current) => [...current, { key: `new-${draftSeq}`, id: null, name: '', kcal: '', isDefault: !current.some((row) => row.kind === kind), kind, editing: true }])
    touch()
  }
  const cancel = () => {
    fields.reset()
    if (data) { setDrafts(fromData(data)); setTreatLimit(String(data.treatLimitPercent ?? 10)) }
    setDirty(false)
    setError('')
  }

  const save = async () => {
    if (status !== 'ready') return
    setError('')
    if (!fields.submit()) {
      setDrafts((current) => current.map((row) => ({ ...row, editing: true })))
      return
    }
    const generation = generationRef.current
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await nenRanksApi.saveFeeding(accountId, drafts.map((row) => ({
        id: row.id, name: row.name.trim(), kcalPer100g: Number(row.kcal.replace(/[,，]/g, '')), isDefault: row.isDefault, kind: row.kind,
      })), Number(treatLimit))
      if (!res.success) throw new Error(res.error)
      if (generationRef.current !== generation) return
      setData(res.data)
      setDrafts(fromData(res.data))
      setTreatLimit(String(res.data.treatLimitPercent ?? 10))
      setDirty(false)
      notifySaved(res.data.refreshedPets
        ? `主食を保存し、登録済みのペット ${formatNumber(res.data.refreshedPets)}頭の目安を計算し直しました。`
        : '主食を保存しました。')
    } catch (caught) {
      if (generationRef.current !== generation) return
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)

      setError(describeApiFailure(caught, '主食の保存', {
        scope: 'store',
      })) }
    } finally {
      if (generationRef.current === generation) setBusy(false)
    }
  }

  if (status === 'forbidden') return <SaveErrorScope errors={saveErrors}><ListState kind="forbidden" /></SaveErrorScope>
  if (status === 'error') return <SaveErrorScope errors={saveErrors}><ListState kind="error" title="主食のカロリー表を読み込めませんでした" error={loadError ?? undefined} description={isForbiddenOrRateLimited(loadError) ? undefined : '通信の状態を確認して、もう一度お試しください。'} onRetry={() => void load()} /></SaveErrorScope>
  if (!data) return <SaveErrorScope errors={saveErrors}>{notice ? <Notice tone="success" message={notice} /> : null}<ListState kind="loading" title="主食のカロリー表を読み込んでいます" /></SaveErrorScope>

  const formula = (
        <Card layout="vertical" padding="spacious" surface="bordered" spacing="normal" aria-label="今日の目安の計算">
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>今日の目安の計算</h2>
            <p className={styles.cardDesc}>体重・年齢・避妊去勢・運動量から、公的な指針の式で計算します</p>
          </div>
          <dl className={styles.formulaList}>
            {FORMULAS.map((row) => (
              <div key={row.label} className={styles.formulaRow}>
                <dt className={styles.formulaLabel}>{row.label}</dt>
                <dd className={styles.formulaValue}>{row.value}</dd>
              </div>
            ))}
          </dl>
          <div className={styles.factorTable} role="table" aria-label="係数">
            <div className={styles.factorHead} role="row">
              <span className={styles.factorLabel} role="columnheader">係数</span>
              <span className={styles.factorNum} role="columnheader">犬</span>
              <span className={styles.factorNum} role="columnheader">猫</span>
            </div>
            {FACTOR_ROWS.map((row) => (
              <div key={row.label} className={styles.factorRow} role="row">
                <span className={styles.factorLabel} role="cell">{row.label}</span>
                <span className={styles.factorNum} role="cell">{row.dog}</span>
                <span className={styles.factorNum} role="cell">{row.cat}</span>
              </div>
            ))}
          </div>
          <p className={styles.formulaNote}>犬・猫以外は計算しません</p>
        </Card>
  )

  const tableProps = { fields, drafts, canEdit, busy, onUpdate: update, onDefault: setDefault, onRemove: remove, addDisabled: drafts.length >= MAX_PRODUCTS }

  return (
    <SaveErrorScope errors={saveErrors}><div className={styles.feeding}>
      {notice ? <Notice tone="success" message={notice} /> : null}
      {error ? <Notice tone="danger" message={error} /> : null}
      <DetailColumns aside={formula} asideLabel="今日の目安の計算" expanded={formulaExpanded} onExpandedChange={setFormulaExpanded} presentation="card">
        <div className={styles.feedingMain}>
          <Card layout="vertical" padding="spacious" surface="bordered" spacing="normal" aria-label="主食">
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>主食（お客さまが選ぶ、ふだんのごはん）</h2>
              <p className={styles.cardDesc}>一般的な種類だけ登録します。マイページの「いつもの主食」で選ばれ、1日の目安（g）はこの kcal で割ります</p>
            </div>
            <ProductTable {...tableProps} kind="staple" defaultHead="既定の主食" defaultChip="既定" makeDefault="既定にする" addLabel="主食を追加する" onAdd={() => add('staple')} />
          </Card>
          <Card layout="vertical" padding="spacious" surface="bordered" spacing="normal" aria-label="然の商品">
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>然の商品（おやつ・トッピング）</h2>
              <p className={styles.cardDesc}>然の商品名と 100g あたりのカロリーを登録すると、マイページに「然の鹿肉の目安」が出ます</p>
            </div>
            <ProductTable {...tableProps} kind="nen" defaultHead="目安に使う商品" defaultChip="目安に使う中" makeDefault="これを使う" addLabel="然の商品を追加する" onAdd={() => add('nen')} />
            <div className={styles.treat}><Field label="おやつの上限（%）" htmlFor="nen-treat-limit"><span className={styles.treatRow}>
                <span className={styles.treatInput}>
                  {canEdit ? (
                    <SaveErrorField names={["treatLimit","treat_limit"]}><NumberInput numericText unit="%" disabled={busy} id="nen-treat-limit" inputMode="numeric" value={treatLimit} onChange={(event) => { setTreatLimit(event.target.value); touch() }} /></SaveErrorField>
                  ) : (
                    <SaveErrorField names={["treatLimit","treat_limit"]}><TextField id="nen-treat-limit" value={treatLimit} readOnly /></SaveErrorField>
                  )}
                </span>
                <span className={styles.treatNote}>1日の必要カロリーのうち、おやつに回す割合</span>
              </span></Field></div>
          </Card>
        </div>


      </DetailColumns>

      {canEdit ? (
        <StickyBar
          className={styles.stickyBar}
          status={dirty ? '保存していない変更があります' : undefined}
          actions={(
            <>
              <Button onClick={cancel} disabled={busy || !dirty} title={busy ? '保存しています' : !dirty ? '変更がありません' : undefined}>キャンセル</Button>
          <Button variant="primary" onClick={() => save()} disabled={busy || !dirty} disabledReason={!dirty ? 'ごはんの目安を変更すると保存できます。' : undefined} title={busy ? '保存しています' : !dirty ? 'ごはんの目安を変更すると保存できます' : undefined} busy={busy} busyLabel="保存しています…"><Check size={16} aria-hidden="true" />保存する</Button>
            </>
          )}
        />
      ) : null}
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="ごはんの目安への変更" onConfirm={confirmLeave} onCancel={cancelLeave} />
    </div></SaveErrorScope>
  )
}

function ProductTable({
  kind, drafts, fields, canEdit, defaultHead, defaultChip, makeDefault, addLabel, onUpdate, onDefault, onRemove, onAdd, addDisabled, busy,
}: {
  kind: NenFeedingKind
  fields: ReturnType<typeof useFieldValidation>
  drafts: FeedingDraft[]
  canEdit: boolean
  busy: boolean
  defaultHead: string
  defaultChip: string
  makeDefault: string
  addLabel: string
  onUpdate: (key: string, patch: Partial<FeedingDraft>) => void
  onDefault: (key: string) => void
  onRemove: (key: string) => void
  onAdd: () => void
  addDisabled: boolean
}) {
  const rows = drafts.filter((row) => row.kind === kind)
  return (
    <>
      <div className={styles.productTable} data-kind={kind} role="table" aria-label={kind === 'nen' ? '然の商品' : '主食'}>
        <div className={styles.productHead} role="row">
          <span className={styles.productName} role="columnheader">商品名</span>
          <span className={styles.productKcal} role="columnheader">100g あたり</span>
          <span className={styles.productDefault} role="columnheader">{defaultHead}</span>
          <span className={styles.productTrash} role="columnheader"><span className="sr-only">削除</span></span>
        </div>
        {rows.map((row, saveFieldIndex) => (
          <div key={row.key} className={styles.productRow} role="row">
            <span className={styles.productName} role="cell">
              {row.editing && canEdit ? (
                <><SaveErrorField names={[`rows.${saveFieldIndex}.name`,"row.name"]}><TextField {...fields.bind(`feeding-name-${row.key}`)} disabled={busy} aria-label="商品名" value={row.name} maxLength={40} placeholder={kind === 'nen' ? '例：然 鹿肉ジャーキー' : '例：ドライフード'} onChange={(event) => onUpdate(row.key, { name: event.target.value })} /></SaveErrorField><FieldError id={`feeding-name-${row.key}-error`}>{fields.error(`feeding-name-${row.key}`)}</FieldError></>
              ) : canEdit ? (
                <button type="button" disabled={busy} className={styles.productNameButton} title={`${row.name}を直す`}  onClick={() => onUpdate(row.key, { editing: true })}>{row.name}</button>
              ) : (
                <span className={styles.cell} ><TruncatedText value={String(row.name ?? '')} /></span>
              )}
            </span>
            <span className={styles.productKcal} role="cell">
              {row.editing && canEdit ? (
                <span className={styles.kcalInput}>
                  <SaveErrorField names={[`rows.${saveFieldIndex}.kcal`,"kcal","row.kcal"]}><TextField {...fields.bind(`feeding-kcal-${row.key}`)} disabled={busy} aria-label={`${row.name || '商品'}の100gあたりのカロリー`} inputMode="decimal" value={row.kcal} placeholder="360" onChange={(event) => onUpdate(row.key, { kcal: event.target.value })} /></SaveErrorField><FieldError id={`feeding-kcal-${row.key}-error`}>{fields.error(`feeding-kcal-${row.key}`)}</FieldError>
                  <span className={styles.sub}>kcal</span>
                </span>
              ) : (
                <span className={styles.num}>{`${row.kcal} kcal`}</span>
              )}
            </span>
            <span className={styles.productDefault} role="cell">
              {row.isDefault ? (
                <Pill tone="ok">{defaultChip}</Pill>
              ) : canEdit ? (
                <Button disabled={busy} onClick={() => onDefault(row.key)}>{makeDefault}</Button>
              ) : null}
            </span>
            <span className={styles.productTrash} role="cell">
              {canEdit ? (
                <IconButton disabled={busy} aria-label={`${row.name || 'この商品'}を削除する`} title="削除する" onClick={() => onRemove(row.key)}>
                  <Trash2 size={16} aria-hidden="true" />
                </IconButton>
              ) : null}
            </span>
          </div>
        ))}
      </div>
      {canEdit ? (
        <button type="button" className={styles.addLink} onClick={onAdd} disabled={busy || addDisabled}>
          {`＋ ${addLabel}`}
        </button>
      ) : null}
    </>
  )
}
