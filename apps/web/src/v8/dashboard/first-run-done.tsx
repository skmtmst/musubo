'use client'

import { useEffect, useState } from 'react'
import type { AccountStyle } from '@line-crm/shared'
import HelpTip from '@/components/shared/help-tip'
import Dialog from '@/components/shared/dialog'
import TextLink from '@/components/shared/text-link'
import ListState from '@/components/shared/list-state'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { styleApi, type StarterSetItem } from '@/lib/api/helpers/styles'
import type { StepResult, StyleSetupProgress } from '@/v8/settings/public/getting-started-steps/index'
import { stepsForStyle } from '@/v8/settings/public/getting-started-steps/index'
import styles from './first-run-done.module.css'

/*
 * 最初の1通が届いた時の窓（SPEC-11 ③）。その場で「済み」に変わったのを見た人にだけ、ダッシュボードの上に出す。
 * 「届きました」は LINE が受け取った意味で、読んだかは言わない。閉じても帯の記憶（dismiss）は呼ばない。
 */

const KIND_ROWS: ReadonlyArray<{ kind: Exclude<StarterSetItem['kind'], 'dashboard'>; label: string }> = [
  { kind: 'rich_menu', label: 'リッチメニュー' },
  { kind: 'template', label: 'テンプレート' },
  { kind: 'automation', label: 'オートメーション' },
  { kind: 'reminder', label: 'リマインダ' },
  { kind: 'booking_menu', label: '予約メニュー' },
  { kind: 'friend_add_rule', label: '友だち追加の決まり' },
]

const RUNNING = new Set(['active', 'published'])

type ItemState = { kind: string; status: string | null }
export type DoneRow = { kind: string; label: string; badge: { tone: StatusBadgeTone; text: string }; hasStopped?: boolean }

/** 入った物を種類ごとに 1 行。送る物は動いているか止めているか、入らなかった種類は「入れなかった（あとで）」。 */
export function doneRows(definition: ReadonlyArray<Pick<StarterSetItem, 'kind'>>, items: ReadonlyArray<ItemState>): DoneRow[] {
  return KIND_ROWS.flatMap(({ kind, label }): DoneRow[] => {
    const planned = definition.some((item) => item.kind === kind)
    const inserted = items.filter((item) => item.kind === kind)
    if (!planned && inserted.length === 0) return []
    if (inserted.length === 0) return [{ kind, label, badge: { tone: 'neutral', text: '入れなかった（あとで）' } }]
    if (kind === 'template') return [{ kind, label, badge: { tone: 'neutral', text: '入っています' } }]
    const running = inserted.some((item) => item.status !== null && RUNNING.has(item.status))
    const hasStopped = inserted.some((item) => item.status !== null && item.status !== 'missing' && !RUNNING.has(item.status))
    const missingCount = inserted.filter((item) => item.status === 'missing').length
    if (missingCount > 0) {
      return [{ kind, label, badge: { tone: 'warning', text: missingCount === inserted.length ? '見つかりません' : '一部見つかりません' }, hasStopped }]
    }
    if (!running && inserted.some((item) => item.status === null)) {
      return [{ kind, label, badge: { tone: 'warning', text: '状態を確認できません' } }]
    }
    return [{ kind, label, badge: running ? { tone: 'success', text: '動いています' } : { tone: 'warning', text: '止めています' }, hasStopped }]
  })
}

/** 「開始から N 分」。60 分を超えたら「N 時間 M 分」。分は Worker が計算した数をそのまま使う。 */
export function elapsedText(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return null
  if (minutes <= 60) return `開始から ${minutes} 分`
  return `開始から ${Math.floor(minutes / 60)} 時間 ${minutes % 60} 分`
}

export function FirstRunDoneDialog({ accountId, style, minutes, steps, progress, onClose }: {
  accountId: string
  style: AccountStyle
  minutes: number | null
  steps: ReadonlyArray<StepResult>
  progress?: StyleSetupProgress
  onClose: () => void
}) {
  const [rows, setRows] = useState<DoneRow[] | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    setRows(null)
    setError('')
    void Promise.all([styleApi.starterSet(accountId, style), styleApi.starterItems(accountId)]).then(([set, items]) => {
      if (!set.success || !items.success) throw new Error('starter_unavailable')
      if (!cancelled) setRows(doneRows(set.data.definition.items, items.data.items))
    }).catch((caught: unknown) => { if (!cancelled) setError(describeApiFailure(caught, '読み込み')) })
    return () => { cancelled = true }
  }, [accountId, style, tick])
  const elapsed = elapsedText(minutes)
  const next = stepsForStyle(steps, style, progress).filter((step) => step.state !== 'done' && step.action)
  return (
    <Dialog
      open
      title="最初の 1 通が届きました"
      description={elapsed ?? undefined}
      size="large"
      onCancel={onClose}

    >
      <div className={styles.body}>
        <p className={styles.note}>LINE がお客さまへの 1 通を受け取りました。</p>
        <section className={styles.section} aria-labelledby="first-run-done-items">
          <h3 id="first-run-done-items" className={styles.title}>入った物</h3>
          {error ? <ListState kind="error" title="入った物を読み込めませんでした" error={error} onRetry={() => setTick((n) => n + 1)} />
            : rows === null ? <ListState kind="loading" title="入った物を確かめています" />
              : (
                <ul className={styles.rows}>
                  {rows.map((row) => (
                    <li key={row.kind} className={styles.row}>
                      <span className={styles.rowLabel}>{row.label}</span>
                      <StatusBadge tone={row.badge.tone} dot>{row.badge.text}</StatusBadge>
                    </li>
                  ))}
                </ul>
              )}
          {rows?.some((row) => row.hasStopped) ? <p className={styles.note}>止めている物は、はじめの質問の最後の一覧の［まとめて動かす］から動かせます。</p> : null}
        </section>
        {next.length > 0 ? (
          <section className={styles.section} aria-labelledby="first-run-done-next">
            <h3 id="first-run-done-next" className={styles.title}>次にやること</h3>
            <ul className={styles.rows}>
              {next.map((step) => (
                <li key={step.key} className={styles.row}>
                  <span className={styles.rowLabel}>{step.title}</span>
                  {step.state === 'unknown' ? <HelpTip label={`${step.title}の未確認の理由`}>{step.next}</HelpTip> : null}
                  <TextLink tone="action" href={step.action!.href} className={styles.link}>開く</TextLink>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Dialog>
  )
}
