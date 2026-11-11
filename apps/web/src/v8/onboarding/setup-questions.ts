import { PREPARING_WORD } from '@/components/shared/preparing-dialog'
import type { Choice, Question } from './question-types'


export const RULES = '/booking/menus?tab=rules'

export const yesNo = (yes: Omit<Choice, 'value'>, no: Omit<Choice, 'value'>): Choice[] => [{ value: 'true', ...yes }, { value: 'false', ...no }]


export const Q: Record<string, Question> = {
  booking: {
    key: 'booking', short: '予約の受け付け', title: 'LINE で予約を受け付けますか？', description: '予約メニューの見本を止めた状態で入れます。最後に確かめてから動かします。',
    choices: yesNo(
      { icon: 'calendarCheck', label: '受け付ける', note: 'リッチメニューの「予約する」から予約できます' },
      { icon: 'ban', label: '受け付けない', note: '予約メニューは入れません' },
    ),
    recommended: { ec: 'false', standard: 'false' },
    where: '予約設定', manualHref: '/booking/menus', manualNote: '予約設定の画面を開きます',
    todo: { title: '予約の受け付けを決める', note: '予約メニューと営業時間を入れると予約できます', action: '決める' },
  },
  approval: {
    key: 'approval', short: '予約の確定の仕方', title: '予約はその場で確定しますか？', description: 'お客さまが LINE で予約したときの扱いです。',
    choices: [
      { value: 'automatic', icon: 'circleCheck', label: 'その場で確定する', note: '空いていれば、すぐに予約が決まります。' },
      { value: 'require_approval', apiValue: 'manual', icon: 'userCheck', label: 'お店が承認してから確定する', note: '届いた予約を見て、お店が［承認する］を押すと決まります' },
    ],
    recommended: { consult: 'require_approval' },
    where: '予約設定 › 予約のルール', manualHref: RULES, manualNote: '予約のルールの画面を開きます',
    todo: { title: '予約の確定の仕方を決める', note: 'その場で確定するか、お店が承認するかを選びます', action: '決める' },
  },
  payment: {
    key: 'payment', short: 'お支払い', title: '予約のときのお支払いはどうしますか？', description: 'コース・メニューごとにあとで変えられます。',
    choices: [
      { value: 'store', icon: 'store', label: 'お店で払う', note: '当日にお店で払います。今までどおりです' },
      { value: 'online', icon: 'card', label: 'オンラインで先払い', note: `試験の支払いを確認します。本当のカード請求は${PREPARING_WORD}です` },
      { value: 'customer_choice', icon: 'split', label: 'お客さまが選ぶ', note: '先払いか、お店で払うかをお客さまが選びます' },
    ],
    where: '予約設定 › お支払い', manualHref: '/booking/menus?tab=payments', manualNote: 'お支払いの画面を開きます',
    info: `予約はLINEの予約と管理に対応します。カードの請求は${PREPARING_WORD}です。試験の支払いで本当の請求は起きません。`,
    todo: { title: 'Stripe をつなぐ', note: 'オンライン先払いを使うときに必要です', action: 'つなぐ' },
    skipped: `カードの請求は${PREPARING_WORD}です。試験の支払いで本当の請求は起きません`,
    skippedTitle: 'お支払い（オンライン）',
  },
  reminders: {
    key: 'reminders', short: '前日のお知らせ', title: '予約の前日にお知らせを送りますか？', description: '予約の確定・前日のお知らせを自動で送ります。最初は止めた状態で入り、最後に確かめてから動かします。',
    choices: yesNo(
      { icon: 'bell', label: '前日の 18:00 に送る', note: '予約の日時・場所・キャンセルの方法を送ります' },
      { icon: 'bellOff', label: '送らない', note: 'お知らせは入れません' },
    ),
    where: 'リマインダ', manualHref: '/reminders', manualNote: 'リマインダの画面を開きます',
    todo: { title: '予約のお知らせを決める', note: '予約のあとに LINE で送るお知らせです', action: '決める' },
  },
  stamps: {
    key: 'stamps', short: '来店スタンプ', title: '来店スタンプを使いますか？', description: '来店ごとにスタンプを押し、たまったら特典を渡します。',
    choices: yesNo(
      { icon: 'stamp', label: '使う', note: 'リッチメニューに「ポイントカード」を入れます。決まりは来店スタンプの画面で入れます' },
      { icon: 'ban', label: '使わない', note: 'リッチメニューにスタンプのボタンを入れません' },
    ),
    recommended: { consult: 'false' },
    where: '来店スタンプ', manualHref: '/visit-stamps', manualNote: '来店スタンプの画面を開きます',
    todo: { title: '来店スタンプを設定する', note: 'リッチメニューにボタンがあるのに中身が未設定です', action: '来店スタンプを設定する' },
    skipped: `リッチメニューの「スタンプ」は、お客さまには「${PREPARING_WORD}」と出ます`,
  },
  coupons: {
    key: 'coupons', short: 'クーポン', title: 'クーポンを使いますか？', description: 'リッチメニューや配信からクーポンを開けるようにします。',
    choices: yesNo(
      { icon: 'ticket', label: '使う', note: 'クーポンの案内の見本を入れます。中身はあとで変えられます' },
      { icon: 'ban', label: '使わない', note: 'クーポンは入れません' },
    ),
    recommended: { consult: 'false', lesson: 'false' },
    where: 'クーポン', manualHref: '/templates', manualNote: 'テンプレートの画面を開きます',
    todo: { title: 'クーポンを決める', note: 'お客さまに出すクーポンです', action: '決める' },
    preparing: 'クーポン',
  },
  tickets: {
    key: 'tickets', short: '回数券', title: '回数券・月謝を使いますか？', description: '回数券や月謝の残りを、お客さまが LINE で見られるようにします。',
    choices: yesNo(
      { icon: 'ticket', label: '使う', note: 'リッチメニューから残りを見られます' },
      { icon: 'ban', label: '使わない', note: '回数券は入れません' },
    ),
    where: '予約設定 › 回数券・月謝', manualHref: '/booking/menus?tab=passes', manualNote: '回数券の画面を開きます',
    todo: { title: '回数券を決める', note: '回数券や月謝の残りを見せます', action: '決める' },
  },
  outcome: {
    key: 'outcome', short: '面談の結果', title: '面談の結果を記録しますか？', description: '面談のあとに「検討中・成約・見送り」を残して、成約率を数えます。',
    choices: yesNo(
      { icon: 'circleCheck', label: '記録する', note: '面談のあとに結果を入れる欄を出します' },
      { icon: 'ban', label: '記録しない', note: '結果の欄は出しません' },
    ),
    where: '予約設定', manualHref: '/booking/menus', manualNote: '予約設定の画面を開きます',
    todo: { title: '面談の結果の記録を決める', note: '成約率を数えるのに使います', action: '決める' },
  },
  content: {
    key: 'content', short: 'メッセージの見本', title: 'よく使うメッセージの見本を入れますか？', description: '予約の確認・前日のお知らせ・来店のお礼など、業種に合った見本をテンプレートに入れます。',
    choices: yesNo(
      { icon: 'file', label: '入れる', note: '「【見本】」の名前で入ります。直して使えます' },
      { icon: 'ban', label: '入れない', note: 'テンプレートとリッチメニューの見本は入れません' },
    ),
    where: 'テンプレート', manualHref: '/templates', manualNote: 'テンプレートの画面を開きます',
    todo: { title: 'メッセージの見本を決める', note: 'よく使うメッセージの見本です', action: '決める' },
  },
}


