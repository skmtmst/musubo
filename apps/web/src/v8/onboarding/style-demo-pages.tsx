'use client'

import { useEffect, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import { useInView, useReducedMotion, useTabVisible } from './style-experience-player/use-autoplay'
import type { AccountStyle } from '@line-crm/shared'
import Card from '@/components/shared/card'
import { Field, TextInput } from '@/components/shared/form-controls'
import { Steps } from '@/components/templates/steps'
import { Check } from 'lucide-react'
import { styleTerm } from '@/lib/terms'
import { RestaurantFollowupDemo } from '@/v8/restaurant/line-followup/public/demo'
import { ConsultAfterDemo, ConsultOperationDemo, EcAfterDemo, EcOperationDemo, LessonAfterDemo, LessonOperationDemo, RestaurantAfterDemo, SalonAfterDemo, SalonOperationDemo, StandardAfterDemo } from './style-operation-demo'
import { STYLE_EXPERIENCE_SCRIPT, StyleExperiencePlayer } from './style-experience-player'
import StyleSettingDemo from './style-setting-demo'
import styles from './style-demo-pages.module.css'

const afterLabel: Record<AccountStyle, string> = { restaurant: '来店のあとも', salon: '来店のあとも', consult: '相談のあとも', lesson: 'レッスンのあとも', standard: '問い合わせのあとも', ec: '注文のあとも' }
const labelsFor = (style: AccountStyle) => ['できること', '設定のしかた', style === 'restaurant' ? 'LINE来店フォロー' : style === 'standard' ? 'お知らせを作る' : 'よく使う操作', afterLabel[style], '見本から始める']
const headings: Record<AccountStyle, string[]> = {
 restaurant: ['席と人数で、予約を受ける', '予約を受ける準備をする', 'LINE来店フォローで、かんたんに作る', '来店のあとも、つながりが続く', 'お店に合う見本から始められる'],
 salon: ['メニューと担当で、予約を受ける', '予約を受ける準備をする', '担当ごとの予定を確認する', '来店のあとも、つながりが続く', 'サロンに合う見本から始められる'],
 consult: ['相談の予約を、わかりやすく受ける', '相談を受ける準備をする', '相談の予定を確認する', '相談のあとも、つながりが続く', '相談に合う見本から始められる'],
 lesson: ['レッスンの予定と予約をまとめる', 'イベントを受け付ける準備をする', 'クラスの予定を確認する', 'レッスンのあとも、つながりが続く', '教室に合う見本から始められる'],
 standard: ['問い合わせとお知らせを、ひとつに', 'お客さまを分類する準備をする', 'お知らせを作る', '問い合わせのあとも、つながりが続く', '使い方に合う見本から始められる'],
 ec: ['注文とお問い合わせを確認する', `${styleTerm('ec', 'V12')}を分類する準備をする`, '商品の案内を用意する', '注文のあとも、つながりが続く', 'お店に合う見本から始められる'],
}
const content: Record<AccountStyle, { setting: string; operation: string; after: string; feature: string }> = {
  restaurant: { setting: '席と卓を登録し、人数に合わせた予約を受けます。', operation: '予約の前日や来店後の案内を用意します。', after: '予約を確認し、来店を記録します。', feature: '席・人数・コースに合わせたお店の見本から始められます。' },
  salon: { setting: 'メニューと担当者、受付時間を設定します。', operation: '担当ごとの予定を確認します。', after: '来店を記録し、次のご案内に備えます。', feature: '担当とメニューに合わせた見本から始められます。' },
  consult: { setting: '相談のメニューと受付時間を設定します。', operation: 'オンラインまたは対面の相談予約を確認します。', after: '面談の結果を確認し、次のご案内に備えます。', feature: '相談の使い方に合わせた見本から始められます。' },
  lesson: { setting: 'イベント予約を使う場合は、受付の予定を設定します。', operation: 'クラスの予定と出席を確認します。', after: 'レッスンの出席を記録します。', feature: 'クラスと出欠に合わせた見本から始められます。' },
  standard: { setting: 'お客さまを分類するタグを作れます。', operation: 'お知らせの文とプレビューを確認します。', after: 'お問い合わせを受信箱で確認し、担当者が返事します。', feature: '使い方に合わせた見本と画面から始められます。' },
  ec: { setting: `${styleTerm('ec', 'V12')}を分類するタグを作れます。`, operation: '商品の案内を用意します。', after: '注文の数とお問い合わせを確認します。', feature: 'お店の使い方に合わせた見本から始められます。' },
}

function FollowupDemoPlayer() {
  const root = useRef<HTMLElement>(null)
  const reduced = useReducedMotion(), inView = useInView(root), visible = useTabVisible()
  const [phase, setPhase] = useState(0), [paused, setPaused] = useState(false)
  const [seenReduced, setSeenReduced] = useState(reduced)
  if (seenReduced !== reduced) { setSeenReduced(reduced); if (reduced) setPhase(4) }
  useEffect(() => {
    if (reduced || !inView || !visible || paused) return
    const timer = window.setTimeout(() => setPhase(value => (value + 1) % 5), phase === 0 ? 5000 : 4000)
    return () => window.clearTimeout(timer)
  }, [phase, paused, reduced, inView, visible])
  return <section ref={root} aria-label="LINE来店フォローの操作の見本">
    {!reduced && <Button onClick={() => setPaused(value => !value)}>{paused ? '再生する' : '止める'}</Button>}
    <RestaurantFollowupDemo phase={phase} />
  </section>
}

export default function StyleDemoPages({ accountName, viewing, page, onPage, chosen, onChoose, disabled }: {
  accountName?: string; viewing: AccountStyle; page: number; onPage: (index: number) => void; chosen: AccountStyle | null
  onChoose: (style: AccountStyle) => void; disabled: boolean
}) {
  const labels = labelsFor(viewing)
  const safePage = Number.isFinite(page) ? Math.min(labels.length - 1, Math.max(0, Math.trunc(page))) : 0
  const look = STYLE_EXPERIENCE_SCRIPT.styles[viewing]
  const text = content[viewing]
  const message = safePage === 1 ? text.setting : safePage === 2 ? text.operation : safePage === 3 ? text.after : text.feature
  return <section className={styles.root} aria-label={`${look.label}のデモ`}>
    <Steps label="デモのページ" currentKey={String(safePage)} steps={labels.map((label, index) => ({
      key: String(index), label, state: index === safePage ? 'current' : index < safePage ? 'done' : 'todo', reachable: !disabled, onSelect: () => { if (disabled) return; onPage(index) },
    }))} />
    <p className={styles.counter}>{`${safePage + 1} / ${labels.length}`}</p>
    <div><h3 data-demo-heading tabIndex={-1} className={styles.heading}>{headings[viewing][safePage]}</h3><p className={styles.description}>{safePage === 0 ? 'できることを、見本で紹介します。' : message}</p></div>
    {safePage === 0 ? <>
      <ul className={styles.can}>{look.can.map(item => <li key={item.text}><Check aria-hidden="true" className={styles.check} />{item.text}</li>)}</ul>
      <StyleExperiencePlayer accountName={accountName?.trim() || "店名未取得"} script={STYLE_EXPERIENCE_SCRIPT} style={viewing} switcher="external" variant="minimal" data="sample" />
    </> : <>
      {safePage === 1 ? <StyleSettingDemo key={viewing} style={viewing} /> : safePage === 2 && viewing === 'restaurant'
        ? <FollowupDemoPlayer />
        : safePage === 2 && viewing === 'salon' ? <SalonOperationDemo />
        : safePage === 2 && viewing === 'consult' ? <ConsultOperationDemo />
        : safePage === 2 && viewing === 'lesson' ? <LessonOperationDemo />
        : safePage === 2 && viewing === 'ec' ? <EcOperationDemo />
        : safePage === 3 && viewing === 'restaurant' ? <RestaurantAfterDemo />
        : safePage === 3 && viewing === 'salon' ? <SalonAfterDemo />
        : safePage === 3 && viewing === 'consult' ? <ConsultAfterDemo />
        : safePage === 3 && viewing === 'lesson' ? <LessonAfterDemo />
        : safePage === 3 && viewing === 'standard' ? <StandardAfterDemo />
        : safePage === 3 && viewing === 'ec' ? <EcAfterDemo />
        : safePage === 4 ? <Card layout="vertical" padding="default" gap="normal" aria-label="見本から始める案内">
          <strong>{styleTerm(viewing, 'V01')}のメニュー</strong>
          {look.richMenu?.length ? <ul className={styles.can}>{look.richMenu.map(item => <li key={item.label}>{item.label}</li>)}</ul> : <p className={styles.description}>メニューの内容を確認できません。</p>}
          <p className={styles.note}>このスタイルを選んだあと、見本の内容を確認できます。</p>
        </Card>
        : safePage === 2 && viewing === 'standard' ? <Card layout="vertical" padding="default" gap="normal" aria-label="お知らせの見本">
          <strong>一斉配信</strong><Field label="本文"><TextInput value="営業時間のお知らせ" readOnly /></Field><p className={styles.note}>お知らせの文の見本です。</p>
        </Card> : <Card layout="vertical" padding="default" gap="normal" aria-label="使い方の見本">
          <strong>{safePage === 2 ? '操作の見本' : safePage === 3 ? '利用の流れ' : '基本の機能'}</strong>
          <p className={styles.description}>{safePage === 4 ? '配信・タグ・自動応答などの基本も使えます。' : message}</p>
        </Card>}
      {safePage === 2 && viewing === 'restaurant' ? <p className={styles.note}>実際の初期セットとは異なります。送り始めるにはテスト送信と承認が必要です。</p> : null}
    </>}

  </section>
}
