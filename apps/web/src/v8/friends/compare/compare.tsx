'use client'
import { scrollMotion } from '@/components/shared/overlay-utils'
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Clock, Link as LinkIcon, UserX } from 'lucide-react'
import type { IdentityCandidateDecision } from '@line-crm/shared'
import type { IdentityCandidateWithProfiles } from '@/lib/api'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { PageFrame, PageHeading } from '@/components/templates/page-frame'
import { DashboardColumns } from '@/components/templates'
import { DialogActions } from '@/components/shared/dialog'
import DifferencesFilter, { comparisonSourceLabels, sameKnownValues } from '@/components/shared/differences-filter'
import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import { PageFooter } from '@/components/templates/page-footer'
import Checkbox from '@/components/shared/checkbox'
import Radio from '@/components/shared/radio'
import Select from '@/components/shared/select'
import TruncatedText from '@/components/shared/truncated-text'
import { TextField } from '@/components/shared/text-field'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import ListState from '@/components/shared/list-state'
import { IdentityStateBlock } from '@/components/identity/identity-state'
import { useIdentityReview } from '@/components/identity/identity-review'
import { canSubmitDecision } from '@/components/identity/identity-view'
import { candidateStatusWord, confidenceWord, slashDateTime } from '../duplicates/words'
import styles from './compare.module.css'
import { Field } from '@/components/shared/form-controls'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import StatusBadge from '@/components/shared/status-badge'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'

/*
 * ★V8 重複候補を比べて決める（Pencil ：判定の小窓を開いた形、1152 は ：閉じた形）。
 * /friends/identity-candidates（`?id=` で候補を指定。無ければ未判定の先頭）。
 *
 * 読み込み・判定は今と同じ口（components/identity の useIdentityReview：
 * 一覧・詳細・判定・版の照合）。判定の中身も今と同じ（理由は必須・結び付けるときは
 * 採用する値と3つの確認）。違いは見せ方だけ：
 * - 判定は窓ではなく「結び付けた人に使う値」の中に開く小窓。下の帯の3つのボタンが開く
 * - 採用する値は表の「使う値」で選ぶ（小窓はその要約）
 * - 判定の履歴は小窓の右に出す
 */

const STRENGTH_WORD = { strong: '決め手', medium: '手がかり', weak: '参考' } as const
const ATTRIBUTE_WORD: Record<string, string> = { メールアドレス: 'メール', 電話番号: '電話' }
function lookupWord(table: object, key: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(table, key) ? (table as Record<string, string>)[key] : fallback
}
const DECISIONS: Array<{ value: IdentityCandidateDecision; label: string }> = [
  { value: 'linked', label: '同じ人' },
  { value: 'different', label: '別の人' },
  { value: 'deferred', label: '保留' },
]
/* 結び付けるときの3つの確認（文）。3つそろうまで判定できない。 */
const CONSENTS = ['利用目的の範囲で結び付ける', '本人の同意（または正当な理由）がある', 'あとで戻せることを知っている']

