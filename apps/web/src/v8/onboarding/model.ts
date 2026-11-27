import { INITIAL_MENUS } from '@line-crm/shared'
import type { IconKey, Choice, Question } from './question-types'
export type { IconKey, Choice, Question } from './question-types'
import type { StarterSetItem } from '@/lib/api/helpers/styles'
import type { AccountStyle, SetupAnswer, StyleSelectionStatus } from '@line-crm/shared'
import { bookingHost, styleTerm } from '@/lib/terms'
import { Q } from './setup-questions'

export const STYLE_CHOICES: ReadonlyArray<{ value: AccountStyle; icon: IconKey; label: string; note: string }> = [
  { value: 'restaurant', icon: 'utensils', label: styleTerm('restaurant', 'V01'), note: '席・コースの予約、前日のお知らせ、来店スタンプ' },
  { value: 'salon', icon: 'scissors', label: styleTerm('salon', 'V01'), note: '担当者の指名・空き枠、回数券、次回予約' },
  { value: 'consult', icon: 'messages', label: styleTerm('consult', 'V01'), note: '担当を自動で割り当て、オンライン／対面、資料' },
  { value: 'lesson', icon: 'graduation', label: styleTerm('lesson', 'V01'), note: 'クラスの定員、回数券・月謝、振替' },
  { value: 'ec', icon: 'bag', label: styleTerm('ec', 'V01'), note: '商品のお知らせ、カゴ落ち、再入荷' },
  { value: 'standard', icon: 'grid', label: styleTerm('standard', 'V01'), note: '配信と受信箱だけで始める（あとで足せます）' },
]

export function styleLabel(style: AccountStyle): string {
  return STYLE_CHOICES.find((choice) => choice.value === style)?.label ?? '標準'
}

/** 口が受け付ける質問のキー（組4 `questionKeys`）。保存はこのキーだけ送る。 */
export const API_QUESTION_KEYS = ['image', 'booking', 'approval', 'payment', 'reminders', 'stamps', 'coupons', 'tickets', 'outcome', 'content', 'cancelDeadline', 'seats', 'hours', 'partySize', 'nomination', 'assignment', 'classCapacity'] as const

/** 保存する答え：口のキーだけ。予約の確定の仕方を答えた（その場で／承認）＝予約を使う、を booking に写す。 */
export function answersForApi(answers: Record<string, SetupAnswer>): Record<string, SetupAnswer> {
  const out = Object.fromEntries(Object.entries(answers).filter(([key]) => (API_QUESTION_KEYS as readonly string[]).includes(key)))
  if (!out.booking && answers.approval?.mode === 'configured') out.booking = { mode: 'configured', value: true }
  return out
}

/* （オーナー）が正：飲食は 11 問（lS1Gh の左の一覧の並び）。予約を使うかは「予約の確定の仕方」の答えから送る。 */
const BY_STYLE: Record<AccountStyle, string[]> = {
  restaurant: ['approval', 'payment', 'cancelDeadline', 'reminders', 'stamps', 'coupons', 'seats', 'hours', 'partySize'],
  salon: ['approval', 'payment', 'cancelDeadline', 'reminders', 'tickets', 'stamps', 'coupons', 'nomination', 'hours'],
  consult: ['approval', 'payment', 'cancelDeadline', 'reminders', 'outcome', 'assignment', 'hours'],
  lesson: ['approval', 'payment', 'cancelDeadline', 'reminders', 'tickets', 'coupons', 'classCapacity', 'hours'],
  ec: ['coupons', 'content'],
  standard: ['content'],
}

/** 1問目（スタイル）と 2問目（見た目＝口の image）は形が違うので、名前だけを持つ。 */
export const STYLE_STEP = { key: 'style', short: '使い方のスタイル' } as const
export const LOOK_STEP = { key: 'image', short: '見た目' } as const

export const LOOK_CHOICES: ReadonlyArray<{ value: 'keep' | 'change' | 'existing' | 'configured' | 'later'; icon: IconKey; label: string; note: string }> = [
  { value: 'keep', icon: 'sparkles', label: '見本を使う（おすすめ）', note: 'の見本のまま使います。あとで画像だけ変えられます' },
  { value: 'change', icon: 'image', label: '画像を変更する', note: '写真・ロゴを入れる／バナー生成で作る' },
  { value: 'existing', icon: 'folder', label: '同じアカウントの中にある物を使う', note: '今あるリッチメニュー・テンプレート・画像から選ぶ' },
  { value: 'configured', icon: 'download', label: 'もう設定した物を入れる', note: 'ほかのアカウントで作った物を入れる' },
  { value: 'later', icon: 'hourglass', label: 'あとで設定する', note: '今は入れません。はじめにやることに残ります' },
]

