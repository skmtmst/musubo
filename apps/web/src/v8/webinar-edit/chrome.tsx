'use client'

/*
 * ウェビナーの編集（V8）の頭まわり。
 * - 詳細の頭（参加者 ・分析 ・コメント演出 ）：戻る → 題 → 説明の行、右に操作、下にタブ。
 * - 作る手順の帯（作る型 CreatePage の steps に渡す）：5段、済みの段へ戻れる（型の共通部品 Steps）。
 */
/*
 * ウェビナーの編集（V8）の頭まわり。
 * - 詳細の頭（参加者 ・分析 ・コメント演出 ）：戻る → 題 → 説明の行、右に操作、下にタブ。
 * - 作る手順の帯（作る型 CreatePage の steps に渡す）：5段、済みの段へ戻れる（型の共通部品 Steps）。
 */
import type { ReactNode } from 'react';
import { Tabs } from '@/components/shared/tabs'
import { Steps } from '@/components/templates/steps';
import { PageHeading } from '@/components/templates/page-frame';
import { STEPS, type PaneKey, type StepKey } from './helpers';
import styles from './chrome.module.css'

export function BackLink() { return null }

const DETAIL_TABS: ReadonlyArray<{ key: PaneKey; label: string }> = [
  { key: 'basic', label: '設定' },
  { key: 'participants', label: '参加者' },
  { key: 'analytics', label: '分析' },
  { key: 'comments', label: 'コメント演出' },
]

export function DetailHead({
  title,
  subtitle,
  actions,
  menuActions,
  current,
  participantsCount,
  onSelect,
}: {
  title: string
  subtitle: string
  actions?: ReactNode
  menuActions?: ReactNode
  current: PaneKey
  participantsCount: number | null
  onSelect: (key: PaneKey) => void
}) {
  return (
    <>
      <PageHeading title={title} explanationKey={`webinar:${current}`} help={<>{subtitle}{current === 'participants' ? <p>「見ていない」は申込だけで入場の記録がない人です。「入場のみ」は入場したが再生を確かめられなかった人です。</p> : null}</>} actions={actions || menuActions ? <>{actions}{menuActions}</> : undefined} />
      <div className={styles.tabsRow}>
        <Tabs label="設定・参加者・分析・コメント演出" items={DETAIL_TABS.map((tab) => ({
          label: tab.key === 'participants' && participantsCount !== null && Number.isFinite(participantsCount) ? `${tab.label} ${participantsCount}` : tab.label,
          current: tab.key === current,
          onClick: () => { if (tab.key !== current) onSelect(tab.key) },
        }))} />
      </div>
    </>
  )
}

/**
 * 作る手順の帯。型の共通部品 Steps（Fa8ED）へ渡すだけ。済みの段は押して戻れる（まだの段は押せない・2026-10-08 オーナー）。
 */
export function WizardSteps({
  current,
  stateOf,
  onSelect,
  summaries,
  readOnly,
}: {
  current: StepKey
  summaries?: Readonly<Record<string, string>>
  readOnly?: boolean
  stateOf: (key: StepKey) => 'done' | 'current' | 'todo'
  /** 渡さないときは段を押せない（作る前など）。 */
  onSelect?: (key: StepKey) => void
}) {
  return (
    <Steps
      label="ウェビナーを作る進み方"
      currentKey={current}
      summaries={summaries}
      readOnly={readOnly}
      steps={STEPS.map((step) => {
        const state = stateOf(step.key)
        const selectable = state === 'done' && step.key !== current
        return {
          key: step.key,
          label: step.title,
          order: step.no,
          state: state === 'current' ? 'todo' : state,
          onSelect: onSelect && selectable ? () => onSelect(step.key) : undefined,
        }
      })}
    />
  )
}
