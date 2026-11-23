'use client'

import EntitySelect from '@/components/shared/entity-select'

import { DataTable, TableHeadRow, Tr, Td, Th, HandleCell, ActionCell } from '@/components/shared/table'

import Notice from '@/components/shared/notice'

import { useMemo, useState } from 'react'
import { Play, Plus } from 'lucide-react'
import type { FormBlock } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import HelpTip from '@/components/shared/help-tip'
import { RowMenu } from '@/components/shared/row-actions'
import ReorderHandle, { useReorder } from '@/components/shared/reorder-handle'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import Toggle from '@/components/shared/toggle'
import type { FormRefs } from '@/components/forms/form-refs'
import { choiceModeLabel, type FormRouting, type RoutingRule, type RoutingTarget, emptyRouting, hasBookingBlock, matchRule, MAX_ROUTING_ROWS, newRule, routingError, routingQuestions, ruleAnswer } from './routing-model'
import styles from './routing-section.module.css'

const MODES = [{ value: '', label: '指定しない' }, { value: 'in_person', label: 'お店で' }, { value: 'online', label: 'オンライン' }]

/*
 * 回答フォーム 編集 › 中身 の区画「答えで予約の行き先を分ける」（B6-1・BGoRL）。
 * 表の 1 行 1 決まり・上から順に当てる・最後の行は消せない。「試しに答える」は保存せず、当たった行を緑で光らせる。
 * 閲覧のみの人には編集を出さず、試しだけ使える（何も変えないため）。決まりは回答フォームの版に含める。
 */
export default function RoutingSection({ blocks, refs, routing, readOnly, onChange }: {
  blocks: FormBlock[]
  refs: FormRefs
  routing: FormRouting | undefined
  readOnly?: boolean
  onChange: (next: FormRouting) => void
}) {
  const questions = useMemo(() => routingQuestions(blocks), [blocks])
  const value = routing ?? emptyRouting()
  const [trying, setTrying] = useState(false)
  const [trial, setTrial] = useState('')
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [pickedQuestion, setPickedQuestion] = useState<string | null>(null)
  const questionId = value.rules[0]?.conditions[0]?.questionId ?? pickedQuestion ?? questions[0]?.id ?? ''
  const question = questions.find((q) => q.id === questionId) ?? null
  const menus = refs.bookingMenus ?? []
  const ruled = value.rules.map((r, i) => ({ ...r, id: `r${i}` }))
  const reorder = useReorder({ items: ruled, idOf: (r) => r.id, disabledReason: readOnly ? '閲覧のみのため並べ替えられません' : null, onReorder: ({ ids }) => onChange({ ...value, rules: ids.map((id) => value.rules[Number(id.slice(1))]) }) })
  const problem = routingError(value)
  if (!hasBookingBlock(blocks) || questions.length === 0) return null

  const hit = trying && trial && question ? matchRule(value, question.id, [trial]) : null
  const answersLeft = (question?.choices ?? []).filter((c) => !value.rules.some((r) => ruleAnswer(r) === c.label))
  const set = (patch: Partial<FormRouting>) => onChange({ ...value, ...patch })
  const setRule = (id: string, patch: Partial<RoutingRule>) => set({ rules: value.rules.map((r, i) => (`r${i}` === id ? { ...r, ...patch } : r)) })
  const setTarget = (target: RoutingTarget, patch: Partial<RoutingTarget>): RoutingTarget => ({ ...target, ...patch, ...(patch.menuId !== undefined && patch.menuId !== target.menuId ? { staffId: undefined, staffGroupId: undefined } : {}) })
  const menuOptions = [{ value: '', label: 'メニューを選ぶ' }, ...menus.map((m) => ({ value: m.id, label: `${m.name} ${m.durationMinutes} 分` }))]
  const staffOptions = (menuId: string) => [{ value: '', label: '全員' }, ...(refs.bookingMenuStaff?.[menuId] ?? []).map((s) => ({ value: s.id, label: s.name }))]

  const targetCells = (target: RoutingTarget, update: (next: RoutingTarget) => void, label: string, invalid: boolean) => <>
    <Td>{readOnly ? <span>{menus.find((m) => m.id === target.menuId)?.name ?? '—'}</span> : <EntitySelect aria-label={`${label}の出すメニュー`} invalid={invalid} value={target.menuId} options={menuOptions} onChange={(v) => update(setTarget(target, { menuId: v }))} />}</Td>
    <Td>{readOnly ? <span>{target.staffId ? (refs.bookingMenuStaff?.[target.menuId] ?? []).find((s) => s.id === target.staffId)?.name : '全員'}</span> : <EntitySelect aria-label={`${label}の担当`} value={target.staffId ?? ''} options={staffOptions(target.menuId)} onChange={(v) => update(setTarget(target, { staffId: v || undefined }))} disabled={!target.menuId} />}</Td>
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
          {value.enabled ? <Button variant="secondary" icon={<Play size={16} aria-hidden="true" />} onClick={() => { setTrying((v) => !v); setTrial('') }} aria-expanded={trying} aria-controls="routing-trial">試しに答える</Button> : null}
          {readOnly ? null : <Toggle label="答えで予約の行き先を分ける" checked={value.enabled} onChange={(enabled) => set({ enabled })} />}
        </span>
      </div>
      {value.enabled ? <>
        <div className={styles.questionRow}>
          <span className={styles.label}>分ける質問</span>
          {readOnly ? <span className="text-body">{question?.label}</span> : <EntitySelect aria-label="分ける質問" value={questionId} options={questions.map((q) => ({ value: q.id, label: `${q.label}（${choiceModeLabel(q.type)}）` }))}
            onChange={(id) => { setPickedQuestion(id); set({ rules: [] }) }} />}
          <span className={styles.hint}>使える質問：1 つ選ぶ・いくつでも選ぶ・プルダウン</span>
        </div>
        {/* 決まり2: 行き先の決まりは帯にせず、題の横の「？」へ入れる。 */}
        {trying && question ? <div id="routing-trial" className={styles.trial} role="group" aria-label="試しに答える">
          <span>もしお客さまが「{question.label}」に</span>
          <Select aria-label="試しの答え" value={trial} options={[{ value: '', label: '答えを選ぶ' }, ...(question.choices ?? []).map((c) => ({ value: c.label, label: c.label }))]} onChange={setTrial} />
          <span>と答えたら</span>
          {trial ? <strong>{hit === -1 || hit === null ? '「どれにも当たらないとき」の行き先になります（保存はされません）' : `${(hit ?? 0) + 1} 行目の行き先になります（保存はされません）`}</strong> : null}
        </div> : null}
        <DataTable aria-label="行き先の表">
          <thead><TableHeadRow><Th aria-label="並べ替え" /><Th>もし「{question?.label ?? '質問'}」が</Th><Th grow>出すメニュー</Th><Th>担当の組</Th><Th>会い方</Th><Th aria-label="操作" /></TableHeadRow></thead><tbody>
          {(readOnly ? ruled : reorder.shown).map((rule, index) => {
            const invalid = problem?.row === index
            return (
              <Tr key={rule.id} selected={hit === index} data-invalid={invalid || undefined} {...reorder.rowProps(rule.id)}>
                <HandleCell>{readOnly ? null : <ReorderHandle look="icon" label={`${index + 1} 行目`} {...reorder.handle(rule.id)} {...reorder.handleProps(rule.id)} />}</HandleCell>
                <Td><span className={styles.cond}><span title={ruleAnswer(rule)}>〈{ruleAnswer(rule)}〉</span></span></Td>
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