export function questionsFor(style: AccountStyle): Question[] {
  const host = bookingHost(style)
  const words = (value: string) => value.split('お店で払う').map(part => part.replaceAll('お店', host).replaceAll('お客さま', styleTerm(style, 'V12').split('（')[0])).join(styleTerm(style, 'V25'))
  return BY_STYLE[style].map((key) => {
    const question = Q[key]
    if (key === 'content' && (style === 'standard' || style === 'ec')) return { ...question, description: style === 'ec' ? 'ごあいさつ・商品のお知らせ・購入へのお礼・再入荷の見本を入れます。自動のLINEは止めた状態です。' : 'ごあいさつ・ご案内・お問い合わせの見本を入れます。' }
    return { ...question, title: words(question.title), description: words(question.description), info: question.info ? words(question.info) : undefined, manualNote: words(question.manualNote), todo: { ...question.todo, title: words(question.todo.title), note: words(question.todo.note) }, choices: question.choices.map((choice) => ({ ...choice, label: words(choice.label), note: key === 'payment' && choice.value === 'store' && style === 'consult' ? '面談の当日に払います。' : words(choice.note) })) }
  })
}

/** 左の一覧の並び（スタイル・見た目・質問…）。 */
export function stepNames(style: AccountStyle): Array<{ key: string; short: string }> {
  return [STYLE_STEP, LOOK_STEP, ...questionsFor(style).map(({ key, short }) => ({ key, short }))]
}

export function recommendedValue(question: Question, style: AccountStyle): string {
  return question.recommended?.[style] ?? question.choices[0].value
}

/** おすすめの答えの題に「（おすすめ）」を付ける。 */
export function choiceLabel(question: Question, choice: Choice, style: AccountStyle): string {
  return choice.value === recommendedValue(question, style) ? `${choice.label}（おすすめ）` : choice.label
}

/** 画面の値を口の答えへ（'true'/'false' は真偽）。 */
export function answerOf(value: string, question?: Question): SetupAnswer {
  if (value === 'later') return { mode: 'later' }
  if (value === 'manual') return { mode: 'manual' }
  const choice = question?.choices.find((item) => item.value === value)
  if (choice?.apiValue !== undefined) return { mode: 'configured', value: choice.apiValue }
  return { mode: 'configured', value: value === 'true' ? true : value === 'false' ? false : value }
}

/** 画面で選んでいる値（configured は value を文字にしたもの、ほかは mode）。 */
export function selectedValue(answer: SetupAnswer | undefined, question?: Question): string | null {
  if (!answer) return null
  const choice = answer.mode === 'configured' ? question?.choices.find((item) => item.apiValue !== undefined && item.apiValue === answer.value) : undefined
  if (choice) return choice.value
  return answer.mode === 'configured' ? String(answer.value ?? (answer.resourceId ? 'existing' : '')) : answer.mode
}

/* ── 開き直したときの保存（ (2)） ─────────────────────────── */

/** 予約設定に書く答え（口は approval を予約設定の承認の仕方へ書く）。 */
export const SETTINGS_KEYS = ['approval']

const same = (a: SetupAnswer | undefined, b: SetupAnswer | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** 前に保存した答えから変わった物だけ。 */
export function changedAnswers(saved: Record<string, SetupAnswer>, next: Record<string, SetupAnswer>): Record<string, SetupAnswer> {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => !same(saved[key], value)))
}

const APPROVAL_WORD: Record<string, string> = { automatic: 'その場で確定する', manual: 'お店が承認してから確定する' }

/** 予約設定のどこがどう変わるか（確かめの窓の文）。変わらなければ空。 */
export function settingsChanges(saved: Record<string, SetupAnswer>, next: Record<string, SetupAnswer>): string[] {
  const changed = changedAnswers(saved, next)
  const lines: string[] = []
  const approval = changed.approval
  if (approval?.mode === 'configured') {
    const before = saved.approval?.mode === 'configured' ? APPROVAL_WORD[String(saved.approval.value)] : null
    lines.push(`予約の確定の仕方：${before ? `${before} → ` : ''}${APPROVAL_WORD[String(approval.value)] ?? String(approval.value)}`)
  }
  return lines
}

