'use client'

import { usageTone } from './edit-model'

import Button from '@/components/shared/button'
import { emptyValue } from '@/components/shared/empty-value'
import { NOT_AVAILABLE } from '@/components/shared/not-connected'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import TruncatedText from '@/components/shared/truncated-text'
import { formatNumber } from '@/lib/format'
import type { CommonVarChangeImpact,CommonVarDeleteImpact } from '@line-crm/shared'
import { ChevronDown,ChevronUp,CircleCheck,Download } from 'lucide-react'
import { useState } from 'react'
import styles from './edit.module.css'
import impactLayout from './impact-csv-layout.module.css'
import { blockingErrors,characterCountText,checkedAtText,hiddenText,historicalText,immediateItems,isChangeItem,reflectionScopeText,reflectionTimingText,reviewWarnings } from './impact'
import { TextField as SharedTextField } from '@/components/shared/text-field'

/*
 * 変える前に影響を見る、の行。いまの文と保存したあとの文を
 * 赤・緑の箱で並べる（板 ）。3件まで出し、残りは畳む。
 */
export function ImpactRows({
  impact,
  onExportCsv,
}: {
  impact: CommonVarDeleteImpact | CommonVarChangeImpact
  onExportCsv: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const rows = immediateItems(impact)
  const visible = expanded ? rows : rows.slice(0, 3)
  const rest = rows.length - visible.length
  const changeable = 'canSave' in impact
  const csvRows = changeable ? impact.items.filter((item) => item.changesOnSave) : []

  return (
    <>
      {rows.length === 0 ? (
        <p className={styles.cardNote}>{impact.total === 0 ? '使われている場所がないため、確かめる文はありません。' : 'すぐ変わる使用先の文はありません。'}</p>
      ) : (
        <div className={styles.impactList}>
          {visible.map((row, index) => (
            <div key={`${row.kind}-${row.name}-${index}`} className={styles.impactRow}>
              <div className={styles.impactHead}>
                <span className={styles.impactKind}>{row.kindLabel}</span>
                <span className={styles.impactName} ><TruncatedText value={String(row.name ?? '')} /></span>
                <span className={styles.impactSpacer} aria-hidden="true" />
                <span className={usageTone(row.status) === 'warning' ? styles.impactStatusWarn : styles.impactStatus}>{row.status}</span>
              </div>
              <div className={styles.impactPair}>
                <p className={styles.impactBefore} title={row.currentPreview}>{`…${row.currentPreview}`}</p>
                <p className={styles.impactAfter} title={isChangeItem(row) ? characterCountText(row) : undefined} data-over-limit={isChangeItem(row) && row.exceedsCharacterLimit || undefined}>
                  {isChangeItem(row)
                    ? `…${row.nextPreview ?? `${NOT_AVAILABLE}（使用先を開いて確認してください）`}`
                    : '値を変えると、ここに保存後の文が出ます。'}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className={styles.impactFoot}>
        {rest > 0 ? (
          <Button variant="text" type="button" onClick={() => setExpanded(true)}>
            <ChevronDown size={16} aria-hidden="true" />
            {`ほか ${formatNumber(rest)} か所を見る`}
          </Button>
        ) : rows.length > 3 ? (
          <Button variant="text" type="button" onClick={() => setExpanded(false)}>
            <ChevronUp size={16} aria-hidden="true" />
            畳む
          </Button>
        ) : null}
        <span className={styles.impactSpacer} aria-hidden="true" />
        {changeable ? (
          <div className={impactLayout.csvAction}><Button variant="text" type="button" onClick={onExportCsv} disabled={csvRows.length === 0} disabledReason={csvRows.length === 0 ? '書き出す使用先がありません。' : undefined}>
            <Download size={16} aria-hidden="true" />
            この一覧をCSVで
          </Button></div>
        ) : null}
      </div>
      {changeable ? (
        <>
          {blockingErrors(impact).length > 0 ? (
            <ul className={styles.blockList}>
              {blockingErrors(impact).map((message) => <li key={message}>{message}</li>)}
            </ul>
          ) : (
            <p className={styles.validNote} role="status">
              <CircleCheck size={16} aria-hidden="true" />
              <span>文字数の上限をこえる文はありません。保存を止める問題は見つかりませんでした。</span>
            </p>
          )}
          {reviewWarnings(impact).map((message) => (
            <p key={message} className={styles.cardNote}>{message}</p>
          ))}
        </>
      ) : (
        <>
          {reflectionScopeText(impact) ? <p className={styles.cardNote}>{reflectionScopeText(impact)}</p> : null}
          {reflectionTimingText(impact) ? <p className={styles.cardNote}>{reflectionTimingText(impact)}</p> : null}
          {historicalText(impact) ? <p className={styles.cardNote}>{historicalText(impact)}</p> : null}
        </>
      )}
      {hiddenText(impact) ? (
        <p className={styles.cardNote}>名前を確認できない使用先：{hiddenText(impact)}</p>
      ) : null}
      <p className={styles.cardNote}>{`${checkedAtText(impact.checkedAt)} 時点で確認`}</p>
    </>
  )
}

/** 閲覧のみで、日時の欄に入っている値を文字で見せる（空なら「指定なし」）。 */
export function readOnlyDate(value: string): string {
  return value ? value.replace('T', ' ') : emptyValue('unconfigured')
}

/** 閲覧のみ：選ぶ部品・日付の部品の代わりに、選んでいる値を読み取りだけの欄で見せる。 */
export function ReadOnlyValue({ id, label, value }: { id: string; label?: string; value: string }) {
  return (
    <SaveErrorField names={["value"]}><SharedTextField
      id={id}
      type="text"
      value={value}
      readOnly
      aria-readonly="true"
      aria-label={label}
      className={styles.fieldInput}
    /></SaveErrorField>
  )
}
