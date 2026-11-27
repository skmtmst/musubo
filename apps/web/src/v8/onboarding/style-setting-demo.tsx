'use client'

import { useEffect, useRef, useState } from 'react'
import type { AccountStyle } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import { Hand, LayoutDashboard, CalendarDays, Users } from 'lucide-react'
import { Field, TextInput } from '@/components/shared/form-controls'
import { useInView, useReducedMotion, useTabVisible } from './style-experience-player/use-autoplay'
import styles from './style-setting-demo.module.css'

type Example = { area: string; open: string; field: string; value: string; save: string; steps: string[] }
const reservation = (value: string): Example => ({ area: '予約設定', open: value, field: 'メニュー名', value, save: '変更を保存する', steps: ['予約設定を開く', 'メニューを選ぶ', 'メニュー名を入力する', '変更を保存する'] })
const examples: Record<AccountStyle, Example> = {
  restaurant: { area: '座席・卓管理', open: '卓を作る', field: '表示名', value: '2人卓', save: '追加する', steps: ['座席・卓管理を開く', '卓を作る', '卓番を入力する', '表示名を入力する', '追加する'] },
  salon: reservation('カット'), consult: reservation('初めてのご相談'),
  standard: { area: 'タグ', open: 'タグを作る', field: 'タグ名', value: 'お知らせ希望', save: 'タグを作る', steps: ['タグを開く', 'タグを作る', 'タグ名を入力する', '作成を確定する'] },
  lesson: { area: 'イベント予約', open: 'イベントを作る', field: 'イベント名', value: 'ヨガレッスン', save: '下書きを保存', steps: ['イベント予約を開く', 'イベントを作る', 'イベント名などを入力する', '下書きを保存する'] },
  ec: { area: 'タグ', open: 'タグを作る', field: 'タグ名', value: 'リピーター', save: 'タグを作る', steps: ['タグを開く', 'タグを作る', 'タグ名を入力する', '作成を確定する'] },
}

/** 実際の保存は行わない、画面と操作の見本。 */
export default function StyleSettingDemo({ style }: { style: AccountStyle }) {
  const example = examples[style]
  const root = useRef<HTMLElement>(null)
  const reduced = useReducedMotion()
  const inView = useInView(root)
  const visible = useTabVisible()
  const [step, setStep] = useState(() => (reduced ? example.steps.length - 1 : 0))
  const [paused, setPaused] = useState(false)
  const [seenStyle, setSeenStyle] = useState(style)
  const [seenReduced, setSeenReduced] = useState(reduced)
  if (seenStyle !== style || seenReduced !== reduced) {
    const styleChanged = seenStyle !== style
    if (styleChanged) {
      setSeenStyle(style)
      setPaused(false)
    }
    if (seenReduced !== reduced) setSeenReduced(reduced)
    if (reduced) setStep(example.steps.length - 1)
    else if (styleChanged) setStep(0)
  }
  const safeStep = Math.min(step, example.steps.length - 1)
  useEffect(() => {
    if (reduced || !inView || !visible || paused) return
    const timer = window.setTimeout(() => { setStep(current => (current + 1) % example.steps.length) }, 2800)
    return () => window.clearTimeout(timer)
  }, [safeStep, paused, reduced, inView, visible, example.steps.length])

  const editing = safeStep >= 2
  const saving = safeStep === example.steps.length - 1
  return <section ref={root} className={styles.root} aria-label="設定操作の見本">
    <p className={styles.note}>画面と操作の見本です。実際の入力や保存は行いません。{style === 'lesson' ? '保存にはほかの項目も入力します。' : ''}</p>
    <div className={styles.toolbar}><strong>{example.steps[safeStep]}</strong>{!reduced && <Button onClick={() => setPaused(value => !value)}>{paused ? '再生する' : '止める'}</Button>}</div>
    <progress className={styles.progress} aria-label="操作の進み" value={safeStep + 1} max={example.steps.length} />
    <Card layout="vertical" padding="compact">
    <Card surface="muted" layout="vertical" padding="default" gap="normal">
      <div className={styles.canvas} aria-hidden="true" inert>
        <aside className={styles.sidebar}><strong>musubo</strong><div><LayoutDashboard size={15} /> ダッシュボード</div>{style !== 'standard' && style !== 'ec' && <div><CalendarDays size={15} /> 予約</div>}<div><Users size={15} /> 友だち</div><div className={`${styles.menuItem} ${safeStep === 0 ? styles.active : ''}`}>{example.area}{safeStep === 0 && <Hand className={styles.hand} size={22} />}</div></aside>
        <div className={styles.screen}><header className={styles.screenHead}><div><small>設定</small><h4>{example.area}</h4></div><div className={safeStep === 1 ? styles.active : ''}><Button variant="primary">{example.open}</Button>{safeStep === 1 && <Hand className={styles.hand} size={22} />}</div></header>
          <div className={styles.board}><strong>{example.area}</strong><p>設定した内容をここで確認できます。</p>
          {editing && <div className={styles.form}><strong>{style === 'restaurant' ? '新しい卓' : style === 'lesson' ? 'イベントを作る' : (style === 'ec' || style === 'standard') ? 'タグを作る' : '予約メニューを直す'}</strong>
            {style === 'restaurant' && <div className={safeStep === 2 ? styles.active : ''}><Field label="卓番" required><TextInput value="1" readOnly /></Field>{safeStep === 2 && <Hand className={styles.hand} size={22} />}</div>}
            <div className={!saving && (style !== 'restaurant' || safeStep === 3) ? styles.active : ''}><Field label={example.field} required><TextInput value={safeStep >= (style === 'restaurant' ? 3 : 2) ? example.value : ''} readOnly /></Field>{!saving && (style !== 'restaurant' || safeStep === 3) && <Hand className={styles.hand} size={22} />}</div>
            <div className={`${styles.buttonTarget} ${saving ? styles.active : ''}`}><Button variant="primary">{example.save}</Button>{saving && <Hand className={styles.hand} size={22} />}</div>
          </div>}
          </div>
        </div>
      </div>
    </Card>
    </Card>
  </section>
}
