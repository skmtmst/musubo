'use client'

import { displayRange } from '@/lib/display-range'
import Card from '@/components/shared/card'
import StatusBadge from '@/components/shared/status-badge'
import styles from './style-demo-pages.module.css'

type SalonEntry = { time: string; name: string; menu: string; state: 'done' | 'booked'; stateLabel: string }
type SalonColumn = { staff: string; next: string; entries: SalonEntry[] }

/** script.ts のサロン盤の見本と同じ架空の値。実データの読み書きはしない。 */
const SALON_BOARD_SAMPLE: SalonColumn[] = [
  {
    staff: '見本 あおい', next: '次の空き 14:00',
    entries: [
      { time: displayRange('10:00', '11:00'), name: '見本 ゆい', menu: 'カット', state: 'done', stateLabel: '来店済み' },
      { time: displayRange('11:30', '12:30'), name: '見本 みお', menu: 'カット', state: 'booked', stateLabel: '予約' },
    ],
  },
  {
    staff: '見本 れん', next: '次の空き 10:00',
    entries: [
      { time: displayRange('12:00', '13:00'), name: '見本 そら', menu: 'トリートメント', state: 'booked', stateLabel: '予約' },
    ],
  },
]

type ConsultEntry = { time: string; name: string; meet: string; stateLabel: string }
type ConsultColumn = { staff: string; next: string; entries: ConsultEntry[] }

/** script.ts の面談盤の見本と同じ架空の値。実データの読み書きはしない。 */
const CONSULT_BOARD_SAMPLE: ConsultColumn[] = [
  {
    staff: '見本 かい', next: '次の空き 11:00',
    entries: [
      { time: displayRange('10:00', '10:45'), name: '見本 ひな', meet: 'オンライン', stateLabel: '予約' },
    ],
  },
  {
    staff: '見本 なな', next: '次の空き 10:00',
    entries: [
      { time: displayRange('10:30', '11:15'), name: '見本 りく', meet: '対面', stateLabel: '予約' },
    ],
  },
]