export const PENDING: Record<string, Question> = {
  cancelDeadline: {
    key: 'cancelDeadline', short: 'キャンセルの期限', title: 'お客さまはいつまでキャンセルできますか？', description: 'LINE からキャンセルできる期限です。過ぎたらお店へ連絡してもらいます。',
    choices: [
      { value: 'day_before', icon: 'calendarCheck', label: '前日まで', note: '前日の 23:59 までキャンセルできます' },
      { value: 'hours_3', icon: 'clock', label: '3 時間前まで', note: '予約の 3 時間前までキャンセルできます' },
      { value: 'none', icon: 'ban', label: '期限なし', note: '予約の時間までいつでもキャンセルできます' },
    ],
    recommended: { consult: 'hours_3' },
    where: '予約設定 › 予約のルール', manualHref: RULES, manualNote: '予約のルールの画面を開きます',
    todo: { title: 'キャンセルの期限を決める', note: 'LINE からキャンセルできる期限です', action: '決める' },
  },
  seats: {
    key: 'seats', short: '席・卓', title: '席・卓はどう入れますか？', description: '予約を受ける席の数です。卓ごとの人数はあとで直せます。',
    choices: [
      { value: 'sample', icon: 'users', label: '見本の席を入れる（4 人卓 × 6）', note: 'あとで卓を足す・減らすことができます' },
      { value: 'none', icon: 'ban', label: '席を分けない', note: '時間ごとの組数だけで受け付けます' },
    ],
    where: '座席・卓管理', manualHref: '/restaurant-test/tables', manualNote: '座席・卓の画面を開きます',
    todo: { title: '席・卓を入れる', note: '予約を受ける席の数です', action: '入れる' },
  },
  nomination: {
    key: 'nomination', short: '担当者の指名', title: '担当者の指名を受け付けますか？', description: 'お客さまが予約のときに担当者を選べるようにします。',
    choices: [
      { value: 'allow', icon: 'user', label: '指名を受け付ける', note: '指名なしも選べます' },
      { value: 'none', icon: 'users', label: '指名は受け付けない', note: '空いている担当者に入ります' },
    ],
    where: '予約設定 › 担当者', manualHref: '/booking/menus?tab=staff', manualNote: '担当者の画面を開きます',
    todo: { title: '担当者の指名を決める', note: '予約のときに担当者を選べるかどうかです', action: '決める' },
  },
  assignment: {
    key: 'assignment', short: '担当の割り当て', title: '面談の担当はどう決めますか？', description: '予約が入ったときの担当の決め方です。',
    choices: [
      { value: 'auto', icon: 'users', label: '自動で割り当てる', note: '空いている担当に順番に入ります' },
      { value: 'customer', icon: 'user', label: 'お客さまが選ぶ', note: '担当を選んで予約してもらいます' },
    ],
    where: '予約設定 › 担当者', manualHref: '/booking/menus?tab=staff', manualNote: '担当者の画面を開きます',
    todo: { title: '担当の割り当てを決める', note: '予約が入ったときの担当の決め方です', action: '決める' },
  },
  classCapacity: {
    key: 'classCapacity', short: 'クラスの定員', title: '1 クラスの定員は？', description: '1 回のクラスで受け付ける人数です。',
    choices: [
      { value: '8', icon: 'users', label: '8 人', note: '少人数のクラスです' },
      { value: '20', icon: 'users', label: '20 人', note: '大人数のクラスです' },
    ],
    where: 'イベント予約', manualHref: '/events', manualNote: 'イベント予約の画面を開きます',
    todo: { title: 'クラスの定員を決める', note: '1 回のクラスで受け付ける人数です', action: '決める' },
  },
  hours: {
    key: 'hours', short: '営業時間', title: 'Googleビジネスの営業時間を設定しますか？', description: 'Googleビジネスプロフィールの通常・特別営業時間をmusuboの基準にします。',
    choices: [
      { value: 'google_business', icon: 'clock', label: 'Googleビジネスで設定する', note: '接続画面から店舗を選びます' },
      { value: 'later', icon: 'clock', label: 'あとで設定する', note: '接続後に営業時間が反映されます' },
    ],
    where: 'Googleビジネス › 営業時間', manualHref: '/settings/google-hours', manualNote: '未接続ならGoogleビジネスの接続画面を開きます',
    todo: { title: '営業時間を設定する', note: 'Googleビジネスプロフィールの営業時間を使います', action: '設定する' },
  },
  partySize: {
    key: 'partySize', short: '受け付ける人数', title: '1 回の予約で受け付ける人数は？', description: 'LINE から予約できる人数です。多い人数はお店へ連絡してもらいます。',
    choices: [
      { value: '1-6', icon: 'users', label: '1〜6 人', note: '7 人からはお店へ連絡してもらいます' },
      { value: '1-10', icon: 'users', label: '1〜10 人', note: '宴会も LINE で受け付けます' },
    ],
    where: '予約設定 › 予約のルール', manualHref: RULES, manualNote: '予約のルールの画面を開きます',
    todo: { title: '受け付ける人数を決める', note: 'LINE から予約できる人数です', action: '決める' },
  },
}

Object.assign(Q, PENDING)
