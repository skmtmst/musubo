'use client'

import EntitySelect from '@/components/shared/entity-select'

import { DataTable, TableHeadRow, Tr, Td, Th, HandleCell, ActionCell } from '@/components/shared/table'

import Notice from '@/components/shared/notice'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Plus } from 'lucide-react'
import type { FormBlock, FormInputBlock } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import Card from '@/components/shared/card'
import HelpTip from '@/components/shared/help-tip'
import { RowMenu } from '@/components/shared/row-actions'
import ReorderHandle, { useReorder } from '@/components/shared/reorder-handle'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import Toggle from '@/components/shared/toggle'
import type { FormRefs } from '@/components/forms/form-refs'
import { choiceModeLabel, type FormRouting, type RoutingRule, type RoutingTarget, emptyRouting, hasBookingBlock, MAX_ROUTING_ROWS, newRule, routingError, routingQuestions, ruleAnswer } from './routing-model'
import styles from './routing-section.module.css'

const MODES = [{ value: '', label: '指定しない' }, { value: 'in_person', label: 'お店で' }, { value: 'online', label: 'オンライン' }]

/*
 * 回答フォーム 編集 › 中身 の区画「答えで予約の行き先を分ける」（B6-1・BGoRL）。
 * 表の 1 行 1 決まり・上から順に当てる・最後の行は消せない。「試しに答える」は保存せず、当たった行を緑で光らせる。
 * 閲覧のみの人には編集を出さず、試しだけ使える（何も変えないため）。決まりは回答フォームの版に含める。
 */