/** 予約確定のご案内の見本（いつもの確定の知らせと重なる。 (3)・点検 1-3）。 */
export function isBookingConfirmSample(item: StarterSetItem): boolean {
  return item.kind === 'automation' && (item.key === 'reminder' || item.name.includes('予約確定'))
}

/* ── 機能と、リッチメニューのボタンの決まり（警告・お客さまの見え方） ─────────── */

/** 機能（口の feature）。settingHref は今ある設定の画面。preparing は設定の画面がまだ無い物（準備中の窓）。 */
export const FEATURES: Record<string, { name: string; opens: string; settingHref: string; preparing?: string }> = {
  booking: { name: '予約', opens: '予約のページを開く', settingHref: '/booking/menus' },
  history: { name: '予約の確認', opens: '予約の履歴を開く', settingHref: '/booking/menus' },
  coupons: { name: 'クーポン', opens: 'クーポンの一覧を開く', settingHref: '/templates', preparing: 'クーポン' },
  menu: { name: 'メニュー', opens: 'メニューのページを開く', settingHref: '/restaurant-test/menu' },
  stamps: { name: '来店スタンプ', opens: '来店スタンプを開く', settingHref: '/visit-stamps' },
  tickets: { name: '回数券・月謝', opens: '回数券・月謝の残りを開く', settingHref: '/booking/menus?tab=passes' },
  forms: { name: 'お申し込み', opens: '設定した回答フォームを開く', settingHref: '/form-submissions' },
  mypage: { name: 'マイページ', opens: '本人のマイページを開く', settingHref: '/rich-menus' },
  news: { name: 'お知らせ', opens: '設定したお知らせを見る', settingHref: '/templates' },
  shop: { name: '商品', opens: '設定したECサイトを開く', settingHref: '/ec-commerce?tab=connector' },
  contact: { name: 'お問い合わせ', opens: 'トークを開く', settingHref: '/chats' },
  photos: { name: 'スタイル写真', opens: '写真のページを開く', settingHref: '/rich-menus' },
  faq: { name: 'よくある質問', opens: 'よくある質問を開く', settingHref: '/auto-replies' },
  docs: { name: '資料', opens: '資料のページを開く', settingHref: '/rich-menus' },
  about: { name: '会社のこと', opens: '会社のページを開く', settingHref: '/rich-menus' },
  transfer: { name: '振替', opens: '振替のページを開く', settingHref: '/events' },
  schedule: { name: 'スケジュール', opens: 'スケジュールを開く', settingHref: '/events' },
}

export function featureName(feature: string): string {
  return FEATURES[feature]?.name ?? feature
}

/** 機能の設定の画面。口の href は今の画面に無い道（/booking/settings 等）があるので、画面の表を先に使う。 */
export function featureHref(feature: string, fallback?: string, style?: AccountStyle): string {
  if (style === 'lesson' && (feature === 'booking' || feature === 'history')) return '/events'
  if (feature === 'meeting') return '/booking/menus?tab=staff'
  if (feature === 'auto_line') return '/ec-commerce?tab=auto-line'
  return FEATURES[feature]?.settingHref ?? fallback ?? '/'
}

/* ── 見本のリッチメニュー（wI4ZX）。色は見本の画像の色（globals.css の --sample-*） ───────────── */

export type SampleTile = { label: string; icon: string; feature: string }
export type SampleMenu = { account: string; greeting: string; tone: { bg: string; ink: string }; tiles: SampleTile[] }

export const SAMPLE_STYLES: AccountStyle[] = ['restaurant', 'salon', 'consult', 'lesson', 'standard', 'ec']
const SAMPLE_NAMES:Record<AccountStyle,string>={restaurant:'お店のLINE',salon:'サロンのLINE',consult:'ご相談窓口',lesson:'教室のLINE',standard:'ご案内',ec:'オンラインストア'}
export const SAMPLE_MENUS = Object.fromEntries(SAMPLE_STYLES.map(style=>[style,{
 account:SAMPLE_NAMES[style],greeting:'友だち追加ありがとうございます。下のメニューからお進みください。',
 tone:{bg:`var(--sample-${style==='standard'?'consult':style==='ec'?'salon':style}-bg)`,ink:`var(--sample-${style==='standard'?'consult':style==='ec'?'salon':style}-ink)`},
 tiles:INITIAL_MENUS[style].buttons.map(button=>({label:button.label,feature:button.feature,icon:button.icon})),
}])) as Record<AccountStyle,SampleMenu>
export function sampleMenuFor(style:AccountStyle):SampleMenu { return SAMPLE_MENUS[style] }

