'use client'

/*
 * 下書きの自動保存（★V8 の作る・編集画面で共通）。
 *
 * 一斉配信（components/broadcasts/broadcast-form.tsx）と同じ形にそろえる：
 * - 入力が止まってから AUTOSAVE_DELAY_MS（2秒）で、画面が持つ「下書きを保存」を静かに呼ぶ
 * - 保存の帯（下の帯の左）に「下書きを保存しています…」「下書き保存済み・n秒前」を出す
 * - 保存中に追記されたら、終わったあと最新の入力で追って保存する（置き去りにしない）
 * - 離れる確認（番兵の窓）を出している間・手で保存している間は送らない
 * - 失敗したら帯に出し、同じ入力では繰り返し送らない（手の保存・次の入力でやり直す）
 *
 * 画面ごとに違うのは「保存する関数」と「通せる形か（enabled）」だけ。
 * 保存する関数は画面の手の保存と同じ口を使い、知らせ（トースト・赤い帯）だけ出さない。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { formatRelative } from '@/lib/format'
import { emptyValue } from '@/components/shared/empty-value'

/** 一斉配信と同じ間合い。 */
export const AUTOSAVE_DELAY_MS = 2000
/** 「n秒前」の数字を進める間合い（一斉配信と同じ）。 */
const CLOCK_TICK_MS = 10_000

export const AUTOSAVE_WORDS = {
  saving: '下書きを保存しています…',
  unsaved: '下書きはまだ保存していません',
  failed: '下書きを自動保存できませんでした。「下書きを保存」で保存できます',
  saved: (ago: string) => `下書き保存済み・${ago}`,
} as const

/** 保存した時刻から「n秒前」（1分未満）・それより前は「n分前」などを作る。 */
export function savedAgoLabel(savedAt: number, now: number): string {
  if (!Number.isFinite(savedAt) || !Number.isFinite(now)) return emptyValue('unknown')
  const seconds = Math.floor((now - savedAt) / 1000)
  return seconds < 60 ? `${Math.max(0, seconds)}秒前` : formatRelative(savedAt, now)
}

/** 一つ分の状態から帯の文を選ぶ（一斉配信の draftStatusLabel と同じ順）。 */
export function autosaveLabel(state: {
  autosaving: boolean
  failed: boolean
  dirty: boolean
  savedAt: number | null
  now: number
}): string | null {
  if (state.autosaving) return AUTOSAVE_WORDS.saving
  if (state.dirty && state.failed) return AUTOSAVE_WORDS.failed
  if (state.dirty) return AUTOSAVE_WORDS.unsaved
  if (state.savedAt !== null) {
    return Number.isFinite(state.savedAt) && Number.isFinite(state.now)
      ? AUTOSAVE_WORDS.saved(savedAgoLabel(state.savedAt, state.now))
      : '下書き保存済み'
  }
  return null
}

export interface DraftAutosaveOptions {
  /** 保存に送る形の指紋。変わったら数え直す。 */
  fingerprint: string
  /** 最後に保存した形と違うか。 */
  dirty: boolean
  /** 閲覧のみの人は false。送らず、帯にも何も出さない。 */
  active?: boolean
  /**
   * いま送ってよいか。読み込み前・通せない形（名前が空など）・
   * 競合の帯が出ている間は false にする（帯は「まだ保存していません」のまま）。
   */
  enabled: boolean
  /** 一時的に止める（離れる確認の窓・手の保存・公開の最中）。 */
  paused?: boolean
  /** 静かに保存する。保存できたら true（画面の「保存済みの形」も更新しておく）。 */
  save: () => Promise<boolean>
}

export function useDraftAutosave({ fingerprint, dirty, active = true, enabled, paused = false, save }: DraftAutosaveOptions) {
  const [autosaving, setAutosaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [failedFingerprint, setFailedFingerprint] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const runningRef = useRef(false)
  const runSeqRef = useRef(0)
  const activeRef = useRef(active)
  activeRef.current = active
  const saveRef = useRef(save)
  saveRef.current = save
  const fingerprintRef = useRef(fingerprint)
  fingerprintRef.current = fingerprint
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      runSeqRef.current += 1
    }
  }, [])
  useEffect(() => {
    if (!active) runSeqRef.current += 1
  }, [active])

  const run = useCallback(async () => {
    if (runningRef.current || !activeRef.current) return
    const seq = ++runSeqRef.current
    runningRef.current = true
    setAutosaving(true)
    const sent = fingerprintRef.current
    try {
      const ok = await saveRef.current()
      if (!mountedRef.current || seq !== runSeqRef.current || !activeRef.current) return
      if (ok) {
        const at = Date.now()
        setSavedAt(at)
        setNow(at)
        setFailedFingerprint(null)
      } else {
        setFailedFingerprint(sent)
      }
    } catch {
      if (mountedRef.current && seq === runSeqRef.current && activeRef.current) {
        setFailedFingerprint(sent)
      }
    } finally {
      runningRef.current = false
      // 終わると下の effect がもう一度回り、保存中に進んだ入力があれば追って送る。
      if (mountedRef.current) setAutosaving(false)
    }
  }, [])

  useEffect(() => {
    if (!active || !enabled || !dirty || paused || autosaving) return
    // 同じ入力で失敗したものは繰り返さない（打ち直すか、手で保存する）。
    if (fingerprint === failedFingerprint) return
    const timer = setTimeout(() => void run(), AUTOSAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [fingerprint, dirty, active, enabled, paused, autosaving, failedFingerprint, run])

  // 「下書き保存済み・n秒前」の秒数だけ進める。
  useEffect(() => {
    if (savedAt === null) return
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [savedAt])

  /** 手で保存できたときに呼ぶ（帯を「保存済み・0秒前」にし、失敗の印を外す）。 */
  const markSaved = useCallback(() => {
    runSeqRef.current += 1
    const at = Date.now()
    setSavedAt(at)
    setNow(at)
    setFailedFingerprint(null)
  }, [])

  /** 失敗の印だけ外し、同じ入力でもう一度送れるようにする（競合を解いたあとなど）。 */
  const retry = useCallback(() => setFailedFingerprint(null), [])

  const failed = failedFingerprint !== null && failedFingerprint === fingerprint
  return {
    autosaving,
    savedAt,
    failed,
    markSaved,
    retry,
    label: active ? autosaveLabel({ autosaving, failed, dirty, savedAt, now }) : null,
  }
}
