'use client'

import Card from '@/components/shared/card'
import Button from '@/components/shared/button'

import { Check, Circle, CircleCheck, CircleDot } from 'lucide-react'
import type { StepperStep } from '@/components/shared/stepper'
import { useImperativeHandle, useLayoutEffect, useRef, type HTMLAttributes, type Ref } from 'react'
import { motionEasing, motionMs, prefersReducedMotion, shouldAnimateLeave } from '@/components/shared/overlay-utils'
import styles from './steps.module.css'

export type { StepperStep as StepsStep } from '@/components/shared/stepper'

type DotState = 'done' | 'current' | 'todo' | 'attention'

/**
 * ★V8 の手順（共通部品 Fa8ED「手順（共通・題と説明の下・左寄せ）」・決まりの板 q1xNMz。2026-10-08 オーナー）。
 *
 * - 作る画面の題と説明の下に置き、丸を等間隔に並べ、名前を丸の下で中央にそろえる。
 * - 済みは薄い緑にチェック、今は緑の輪と数字、まだは灰の輪と数字。段の間を線でつなぐ。
 * - 済みの段（と直すところがある段）は押して戻れる。まだの段・今の段は押せない（reachable の付いたまだの段だけ、番号のまま押して進める）
 * - 入らない幅では各名を1行で省略し、全文は読み上げと title に残す
 *
 * 渡し方は共通の型（label・steps・currentKey）。手順の見た目はこのV8部品だけを使う。
 */
export function Steps({
  label,
  steps,
  currentKey,
  connectorSize,
  layout = 'horizontal',
  summaries,
  summaryLayout = 'default',
  readOnly = false,
  variant = 'default',
  animate = false,
}: {
  /** 何の進みか（例：「リッチメニューを作る手順」）。nav の読み上げ名。 */
  label: string
  steps: ReadonlyArray<StepperStep>
  /** いまいる段の key（例：URL の `?step=`）。渡さないときは state が current の最初の段。 */
  currentKey?: string
  connectorSize?: 'short'
  /** 窓の左で、回答済み・現在・未回答の質問へ移る列。 */
  layout?: 'horizontal' | 'sidebar'
  /** 済んだ入力の要約。値を持つ画面だけが渡す。 */
  summaries?: Readonly<Record<string, string>>
  summaryLayout?: 'default' | 'aligned'
  readOnly?: boolean
  /** `auth` はログイン前の画面の小さな帯（丸 24・文字 12・線 2）。 */
  variant?: 'default' | 'auth'
  /** 画面が出たときに、済み → 線 → 今の段の順に動かす（動きを減らす設定では動かさない）。 */
  animate?: boolean
}) {
  const rootRef = useRef<HTMLElement>(null)
  const items = steps.map((raw, index) => ({ ...raw, key: raw.key ?? raw.label, order: raw.order ?? index + 1 }))
  const currentIndex = currentKey !== undefined
    ? items.findIndex((step) => step.key === currentKey)
    : items.findIndex((step) => step.state === 'current')
  const stateOf = (index: number): DotState => {
    if (index === currentIndex) return 'current'
    const state = items[index].state
    return state === 'current' ? 'todo' : state
  }

  const summaryItems = summaries ? items.filter((step, index) => stateOf(index) === 'done' && summaries[step.key]) : []

  useLayoutEffect(() => {
    if (!animate || layout === 'sidebar' || typeof window === 'undefined' || prefersReducedMotion()) return
    const root = rootRef.current
    if (!root || typeof root.querySelector !== 'function') return
    const done = root.querySelector<HTMLElement>('[data-step-dot="done"]')
    const current = root.querySelector<HTMLElement>('[data-step-dot="current"]')
    const line = root.querySelector<HTMLElement>('[data-step-line]')
    const target = done ?? current
    if (!target?.animate) return
    const easing = motionEasing()
    const spring = motionEasing('--motion-spring')
    const dotMs = motionMs('--motion-exit', 150)
    const lineMs = motionMs('--motion-base', 200)
    const animations: Animation[] = []
    if (done?.animate) animations.push(done.animate([
      { transform: 'scale(0.8)' },
      { transform: 'scale(1)' },
    ], { duration: dotMs, easing: spring, fill: 'both' }))
    if (line?.animate) animations.push(line.animate([
      { transform: 'scaleX(0)' },
      { transform: 'scaleX(1)' },
    ], { duration: lineMs, delay: dotMs, easing, fill: 'both' }))
    if (current?.animate) animations.push(current.animate([
      { transform: 'scale(0.8)', opacity: 0 },
      { transform: 'scale(1)', opacity: 1 },
    ], { duration: dotMs, delay: dotMs + lineMs, easing, fill: 'both' }))
    return () => animations.forEach((animation) => animation.cancel())
  }, [animate, layout])

  if (layout === 'sidebar') return (
    <nav aria-label={label} data-part="steps" data-layout="sidebar" className={styles.root}>
      <ol className={styles.sidebarList}>
        {items.map((step, index) => {
          const state = stateOf(index)
          const Icon = state === 'current' ? CircleDot : state === 'done' ? CircleCheck : Circle
          return <li key={step.key} aria-current={state === 'current' ? 'step' : undefined}>
            <button type="button" className={styles.sidebarStep} data-state={state} onClick={step.onSelect} disabled={!step.onSelect}>
              <Icon aria-hidden="true" className={styles.sidebarIcon} /><span className={styles.sidebarName}>{step.label}</span>
            </button>
          </li>
        })}
      </ol>

    </nav>
  )

  return (
    <nav ref={rootRef} aria-label={label} data-part="steps" data-connector-size={connectorSize} data-variant={variant === 'auth' ? 'auth' : undefined} className={styles.root}>
      <ol className={styles.list} data-design="Steps">
        {items.map((step, index) => {
          const state = stateOf(index)
          const isCurrent = state === 'current'
          const forward = state === 'todo' && step.reachable === true
          const clickable = (state === 'done' || state === 'attention' || forward) && Boolean(step.anchor || step.onSelect)
          const lineDone = index > 0 && stateOf(index - 1) === 'done'
          const dot = (
            <span className={styles.dot} data-step-dot={state} title={state === 'attention' ? '直すところがあります' : undefined}>
              {state === 'done'
                ? <><Check className={styles.check} aria-hidden="true" strokeWidth={2} /><span className={styles.srOnly}>済み</span></>
                : state === 'attention'
                  ? <><span aria-hidden="true">△</span><span className={styles.srOnly}>直すところあり</span></>
                  : step.order}
            </span>
          )
          const name = <span className={styles.name} data-step-name={state}>{step.label}</span>
          return (
            <li key={step.key} className={styles.item} data-step-state={state}>
              {index > 0 ? <span aria-hidden="true" className={styles.line} data-step-line={lineDone ? 'done' : 'todo'} /> : null}
              {clickable ? (
                <button
                  type="button"
                  className={styles.step}
                  title={step.label}
                  aria-label={`${step.label}に${forward ? '進む' : '戻る'}`}
                  onClick={() => {
                    if (step.onSelect) {
                      step.onSelect?.()
                      return
                    }
                    if (step.anchor) document.getElementById(step.anchor)?.scrollIntoView({ block: 'start' })
                  }}
                >
                  {dot}
                  {name}
                </button>
              ) : (
                <span className={styles.step} title={step.label} aria-current={isCurrent ? 'step' : undefined}>
                  {dot}
                  {name}
                </span>
              )}
            </li>
          )
        })}
      </ol>
      {summaries && summaryItems.length > 0 ? <div role="list" aria-label="設定済みの内容" data-summary-layout={summaryLayout} className={styles.summaries}>
        {summaryItems.map((step) => <div role="listitem" key={step.key} className={styles.sectionHead}>
          <span className={styles.sectionTitle}>{step.label}</span>
          <span className={styles.sectionSummary} title={summaries[step.key]}>{summaries[step.key]}</span>
          {step.onSelect && !readOnly ? <Button variant="secondary" size="compact" aria-label={`${step.label}を変える`} onClick={step.onSelect}>変える</Button> : null}
        </div>)}
      </div> : null}
    </nav>
  )
}