/* ── 入った物（starter-items）と初期セットの中身（definition）の突き合わせ ────────── */

export type StarterItemState = { target_id: string; kind: string; is_sample: number; status: string | null; draftRevision: string | null; key?: string; name?: string | null; activationAllowed?: boolean; requiresActivation?: boolean }

/**
 * 口の starter-items が返す key で初期セットの中身と対応させる。旧応答にkeyが無い場合だけ、種類ごとに
 * 入った物の並びを前から対応させて名前を付ける。入った物より中身が多い（未定で入れなかった）ときは名前だけ余る。
 */
export function pairStarterItems(definition: StarterSetItem[], items: StarterItemState[]): Array<{ item: StarterSetItem; state: StarterItemState }> {
  const out: Array<{ item: StarterSetItem; state: StarterItemState }> = []
  for (const kind of [...new Set(items.map((state) => state.kind))]) {
    const defs = definition.filter((item) => item.kind === kind)
    items.filter((state) => state.kind === kind).forEach((state, index) => {
      const matched = state.key ? defs.find(item => item.key === state.key) : defs[index]
      if (state.key && !matched) return
      out.push({ item: matched ?? { key: state.target_id, kind: kind as StarterSetItem['kind'], name: state.name ?? kind }, state })
    })
  }
  return out
}

/** 動かす前に確かめる物（オートメーションの下書き・止めた予約メニュー）。 */
export function needsActivation(state: StarterItemState): boolean {
  /* 予約確定の見本は名前で判定するので、一覧側（isBookingConfirmSample）で外す。 */
  return state.activationAllowed !== false && state.requiresActivation !== false && (state.kind === 'automation' || state.kind === 'booking_menu') && state.status !== 'active'
}

/* ── はじめにやること（Bdfxm） ─────────────────────────────────── */

export type StyleState = StyleSelectionStatus & { style: AccountStyle; version: number; answers: Record<string, SetupAnswer> }
export type StyleWarning = { feature: string; areaId: string; groupId: string; href?: string; customerState: 'preparing' }

/** 業種に合う警告を、上の帯と設定の一覧でそろえる。 */
export function setupWarningsForStyle(style: AccountStyle, warnings: ReadonlyArray<StyleWarning>): StyleWarning[] {
  return warnings.filter(warning => style !== 'ec' || warning.feature !== 'stamps')
}

export type TodoRow = {
  key: string
  title: string
  note: string
  badge: { tone: 'warning' | 'neutral'; label: string }
  alert?: boolean
  action: { label: string; href?: string; step?: string; preparing?: string }
}

export type SetupSummary = {
  style: AccountStyle
  done: number
  total: number
  doneNames: string[]
  rows: TodoRow[]
  nextStep: number
}

/** 選んだ機能の案内は、ダッシュボードと設定画面で同じ業種の言葉を使う。 */
const SETUP_WORDS: Record<AccountStyle, { bookingMenu: string; initialMenu: string; images: string }> = {
  restaurant: {
    bookingMenu: '予約メニュー',
    initialMenu: 'メニュー・アクセスの内容と席の予約設定を確かめてから、LINEに出します',
    images: 'お店の写真とロゴを入れる',
  },
  salon: {
    bookingMenu: '施術メニュー',
    initialMenu: 'メニュー・料金と予約設定を確かめてから、LINEに出します',
    images: 'サロンの写真とロゴを入れる',
  },
  consult: {
    bookingMenu: '面談メニュー',
    initialMenu: 'ご相談内容・会社案内と面談の予約設定を確かめてから、LINEに出します',
    images: '相談窓口の写真とロゴを入れる',
  },
  lesson: {
    bookingMenu: '予約メニュー',
    initialMenu: 'クラス・スケジュールと教室案内を確かめてから、LINEに出します',
    images: '教室の写真とロゴを入れる',
  },
  ec: {
    bookingMenu: 'メニュー',
    initialMenu: '商品・お問い合わせ・ご利用ガイドの内容を確かめてから、LINEに出します',
    images: 'ショップの写真とロゴを入れる',
  },
  standard: {
    bookingMenu: 'メニュー',
    initialMenu: 'お知らせ・お申し込み・お問い合わせの内容を確かめてから、LINEに出します',
    images: '案内に使う写真とロゴを入れる',
  },
}

