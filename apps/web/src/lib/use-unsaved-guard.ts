'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { UNSAVED_ACTION_EVENT } from './unsaved-action'
import { clearUnsavedCohort, historyGuards, selectUnsavedCohort, selectedUnsavedGuards, type HistoryGuard } from './unsaved-guard-registry'
import { canonicalLocalUrl, forgetLeave, leaveThroughHistory, releaseHistoryInterception, retainHistoryInterception, type HistoryPlace } from './unsaved-history'

/** 確認のあとに行う移動。戻る・進むは行き先の履歴の位置を持つ（受け止めは unsaved-history.ts が全部の番兵で1つ持つ）。 */
export type UnsavedLeaveTarget =
  | { kind: 'link'; href: string }
  | { kind: 'history-back'; to?: HistoryPlace }
  | { kind: 'action'; run: () => void }

/**
 * 未保存の変更がある間、画面を離れる操作を止める。
 *
 * - ブラウザ再読込・タブ終了: beforeunload で標準の確認を出す
 * - 左メニュー等の画面内リンク: クリックを捕まえて確認対話を出す
 * - 戻る・進む: Next のルーターより先に popstate を受け、元の履歴位置へ戻してから確認対話を出す
 *
 * 保存成功や「保存せずに移る」の確認後は markClean で dirty を外し、
 * 警告がもう出ないようにする。
 */