/** サロン3ページ目「担当ごとの予定を確認する」の静止見本。保存・送信はしない。 */
export function SalonOperationDemo() {
  return <section aria-label="担当ごとの予定の見本">
    <p className={styles.note}>画面の見本です。実際の設定は変わりません。</p>
    <Card layout="vertical" padding="default" gap="normal" aria-label="担当ごとの予定">
      <strong>担当ごとの予定（見本）</strong>
      {SALON_BOARD_SAMPLE.map(column => (
        <section key={column.staff} aria-label={`${column.staff}の予定`}>
          <p className={styles.description}>{column.staff}・{column.next}</p>
          <ul className={styles.can}>
            {column.entries.map(entry => (
              <li key={`${column.staff}-${entry.time}`}>
                <StatusBadge tone={entry.state === 'done' ? 'success' : 'info'}>{entry.stateLabel}</StatusBadge>
                <span>{entry.time} {entry.name} さま・{entry.menu}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className={styles.note}>名前・数は架空です。見本のため実際の設定は変わりません。</p>
    </Card>
  </section>
}

type LessonEntry = { time: string; name: string; note: string; tone: 'success' | 'info'; stateLabel: string }

/**
 * 教室のクラスの見本の値。購入・月謝・決済は描かない（未検証のため完成済みとしない）。
 * 実データの読み書きはしない。
 */
const LESSON_BOARD_SAMPLE: LessonEntry[] = [
  { time: displayRange('9:00', '10:00'), name: '朝のヨガ', note: '12人', tone: 'success', stateLabel: '出席済み' },
  { time: displayRange('10:00', '11:00'), name: 'はじめてのヨガ', note: '残り 3・出欠待ち 2人', tone: 'info', stateLabel: '出欠待ち' },
  { time: displayRange('14:00', '15:00'), name: 'おひるのヨガ', note: '残り 8', tone: 'info', stateLabel: '受付中' },
]

/** 面談・相談3ページ目「相談の予定を確認する」の静止見本。保存・送信はしない。 */
export function ConsultOperationDemo() {
  return <section aria-label="相談の予定の見本">
    <p className={styles.note}>画面の見本です。実際の設定は変わりません。</p>
    <Card layout="vertical" padding="default" gap="normal" aria-label="相談の予定">
      <strong>相談の予定（見本）</strong>
      {CONSULT_BOARD_SAMPLE.map(column => (
        <section key={column.staff} aria-label={`${column.staff}の予定`}>
          <p className={styles.description}>{column.staff}・{column.next}</p>
          <ul className={styles.can}>
            {column.entries.map(entry => (
              <li key={`${column.staff}-${entry.time}`}>
                <StatusBadge tone="info">{entry.stateLabel}</StatusBadge>
                <span>{entry.time} {entry.name} さま・{entry.meet}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className={styles.note}>名前・数は架空です。見本のため実際の設定は変わりません。</p>
    </Card>
  </section>
}

type EcEntry = { name: string; detail: string }

/**
 * ECの商品案内の見本の値。購入・連携・クーポン・定期便の動作は描かない
 * （未検証のため完成済みとしない）。実データの読み書きはしない。
 */
const EC_BOARD_SAMPLE: EcEntry[] = [
  { name: '見本 焼き菓子セット', detail: '¥1,200' },
  { name: '見本 ハーブティー', detail: '¥800' },
]

/**
 * 飲食店の来店後の見本の値。来店後の送信は設定・公開・承認が必要で、
 * 保存しただけでは始まらない。実データの読み書き・送信はしない。
 */
const RESTAURANT_AFTER_SAMPLE = {
  visit: { time: displayRange('18:00', '20:00'), name: '見本 たろう', detail: '2名・テーブル席' },
  thanks: { when: '翌日 12:00', text: '昨日はありがとうございました。またのお越しをお待ちしています。' },
}

/** 飲食店4ページ目「来店のあとも、つながりが続く」の静止見本。保存・送信はしない。 */
export function RestaurantAfterDemo() {
  return <section aria-label="来店のあとの見本">
    <p className={styles.note}>画面の見本です。実際の設定は変わりません。</p>
    <Card layout="vertical" padding="default" gap="normal" aria-label="来店のあと">
      <strong>来店のあと（見本）</strong>
      <section aria-label="来店の記録">
        <p className={styles.description}>予約台帳の来店記録</p>
        <ul className={styles.can}>
          <li>
            <StatusBadge tone="success">来店済み</StatusBadge>
            <span>{RESTAURANT_AFTER_SAMPLE.visit.time} {RESTAURANT_AFTER_SAMPLE.visit.name} さま・{RESTAURANT_AFTER_SAMPLE.visit.detail}</span>
          </li>
        </ul>
      </section>
      <section aria-label="お礼の見本">
        <p className={styles.description}>LINEのお礼（{RESTAURANT_AFTER_SAMPLE.thanks.when}・停止中）</p>
        <p className={styles.description}>{RESTAURANT_AFTER_SAMPLE.thanks.text}</p>
      </section>
      <p className={styles.note}>名前・数は架空です。送り始めるには設定と承認が必要で、保存しただけでは始まりません。</p>
    </Card>
  </section>
}

/**
 * サロンの来店後の見本の値。お礼を自動で送る機能の有無と条件は確認中。
 * 時刻と停止状態も見本であり、実際の設定値や送り始める手順は示さない。
 * 実データの読み書き・送信はしない。
 */
const SALON_AFTER_SAMPLE = {
  visit: { time: displayRange('11:30', '12:30'), name: '見本 みお', menu: 'カット', staff: '見本 あおい' },
  thanks: { when: '翌日 12:00', text: '昨日はご来店ありがとうございました。またのご利用をお待ちしています。' },
}

/** サロン4ページ目「来店のあとも、つながりが続く」の静止見本。保存・送信はしない。 */
export function SalonAfterDemo() {
  return <section aria-label="来店のあとの見本">
    <p className={styles.note}>画面の見本です。実際の設定は変わりません。</p>
    <Card layout="vertical" padding="default" gap="normal" aria-label="来店のあと">
      <strong>来店のあと（見本）</strong>
      <section aria-label="来店の記録">
        <p className={styles.description}>予約台帳の来店記録</p>
        <ul className={styles.can}>
          <li>
            <StatusBadge tone="success">来店済み</StatusBadge>
            <span>{SALON_AFTER_SAMPLE.visit.time} {SALON_AFTER_SAMPLE.visit.name} さま・{SALON_AFTER_SAMPLE.visit.menu}・担当 {SALON_AFTER_SAMPLE.visit.staff}</span>
          </li>
        </ul>
      </section>
      <section aria-label="お礼の見本">
        <p className={styles.description}>LINEのお礼の見本（{SALON_AFTER_SAMPLE.thanks.when}・停止中）</p>
        <p className={styles.description}>{SALON_AFTER_SAMPLE.thanks.text}</p>
      </section>
      <p className={styles.note}>名前・数は架空です。お礼を自動で送る機能の有無と条件は確認中のため、「翌日 12:00」や「停止中」を含め、この見本では送り始める手順を示しません。実際の設定は変わりません。</p>
    </Card>
  </section>
}

/**
 * 面談・相談の相談後の見本の値。相談後の送信は設定・公開・承認が必要で、
 * 保存しただけでは始まらない。実データの読み書き・送信はしない。
 */
const CONSULT_AFTER_SAMPLE = {
  result: { time: displayRange('10:00', '10:45'), name: '見本 ひな', meet: 'オンライン', staff: '見本 かい' },
  thanks: { when: '翌日 12:00', text: '昨日はご相談ありがとうございました。次のご案内をお待ちください。' },
}

/** 面談・相談4ページ目「相談のあとも、つながりが続く」の静止見本。保存・送信はしない。 */
export function ConsultAfterDemo() {
  return <section aria-label="相談のあとの見本">
    <p className={styles.note}>画面の見本です。実際の設定は変わりません。</p>
    <Card layout="vertical" padding="default" gap="normal" aria-label="相談のあと">
      <strong>相談のあと（見本）</strong>
      <section aria-label="面談の結果">
        <p className={styles.description}>面談の結果の確認</p>
        <ul className={styles.can}>
          <li>
            <StatusBadge tone="success">実施済み</StatusBadge>
            <span>{CONSULT_AFTER_SAMPLE.result.time} {CONSULT_AFTER_SAMPLE.result.name} さま・{CONSULT_AFTER_SAMPLE.result.meet}・担当 {CONSULT_AFTER_SAMPLE.result.staff}</span>
          </li>
        </ul>
      </section>
      <section aria-label="次のご案内の見本">
        <p className={styles.description}>次のご案内（{CONSULT_AFTER_SAMPLE.thanks.when}・停止中）</p>
        <p className={styles.description}>{CONSULT_AFTER_SAMPLE.thanks.text}</p>
      </section>
      <p className={styles.note}>名前・数は架空です。お礼を自動で送る機能の有無と条件は確認中のため、「翌日 12:00」や「停止中」を含め、この見本では送り始める手順を示しません。実際の設定は変わりません。</p>
    </Card>
  </section>
}

/**
 * 教室のレッスン後の見本の値。参加後の送信は設定・公開・承認が必要で、
 * 保存しただけでは始まらない。実データの読み書き・送信はしない。
 */
const LESSON_AFTER_SAMPLE = {
  attendance: { time: displayRange('9:00', '10:00'), name: '朝のヨガ', note: '出席 12人' },
  thanks: { when: '翌日 12:00', text: '昨日はご参加ありがとうございました。ご質問がありましたら、このトークでお知らせください。' },
}

/** 教室・レッスン4ページ目「レッスンのあとも、つながりが続く」の静止見本。保存・送信はしない。 */
export function LessonAfterDemo() {
  return <section aria-label="レッスンのあとの見本">
    <p className={styles.note}>画面の見本です。実際の設定は変わりません。</p>
    <Card layout="vertical" padding="default" gap="normal" aria-label="レッスンのあと">
      <strong>レッスンのあと（見本）</strong>
      <section aria-label="出席の記録">
        <p className={styles.description}>名簿の出席記録</p>
        <ul className={styles.can}>
          <li>
            <StatusBadge tone="success">出席済み</StatusBadge>
            <span>{LESSON_AFTER_SAMPLE.attendance.time} {LESSON_AFTER_SAMPLE.attendance.name}・{LESSON_AFTER_SAMPLE.attendance.note}</span>
          </li>
        </ul>
      </section>
      <section aria-label="参加のお礼の見本">
        <p className={styles.description}>参加のお礼（{LESSON_AFTER_SAMPLE.thanks.when}・停止中）</p>
        <p className={styles.description}>{LESSON_AFTER_SAMPLE.thanks.text}</p>
      </section>
      <p className={styles.note}>名前・数は架空です。お礼を自動で送る機能の有無と条件は確認中のため、「翌日 12:00」や「停止中」を含め、この見本では送り始める手順を示しません。実際の設定は変わりません。</p>
    </Card>
  </section>
}

/**
 * 標準の問い合わせ後の見本の値。返事の送信は行わず、下書きの見本だけを示す。
 * 実データの読み書き・送信はしない。
 */
const STANDARD_AFTER_SAMPLE = {
  inbox: { unreplied: 2, latest: { name: '見本 さくら', topic: '見学のご相談' } },
  reply: { text: 'お問い合わせありがとうございます。担当者からご返事します。' },
}

/** 標準4ページ目「問い合わせのあとも、つながりが続く」の静止見本。保存・送信はしない。 */
export function StandardAfterDemo() {
  return <section aria-label="問い合わせのあとの見本">
    <p className={styles.note}>画面の見本です。実際の設定は変わりません。</p>
    <Card layout="vertical" padding="default" gap="normal" aria-label="問い合わせのあと">
      <strong>問い合わせのあと（見本）</strong>
      <section aria-label="受信箱の見本">
        <p className={styles.description}>受信箱・未返信 {STANDARD_AFTER_SAMPLE.inbox.unreplied}件（最新の1件の見本）</p>
        <ul className={styles.can}>
          <li>
            <StatusBadge tone="caution">未返信</StatusBadge>
            <span>{STANDARD_AFTER_SAMPLE.inbox.latest.name} さま・{STANDARD_AFTER_SAMPLE.inbox.latest.topic}</span>
          </li>
        </ul>
      </section>
      <section aria-label="返事の下書きの見本">
        <p className={styles.description}>返事の下書き（送信しません）</p>
        <p className={styles.description}>{STANDARD_AFTER_SAMPLE.reply.text}</p>
      </section>
      <p className={styles.note}>名前・数は架空です。見本のため実際の設定は変わらず、何も送信しません。</p>
    </Card>
  </section>
}

/** EC3ページ目「商品の案内を用意する」の静止見本。保存・送信はしない。 */
export function EcOperationDemo() {
  return <section aria-label="商品の案内の見本">
    <p className={styles.note}>画面の見本です。店のECサイトの商品案内の例で、在庫の管理はしません。実際の設定は変わりません。</p>
    <Card layout="vertical" padding="default" gap="normal" aria-label="商品の案内">
      <strong>商品の案内（見本）</strong>
      <ul className={styles.can}>
        {EC_BOARD_SAMPLE.map(entry => (
          <li key={entry.name}>
            <span>{entry.name}・{entry.detail}</span>
          </li>
        ))}
      </ul>
      <p className={styles.note}>名前・値段は架空です。見本のため実際の設定は変わりません。</p>
    </Card>
  </section>
}

/** 教室・レッスン3ページ目「クラスの予定を確認する」の静止見本。保存・送信はしない。 */
export function LessonOperationDemo() {
  return <section aria-label="クラスの予定の見本">
    <p className={styles.note}>画面の見本です。実際の設定は変わりません。</p>
    <Card layout="vertical" padding="default" gap="normal" aria-label="クラスの予定">
      <strong>クラスの予定（見本）</strong>
      <ul className={styles.can}>
        {LESSON_BOARD_SAMPLE.map(entry => (
          <li key={`${entry.time}-${entry.name}`}>
            <StatusBadge tone={entry.tone}>{entry.stateLabel}</StatusBadge>
            <span>{entry.time} {entry.name}・{entry.note}</span>
          </li>
        ))}
      </ul>
      <p className={styles.note}>名前・数は架空です。見本のため実際の設定は変わりません。</p>
    </Card>
  </section>
}

/** 架空の注文数と問い合わせを示す、読み取り専用の見本。 */
export function EcAfterDemo() {
  return <section aria-label="注文のあとの見本">
    <Card layout="vertical" padding="default" gap="normal" aria-label="注文とお問い合わせ">
      <strong>注文とお問い合わせ（見本）</strong>
      <p className={styles.description}>今日の注文 5件</p>
      <ul className={styles.can}>
        <li><StatusBadge tone="neutral">注文</StatusBadge><span>見本 焼き菓子セット・2件</span></li>
        <li><StatusBadge tone="neutral">注文</StatusBadge><span>見本 ハーブティー・1件</span></li>
        <li><StatusBadge tone="neutral">注文</StatusBadge><span>見本 クッキー缶・2件</span></li>
      </ul>
      <p className={styles.description}>お問い合わせ・未返信 1件</p>
      <p className={styles.note}>見本 あかり さま・届き日のご相談</p>
    </Card>
  </section>
}
