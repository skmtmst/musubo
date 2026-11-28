import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import Icon from './icon';
import styles from './button.module.css';

/**
 * ★V8 のボタン。主 (濃い緑・白文字・高さ48) は1画面に1つだけ置く。
 * 副 (白の地に枠・高さ44) は読み直し・履歴へ戻るなどに使う。青のボタンは作らない。
 * 赤 (`danger`) は確認窓の取り消せない操作にだけ使う。
 * ★A: 押すと縮み色を濃くする手応え付き。
 */
export default function Button({
  variant = 'primary',
  children,
  className = '',
  selected: selectedProp,
  unavailable = false,
  waitlisted = false,
  full = false,
  href,
  external = false,
  ref,
  ...rest
}: {
  variant?: 'counter' | 'compact-secondary' | 'stamp-primary' | 'stamp-choice' | 'stamp-reward' | 'inline-action' | 'inline-danger' | 'notify-text' | 'restaurant-select' | 'restaurant-date' | 'restaurant-primary' | 'restaurant-control' | 'restaurant-time' | 'choice' | 'backdrop' | 'calendar' | 'weekday' | 'row' | 'night-cta' | 'night-text' | 'sound' | 'send' | 'slot-row' | 'reward-row' | 'overlay-bell' | 'segment' | 'primary' | 'secondary' | 'danger' | 'text' | 'text-action' | 'icon' | 'arrow' | 'notify' | 'chip' | 'tab' | 'panels-tab' | 'option' | 'optionRow' | 'day' | 'time' | 'calendarDay' | 'overlay' | 'nightAction' | 'nightText' | 'nightSound' | 'nightSend' | 'switch' | 'link' | 'plain' | 'menuRow';
  selected?: boolean;
  unavailable?: boolean;
  waitlisted?: boolean;
  full?: boolean;
  /** 回答フォームに置く外部リンクも同じボタンの形にする。 */
  href?: string;
  external?: boolean;
  children?: ReactNode;
  className?: string;
  /** 確認窓が開いたときのフォーカス移動用 (React 19 の ref-as-prop)。 */
  ref?: Ref<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const selected = selectedProp ?? (rest['aria-pressed'] === true || rest['aria-pressed'] === 'true' || rest['aria-checked'] === true || rest['aria-checked'] === 'true');
  const aliases = {'choice': 'time', 'backdrop': 'overlay', 'calendar': 'calendarDay', 'weekday': 'day', 'row': 'option', 'night-cta': 'nightAction', 'night-text': 'nightText', 'sound': 'nightSound', 'send': 'nightSend', 'slot-row': 'optionRow', 'reward-row': 'option', 'overlay-bell': 'notify', 'segment': 'tab'} as const;
  const tone = variant in aliases ? aliases[variant as keyof typeof aliases] : variant as Exclude<typeof variant, keyof typeof aliases>;
  const base = 'liff-press focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50';
  const action = 'flex w-full items-center justify-center gap-2 rounded-(--liff-radius) px-4 font-bold';
  const choice = selected
    ? 'bg-liff-soft outline-2 -outline-offset-1 outline-liff-primary'
    : unavailable
      ? 'bg-liff-off-bg outline-1 -outline-offset-1 outline-liff-line'
      : 'bg-canvas outline-1 -outline-offset-1 outline-liff-line';
  const tones = {
    counter: 'liff-hit inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-(--liff-radius-stamp-control) border border-liff-line-strong bg-canvas text-liff-sub shadow-(--liff-control-shadow)',
    'compact-secondary': `${action} min-h-9 border border-liff-line-strong bg-canvas text-[13px] leading-5 font-semibold text-ink shadow-(--liff-control-shadow)`,
    'stamp-primary': 'flex min-h-12 w-full items-center justify-center gap-2 rounded-(--liff-radius-stamp-control) border border-liff-primary bg-liff-primary px-4 text-[13px] leading-5 font-semibold text-(--liff-on-primary) shadow-(--liff-card-shadow)',
    'stamp-reward': 'liff-hit flex w-full items-center gap-2.5 text-left disabled:opacity-100',
    'stamp-choice': 'liff-hit flex min-h-11 w-full items-center gap-2.5 text-left disabled:opacity-100',
    'inline-action': 'liff-hit inline-flex min-h-7 shrink-0 items-center justify-center gap-1 rounded-lg border border-liff-line-strong bg-canvas px-3 text-[11px] leading-[17px] font-semibold whitespace-nowrap text-ink',
    'inline-danger': 'liff-hit inline-flex min-h-7 shrink-0 items-center justify-center gap-1 rounded-lg border border-danger bg-canvas px-3 text-[11px] leading-[17px] font-semibold whitespace-nowrap text-danger',
    'notify-text': 'liff-hit inline-flex min-h-9 items-center justify-center gap-2 rounded-(--liff-radius) px-3 text-xs whitespace-nowrap text-liff-primary border border-liff-line-strong bg-canvas',
    'restaurant-date': 'liff-hit text-[15px] leading-[23px] font-bold text-ink',
    'restaurant-select': 'liff-hit flex min-h-9 w-full items-center justify-between rounded-(--liff-radius) bg-canvas px-3 text-[13px] leading-5 font-medium text-ink outline-1 -outline-offset-1 outline-liff-line-strong shadow-(--liff-control-shadow)',
    'restaurant-primary': `${action} min-h-9 text-[13px] leading-5 font-semibold bg-liff-primary text-(--liff-on-primary) shadow-(--liff-card-shadow)`,
    'restaurant-control': 'liff-hit inline-flex min-h-9 items-center justify-center gap-2 rounded-(--liff-radius) px-4 text-[13px] leading-5 font-semibold bg-canvas text-ink outline-1 -outline-offset-1 outline-liff-line-strong shadow-(--liff-control-shadow)',
    'restaurant-time': `liff-hit inline-flex min-h-9 items-center rounded-full px-3 text-xs leading-[18px] shadow-(--liff-control-shadow) outline-1 -outline-offset-1 ${selected ? 'bg-liff-soft text-liff-primary font-semibold outline-liff-primary' : 'bg-canvas text-ink font-medium outline-liff-line-strong'} disabled:text-liff-off-ink`,
    /** オン・オフの切り替え（B4 続けて予約）。つまみは子の span。 */
    /** 文の中・札の右の小さな緑の操作（「変える」「もう一度」）。 */
    /** 中身を自分で組む行（丸の選択肢など）。見た目は付けず、押せる範囲と手応えだけ。 */
    plain: 'liff-hit flex w-full text-left',
    primary: `${action} min-h-12 bg-liff-primary text-[15px] text-(--liff-on-primary) focus-visible:outline-liff-primary active:opacity-90`,
    danger: `${action} min-h-12 bg-danger text-[15px] text-white focus-visible:outline-danger active:opacity-90`,
    secondary: `${action} min-h-11 border border-liff-line-strong bg-canvas text-sm font-semibold text-ink active:bg-liff-off-bg`,
    text: 'liff-hit inline-flex min-h-9 items-center justify-center gap-1 px-2 text-xs text-liff-sub',
    'text-action': 'liff-hit inline-flex min-h-11 items-center justify-center gap-1 px-5 text-sm font-bold text-liff-primary',
    icon: 'liff-hit inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink disabled:text-liff-off-ink',
    arrow: 'liff-hit flex h-10 w-[18px] shrink-0 items-center justify-center text-ink disabled:text-liff-off-ink',
    notify: 'liff-hit flex h-6 w-6 items-center justify-center rounded-full bg-canvas text-liff-primary shadow outline-1 -outline-offset-1 outline-liff-line-strong',
    chip: `liff-hit inline-flex shrink-0 items-center justify-center rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap ${selected ? 'border border-liff-primary bg-liff-soft text-liff-primary' : 'border border-transparent bg-liff-chip text-liff-sub'}`,
    tab: `liff-hit flex min-h-8 flex-1 items-center justify-center rounded-lg px-1 text-xs ${selected ? 'bg-canvas font-bold text-ink' : 'font-semibold text-liff-sub'}`,
    'panels-tab': `liff-hit flex min-h-8 flex-1 items-center justify-center rounded-lg px-1 text-sm ${selected ? 'bg-canvas font-bold text-liff-primary shadow-(--liff-control-shadow)' : 'font-semibold text-liff-sub'}`,
    option: `liff-hit flex w-full items-center gap-3 rounded-(--liff-radius-lg) p-3.5 text-left text-sm text-ink ${choice} ${selected || unavailable ? '' : 'shadow-(--liff-card-shadow)'}`,
    optionRow: `liff-hit flex min-h-11 w-full items-center justify-between gap-3 rounded-(--liff-radius) border px-4 py-2.5 text-left disabled:cursor-not-allowed ${unavailable ? 'border-hairline bg-liff-off-bg' : selected && waitlisted ? 'border-liff-wait-ink bg-liff-wait-bg' : selected ? 'border-liff-primary bg-liff-soft' : 'border-hairline bg-canvas'}`,
    day: `liff-hit flex min-w-0 flex-col items-center gap-0.5 rounded-(--liff-radius) py-2 disabled:opacity-100 ${choice}`,
    time: `liff-hit liff-num min-h-11 w-full rounded-(--liff-radius) px-1 text-[15px] disabled:opacity-100 ${selected ? 'bg-liff-soft font-bold text-ink outline-2 -outline-offset-2 outline-liff-primary' : unavailable ? 'bg-liff-off-bg font-medium text-liff-off-ink' : 'bg-canvas font-medium text-ink outline -outline-offset-1 outline-liff-line-strong'}`,
    calendarDay: `liff-hit flex h-11 flex-col items-center justify-center gap-0.5 rounded-(--liff-radius) font-semibold disabled:opacity-100 ${selected ? 'bg-liff-soft text-ink outline-2 -outline-offset-2 outline-liff-primary' : full ? 'text-liff-full' : unavailable ? 'text-liff-off-ink' : 'text-ink'}`,
    overlay: 'absolute inset-0 bg-ink/40',
    nightAction: `${action} min-h-12 bg-night-cta text-[15px] text-white`,
    nightText: 'liff-hit inline-flex items-center text-xs text-night-mine',
    nightSound: 'liff-hit pointer-events-auto inline-flex items-center gap-1 rounded-full bg-night-panel px-2.5 py-1 text-xs font-semibold text-white',
    /** 入り／切り（role="switch" と aria-checked を呼び側で付ける）。つまみは Button が描く。 */
    switch: `liff-hit relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 ${selected ? 'bg-liff-primary' : 'bg-liff-idle'}`,
    /** カードの中の 1 行（印・名前・数・＞）。マイページの一覧。 */
    menuRow: 'liff-hit flex min-h-[46px] w-full items-center gap-3 px-3.5 text-left text-sm text-ink disabled:opacity-100',
    /** 文中のリンク（領収書を見る など）。ボタンの形にしない。 */
    link: 'liff-hit inline-flex min-h-5 items-center gap-1 text-[13px] font-bold whitespace-nowrap text-info-link',
    nightSend: 'liff-hit flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full bg-liff-primary text-white',
  };
  const skin = tone === 'nightAction' ? `${styles.skin} ${styles.nightAction}` : styles.skin;
  const content = tone === 'switch' ? <><span aria-hidden="true" className={`block h-4 w-4 rounded-full bg-canvas shadow transition-transform ${selected ? 'translate-x-4' : 'translate-x-0'}`} />{children}</> : tone === 'nightSend' && typeof children === 'string' ? <><Icon name="send" className="h-[18px] w-[18px]" /><span className="sr-only">{children}</span></> : children;
  if (href !== undefined) {
    return <a href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined} className={`${base} ${tones[tone]} ${skin} ${className}`} style={rest.style}>{content}</a>;
  }
  return (
    <button type="button" ref={ref} data-selected={selected || undefined} className={`${base} ${tones[tone]} ${skin} ${className}`} {...rest}>
      {content}
    </button>
  );
}
