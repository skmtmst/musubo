'use client'

import { useEffect, useRef, useSyncExternalStore, useState, type CSSProperties } from 'react'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { humanizeErrorText } from './human-error-text'
import { useV8LeaveList } from './overlay-utils'
import styles from './toast.module.css'
import { useStackMotion } from './use-stack-motion'

/** 知らせの種類。白地に印の色で分ける（緑=うまくいった、赤=できなかった）。 */
export type ToastTone = 'success' | 'error' | 'info'

export type ToastItem = {
  id: number
  message: string
  tone: ToastTone
  /** 取り消せる操作の「元に戻す」。1件に1つまで。 */
  actionLabel?: string
  onAction?: () => void
}

/**
 * 通知の消える期限と連動させたい処理（R623: runUndoable の送信期限）。
 * hover/focus で止めるとき一緒に止め、離すと一緒に動かす。
 */
export type ToastLifecycle = {
  onPause?: () => void
  onResume?: () => void
}

export type NotifyToastOptions = {
  tone?: ToastTone
  /** 4秒で消える。「元に戻す」付きは5秒。0以下で消さない（長押しの確認待ちなど）。 */
  duration?: number
  actionLabel?: string
  onAction?: () => void
  /** 期限を共有する処理（取り消せる送信など）。 */
  lifecycle?: ToastLifecycle
}

const DEFAULT_DURATION = 4000
/*
 * ★管理画面 sTJsh §4:「元に戻す」は5秒。乗せている間は時間を止める。
 * ⌘Z でも戻せる（ToastHost が受け持つ）。
 */
const UNDO_DURATION = 5000
const MAX_ITEMS = 3

let nextId = 1
let items: ToastItem[] = []
const listeners = new Set<() => void>()

/*
 * 各知らせの残り時間。マウスを乗せている間・中のボタンに触れている間は止める。
 * `timer` が止まっている間は `remaining` だけが残る。
 * `holds` は止めている理由（pointer=hover、focus=キーボード操作）。
 * どれか1つでも残っていれば止めたままにする。
 */
type ToastPauseReason = 'pointer' | 'focus'
type Countdown = {
  remaining: number
  deadline: number
  timer: ReturnType<typeof setTimeout> | null
  holds: Set<ToastPauseReason>
}
const countdowns = new Map<number, Countdown>()
/** 期限を共有する処理（R623）。止める・動かすの切り替わりで呼ぶ。 */
const lifecycles = new Map<number, ToastLifecycle>()

function emit() {
  for (const listener of listeners) listener()
}