function CompareInner() {
  usePageTitle('重複候補を比べて決める')
  /* 板の頭の「← 〇〇へ」は 2026-10-08 に無くした。一覧へは上の帯のパンくずで戻る。 */
  usePageCrumbs([{ label: '友だち', href: '/friends' }, { label: '重複検出', href: '/friends?tab=duplicates' }])
  const canManage = canManageRole(useStaffRole())
  const lockedReason = usePermissionLockReason(canManage, 'manager')
  const review = useIdentityReview('friend_duplicate')
  const searchParams = useSearchParams()
  const wantedId = searchParams.get('id')
  const appliedWantedRef = useRef(false)
  const first = review.items[0] ?? null
  useEffect(() => {
    if (review.state !== 'ready' || review.selectedId) return
    if (wantedId && !appliedWantedRef.current) {
      appliedWantedRef.current = true
      review.select(wantedId)
    } else if (first) {
      review.select(first.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review.state, review.selectedId, first?.id, wantedId])

  const detail = review.detail as IdentityCandidateWithProfiles | null
  const profileCandidates = useMemo(
    () => (detail && 'profileCandidates' in detail && Array.isArray(detail.profileCandidates) ? detail.profileCandidates : []),
    [detail],
  )
  const tagCandidates = detail && 'tagCandidates' in detail && Array.isArray(detail.tagCandidates) ? detail.tagCandidates : []
  const evidenceList = detail && Array.isArray(detail.evidence) ? detail.evidence : []
  const impactList = detail && Array.isArray(detail.impact) ? detail.impact : []
  const historyList = detail && Array.isArray(detail.history) ? detail.history : []
  const decisive = evidenceList.find((item) => item.strength === 'strong') ?? evidenceList[0]

  const fieldOptions = (field: typeof profileCandidates[number]) => (Array.isArray(field.options) ? field.options : [])
  const subjectAttributes = (subject: IdentityCandidateWithProfiles['left'] | undefined) => (subject && Array.isArray(subject.attributes) ? subject.attributes : [])
  const tagSourceIds = (tag: typeof tagCandidates[number]) => (Array.isArray(tag.sourceFriendIds) ? tag.sourceFriendIds : [])

  /* ── 判定の小窓 ── */
  const [differencesOnly, setDifferencesOnly] = useState(true)
  const [panelOpen, setPanelOpen] = useState(false)
  const [decision, setDecision] = useState<IdentityCandidateDecision>('linked')
  const [reason, setReason] = useState('')
  const [consents, setConsents] = useState([false, false, false])
  const [selections, setSelections] = useState<Record<string, string>>({})
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (review.decideError) setDifferencesOnly(false) }, [review.decideError])

  // 別の候補を開いたら、前の候補の入力を持ち越さない。
  useEffect(() => {
    setDifferencesOnly(true)
    setPanelOpen(false)
    setReason('')
    setConsents([false, false, false])
    setSelections(Object.fromEntries(profileCandidates.flatMap((field) => {
      const firstOption = fieldOptions(field)[0]
      return firstOption ? [[field.fieldKey, firstOption.sourceFriendId]] : []
    })))
  }, [detail?.id, profileCandidates])

  const openPanel = (next: IdentityCandidateDecision) => {
    if (!canManage || lockedReason || !detail?.canDecide || review.deciding) return
    setDecision(next)
    setPanelOpen(true)
    requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: 'center', behavior: scrollMotion() }))
  }

  const linkedReady = decision !== 'linked' || (
    profileCandidates.every((field) => {
      const chosen = selections[field.fieldKey]
      return Boolean(chosen) && fieldOptions(field).some((option) => option.sourceFriendId === chosen)
    }) && consents.every(Boolean)
  )
  const ready = canManage && !lockedReason && Boolean(detail) && canSubmitDecision({ canDecide: detail?.canDecide ?? false, reason, busy: review.deciding }) && linkedReady

  const submit = () => {
    if (!detail || !ready) return
    review.decide({
      decision,
      reason: reason.trim(),
      ...(decision === 'linked' ? {
        profileSelections: profileCandidates.map((field) => ({
          fieldKey: field.fieldKey,
          sourceFriendId: selections[field.fieldKey],
          updateMode: 'fixed' as const,
        })),
      } : {}),
    })
  }

  const sourceLabels = comparisonSourceLabels(detail ? [detail.left, detail.right].map((subject) => ({ id: subject.id, name: subject.label, source: subject.lineAccountName })) : [])
  const sourceName = (friendId: string | undefined, fallback = '') => friendId ? sourceLabels[friendId] || fallback : fallback
  const sameField = (field: typeof profileCandidates[number]) => sameKnownValues([
    fieldOptions(field).find((option) => option.sourceFriendId === detail?.left.id)?.valuePreview,
    fieldOptions(field).find((option) => option.sourceFriendId === detail?.right.id)?.valuePreview,
  ])
  const visibleProfileCandidates = profileCandidates.filter((field) => !differencesOnly || !sameField(field))
  const showTags = tagCandidates.length > 0 && (!differencesOnly || tagCandidates.some((tag) => tagSourceIds(tag).includes(detail?.left.id ?? '') !== tagSourceIds(tag).includes(detail?.right.id ?? '')))
  const sameAttribute = (label: string) => {
    const left = subjectAttributes(detail?.left).find((item) => item.label === label)
    const right = subjectAttributes(detail?.right).find((item) => item.label === label)
    return left?.verified === right?.verified && sameKnownValues([left?.valuePreview, right?.valuePreview])
  }
  const firstSelection = profileCandidates[0]
  const firstChosen = firstSelection ? fieldOptions(firstSelection).find((option) => option.sourceFriendId === selections[firstSelection.fieldKey]) : undefined
  const selectionSummary = firstChosen
    ? `採用する値：表で選んだ値（${sourceName(firstChosen.sourceFriendId, firstChosen.sourceLabel)}：${firstChosen.valuePreview ?? emptyValue('unconfigured')}${profileCandidates.length > 1 ? ' ほか' : ''}）`
    : '採用する値：表で選んだ値'

  return (
    <PageFrame kind="detail" heightMode="content" hasFooter={review.state === 'ready' && Boolean(detail)} boardId="fcg2D">
      <PageHeading title={detail ? `${detail.left.label} ↔ ${detail.right.label}` : '重複候補を比べて決める'}
        help={<>{detail ? `確からしさ：${confidenceWord(detail.confidence.label)}${decisive ? `・根拠：${decisive.label}` : ''}` : '同じ人かどうかを、根拠を見て決めます'}</>} />

      {!canManage ? <ReadOnlyNotice need="manager" /> : null}
      <div className={styles.body} data-template-region="body">
        <IdentityStateBlock
          state={review.state}
          failure={review.failure}
          emptyTitle="確認する候補はありません"
          emptyDescription="同じ人の疑いが見つかると、ここに並びます。"
          onRetry={review.reload}
        />

        {review.state === 'ready' && review.selectedId && !detail ? <ListState
          kind={review.detailState === 'forbidden' ? 'forbidden' : review.detailState === 'error' ? 'error' : 'loading'}
          title={review.detailState === 'error' ? '候補の詳細を読み込めませんでした' : undefined}
          description={review.detailFailure?.description}
          onRetry={review.detailState === 'error' ? review.reloadDetail : undefined}
        /> : null}
        {review.state === 'ready' && detail ? (
          <>
            <Notice tone="info" icon={<LinkIcon size={16} aria-hidden="true" />}>
              <span>結び付けても、元の友だち・注文・LINEアカウントは消えません。2件は残したまま、同じ人として扱います。一斉配信は結び付けた人へ1通になります。</span>
            </Notice>

            <DifferencesFilter checked={differencesOnly} onChange={setDifferencesOnly} />
            <div className={styles.pair}>
              {[{ side: sourceName(detail.left.id), subject: detail.left }, { side: sourceName(detail.right.id), subject: detail.right }].map(({ side, subject }) => (
                <Card key={subject.id} layout="vertical" padding="default" gap="tight" aria-label={side}>
                  <p className={styles.side}>{side}</p>
                  <p className={styles.subjectName}>{subject.label}</p>
                  <p className={styles.subjectSub}>{[subject.detail, subject.lineAccountName].filter(Boolean).join('・') || emptyValue('unknown')}</p>
                  <dl className={styles.attrs}>
                    {subjectAttributes(subject).filter((attribute) => !differencesOnly || !sameAttribute(attribute.label)).map((attribute) => (
                      <div key={attribute.label} className={styles.attr}>
                        <dt>{lookupWord(ATTRIBUTE_WORD, attribute.label, attribute.label)}</dt>
                        <dd className={styles.mono}>{attribute.valuePreview ?? '—（未取得）'}</dd>
                        <dd><StatusBadge dot={false} tone={attribute.verified ? 'success' : 'neutral'}>{attribute.verified ? '確認済み' : '未確認'}</StatusBadge></dd>
                      </div>
                    ))}
                  </dl>
                </Card>
              ))}
            </div>

            <div className={styles.pair}>
              <Card layout="vertical" padding="default" gap="normal" aria-labelledby="compare-evidence">
                <h3 id="compare-evidence" className={styles.cardTitle}>根拠</h3>
                <ul className={styles.lines}>
                  {evidenceList.map((item) => (
                    <li key={item.key} className={styles.line}>
                      <span title={item.valuePreview ?? undefined}>{item.label}</span>
                      <span className={item.strength === 'strong' ? styles.strong : styles.weak}>{lookupWord(STRENGTH_WORD, item.strength, '未確認')}</span>
                    </li>
                  ))}
                </ul>
                <p className={styles.cardNote}>名前やプロフィール画像だけの一致は、決め手にしません。</p>
              </Card>
              <Card layout="vertical" padding="default" gap="normal" aria-labelledby="compare-impact">
                <h3 id="compare-impact" className={styles.cardTitle}>結び付けたときの影響</h3>
                <ul className={styles.lines}>
                  {impactList.map((metric) => (
                    <li key={metric.key} className={styles.line}>
                      <span>{metric.label}</span>
                      <span className={styles.lineValue} title={metric.note ?? undefined}>
                        {metric.value === null
                          ? '—（つないだあとに出ます）'
                          : typeof metric.value === 'number' && Number.isFinite(metric.value)
                            ? `${metric.value}${metric.unit ?? ''}`
                            : '確認できません'}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>

            <Card layout="vertical" padding="default" gap="normal" aria-labelledby="compare-values">
              <h3 id="compare-values" className={styles.cardTitle}>結び付けた人に使う値</h3>

              {panelOpen ? (
                <DashboardColumns layout="cards" cardHeight="natural">{[
                  <Card key="decision" layout="vertical" padding="default" gap="normal"><div ref={panelRef} className="grid gap-3" role="group" aria-label="この2件の判定"><p id="compare-decide" className={styles.panelTitle}>判定</p>
<div className={styles.radios} role="radiogroup" aria-label="判定">
                      {DECISIONS.map((item) => (
                        <SaveErrorField names={["compare-decision","value","item.value","decision"]} key={item.value}><Radio key={item.value} name="compare-decision" value={item.value} checked={decision === item.value} disabled={review.deciding} onChange={() => setDecision(item.value)}>
                          {item.label}
                        </Radio></SaveErrorField>
                      ))}
                    </div>
{decision === 'linked' ? (
                      <>
                        {/* 選ぶ欄として▽を出す（絵 fcg2D）。友だちの結び付けで選べる過去の扱いは1つだけ。 */}
                        <Select aria-label="過去の扱い" size="full" value="merge" onChange={() => undefined}
                          options={[{ value: 'merge', label: '過去の扱い：これまでの履歴を1人分にまとめる' }]} />
                        {/* 採用する値は表の「使う値」の要約。A・B どちらかにまとめて切り替えることもできる。 */}
                        <Select aria-label="採用する値" size="full" disabled={!canManage || !detail.canDecide || review.deciding}
                          value="table"
                          onChange={(value) => {
                            if (value !== 'A' && value !== 'B') return
                            const id = value === 'A' ? detail.left.id : detail.right.id
                            setSelections((current) => ({ ...current, ...Object.fromEntries(profileCandidates.flatMap((field) => fieldOptions(field).some((option) => option.sourceFriendId === id) ? [[field.fieldKey, id]] : [])) }))
                          }}
                          options={[
                            { value: 'table', label: selectionSummary },
                            { value: 'A', label: `採用する値：すべて ${sourceName(detail.left.id)}` },
                            { value: 'B', label: `採用する値：すべて ${sourceName(detail.right.id)}` },
                          ]} />
                        <DataTable aria-label="結び付ける前の確認"><thead><TableHeadRow><Th>確かめること</Th></TableHeadRow></thead><tbody>
                          {CONSENTS.map((label, index) => (
                            <Tr key={label}><Td><SaveErrorField names={["consents"]}><Checkbox
                              key={label}
                              checked={consents[index]}
                              disabled={review.deciding}
                              onCheckedChange={(checked) => setConsents((current) => current.map((value, itemIndex) => (itemIndex === index ? checked : value)))}
                            >
                              {label}
                            </Checkbox></SaveErrorField></Td></Tr>
                          ))}
                        </tbody></DataTable>
                      </>
                    ) : null}
<Field label="判定の理由" htmlFor="compare-reason" required><SaveErrorField names={["reason"]}><TextField
                      id="compare-reason"
                      value={reason}
                      disabled={review.deciding}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder={decisive ? `${decisive.label}` : '何を見てそう判断したか'}
                    /></SaveErrorField></Field>
{review.decideError ? <Notice tone="danger" >{review.decideError}</Notice> : null}
<DialogActions padding="none">
                      <Button type="button" variant="secondary" onClick={() => setPanelOpen(false)} disabled={review.deciding}>キャンセル</Button>
                      <Button type="button" variant={detail.canDecide ? 'primary' : 'secondary'} onClick={submit} lockedReason={lockedReason} disabled={!ready} disabledReason={!detail.canDecide ? 'この候補は今は判定できません' : !reason.trim() ? '判定の理由を入れてください' : !linkedReady ? '使う値と3つの確認を選んでください' : undefined} busy={review.deciding} busyLabel="処理中…">判定する</Button>
                    </DialogActions></div></Card>,
                  <Card key="history" layout="vertical" padding="default" gap="normal">
                    <p className={styles.panelTitle}>判定の履歴</p>
                    <ul className={styles.lines}>
                      {historyList.map((item) => (
                        <li key={item.id} className={styles.historyLine}>
                          <span>{slashDateTime(item.decidedAt)}</span>
                          <span>{`${candidateStatusWord(item.toStatus)}・${item.actorName}「${item.reason}」`}</span>
                        </li>
                      ))}
                      <li className={styles.historyLine}>
                        <span>{slashDateTime(detail.detectedAt)}</span>
                        <span>{`候補に上がった（${decisive?.label ?? '根拠を確認'}）`}</span>
                      </li>
                    </ul>
                  </Card>,
                ]}</DashboardColumns>
              ) : null}

              <DataTable>
                <colgroup>
                  <col className={styles.colItem} />
                  <col />
                  <col />
                  <col className={styles.colUse} />
                </colgroup>
                <thead>
                  <TableHeadRow presentation="embedded">
                    <Th>項目</Th>
                    <Th><TruncatedText value={sourceName(detail.left.id)} /></Th>
                    <Th><TruncatedText value={sourceName(detail.right.id)} /></Th>
                    <Th>使う値</Th>
                  </TableHeadRow>
                </thead>
                <tbody>
                  {visibleProfileCandidates.map((field) => {
                    const options = fieldOptions(field)
                    const left = options.find((option) => option.sourceFriendId === detail.left.id)
                    const right = options.find((option) => option.sourceFriendId === detail.right.id)
                    return (
                      <Tr key={field.fieldKey} className={styles.row}>
                        <Td><TruncatedText className={styles.itemName} value={field.fieldLabel === 'メールアドレス' ? 'メール' : field.fieldLabel} /></Td>
                        <Td>{left?.valuePreview ?? emptyValue('unknown')}</Td>
                        <Td>{right?.valuePreview ?? emptyValue('unknown')}</Td>
                        <Td>
                          <SaveErrorField names={["selections"]}><Select
                            aria-label={`${field.fieldLabel}に使う値`}
                            size="full"
                            value={selections[field.fieldKey] ?? ''}
                            disabled={!canManage || !detail.canDecide || review.deciding}
                            onChange={(value) => setSelections((current) => ({ ...current, [field.fieldKey]: value }))}
                            options={options.map((option) => ({
                              value: option.sourceFriendId,
                              label: `${sourceName(option.sourceFriendId, option.sourceLabel)}：${option.valuePreview ?? emptyValue('unconfigured')}`,
                            }))}
                          /></SaveErrorField>
                        </Td>
                      </Tr>
                    )
                  })}
                  {visibleProfileCandidates.length === 0 && !showTags ? <Tr><Td colSpan={4}>{profileCandidates.length === 0 && tagCandidates.length === 0 ? '比べる項目はまだありません。' : '違う項目はありません。一致した項目は切り替えて確認できます。'}</Td></Tr> : null}
                  {showTags ? (
                    <Tr className={styles.rowPlain}>
                      <Td><span className={styles.itemName}>タグ</span></Td>
                      <Td>{tagCandidates.filter((tag) => tagSourceIds(tag).includes(detail.left.id)).map((tag) => tag.name).join('・') || emptyValue('unknown')}</Td>
                      <Td>{tagCandidates.filter((tag) => tagSourceIds(tag).includes(detail.right.id)).map((tag) => tag.name).join('・') || emptyValue('unknown')}</Td>
                      <Td><span className={styles.faint}>元の友だちに残す</span></Td>
                    </Tr>
                  ) : null}
                </tbody>
              </DataTable>
            </Card>
          </>
        ) : null}
      </div>
      {review.state === 'ready' && detail ? (
        <PageFooter
          actions={(
            <>
              <Button type="button" variant="secondary" lockedReason={lockedReason} disabled={!canManage || !detail.canDecide || review.deciding} disabledReason={!detail.canDecide ? 'この候補は今は判定できません' : undefined} onClick={() => openPanel('different')}>
                <UserX size={16} aria-hidden="true" />
                別の人だった
              </Button>
              <Button type="button" variant="secondary" lockedReason={lockedReason} disabled={!canManage || !detail.canDecide || review.deciding} disabledReason={!detail.canDecide ? 'この候補は今は判定できません' : undefined} onClick={() => openPanel('deferred')}>
                <Clock size={16} aria-hidden="true" />
                あとで決める（保留）
              </Button>
              <Button type="button" variant={detail.canDecide ? 'primary' : 'secondary'} lockedReason={lockedReason} disabled={!canManage || !detail.canDecide || review.deciding} disabledReason={!detail.canDecide ? 'この候補は今は判定できません' : undefined} onClick={() => openPanel('linked')}>
                <LinkIcon size={16} aria-hidden="true" />
                同じ人として結び付ける
              </Button>
            </>
          )}
        />
      ) : null}
    </PageFrame>
  )
}

export default function CompareV8() {
  return (
    <Suspense fallback={null}>
      <CompareInner />
    </Suspense>
  )
}