/** 入力を作り直さず、進む・戻る方向だけを示す。次の操作で前の動きを取り消す。 */
export function StepContent({ step, children, as: Element = 'div', disabled, elementRef, slide = true, ...props }: HTMLAttributes<HTMLElement> & { step: number | null; as?: 'div' | 'fieldset'; disabled?: boolean; elementRef?: Ref<HTMLElement>; slide?: boolean }) {
  const ref = useRef<HTMLDivElement & HTMLFieldSetElement>(null)
  useImperativeHandle(elementRef, () => ref.current!)
  const previous = useRef(step)
  useLayoutEffect(() => {
    const from = previous.current
    previous.current = step
    const panel = ref.current
    if (step === null || from === null || from === step || !panel?.animate || !shouldAnimateLeave()) return
    const animation = panel.animate(slide ? [
      { transform: step > from ? 'translateX(var(--polish-space-card))' : 'translateX(calc(-1 * var(--polish-space-card)))' },
      { transform: 'translateX(0)' },
    ] : [{ opacity: 0 }, { opacity: 1 }], { duration: motionMs('--motion-exit', 150), easing: motionEasing() })
    // 次の操作や閉じる操作による取消は、保存や画面の失敗ではない。
    void animation.finished?.catch(() => {})
    return () => animation.cancel()
  }, [step, slide])
  return <Element {...props} data-step-content disabled={Element === 'fieldset' ? disabled : undefined} ref={ref}>{children}</Element>
}

/** 段を開いて入力し、閉じた段には要約と変更口を残す作成画面。 */
export function StepSection({ order, title, summary, open, onChange, children, readOnly = false }: {
  order: number; title: string; summary: string; open: boolean; onChange: () => void; children: import('react').ReactNode; readOnly?: boolean
}) {
  return <Card padding="default" layout="vertical" gap="var(--polish-space-field)" selected={open} aria-label={`${order} ${title}`}>
    <div className={styles.sectionHead}>
      <span className={styles.sectionNumber}>{order}</span>
      <span className={styles.sectionTitle}>{title}</span>
      <span className={styles.sectionSummary} title={open ? undefined : summary}>{open ? null : summary}</span>
      {open || readOnly ? null : <Button variant="secondary" onClick={onChange}>変える</Button>}
    </div>
    {open ? <div className={styles.sectionBody}>{children}</div> : null}
  </Card>
}