function snapshot(): ToastItem[] {
  return items
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function scheduleDismiss(id: number, ms: number): void {
  const entry: Countdown = { remaining: ms, deadline: Date.now() + ms, timer: null, holds: new Set() }
  entry.timer = setTimeout(() => dismissToast(id), ms)
  countdowns.set(id, entry)
}

/*
 * 共有期限の後始末。取り消されずに知らせが消えるとき（×・押出し・
 * unmount・掃除）は、残り時間で必ず一度だけ送信を進める。
 * 取り消し済み・送信済みなら受け側（settled）が無視するので、
 * 止まっていたかどうかを問わず呼んでよい。
 */
function releaseLifecycle(id: number): void {
  const hooks = lifecycles.get(id)
  lifecycles.delete(id)
  hooks?.onResume?.()
}

/** 止まっている共有期限をすべて残り時間で進める（ホストを外すとき用）。 */
function resumeAllLifecycles(): void {
  for (const id of [...lifecycles.keys()]) {
    lifecycles.get(id)?.onResume?.()
  }
}

export function dismissToast(id: number): void {
  const entry = countdowns.get(id)
  if (entry?.timer) clearTimeout(entry.timer)
  countdowns.delete(id)
  releaseLifecycle(id)
  const before = items.length
  items = items.filter((item) => item.id !== id)
  if (items.length !== before) emit()
}

/** 乗せている間・触れている間は消えるまでの時間を止める（★管理画面 sTJsh §4）。 */
function pauseToast(id: number, reason: ToastPauseReason = 'pointer'): void {
  const entry = countdowns.get(id)
  if (!entry || entry.holds.has(reason)) return
  const wasHeld = entry.holds.size > 0
  entry.holds.add(reason)
  if (entry.timer !== null) {
    clearTimeout(entry.timer)
    entry.timer = null
    entry.remaining = Math.max(0, entry.deadline - Date.now())
  }
  // 初めて止まったときだけ、期限を共有する送信側も止める（R623）
  if (!wasHeld) lifecycles.get(id)?.onPause?.()
}

function resumeToast(id: number, reason: ToastPauseReason = 'pointer'): void {
  const entry = countdowns.get(id)
  if (!entry || !entry.holds.has(reason)) return
  entry.holds.delete(reason)
  // まだ他の理由で止まっていたら動かさない
  if (entry.holds.size > 0 || entry.timer !== null) return
  entry.deadline = Date.now() + entry.remaining
  entry.timer = setTimeout(() => dismissToast(id), entry.remaining)
  lifecycles.get(id)?.onResume?.()
}

/**
 * 保存の知らせを右下に出す。「保存しました」「削除しました」など、
 * 画面の中に文で出していた知らせはここへ送る。4秒で消える。
 * 「元に戻す」を付けた知らせは5秒残る。
 *
 * 返す関数を呼ぶとすぐに消せる。取り消せる操作は
 * `actionLabel: '元に戻す'` と `onAction` を渡す。
 */
export function notifyToast(message: string, options?: NotifyToastOptions): () => void {
  const id = nextId
  nextId += 1
  /*
   * 「元に戻す」付きの知らせは5秒（★管理画面 sTJsh §4）。押す間が要るので
   * 通常の4秒より長い。duration を明示したらそちらが勝つ。
   */
  const duration = options?.duration ?? (options?.actionLabel ? UNDO_DURATION : DEFAULT_DURATION)
  const next = [
    ...items,
    {
      id,
      // 失敗の知らせは機械の文（API error: 500 など）を人の文へ置き換えてから出す。
      message: (options?.tone ?? 'success') === 'error' ? humanizeErrorText(message) : message,
      tone: options?.tone ?? 'success',
      actionLabel: options?.actionLabel,
      onAction: options?.onAction,
    },
  ]
  // 表示数を超えて押し出された知らせの残り時間タイマーも止める。
  // 押し出されても未取消の保存は残り時間で送る（releaseLifecycle）。
  for (const dropped of next.slice(0, Math.max(0, next.length - MAX_ITEMS))) {
    const entry = countdowns.get(dropped.id)
    if (entry?.timer) clearTimeout(entry.timer)
    countdowns.delete(dropped.id)
    releaseLifecycle(dropped.id)
  }
  items = next.slice(-MAX_ITEMS)
  emit()
  if (options?.lifecycle && duration > 0) lifecycles.set(id, options.lifecycle)
  if (duration > 0) scheduleDismiss(id, duration)
  return () => dismissToast(id)
}

/** 保存成功の知らせはこの口から1つだけ出す。 */
export function notifySaved(message = '保存しました', options?: Omit<NotifyToastOptions, 'tone'>): () => void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('lh:form-saved'))
  return notifyToast(message, { ...options, tone: 'success' })
}

/** テスト用。溜まった知らせを全部消す。 */
export function clearToastsForTest(): void {
  for (const id of countdowns.keys()) {
    const entry = countdowns.get(id)
    if (entry?.timer) clearTimeout(entry.timer)
  }
  countdowns.clear()
  // 消えた分の未取消の保存は残り時間で送る（取り消し済みは settled が無視）。
  resumeAllLifecycles()
  lifecycles.clear()
  items = []
  emit()
}

/** 直前の「元に戻す」を実行する（⌘Z）。戻せる知らせが無いとき何もしない。 */
export function undoLatestToast(): boolean {
  /*
   * 本物の「元に戻す」だけを選ぶ。「もう一度」（runOptimistic の再試行）や
   * その他の操作は選ばない（R624）。押しての再試行はボタンのまま残す。
   */
  const target = [...items].reverse().find((item) => item.actionLabel === '元に戻す' && item.onAction)
  if (!target) return false
  target.onAction?.()
  dismissToast(target.id)
  return true
}

/**
 * 知らせ1件の見た目。置き場所（`ToastHost`）の外で単体に描くとき用
 * （見本・テスト）。ふだんは `notifyToast` を使う。
 */