export function useUnsavedGuard(options: {
  dirty: boolean
  subject?: string
  busy?: boolean
  /**
   * 戻る・進むの行き先が「同じ画面の中の移動」かを返す。
   * 段(pane)の切替だけがURLに出る画面では、戻る・進むは離脱ではない。
   * true のとき popstate を止めず・確認も出さず、そのまま通す。
   */
  samePage?: (destination: URL) => boolean
  /** 同じ画面の選び直しを、画面側の確認で扱う Link。通常の離脱には使わない。 */
  handlesLocalLink?: (destination: URL) => boolean
  /**
   * 「保存せずに移る」が確定したあと・実際に移動する直前に呼ぶ。
   * クエリだけ変わる画面内遷移（コンポーネントがアンマウントされない）でも
   * 「変更は消えます」と約束した通り、画面の入力を初期状態へ戻せるようにする。
   */
  onDiscard?: () => void
}) {
  const { dirty, busy = false, samePage, handlesLocalLink, onDiscard, subject = 'ほかの未保存の入力' } = options
  const subjectRef = useRef(subject)
  subjectRef.current = subject
  const router = useRouter()
  const [leaveTarget, setLeaveTarget] = useState<UnsavedLeaveTarget | null>(null)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const busyRef = useRef(busy)
  busyRef.current = busy
  const samePageRef = useRef(samePage)
  samePageRef.current = samePage
  const handlesLocalLinkRef = useRef(handlesLocalLink)
  handlesLocalLinkRef.current = handlesLocalLink
  const onDiscardRef = useRef(onDiscard)
  onDiscardRef.current = onDiscard
  const historyCohortRef = useRef<HistoryGuard[] | null>(null)
  /* 公開成功など「離れてよい」と決まった遷移の直前に立てる解除印。 */
  const disarmedRef = useRef(false)
  const historyGuardRef = useRef<HistoryGuard | null>(null)
  if (!historyGuardRef.current) historyGuardRef.current = {
    active: () => (dirtyRef.current || busyRef.current) && !disarmedRef.current,
    busy: () => busyRef.current,
    subject: () => subjectRef.current,
    handles: destination => !samePageRef.current?.(destination),
    handlesLink: (destination, current, anchor) => !(destination.pathname === current.pathname && anchor.hasAttribute('data-row-local-open') && handlesLocalLinkRef.current?.(destination)),
    discard: () => onDiscardRef.current?.(),
    disarm: () => { disarmedRef.current = true },
    askHistoryLeave: (to, cohort, destination) => {
      historyCohortRef.current = cohort
      // 保存中の入力があれば、元の位置へ戻すだけで確認はまだ出さない。
      if (cohort.some(entry => entry.busy())) return
      selectUnsavedCohort(historyGuardRef.current, cohort, entry => entry.handles(destination))
      setLeaveTarget({ kind: 'history-back', to })
    },
  }
  useEffect(() => {
    const entry = historyGuardRef.current!
    retainHistoryInterception()
    historyGuards.add(entry)
    return () => {
      historyGuards.delete(entry)
      clearUnsavedCohort(entry)
      forgetLeave(entry)
      releaseHistoryInterception()
    }
  }, [])

  /*
   * ブラウザ再読込・タブ終了だけは画面内のDialogを出せないので、標準の確認を
   * dirtyな間だけ登録する。保存成功・account切替・unmountではeffect cleanupで外れる。
   */
  useEffect(() => {
    if (!dirty && !busy) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (disarmedRef.current || (!dirtyRef.current && !busyRef.current)) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty, busy])

  /*
   * 左メニュー等のLinkも含めて、同一タブの画面内遷移を捕まえる。
   * browser backはブラウザ側が先に履歴を動かすため対象外にし、ここでは
   * 「クリックして別の管理画面へ行く」導線だけを安全に止める。
   */
  useEffect(() => {
    if (!dirty && !busy) return
    const onDocumentClick = (event: MouseEvent) => {
      if (disarmedRef.current) return
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const target = event.target as { closest?: (selector: string) => Element | null } | null
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return
      const rawDestination = new URL(anchor.href, window.location.href)
      const rawCurrent = new URL(window.location.href)
      if (rawDestination.origin !== rawCurrent.origin) return
      const destination = canonicalLocalUrl(rawDestination)
      const current = canonicalLocalUrl(rawCurrent)
      if (destination.href === current.href) return
      // 選び直しの確認を持つ画面は、名前 Link の同一タブ操作をその確認へ渡す。
      if (destination.pathname === current.pathname && anchor.hasAttribute('data-row-local-open') && handlesLocalLinkRef.current?.(destination)) return
      // パスとクエリが同じで hash だけが変わる移動は画面内の見出しジャンプ。
      // 画面を離れないので確認を出さない（離すと「#見出し」リンクが全部確認になる）。
      if (destination.pathname === current.pathname && destination.search === current.search) return
      event.preventDefault()
      const cohort = [...historyGuards].filter(entry => entry.active() && entry.handlesLink(destination, current, anchor))
      historyCohortRef.current = cohort
      if (!cohort.some(entry => entry.busy())) {
        selectUnsavedCohort(historyGuardRef.current, cohort, entry => entry.handlesLink(destination, current, anchor))
        setLeaveTarget({ kind: 'link', href: `${destination.pathname}${destination.search}${destination.hash}` })
      }
    }
    document.addEventListener('click', onDocumentClick, true)
    return () => document.removeEventListener('click', onDocumentClick, true)
  }, [dirty, busy])

  /*
   * 戻る・進むは、全部の番兵で1つの受け口（onHistoryTraverse）が Next のルーターより先に受け、止める時だけ
   * この番兵の askHistoryLeave で確認を出す。入力がきれいになったら解除の印と、決めていた移動の予約を外す。
   * pane の切替だけが変わる同じ画面の中の戻る・進むは、samePage（handles）で止めない。
   */
  useEffect(() => {
    if (dirty || busy) return
    disarmedRef.current = false
    forgetLeave(historyGuardRef.current!)
  }, [dirty, busy])

  useEffect(() => {
    if (!dirty && !busy) return
    const request = (event: Event) => {
      if (event.defaultPrevented || disarmedRef.current) return
      event.preventDefault()
      const run = (event as CustomEvent<{ run: () => void }>).detail.run
      const cohort = [...historyGuards].filter(entry => entry.active())
      historyCohortRef.current = cohort
      if (!cohort.some(entry => entry.busy())) {
        selectUnsavedCohort(historyGuardRef.current, cohort, () => true)
        setLeaveTarget({ kind: 'action', run })
      }
    }
    window.addEventListener(UNSAVED_ACTION_EVENT, request)
    return () => window.removeEventListener(UNSAVED_ACTION_EVENT, request)
  }, [dirty, busy])

  /**
   * 確認で「保存せずに移る」が選ばれたとき、予定していた移動を実行する。
   *
   * `onDiscard` は移動の直前に呼ぶ。「変更は消えます」と約束したあと、
   * クエリだけ変わる画面内遷移（コンポーネントがアンマウントされない）でも
   * 画面の入力を初期状態へ戻せるようにするため。
   */
  const confirmLeave = useCallback(() => {
    if (!leaveTarget) return
    const own = historyGuardRef.current
    const cohort = historyCohortRef.current
    if (leaveTarget.kind === 'history-back' && !cohort) { disarmedRef.current = false; return }
    // 確認後に別の入力が増えた場合は、黙って破棄せず確認を更新する。
    if (cohort && selectedUnsavedGuards().some(entry => entry !== own && !cohort.includes(entry))) {
      historyCohortRef.current = selectedUnsavedGuards()
      selectUnsavedCohort(historyGuardRef.current, historyCohortRef.current)
      setLeaveTarget({ ...leaveTarget })
      return
    }
    // 自分の保存成功直後は busyRef が古い場合がある。他の入力の保存中は待つ。
    if (busy || cohort?.some(entry => entry !== own && historyGuards.has(entry) && entry.active() && entry.busy())) {
      disarmedRef.current = false
      setLeaveTarget(leaveTarget)
      return
    }
    setLeaveTarget(null)
    clearUnsavedCohort()
    if (leaveTarget.kind === 'history-back') {
      for (const entry of historyCohortRef.current ?? []) {
        if (!historyGuards.has(entry) || (entry !== own && !entry.active())) continue
        if (entry !== own) entry.disarm()
        entry.discard()
      }
      historyCohortRef.current = null
      leaveThroughHistory(own!, leaveTarget.to ?? null)
      return
    }
    if (cohort) {
      for (const entry of cohort) {
        if (!historyGuards.has(entry) || (entry !== own && !entry.active())) continue
        if (entry !== own) entry.disarm()
        entry.discard()
      }
      historyCohortRef.current = null
    } else onDiscardRef.current?.()
    if (leaveTarget.kind === 'action') {
      /*
       * 保留していた操作（一覧へ戻るボタン等の router.push）を再実行する。
       * 実行前に腕を下ろしておかないと、操作の中の遷移が再度止まる。
       */
      disarmedRef.current = true
      leaveTarget.run()
      return
    }
    router.push(leaveTarget.href)
  }, [leaveTarget, busy, router])

  const cancelLeave = useCallback(() => { historyCohortRef.current = null; clearUnsavedCohort(); setLeaveTarget(null) }, [])

  /*
   * リンクではない離れる操作（`<button onClick>` からの router.push や、
   * 画面内で閉じる操作）にも同じ確認を挟む入口。dirty でなければ操作を
   * そのまま実行し、dirty なら操作を保留して確認対話を出す。
   */
  const guarded = useCallback((action: () => void) => {
    if (busy) return
    if (disarmedRef.current || !dirtyRef.current) {
      action()
      return
    }
    if (!busy) { historyCohortRef.current = null; clearUnsavedCohort(); setLeaveTarget({ kind: 'action', run: action }) }
  }, [busy])

  /*
   * 公開成功のあとの画面遷移のように「未保存でも警告せず離れてよい」と
   * 決まった遷移の直前に呼ぶ。beforeunload・戻る・画面内リンクのどれも
   * もう止めない。画面に留まって dirty が降りたら自動で腕を戻す。
   */
  const disarm = useCallback(() => {
    clearUnsavedCohort(historyGuardRef.current)
    disarmedRef.current = true
    setLeaveTarget(null)
  }, [])

  return { leaveTarget, confirmLeave, cancelLeave, disarm, guarded }
}