export default function RoutingSection({ blocks, refs, routing, readOnly, onChange, onPreview }: {
  blocks: FormBlock[]
  refs: FormRefs
  routing: FormRouting | undefined
  readOnly?: boolean
  onChange: (next: FormRouting) => void
  onPreview?: (answers: Record<string, unknown>) => Promise<{ matchedIndex: number; target: RoutingTarget; fellBack: boolean }>
}) {
  const questions = useMemo(() => routingQuestions(blocks), [blocks])
  const value = routing ?? emptyRouting()
  const trialQuestions = useMemo(() => blocks.filter((block): block is FormInputBlock => block.kind === 'input' && (questions.some((q) => q.id === block.id) || (block.type === 'rating' && value.rules.some((rule) => rule.conditions.some((condition) => condition.questionId === block.id))))), [blocks, questions, value.rules])
  const [trying, setTrying] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string | string[] | number>>({})
  const [preview, setPreview] = useState<{ matchedIndex: number; target: RoutingTarget; fellBack: boolean } | null>(null)
  const [previewError, setPreviewError] = useState('')
  const previewSequence = useRef(0)
  useEffect(() => { previewSequence.current++; setPreview(null); setPreviewError('') }, [routing, blocks])
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [pickedQuestion, setPickedQuestion] = useState<string | null>(null)
  const questionId = pickedQuestion ?? value.rules[0]?.conditions[0]?.questionId ?? questions[0]?.id ?? ''
  const question = questions.find((q) => q.id === questionId) ?? null
  const menus = refs.bookingMenus ?? []
  const ruled = value.rules.map((r, i) => ({ ...r, id: `r${i}` }))
  const reorder = useReorder({ items: ruled, idOf: (r) => r.id, disabledReason: readOnly ? '閲覧のみのため並べ替えられません' : null, onReorder: ({ ids }) => onChange({ ...value, rules: ids.map((id) => value.rules[Number(id.slice(1))]) }) })
  const problem = routingError(value)
  if (!hasBookingBlock(blocks)) return null

  const hit = trying ? preview?.matchedIndex ?? null : null
  const runPreview = async (next: Record<string, string | string[] | number>) => {
    setAnswers(next); setPreview(null); setPreviewError('')
    const sequence = ++previewSequence.current
    if (!onPreview || !Object.values(next).some(Boolean)) return
    try {
      const result = await onPreview(next)
      if (sequence === previewSequence.current) setPreview(result)
    } catch { if (sequence === previewSequence.current) setPreviewError('試せませんでした。行き先を確認してもう一度お試しください。') }
  }
  const answersLeft = (question?.choices ?? []).filter((c) => !value.rules.some((r) => r.conditions.length === 1 && r.conditions[0]?.questionId === question?.id && r.conditions[0]?.op === 'is' && ruleAnswer(r) === c.label))
  const set = (patch: Partial<FormRouting>) => { previewSequence.current++; setPreview(null); onChange({ ...value, ...patch }) }
  const setRule = (id: string, patch: Partial<RoutingRule>) => set({ rules: value.rules.map((r, i) => (`r${i}` === id ? { ...r, ...patch } : r)) })
  const setTarget = (target: RoutingTarget, patch: Partial<RoutingTarget>): RoutingTarget => ({ ...target, ...patch, ...(patch.menuId !== undefined && patch.menuId !== target.menuId ? { staffId: undefined, staffGroupId: undefined } : {}) })
  const menuOptions = [{ value: '', label: 'メニューを選ぶ' }, ...menus.map((m) => ({ value: m.id, label: `${m.name} ${m.durationMinutes} 分` }))]
  const staffOptions = (target: RoutingTarget) => [{ value: '', label: '全員' }, ...(target.staffGroupId ? [{ value: `group:${target.staffGroupId}`, label: '担当の組（登録済み）' }] : []), ...(refs.bookingMenuStaff?.[target.menuId] ?? []).map((s) => ({ value: s.id, label: s.name }))]

  const targetCells = (target: RoutingTarget, update: (next: RoutingTarget) => void, label: string, invalid: boolean) => <>
    <Td>{readOnly ? <span>{menus.find((m) => m.id === target.menuId)?.name ?? '—'}</span> : <EntitySelect aria-label={`${label}の出すメニュー`} invalid={invalid} value={target.menuId} options={menuOptions} onChange={(v) => update(setTarget(target, { menuId: v }))} />}</Td>
    <Td>{readOnly ? <span>{target.staffGroupId ? '担当の組（登録済み）' : target.staffId ? (refs.bookingMenuStaff?.[target.menuId] ?? []).find((s) => s.id === target.staffId)?.name : '全員'}</span> : <EntitySelect aria-label={`${label}の担当`} value={target.staffGroupId ? `group:${target.staffGroupId}` : target.staffId ?? ''} options={staffOptions(target)} onChange={(v) => { if (v.startsWith('group:')) return; update(setTarget(target, { staffId: v || undefined, staffGroupId: undefined })) }} disabled={!target.menuId} />}</Td>
    <Td>{readOnly ? <span>{MODES.find((m) => m.value === (target.meetingMode ?? ''))?.label}</span> : <Select aria-label={`${label}の会い方`} value={target.meetingMode ?? ''} options={MODES} onChange={(v) => update(setTarget(target, { meetingMode: (v || undefined) as RoutingTarget['meetingMode'] }))} />}</Td>
  </>

  return (
    <Card layout="vertical" contentPadding="var(--tpl-fe-card-pad)" gap="var(--tpl-fe-card-gap)" aria-labelledby="fe-routing-title">
      <div className={styles.head}>
        <span className={styles.title}>
          <h2 id="fe-routing-title" className={styles.h2}>答えで予約の行き先を分ける</h2>
          <HelpTip label="答えで予約の行き先を分けるの説明">質問への答えに合わせて、予約のメニューと担当を自動で決めます。行き先はこの表で決まるので、お客さまにはメニューと担当を選ばせず日時から始めます（下の「メニューを選んでもらう」は使いません）。上の行から順に当てはめ、どれにも当たらないときは最後の行へ進みます。</HelpTip>
        </span>
        <span className={styles.actions}>
          {value.enabled ? <Button variant="secondary" icon={<Play size={16} aria-hidden="true" />} onClick={() => { setTrying((v) => !v); previewSequence.current++; setAnswers({}); setPreview(null); setPreviewError('') }} aria-expanded={trying} aria-controls="routing-trial">試しに答える</Button> : null}
          {readOnly ? null : <Toggle label="答えで予約の行き先を分ける" checked={value.enabled} onChange={(enabled) => set({ enabled })} />}
        </span>
      </div>
      {value.enabled ? <>
        <div className={styles.questionRow}>
          <span className={styles.label}>分ける質問</span>
          {readOnly ? <span>{question?.label ?? '質問がありません'}</span> : questions.length === 0 ? <span>使える質問を追加してください。</span> : <EntitySelect aria-label="分ける質問" value={questionId} options={questions.map((q) => ({ value: q.id, label: `${q.label}（${choiceModeLabel(q.type)}）` }))}
            onChange={(id) => setPickedQuestion(id)} />}
          <span className={styles.hint}>使える質問：1 つ選ぶ・いくつでも選ぶ・プルダウン</span>
        </div>
        {/* 決まり2: 行き先の決まりは帯にせず、題の横の「？」へ入れる。 */}
        {trying ? <div id="routing-trial" className={styles.trial} role="group" aria-label="試しに答える">
          {trialQuestions.map((q) => q.kind !== 'input' ? null : <span key={q.id}>
            <span>{q.label}</span>
            {q.type === 'checkbox' ? (q.choices ?? []).map((choice) => {
              const selected = Array.isArray(answers[q.name]) ? answers[q.name] as string[] : []
              return <Checkbox key={choice.id} checked={selected.includes(choice.label)} onCheckedChange={(checked) => { void runPreview({ ...answers, [q.name]: checked ? [...selected, choice.label] : selected.filter((item) => item !== choice.label) }) }}>{choice.label}</Checkbox>
            }) : <Select aria-label={`${q.label}の試しの答え`} value={String(answers[q.name] ?? '')} options={[{ value: '', label: '答えを選ぶ' }, ...(q.type === 'rating' ? [1,2,3,4,5].map((n) => ({ value: String(n), label: String(n) })) : (q.choices ?? []).map((c) => ({ value: c.label, label: c.label })))]} onChange={(answer) => { void runPreview({ ...answers, [q.name]: q.type === 'rating' && answer ? Number(answer) : answer }) }} />}
          </span>)}
          {!onPreview ? <span>保存してから試してください。</span> : null}
          {preview ? <strong>{preview.matchedIndex === -1 ? 'どれにも当たらないとき' : `${preview.matchedIndex + 1} 行目`}：{menus.find((menu) => menu.id === preview.target.menuId)?.name ?? '行き先'}{preview.fellBack ? '（元の行き先が使えないため既定の行き先）' : ''}（保存はされません）</strong> : null}
          {previewError ? <Notice tone="danger" role="alert">{previewError}</Notice> : null}
        </div> : null}
        <DataTable aria-label="行き先の表" columnWeights={[0.35, 2, 2.3, 1.3, 1.5, 0.4]}>
          <thead><TableHeadRow><Th aria-label="並べ替え" /><Th>条件</Th><Th grow>出すメニュー</Th><Th>担当の組</Th><Th>会い方</Th><Th aria-label="操作" /></TableHeadRow></thead><tbody>
          {(readOnly ? ruled : reorder.shown).map((rule, index) => {
            const invalid = problem?.row === index
            return (
              <Tr key={rule.id} selected={hit === index} data-invalid={invalid || undefined} {...reorder.rowProps(rule.id)}>
                <HandleCell>{readOnly ? null : <ReorderHandle look="icon" label={`${index + 1} 行目`} {...reorder.handle(rule.id)} {...reorder.handleProps(rule.id)} />}</HandleCell>
                <Td><span className={styles.cond}>{rule.conditions.map((condition, i) => <span key={i} title={`${questions.find((q) => q.id === condition.questionId)?.label ?? '質問'}：${String(condition.value)}`}>{`${trialQuestions.find((q) => q.id === condition.questionId)?.label ?? '質問'}：`}〈{Array.isArray(condition.value) ? condition.value.join('・') : condition.value}〉</span>)}</span></Td>
                {targetCells(rule.target, (target) => setRule(rule.id, { target }), `${index + 1} 行目`, invalid)}
                <ActionCell>{readOnly ? null : <RowMenu appearance="box" size="row" label={`${index + 1} 行目のそのほかの操作`} open={openMenu === rule.id} onOpenChange={(o) => setOpenMenu(o ? rule.id : null)}
                  items={[...reorder.menuItems(rule.id, () => setOpenMenu(null)), { id: 'delete', label: '削除する', tone: 'danger', onSelect: () => { set({ rules: value.rules.filter((_, i) => `r${i}` !== rule.id) }); setOpenMenu(null) } }]} />}</ActionCell>
              </Tr>
            )
          })}
          <Tr data-fallback selected={hit === -1} data-invalid={problem?.row === value.rules.length || undefined}>
            <HandleCell />
            <Td><span className={styles.cond}><span>どれにも当たらない</span><StatusBadge size="compact" dot={false}>消せない</StatusBadge></span></Td>
            {targetCells(value.fallback, (fallback) => set({ fallback }), 'どれにも当たらないとき', problem?.row === value.rules.length)}
            <ActionCell>—</ActionCell>
          </Tr>
        </tbody></DataTable>
        {problem ? <Notice tone="danger">{problem.message}</Notice> : null}
        {readOnly ? null : <div className={styles.add}>
          <Button variant="text" icon={<Plus size={16} aria-hidden="true" />} disabled={answersLeft.length === 0 || value.rules.length >= MAX_ROUTING_ROWS} onClick={() => question && set({ rules: [...value.rules, newRule(question.id, answersLeft[0].label)] })}>行き先を追加</Button>
          {value.rules.length >= MAX_ROUTING_ROWS ? <span className={styles.hint}>{MAX_ROUTING_ROWS} 行までです</span> : answersLeft.length === 0 ? <span className={styles.hint}>この質問の答えはすべて表にあります</span> : null}
        </div>}
      </> : null}
    </Card>
  )
}