export function Toast({
  item,
  onDismiss,
  leaving = false,
}: {
  item: Omit<ToastItem, 'id'> & { id?: number }
  onDismiss?: () => void
  /** 消えかけ（閉じる動きの間）。読み上げ・押す対象から外す。 */
  leaving?: boolean
}) {
  const Icon = item.tone === 'success' ? CircleCheck : item.tone === 'info' ? Info : CircleAlert
  const dismiss = onDismiss ?? (item.id !== undefined ? () => dismissToast(item.id as number) : undefined)
  /*
   * 1件ずつには role・aria-live を持たせない（動きの点検 14 番）。
   * 読み上げは置き場所（ToastHost）の入れ物が最初から受け持つ。
   * 1件ずつに付けると、入れ物と二重に読まれたり、入れ物ごと後から
   * 差し込まれて最初の1件が読まれなかったりする。
   */
  return (
    <div
      className={styles.toast}
      data-toast=""
      data-closing={leaving || undefined}
      aria-hidden={leaving || undefined}
      inert={leaving || undefined}
      onPointerEnter={item.id !== undefined ? () => pauseToast(item.id as number, 'pointer') : undefined}
      onPointerLeave={item.id !== undefined ? () => resumeToast(item.id as number, 'pointer') : undefined}
      onFocus={
        item.id !== undefined
          ? (e) => {
              // 中のボタンへTabで移った間も期限を止める。中の移動では止め直さない。
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
              pauseToast(item.id as number, 'focus')
            }
          : undefined
      }
      onBlur={
        item.id !== undefined
          ? (e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
              resumeToast(item.id as number, 'focus')
            }
          : undefined
      }
    >
      <Icon
        className={[styles.icon, item.tone === 'success' ? styles.iconSuccess : item.tone === 'info' ? styles.iconInfo : styles.iconError].join(' ')}
        aria-hidden="true"
        size={16}
      />
      <span className={styles.message}>{item.message}</span>
      {item.actionLabel && item.onAction ? (
        <button
          type="button"
          className={styles.undo}
          onClick={() => {
            item.onAction?.()
            dismiss?.()
          }}
        >
          {item.actionLabel}
        </button>
      ) : null}
      {dismiss ? <button data-close-control="" type="button" className={styles.close} onClick={dismiss} aria-label="知らせを閉じる"><X aria-hidden="true" size={16} /></button> : null}
    </div>
  )
}

/** 入力欄の中では ⌘Z は文字の取り消しに使うので、知らせの取り消しはしない。 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * 右下の置き場所。外枠（`app/layout.tsx`）に1つだけ置く。
 * 画面側は置かない。`notifyToast` で送られた分だけ出す。
 * ⌘Z で直前の「元に戻す」を実行する（★管理画面 sTJsh §4）。
 */
export default function ToastHost() {
  const live = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'z' || (!event.metaKey && !event.ctrlKey) || event.shiftKey) return
      if (isEditableTarget(event.target)) return
      if (undoLatestToast()) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      // 外れた（画面遷移など）ときに止めていた送信期限を置き去りにしない。
      // 取り消し済み・送信済みなら受け側（settled）が無視する。
      resumeAllLifecycles()
    }
  }, [])
  /* 消えるときは窓と同じ「消えかけ」で薄く消す（動きの点検 13 番）。 */
  const shown = useV8LeaveList(live)
  const hostRef = useRef<HTMLDivElement>(null)
  const [bottom, setBottom] = useState(16)
  useEffect(() => {
    const view = document.defaultView
    if (!view?.requestAnimationFrame || !view.cancelAnimationFrame) return
    let frame = 0
    const measure = () => {
      view.cancelAnimationFrame(frame)
      frame = view.requestAnimationFrame(() => {
        const tops = [...document.querySelectorAll<HTMLElement>('[data-shared-part="sticky-bar"]')]
          .map(el => el.getBoundingClientRect())
          .filter(r => r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0)
          .map(r => r.top)
        setBottom(tops.length ? Math.max(16, window.innerHeight - Math.min(...tops) + 16) : 16)
      })
    }
    const Observer = document.defaultView?.MutationObserver
    const observer = Observer ? new Observer(measure) : null
    observer?.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    measure()
    return () => { view.cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [shown.length])
  useStackMotion(hostRef, shown.map(({ item }) => item.id).join(','))
  /*
   * 読み上げの入れ物は空でも最初から置いておく（動きの点検 14 番）。
   * 入れ物ごと後から差し込むと、読み上げ側が見張り始める前に中身が入り、
   * 最初の知らせが読まれないことがある。role=status は全体を読み直す
   * （aria-atomic=true が既定）ので、足された1件だけを読むよう false にする。
   */
  return (
    <div ref={hostRef} style={{ '--toast-bottom': `${bottom}px` } as CSSProperties} className={styles.host} role="status" aria-live="polite" aria-atomic="false" aria-label="知らせ">
      {shown.map(({ item, leaving }) => (
        <div key={item.id} data-stack-item={item.id}><Toast item={item} leaving={leaving} /></div>
      ))}
    </div>
  )
}
