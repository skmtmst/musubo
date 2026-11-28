'use client'

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Pause, Play } from 'lucide-react'
import type { AccountStyle } from '@line-crm/shared'
import Button from '@/components/shared/button'
import { observeElementResize } from '@/components/shared/element-resize-observer'
import { KpiValueMotionProvider } from '@/components/shared/kpi-value-motion'
import SegmentedControl from '@/components/shared/segmented'
import { Steps } from '@/components/templates/steps'
import { BoardPane, CanList, DashboardPane, PhonePane, SampleKpiBand } from './scenes'
import type { StyleExperienceScript } from './script-types'
import { useStyleExperienceAutoplay } from './use-autoplay'
import styles from './player.module.css'

/*
 * スタイル体験の見本（共通節 S-4 の口）。最小版＝スマホ枠＋数の帯、全部版＝3 つの画面＋Steps。
 * 自動再生とクロスフェードは決まり §6.15 の 11 の例外で、この部品の中だけ。
 * 舞台は設計の幅で組み、器の幅に合わせて外の器だけを縮める（中の部品の CSS は上書きしない）。
 */

/** 右の 2 画面（ダッシュボード・盤）を組む設計の幅。player.module.css の --sxp-panes-design-w と同じ。 */
const PANES_DESIGN_WIDTH = 800
/** 白い板が 1100 未満（板の左右の余白を引いた器の幅）で、3 つの画面を縦に積む。 */
const STACK_BELOW = 1052
/** 右の 2 画面のいちばん小さい文字（11px）が、縮めても 10px を下回らない割合。下回る幅では縦に積む。 */
const MIN_SCALE = 10 / 11
/** スマホ枠の幅（--sxp-phone-w）と、右の 2 画面との間（--polish-space-section）。 */
const PHONE_WIDTH = 330
const PANES_GAP = 24
/** 撮影台で日付をそろえる日（日本時間）。 */
const RECORD_BASE = '2026-11-02T09:00:00+09:00'
const CIRCLED = '①②③④⑤⑥⑦⑧⑨'

export type StyleExperiencePlayerProps = {
  accountName?: string
  script: StyleExperienceScript
  /** 見ているスタイル。渡すと外が持つ。 */
  style?: AccountStyle
  onStyleChange?: (style: AccountStyle) => void
  /** external＝上の切り替えを出さない（スタイルを選ぶ画面が切り替えを持つ）。 */
  switcher: 'segmented' | 'external'
  variant: 'minimal' | 'full'
  /** 本物のデータで同じ画面を出すのは初期セットの後（今は作り物だけ）。 */
  data?: 'sample'
  /** 撮影台。止めるボタンを隠し、日付をそろえる。 */
  record?: boolean
}

function useStageScale(rootRef: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ scale: 1, stacked: false })
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const measure = () => {
      const width = root.clientWidth
      if (!width) return
      // 並べた時は、右の 2 画面の器の幅を設計の幅で割る。積んだ時は縮めない。
      // 器の幅は並べた時の幅で求める（積んでいる間は右の器が全幅になるため、器の幅からスマホ枠と間を引く）。
      const panesWidth = width - PHONE_WIDTH - PANES_GAP
      const fitted = Math.min(1, panesWidth / PANES_DESIGN_WIDTH)
      const stacked = width < STACK_BELOW || fitted < MIN_SCALE
      const scale = stacked ? 1 : fitted
      setSize((current) => (current.scale === scale && current.stacked === stacked ? current : { scale, stacked }))
    }
    measure()
    return observeElementResize([root], measure)
  }, [rootRef])
  return size
}

