import styles from './icon.module.css';
// Lucide (ISC License, https://lucide.dev) の線アイコンを写した小さな部品。
// 使う分だけ path を持つ。依存は増やさない (package.json・lockfile 不変)。
// 見た目は 24x24・線・角丸 (lucide の決まり) でそろえる。絵文字は使わない。

const PATHS = {
  utensils: [
    <path key="a" d="M3 2v7a4 4 0 0 0 4 4h1m-1-11v20m4-20v7a4 4 0 0 1-4 4" />,
    <path key="b" d="M21 2c-4 0-5 4-5 8v3h5m0-11v20" />,
  ],
  /** 振替・繰り返し */
  repeat: [
    <path key="a" d="m17 2 4 4-4 4" />,
    <path key="b" d="M3 11v-1a4 4 0 0 1 4-4h14" />,
    <path key="c" d="m7 22-4-4 4-4" />,
    <path key="d" d="M21 13v1a4 4 0 0 1-4 4H3" />,
  ],
  'qr-code': [
    <rect key="a" width="5" height="5" x="3" y="3" rx="1" />,
    <rect key="b" width="5" height="5" x="16" y="3" rx="1" />,
    <rect key="c" width="5" height="5" x="3" y="16" rx="1" />,
    <path key="d" d="M21 16h-3a2 2 0 0 0-2 2v3M21 21h.01M12 7v3a2 2 0 0 1-2 2H7M3 12h.01M12 3h.01M12 16v.01M16 12h1M21 12v.01M12 21v-1" />,
  ],
  /** リンクが切れている（見つからない画面） */
  'link-2-off': [
    <path key="a" d="M9 17H7A5 5 0 0 1 7 7" />,
    <path key="b" d="M15 7h2a5 5 0 0 1 4 8" />,
    <path key="c" d="M8 12h4" />,
    <path key="d" d="m2 2 20 20" />,
  ],
  /** 準備中（ の準備中の画面 K9HMJp） */
  hammer: [
    <path key="a" d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9" />,
    <path key="b" d="m18 15 4-4" />,
    <path key="c" d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" />,
  ],
  /** 済み・選択中 */
  check: [<path key="c" d="M20 6 9 17l-5-5" />],
  /** 戻る */
  'chevron-left': [<path key="c" d="m15 18-6-6 6-6" />],
  /** 次へ */
  'chevron-right': [<path key="c" d="m9 18 6-6-6-6" />],
  'arrow-right': [<path key="a" d="M5 12h14m-6-6 6 6-6 6" />],
  /** 日付・空き */
  calendar: [
    <rect key="r" width="18" height="18" x="3" y="4" rx="2" />,
    <path key="a" d="M16 2v4" />,
    <path key="b" d="M8 2v4" />,
    <path key="c" d="M3 10h18" />,
  ],
  /** 予約の履歴を見る */
  'calendar-days': [
    <path key="a" d="M8 2v4" />,
    <path key="b" d="M16 2v4" />,
    <rect key="r" width="18" height="18" x="3" y="4" rx="2" />,
    <path key="c" d="M3 10h18" />,
    <path key="d" d="M8 14h.01" />,
    <path key="e" d="M12 14h.01" />,
    <path key="f" d="M16 14h.01" />,
    <path key="g" d="M8 18h.01" />,
    <path key="h" d="M12 18h.01" />,
    <path key="i" d="M16 18h.01" />,
  ],
  /** 一覧（リスト表示の切り替え・自分のイベントへ戻る。lucide list と同じ線） */
  list: [
    <path key="a" d="M3 12h.01" />,
    <path key="b" d="M3 18h.01" />,
    <path key="c" d="M3 6h.01" />,
    <path key="d" d="M8 12h13" />,
    <path key="e" d="M8 18h13" />,
    <path key="f" d="M8 6h13" />,
  ],
  /** 時刻 */
  clock: [
    <circle key="c" cx="12" cy="12" r="10" />,
    <path key="h" d="M12 6v6l4 2" />,
  ],
  /** 案内の帯の印 */
  info: [
    <circle key="c" cx="12" cy="12" r="10" />,
    <path key="a" d="M12 16v-4" />,
    <path key="b" d="M12 8h.01" />,
  ],
  /** 画像が無いときの印 (イベント詳細) */
  image: [
    <rect key="r" width="18" height="18" x="3" y="3" rx="2" />,
    <circle key="c" cx="9" cy="9" r="2" />,
    <path key="p" d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />,
  ],
  /** 場所 (イベント詳細) */
  /** オンラインの会議 */
  video: [
    <path key="a" d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />,
    <rect key="r" x="2" y="6" width="14" height="12" rx="2" />,
  ],
  'map-pin': [
    <path key="p" d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />,
    <circle key="c" cx="12" cy="10" r="3" />,
  ],
  /** 待ち (キャンセル待ち・承認待ちの印) */
  /** 空きが出た 。lucide party-popper と同じ線 */
  'party-popper': [
    <path key="a" d="M5.8 11.3 2 22l10.7-3.79" />,
    <path key="b" d="M4 3h.01" />,
    <path key="c" d="M22 8h.01" />,
    <path key="d" d="M15 2h.01" />,
    <path key="e" d="M22 20h.01" />,
    <path key="f" d="m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10" />,
    <path key="g" d="m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17" />,
    <path key="h" d="m11 2 .33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7" />,
    <path key="i" d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z" />,
  ],
  /** 再生 (ウェビナーの動画が流れるまで。lucide play と同じ線) */
  play: [<path key="a" d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />],
  hourglass: [
    <path key="a" d="M5 22h14" />,
    <path key="b" d="M5 2h14" />,
    <path key="c" d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12 7.586 16.414A2 2 0 0 0 7 17.828V22" />,
    <path key="d" d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />,
  ],
  /** 送信した */
  send: [
    <path
      key="a"
      d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"
    />,
    <path key="b" d="m21.854 2.147-10.94 10.939" />,
  ],
  /** 読み込み直し */
  'rotate-cw': [
    <path key="a" d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />,
    <path key="b" d="M21 3v5h-5" />,
  ],
  /** 取り消せない操作の確認窓の印 (警告の三角) */
  'alert-triangle': [
    <path
      key="a"
      d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"
    />,
    <path key="b" d="M12 9v4" />,
    <path key="c" d="M12 17h.01" />,
  ],
  /** 読み込めなかった時の印 (雲＋斜線) */
  'cloud-off': [
    <path key="a" d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />,
    <path key="b" d="m2 2 20 20" />,
  ],
  /** ★V8 読み込めなかった時の印 (通信が切れた電波) */
  'wifi-off': [
    <path key="a" d="M8.5 16.5a5 5 0 0 1 7 0" />,
    <path key="b" d="M2 8.82a15 15 0 0 1 4.17-2.65" />,
    <path key="c" d="M10.66 5c4.01-.36 8.14.9 11.34 3.76" />,
    <path key="d" d="M16.85 11.25a10 10 0 0 1 2.22 1.68" />,
    <path key="e" d="M5 13a10 10 0 0 1 5.24-2.76" />,
    <path key="f" d="m2 2 20 20" />,
    <path key="g" d="M12 20h.01" />,
  ],
  /** ★V8 上の帯の閉じる印 */
  x: [<path key="a" d="M18 6 6 18" />, <path key="b" d="m6 6 12 12" />],
  /** ★V8 上の帯のメニュー印 (…) */
  ellipsis: [
    <circle key="a" cx="12" cy="12" r="1" />,
    <circle key="b" cx="19" cy="12" r="1" />,
    <circle key="c" cx="5" cy="12" r="1" />,
  ],
  /** ★V8 その期間に空きが無い時の印 (暦＋×) */
  'calendar-x': [
    <path key="a" d="M8 2v4" />,
    <path key="b" d="M16 2v4" />,
    <rect key="r" width="18" height="18" x="3" y="4" rx="2" />,
    <path key="c" d="M3 10h18" />,
    <path key="d" d="m14 14-4 4" />,
    <path key="e" d="m10 14 4 4" />,
  ],
  /** お店への連絡の案内 */
  'message-circle': [<path key="a" d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />],
  /** 担当 (1人) */
  user: [
    <path key="a" d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />,
    <circle key="c" cx="12" cy="7" r="4" />,
  ],
  /** 指名なし (複数人) */
  users: [
    <path key="a" d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />,
    <circle key="b" cx="9" cy="7" r="4" />,
    <path key="c" d="M22 21v-2a4 4 0 0 0-3-3.87" />,
    <path key="d" d="M16 3.13a4 4 0 0 1 0 7.75" />,
  ],
  /** 友だち追加のお願い */
  'user-plus': [
    <path key="a" d="M2 21a8 8 0 0 1 13.292-6" />,
    <circle key="b" cx="10" cy="8" r="5" />,
    <path key="c" d="M19 16v6" />,
    <path key="d" d="M22 19h-6" />,
  ],
  /** 送信した・配信が終わった */
  'circle-check': [<circle key="c" cx="12" cy="12" r="10" />, <path key="p" d="m9 12 2 2 4-4" />],
  /** 紹介リンクの写し */
  copy: [
    <rect key="r" width="14" height="14" x="8" y="8" rx="2" />,
    <path
      key="p"
      d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
    />,
  ],
  /** 紹介リンクの印 */
  link: [
    <path
      key="a"
      d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
    />,
    <path
      key="b"
      d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
    />,
  ],
  /** リンクの発行 */
  plus: [<path key="a" d="M5 12h14" />, <path key="b" d="M12 5v14" />],
  /** 空いたら知らせる（キャンセル待ちの鈴） */
  bell: [
    <path key="a" d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />,
    <path key="b" d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />,
  ],
  /** 紹介ではじめる */
  'share-2': [
    <circle key="a" cx="18" cy="5" r="3" />,
    <circle key="b" cx="6" cy="12" r="3" />,
    <circle key="c" cx="18" cy="19" r="3" />,
    <line key="d" x1="8.59" x2="15.42" y1="13.51" y2="17.49" />,
    <line key="e" x1="15.41" x2="8.59" y1="6.51" y2="10.49" />,
  ],
  /** タップで音声を出す */
  'volume-x': [
    <path
      key="a"
      d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"
    />,
    <line key="b" x1="22" x2="16" y1="9" y2="15" />,
    <line key="c" x1="16" x2="22" y1="9" y2="15" />,
  ],
  /** 来店スタンプ：へらす（増減の −） */
  minus: [<path key="a" d="M5 12h14" />],
  /** 来店スタンプ：特典（lucide gift と同じ線） */
  gift: [
    <rect key="r" x="3" y="8" width="18" height="4" rx="1" />,
    <path key="a" d="M12 8v13" />,
    <path key="b" d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />,
    <path key="c" d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" />,
  ],
  /** 来店スタンプ：店員の操作（lucide lock と同じ線） */
  lock: [
    <rect key="r" width="18" height="11" x="3" y="11" rx="2" ry="2" />,
    <path key="a" d="M7 11V7a5 5 0 0 1 10 0v4" />,
  ],
  /** 来店スタンプ：紙のカードを撮る（lucide camera と同じ線） */
  camera: [
    <path key="a" d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />,
    <circle key="c" cx="12" cy="13" r="3" />,
  ],
  /** マイページの回数券（lucide ticket と同じ線） */
  ticket: [
    <path key="a" d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />,
    <path key="b" d="M13 5v2" />,
    <path key="c" d="M13 17v2" />,
    <path key="d" d="M13 11v2" />,
  ],
  /** マイページのスタンプ（lucide stamp と同じ線） */
  stamp: [
    <path key="a" d="M5 22h14" />,
    <path key="b" d="M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-.66-.26-1.3-.73-1.77Z" />,
    <path key="c" d="M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-3-3c-1.66 0-3 1-3 3s1 2 1 3.5V13" />,
  ],
  /** マイページのマイル（lucide gem と同じ線） */
  gem: [
    <path key="a" d="M6 3h12l4 6-10 13L2 9Z" />,
    <path key="b" d="M11 3 8 9l4 13 4-13-3-6" />,
    <path key="c" d="M2 9h20" />,
  ],
  /** マイページのクーポン（lucide tag と同じ線） */
  tag: [
    <path key="a" d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />,
    <circle key="c" cx="7.5" cy="7.5" r=".5" />,
  ],
  /** 予約の履歴の領収書（lucide receipt と同じ線） */
  receipt: [
    <path key="a" d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />,
    <path key="b" d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />,
    <path key="c" d="M12 17.5v-11" />,
  ],
  /** 外のページが開く（lucide external-link と同じ線） */
  'external-link': [
    <path key="a" d="M15 3h6v6" />,
    <path key="b" d="M10 14 21 3" />,
    <path key="c" d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />,
  ],
} as const;

export type IconName = keyof typeof PATHS;

export default function Icon({ name, className = 'h-5 w-5', tone }: { name: IconName; className?: string; tone?: 'info' | 'booking-info' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${className} ${tone === 'info' ? styles.info : tone === 'booking-info' ? styles.bookingInfo : ''}`}
      data-liff-icon={name}
      data-liff-icon-tone={tone}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