/** 答え・警告・止めている自動の送信から、はじめにやることの行を組む。 */
export function summarizeSetup(state: StyleState, warnings: StyleWarning[], items: StarterItemState[]): SetupSummary {
  const words = SETUP_WORDS[state.style]
  const steps = stepNames(state.style)
  const questions = questionsFor(state.style)
  const answers = state.answers ?? {}
  const doneKeys = steps.filter((step) => step.key === 'style' ? state.styleSelected : answers[step.key]?.mode === 'configured').map((step) => step.key)
  const rows: TodoRow[] = []
  const warned = new Set<string>()
  for (const warning of setupWarningsForStyle(state.style, warnings)) {
    if (warned.has(warning.feature)) continue
    warned.add(warning.feature)
    const preparing = FEATURES[warning.feature]?.preparing
    rows.push({
      key: `warning-${warning.feature}`,
      title: `${featureName(warning.feature)}を設定する`,
      note: 'リッチメニューにボタンがあるのに中身が未設定です',
      badge: { tone: 'warning', label: '未設定' },
      alert: true,
      action: preparing ? { label: `${featureName(warning.feature)}を設定する`, preparing } : { label: `${featureName(warning.feature)}を設定する`, href: featureHref(warning.feature, warning.href, state.style) },
    })
  }
  if (!state.styleSelected && state.styleMode !== 'manual') rows.push({ key: 'style', title: '使い方のスタイルを選ぶ', note: '答えに合わせて、メニュー・見本・設定をまとめて入れます', badge: { tone: 'neutral', label: '未選択' }, action: { label: '選択する', step: 'style' } })
  for (const question of questions) {
    if (state.style === 'ec' && question.key === 'stamps') continue
    const answer = answers[question.key]
    if (!answer || answer.mode === 'configured') continue
    if (warned.has(question.key)) continue
    rows.push({
      key: question.key,
      title: question.todo.title,
      note: question.todo.note,
      badge: { tone: 'neutral', label: answer.mode === 'manual' ? '手動' : '未設定' },
      action: question.preparing ? { label: question.todo.action, preparing: question.preparing } : { label: question.todo.action, href: question.manualHref },
    })
  }
  const inactive = items.filter(needsActivation)
  if (inactive.length > 0) {
    const targets = [inactive.some(item => item.kind === 'booking_menu') ? words.bookingMenu : null, inactive.some(item => item.kind === 'automation') ? 'お知らせ' : null].filter(Boolean)
    rows.push({ key: 'activation', title: `入った${targets.join('・')}を動かす`, note: '止めた状態で入っています', badge: { tone: 'neutral', label: '止めている' }, action: { label: '中身を見る', step: 'summary' } })
  }
  const look = answers.image
  if(look?.mode==='configured' && look.value==='simple' && items.some(item=>item.kind==='rich_menu'&&item.status!=='published')) {
    rows.push({key:'initial-menu',title:'最初のメニューの内容を確かめる',note:words.initialMenu,badge:{tone:'neutral',label:'下書き'},action:{label:'確かめる',href:'/getting-started/rich-menu'}})
  }
  if (look?.mode === 'configured' && (look.value === 'keep' || look.value === 'change')) {
    rows.push({ key: 'images', title: words.images, note: '見本の画像のままです', badge: { tone: 'neutral', label: '見本' }, action: { label: '画像を変更する', href: '/rich-menus' } })
  } else if (look && look.mode !== 'configured') {
    rows.push({ key: 'image', title: 'リッチメニューなどの見た目を決める', note: '見本を使うか、画像を変えるかを選びます', badge: { tone: 'neutral', label: '未設定' }, action: { label: '決める', step: 'image' } })
  }
  const firstOpen = steps.findIndex((step) => !doneKeys.includes(step.key))
  return {
    style: state.style,
    done: doneKeys.length,
    total: steps.length,
    doneNames: steps.filter((step) => doneKeys.includes(step.key)).map((step) => step.short),
    rows,
    nextStep: firstOpen < 0 ? steps.length : firstOpen,
  }
}