export function StyleExperiencePlayer({ accountName, script, style, onStyleChange, switcher, variant, record = false }: StyleExperiencePlayerProps) {
  const rootRef = useRef<HTMLElement>(null)
  const full = variant === 'full'
  // 全部版は右の画面がそろったスタイルだけを回す（教室は LIFF の描く部分の切り出しの後）。
  const rotation = useMemo(() => script.order.filter((name) => {
    const scenes = script.styles[name]?.scenes
    if (!scenes?.length) return false
    return !full || scenes.every((scene) => scene.board)
  }), [script, full])
  const tabs = useMemo(() => script.tabs.filter((tab) => tab.styles.some((name) => rotation.includes(name))), [script, rotation])
  const tabValue = (tab: StyleExperienceScript['tabs'][number]) => tab.styles.find((name) => rotation.includes(name)) ?? tab.styles[0]
  const { position, scene, running, reduced, manual, userPaused, togglePause, goToStep, selectStyle } = useStyleExperienceAutoplay({
    script, style, onStyleChange, rotation, repeatStyle: switcher === 'external', rootRef,
  })
  const activeTab = tabs.find((tab) => tab.styles.includes(position.style))
  const { scale, stacked } = useStageScale(rootRef)
  const [base] = useState(() => (record ? new Date(RECORD_BASE) : new Date()))
  const sampleLook = script.styles[position.style]
  const look = accountName === undefined ? sampleLook : { ...sampleLook, account: accountName }
  const step = look.steps[position.index]
  const board = full ? scene.board : undefined
  const announce = `${look.label}：${CIRCLED[position.index] ?? position.index + 1} ${step.label}。${scene.line}`

  return (
    <section ref={rootRef} className={styles.root} aria-label="スタイル体験の見本" data-style-experience={position.style} data-variant={variant} data-layout={stacked ? 'stacked' : 'row'} data-reduced-motion={reduced || undefined}
      style={{ '--sxp-scale': scale } as CSSProperties}>
      {switcher === 'segmented' ? <>
        <SegmentedControl aria-label="見るスタイル" value={activeTab ? tabValue(activeTab) : position.style}
          onChange={(value) => selectStyle(value)} options={tabs.map((tab) => ({ value: tabValue(tab), label: tab.label }))} />
        <CanList look={look} />
      </> : null}
      <KpiValueMotionProvider scope={`style-experience:${position.style}`}>
        {/* 中の部品は押せない見本。読み上げは下の 1 行だけ。段が変わると 3 つの画面を同じ時に描き直す。 */}
        <div className={styles.frame} inert aria-hidden="true" data-scene={`${position.style}:${scene.step}`}>
          <div key={`phone:${position.style}:${position.index}`} className={styles.phone} data-pane="phone"><PhonePane phone={scene.phone} style={position.style} look={look} base={base} /></div>
          <div className={styles.panes}>
            <div key={`panes:${position.style}:${position.index}`} className={styles.panesStage}>
              {full ? <div className={styles.pane} data-pane="dashboard"><DashboardPane dashboard={scene.dashboard} style={position.style} /></div>
                : <div className={styles.pane} data-pane="kpis"><SampleKpiBand kpis={scene.dashboard.kpis} style={position.style} /></div>}
              {board ? <div className={styles.pane} data-pane="board"><BoardPane board={board} base={base} /></div> : null}
            </div>
          </div>
        </div>
      </KpiValueMotionProvider>
      <div className={styles.lineRow}>
        <p className={styles.line} aria-hidden="true">{scene.line}</p>
        <p className={styles.srOnly} aria-live={running && !manual ? 'off' : 'polite'}>{announce}</p>
        {record ? null : <Button variant="secondary" size="compact" onClick={togglePause} disabled={reduced} disabledReason={reduced ? '動きを減らす設定のため、自動では進みません。下の手順を押すと移れます。' : undefined}>
          {userPaused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}{userPaused ? '動かす' : '止める'}
        </Button>}
      </div>
      {full || reduced ? <Steps label={`${look.label}の流れ`} currentKey={step.key} steps={look.steps.map((item, index) => ({
        key: item.key, label: item.label, state: index < position.index ? 'done' : index === position.index ? 'current' : 'todo', reachable: true, onSelect: () => goToStep(index),
      }))} /> : null}
    </section>
  )
}
