'use client'

import { scrollMotion } from '@/components/shared/overlay-utils'
import EntitySelect from '@/components/shared/entity-select'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import { api, ApiError, fetchApi, type AccountEmailAttachment } from '@/lib/api'
import { lockUnless } from '@/components/shared/permission-lock'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { InboxInputBox } from '@/components/shared/inbox-composer'
import { IdempotencyKeyStore } from '@/lib/idempotency-key-store'
import { createPollGeneration, startVisiblePoll, type VisiblePollHandle } from '@/lib/visible-polling'
import TemplatePicker from '@/components/chats/template-picker'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import Select from '@/components/shared/select'

import { ConversationHead } from '@/v8/inbox-chat/public/conversation-head/index'
import { formatDateTime } from '@/lib/format'
import Button from '@/components/shared/button'
import { TextArea as SharedTextArea } from '@/components/shared/text-field'

/**
 * メールの往復。受信箱（/chats）の中央ペインで使う。
 *
 * 以前はメール専用の画面の中にしか無かったので、一覧からメールを選ぶと
 * いったんメール画面へ移動する必要があった。LINEのトークは同じ画面で
 * 開けるのに、メールだけ移動が要るのは扱いが揃っていない。
 *
 * 部品にして、LINEのトークと同じ場所に出せるようにした。
 */

type ThreadStatus = 'unread' | 'in_progress' | 'on_hold' | 'resolved'

type EmailMessage = {
  id: string
  direction: 'incoming' | 'outgoing'
  body_text: string
  sent_by_staff_name: string | null
  created_at: string
  attachments?: AccountEmailAttachment[]
}

type EmailDetail = {
  thread: {
    id: string
    subject: string
    customer_name: string | null
    customer_email: string
    status: ThreadStatus
    assigned_staff_id: string | null
    notes: string | null
    revision: number
  }
  messages: EmailMessage[]
  /*
    PERF-11: 初回は新しい側の100件だけ。古い方は before= で、
    新着は after= で差分取得する。古いWorkerはこれらを返さないので
    無ければ「全部ある」として扱う。
  */
  hasMoreOlder?: boolean
  oldestCursor?: string | null
  newestCursor?: string | null
}

/*
 * PERF-11: 差分・過去分を既存の並びへ混ぜる。id で重複を除き、
 * created_at 昇順（同時刻は id 順、Worker の並びと同じ）に保つ。
 * 同じ応答が二度届いても重ねて出さず、順序が逆転しない。
 */
function mergeMessages(current: EmailMessage[], incoming: EmailMessage[]): EmailMessage[] {
  if (incoming.length === 0) return current
  const seen = new Set(current.map((m) => m.id))
  const fresh = incoming.filter((m) => !seen.has(m.id))
  if (fresh.length === 0) return current
  const merged = [...current, ...fresh]
  merged.sort((a, b) =>
    a.created_at === b.created_at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      : a.created_at < b.created_at ? -1 : 1)
  return merged
}

function dateTime(iso: string): string {
  return formatDateTime(iso)
}

export function EmailThreadBackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="text-ink-faint hover:text-ink-secondary -ml-1 flex-shrink-0 p-1 lg:hidden"
      aria-label="戻る"
    >
      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M15 19l-7-7 7-7" />
      </svg>
    </button>
  )
}

function EmailThreadHeader({ children }: { children: React.ReactNode }) {
  return (
    /*
     * U008/U010: 狭い幅では宛先を1行目いっぱいに取り、対応・担当・
     * 顧客情報は2行目へ折り返す。1行に固定すると 320/390px で件名や
     * 右の操作が潰れて、誰へ返すのか読めなかった。LINE のトークと同じ組み方。
     */
    <div className="flex min-h-[66px] flex-wrap items-center justify-between gap-x-2 gap-y-2 border-b border-hairline bg-canvas px-4 py-3">
      {children}
    </div>
  )
}

export default function EmailThread({
  threadId,
  storeAccountId = null,
  sourceLabel,
  replyLockedReason,
  draftStore,
  readOnly = false,
  onBack,
  onChanged,
  customerInfoOpen = false,
  onOpenCustomerInfo,
  onCloseCustomerInfo,
}: {
  threadId: string
  /** 店舗のメールの LINE アカウント。渡すと会話・対応状況・添付を店舗の口で読み書きする。共通は null。 */
  storeAccountId?: string | null
  /** 届いた経路の呼び名（共通／店舗）。会話の頭の補足に出す。 */
  sourceLabel?: string
  /**
   * 返信を送れない理由。渡すと返信欄と［メールで返信］を隠さず灰色にし、乗せた時・焦点を当てた時に
   * 吹き出しで出す（店舗のメールは送信の手段と差出人を確かめるまで受信専用）。
   */
  replyLockedReason?: string
  /**
   * 会話ごとの下書きの預かり先。渡すと、この部品を作り直しても（店舗の会話や LINE を見てから戻っても）
   * 下書きが残る。渡さなければ部品の中だけで預かる。
   */
  draftStore?: Map<string, string>
  /** 閲覧のみ。担当・対応状況・返信・メモは隠さず灰色＋理由にする。 */
  readOnly?: boolean
  /** スマホでメール一覧へ戻る。LINEのトークと同じ位置に出す。 */
  onBack: () => void
  /** 状態や返信で一覧の中身が変わったときに知らせる。 */
  onChanged?: () => void
  customerInfoOpen?: boolean
  onOpenCustomerInfo?: () => void
  /** ★V8：会話の頭の「右の列の出し入れ」で閉じる口。 */
  onCloseCustomerInfo?: () => void
}) {

  const [detail, setDetail] = useState<EmailDetail | null>(null)
  const [reply, setReply] = useState('')
  /*
    F06: 下書きは会話ごとに保管する。Aへの送信応答を待つ間にBへ移って
    入力しても、Aの成功応答がBの文面を消さない。A→B→Aの往復でも
    それぞれの下書きが戻る。消すのは「送った会話の、送った版」だけ。
  */
  const draftsRef = useRef(draftStore ?? new Map<string, string>())
  const writeDraft = useCallback((thread: string, value: string) => {
    if (value) draftsRef.current.set(thread, value)
    else draftsRef.current.delete(thread)
  }, [])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  /** 初回の読み込みが失敗した理由。再試行の口と一緒に出す(INBOX-28)。 */
  const [loadError, setLoadError] = useState('')
  // INBOX-24: IME変換中・変換確定のEnterは送信キーにしない。
  const isComposingRef = useRef(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const sendKeysRef = useRef(new IdempotencyKeyStore())

  // 以下は LINE のトークに揃えるためのもの（設計 `TalkPane` / `Reply`）。
  const [operators, setOperators] = useState<Array<{ id: string; name: string }>>([])
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const [showComposerOptions, setShowComposerOptions] = useState(false)
  const [showMemoEditor, setShowMemoEditor] = useState(false)
  const [memoDraft, setMemoDraft] = useState('')
  const [memoSaving, setMemoSaving] = useState(false)
  const [memoError, setMemoError] = useState('')
  /** 送信キー。LINE 側と同じ設定を読む。別々にすると片方だけ効かない。 */
  const [sendMode, setSendMode] = useState<'enter' | 'shift-enter'>('shift-enter')
  // U008: 狭い幅で切れた件名を、その場で全文に広げるための状態。
  const [headerSubjectExpanded, setHeaderSubjectExpanded] = useState(false)

  useEffect(() => {
    try {
      const saved = localStorage.getItem('chat.sendMode')
      if (saved === 'enter' || saved === 'shift-enter') setSendMode(saved)
    } catch {
      /* 保存できない設定のブラウザは既定のまま */
    }
  }, [])

  useEffect(() => {
    // 店舗のメールは担当を持たない。閲覧のみの人にも今の担当の名前を出すため、共通では読む。
    if (storeAccountId) return
    let cancelled = false
    void fetchApi<{ success: boolean; data: Array<{ id: string; name: string }> }>(
      '/api/operators?channel=email',
    )
      .then(res => {
        // 担当を選べないだけ。返信そのものは続けられる。
        if (!cancelled && res.success) setOperators(res.data)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [storeAccountId])

  // 世代で古い応答を捨てる。threadIdが変わった後の遅い応答が
  // 新しい会話を上書きしない(順序逆転防止、#630)。
  const genRef = useRef(createPollGeneration())
  const latestThreadRef = useRef(threadId)
  latestThreadRef.current = threadId
  // PERF-11: 差分取得の起点（newestCursor）と過去側カーソルを
  // effect の外からも読めるよう、今出ている会話を ref で持つ。
  const detailRef = useRef<EmailDetail | null>(null)
  detailRef.current = detail
  const listRef = useRef<HTMLDivElement>(null)
  const [olderLoading, setOlderLoading] = useState(false)

  /*
    F06: 入力欄の正本は draftsRef。setReply を直接使うと、どの会話の
    下書きか記録が残らず、会話の切替・送信完了で他の会話の文面まで
    消えてしまう。画面表示（reply）と保管（draftsRef）を一緒に動かす。
  */
  const setReplyDraft = useCallback((value: string | ((prev: string) => string)) => {
    setReply((prev) => {
      const next = typeof value === 'function' ? value(prev) : value
      writeDraft(latestThreadRef.current, next)
      return next
    })
  }, [writeDraft])

  /*
   * INBOX-28: 読み込み失敗の理由を分けて伝える。
   * 404は会話自体が無い、403は権限、それ以外は回線やサーバー。
   * 空の会話と失敗を混同しない。
   */
  const describeLoadFailure = (cause: unknown): string => {
    if (cause instanceof ApiError) {
      if (cause.status === 404) return 'このメールの会話は見つかりませんでした'
      if (cause.status === 403) return 'このメールの会話を見る権限がありません'
      if (cause.status === 401) return 'ログインの期限が切れています。再ログインしてください'
    }
    return 'メールの会話を読み込めませんでした。接続を確認して再試行してください'
  }

  // 静かな取り直しは成否を返す。失敗の数え直し・待ちの延長は startVisiblePoll が持つ。
  // 古い取得の応答は捨て、失敗にも数えない(新しい取得が届ける)。
  const load = useCallback(
    async (quiet = false): Promise<boolean> => {
      const myThread = threadId
      const mySeq = genRef.current.next()
      const isStale = () =>
        genRef.current.isStale(mySeq) || myThread !== latestThreadRef.current
      /*
        PERF-11: すでに会話を持っているときは after= の差分だけ取る。
        毎回全件・全履歴を取り直していたため、長い会話では5秒ごとに
        全部の本文が流れていた。古いWorkerはカーソルを返さないので、
        その場合は従来どおり全体を取る。
      */
      const current = detailRef.current
      const after = current && current.thread.id === myThread ? (current.newestCursor ?? null) : null
      const query = after ? `?after=${encodeURIComponent(after)}` : ''
      try {
        const res = storeAccountId
          ? await api.accountEmail.thread(storeAccountId, threadId, { after })
          : await fetchApi<{ success: boolean; data: EmailDetail }>(`/api/support/email/threads/${encodeURIComponent(threadId)}${query}`)
        if (isStale()) return true
        if (res.success) {
          const data = res.data
          setDetail((prev) => {
            // 差分応答を別の会話へは混ぜない。初回はそのまま採用する。
            if (!prev || prev.thread.id !== data.thread.id) return data
            return {
              ...data,
              messages: mergeMessages(prev.messages, data.messages),
              // 読み込み済みの古い履歴側の位置は after 応答では変わらない。
              hasMoreOlder: prev.hasMoreOlder ?? data.hasMoreOlder,
              oldestCursor: prev.oldestCursor ?? data.oldestCursor,
              // 差分が空の応答は cursor を持たない。消すと次回が全件へ戻る。
              newestCursor: data.newestCursor ?? prev.newestCursor,
            }
          })
          setLoadError('')
          if (!quiet) {
            window.setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: scrollMotion() }), 50)
          }
          return true
        }
        if (!quiet) setLoadError('メールの会話を読み込めませんでした。接続を確認して再試行してください')
        return false
      } catch (loadErrorCause) {
        if (isStale()) return true
        if (!quiet) setLoadError(describeLoadFailure(loadErrorCause))
        return false
      }
    },
    [threadId, storeAccountId],
  )

  // 相手からの返信が届いたら出したい。未解決の間だけ5秒起点の1本で
  // 取り直す。非表示では止め、連続失敗は待ちを延ばして
  // 上限後は再試行を出す。対応済みになったら止める(#630)。
  const [threadStalled, setThreadStalled] = useState(false)
  const [threadRetryKey, setThreadRetryKey] = useState(0)
  /**
   * いま出ている会話の状態を「どのスレッドのものか」と一緒に持つ(#630)。
   *
   * 状態だけを持つと、対応済みAから未対応Bへ切り替えた直後の描画で
   * まだAの `detail` が残っているため、Bのループが「対応済みだから
   * 休む」と判断して1度も取りに行かず、会話が読み込み中のまま止まる。
   * effect の `setDetail(null)` が効くのは次の描画で、判断はそれより先。
   */
  const threadStatusRef = useRef<{ threadId: string; status: ThreadStatus } | null>(null)
  threadStatusRef.current = detail ? { threadId: detail.thread.id, status: detail.thread.status } : null
  /** 表示中のスレッドの状態。別スレッドのものは見ない。 */
  const currentThreadStatus = (): ThreadStatus | undefined => {
    const seen = threadStatusRef.current
    return seen && seen.threadId === latestThreadRef.current ? seen.status : undefined
  }
  // 対応済みで休んだあと再オープンされたら起こす。effectを作り直すと
  // `setDetail(null)` で会話が消えて読み込み中に戻るので、同じ1本を起こす。
  const pollRef = useRef<VisiblePollHandle | null>(null)
  useEffect(() => {
    setDetail(null)
    // F06: 別会話へ移るときは空にするのではなく、その会話の下書きを戻す。
    setReply(draftsRef.current.get(threadId) ?? '')
    setThreadStalled(false)
    setLoadError('')
    /*
     * INBOX-25: 別スレッドへ切り替わったら、前のスレッドのメモ編集を
     * 閉じて保存中の印も下ろす。保存の応答が遅れて届いても、
     * 新しいスレッドの画面へ書き込ませない。
     */
    setShowMemoEditor(false)
    setMemoSaving(false)
    setMemoError('')
    setHeaderSubjectExpanded(false)
    // 初回も同じ1本に載せる。初回だけ外に別走させると
    // 初回と5秒後の取得が重複する。初回だけ表示あり、2回目から静かに。
    let first = true
    const poll = startVisiblePoll({
      immediate: true,
      shouldPoll: () => currentThreadStatus() !== 'resolved',
      work: async () => {
        const loud = first
        first = false
        const ok = await load(!loud)
        if (!ok) throw new Error('メールの会話を読み込めませんでした')
      },
      onGiveUp: () => setThreadStalled(true),
      onRecovered: () => setThreadStalled(false),
    })
    pollRef.current = poll
    return () => {
      if (pollRef.current === poll) pollRef.current = null
      poll.stop()
    }
    // currentThreadStatus は ref を読むだけなので deps に入れない。
    // 入れると会話を取り直すたびにループを作り直してしまう。
  }, [load, threadRetryKey])

  // 再オープン(対応済み→未対応など)で止まっていたループを起こす。
  useEffect(() => {
    if (detail && detail.thread.id === threadId && detail.thread.status !== 'resolved') {
      pollRef.current?.wake()
    }
  }, [detail, threadId])

  /**
   * 対応の状態を変える。
   *
   * **ここは動いていなかった。** worker は PATCH でしか受けていないのに
   * POST を投げていて、変えても何も起きないうえ、戻り値を見ていないので
   * 失敗も画面に出なかった。経路を合わせ、失敗を出すようにした。
   */
  const updateStatus = async (status: ThreadStatus) => {
    // 操作を始めたスレッドを固定する。応答を待つ間に別スレッドへ
    // 切り替わっても、その画面へ結果・失敗を書き込まない(A02-01/04)。
    if (readOnly || !detail) return
    const myThread = threadId
    try {
      const res = storeAccountId
        ? await api.accountEmail.updateStatus(storeAccountId, myThread, status, detail.thread.revision)
        : await fetchApi<{ success: boolean; error?: string }>(
        `/api/support/email/threads/${encodeURIComponent(myThread)}/status`,
        { method: 'PATCH', body: JSON.stringify({ status, revision: detail?.thread.revision }) },
      )
      if (latestThreadRef.current !== myThread) return
      if (!res.success) {
        setError(res.error || '状態を変えられませんでした')
        return
      }
      setError('')
      await load(true)
      onChanged?.()
    } catch {
      if (latestThreadRef.current === myThread) setError('状態を変えられませんでした')
    }
  }

  /** 担当を付け替える（LINE のトークと同じ）。 */
  const updateAssignee = async (staffId: string | null) => {
    if (readOnly || storeAccountId) return
    const myThread = threadId
    try {
      const res = await fetchApi<{ success: boolean; error?: string }>(
        `/api/support/email/threads/${encodeURIComponent(myThread)}/assignee`,
        { method: 'PATCH', body: JSON.stringify({ staffId: staffId?.startsWith('staff:') ? staffId.slice(6) : staffId, revision: detail?.thread.revision }) },
      )
      if (latestThreadRef.current !== myThread) return
      if (!res.success) {
        setError(res.error || '担当を変えられませんでした')
        return
      }
      setError('')
      await load(true)
      onChanged?.()
    } catch {
      if (latestThreadRef.current === myThread) setError('担当を変えられませんでした')
    }
  }

  /** 閲覧のみの人の理由。担当・対応状況・メモ・返信を灰色にする。 */
  const viewerLock = readOnly ? lockUnless(false, 'viewer') : undefined
  /** 返信欄の理由。店舗のメールは役割に関わらず受信専用の理由を出す。 */
  const replyLock = replyLockedReason ?? viewerLock

  const sendReply = async () => {
    // 店舗のメールは共通の返信の口へ送らない（受信専用）。
    if (storeAccountId || replyLock || !reply.trim() || sending) return
    /*
      F06+A02-01/04: 送信を始めたスレッドと送った版を固定する。
      応答を待つ間に別の会話へ切り替わっても、その画面の入力欄を
      消したり失敗を出したりしない。消すのは送った会話の送った版だけ。
    */
    const sendingThreadId = threadId
    const sentBody = reply
    const content = sentBody.trim()
    const signature = JSON.stringify({ threadId: sendingThreadId, body: content })
    const idempotencyKey = sendKeysRef.current.get(signature)
    setSending(true)
    setError('')
    try {
      await fetchApi(`/api/support/email/threads/${encodeURIComponent(sendingThreadId)}/reply`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ body: content, revision: detail?.thread.revision }),
      })
      sendKeysRef.current.clear(signature)
      /*
        F06: 消すのは送った会話の送った版だけ。応答待ちの間に同じ会話へ
        追記した新しい版（draftが送った版と違う）は残し、別会話へ
        移っていた場合は表示中の入力欄に触らない(A02-01/04)。
      */
      if (draftsRef.current.get(sendingThreadId) === sentBody) {
        draftsRef.current.delete(sendingThreadId)
        if (latestThreadRef.current === sendingThreadId) setReply('')
      }
      // 同じスレッドを開いているときだけ会話を取り直す。
      if (latestThreadRef.current === sendingThreadId) await load()
      onChanged?.()
    } catch (sendError) {
      if (latestThreadRef.current === sendingThreadId) {
        setError(
          sendError instanceof ApiError && sendError.status === 409
            ? '二重送信を避けるため送信を止めました。会話を読み直し、他担当者の返信と送信履歴を確認してください'
            : '返信を送れませんでした',
        )
      }
    } finally {
      setSending(false)
    }
  }

  /*
   * PERF-11: 過去の履歴を1区画だけ上へ足す。上へ追加すると表示位置が
   * ずれるので、足す前の高さとの差分だけ scrollTop を戻す。
   * 失敗しても今の会話はそのまま残し、ボタンでやり直せる。
   */
  const loadOlder = async () => {
    const myThread = threadId
    const cursor = detailRef.current?.thread.id === myThread ? detailRef.current.oldestCursor : null
    if (!cursor || olderLoading) return
    const scroller = listRef.current
    const heightBefore = scroller?.scrollHeight ?? 0
    setOlderLoading(true)
    try {
      const res = storeAccountId
        ? await api.accountEmail.thread(storeAccountId, myThread, { before: cursor })
        : await fetchApi<{ success: boolean; data: EmailDetail }>(`/api/support/email/threads/${encodeURIComponent(myThread)}?before=${encodeURIComponent(cursor)}`)
      if (latestThreadRef.current !== myThread || !res.success) return
      const data = res.data
      setDetail((prev) => {
        if (!prev || prev.thread.id !== myThread) return prev
        return {
          ...prev,
          messages: mergeMessages(prev.messages, data.messages),
          hasMoreOlder: data.hasMoreOlder,
          oldestCursor: data.oldestCursor,
        }
      })
      requestAnimationFrame(() => {
        const el = listRef.current
        if (el && heightBefore > 0) el.scrollTop += el.scrollHeight - heightBefore
      })
    } catch {
      /* 古い履歴が取れなくても今の会話はそのまま。ボタンは残る。 */
    } finally {
      setOlderLoading(false)
    }
  }

  const openMemoEditor = () => {
    setMemoDraft(detail?.thread.notes ?? '')
    setMemoError('')
    setShowMemoEditor(true)
  }

  const closeMemoEditor = () => {
    if (memoSaving) return
    // 閉じたあとに届く保存結果は画面へ適用しない(INBOX-25)。
    memoSaveGenRef.current += 1
    setMemoDraft(detail?.thread.notes ?? '')
    setMemoError('')
    setShowMemoEditor(false)
  }

  /*
   * INBOX-19: MAILのメモ窓もLINEと同じ約束にする。開いたら窓の中へ
   * フォーカス、Tab は窓の中で回り、Escape で閉じ、閉じたら
   * 「内部メモ」ボタンへフォーカスを戻す。保存中は Escape で閉じない。
   */

  /*
   * INBOX-25/26: メモの保存は「保存を始めたスレッドと版」に結びつける。
   * - 応答を待つ間に閉じたり別スレッドへ切り替わっても、今の画面へ
   *   結果を書き込まない。
   * - 成功したら返ってきた notes と revision をそのまま採用する。
   *   古い版のまま次の保存を送ると409になる(INBOX-26)。
   * - 409(他の人が先に更新)は書いた下書きを消さず、読み直しを促す。
   */
  const memoSaveGenRef = useRef(0)
  const saveMemo = async () => {
    // 店舗のメールにはメモの口が無い。閲覧のみの人も保存しない。
    if (!detail || memoSaving || storeAccountId || readOnly) return
    const myThread = threadId
    const myRevision = detail.thread.revision
    const mySeq = ++memoSaveGenRef.current
    const isStale = () =>
      memoSaveGenRef.current !== mySeq || latestThreadRef.current !== myThread
    setMemoSaving(true)
    setMemoError('')
    try {
      const res = await fetchApi<{ success: boolean; error?: string; data?: { notes: string | null; revision: number } }>(
        `/api/support/email/threads/${encodeURIComponent(threadId)}/notes`,
        { method: 'PATCH', body: JSON.stringify({ notes: memoDraft, revision: myRevision }) },
      )
      if (isStale()) return
      if (!res.success) {
        setMemoError(res.error || '内部メモを保存できませんでした。時間をおいて、もう一度お試しください。')
        return
      }
      setDetail((current) => current && current.thread.id === myThread ? {
        ...current,
        thread: {
          ...current.thread,
          // 返ってきた保存結果を採用する。次の保存はこの版を送る。
          notes: res.data?.notes ?? memoDraft ?? null,
          revision: res.data?.revision ?? myRevision,
        },
      } : current)
      setShowMemoEditor(false)
      onChanged?.()
    } catch (saveError) {
      if (isStale()) return
      if (saveError instanceof ApiError && saveError.status === 409) {
        // 書いた下書きは残す。消すと入れ直しになる。
        setMemoError('他の担当者が先に更新しています。会話を読み直してから保存し直してください。')
      } else {
        setMemoError('内部メモを保存できませんでした。時間をおいて、もう一度お試しください。')
      }
    } finally {
      // 閉じた・切り替わったあとも「保存中」の印は必ず下ろす。
      setMemoSaving(false)
    }
  }

  if (!detail) {
    return (
      <div className="flex h-full flex-col">
        <EmailThreadHeader>
          <div className="flex min-w-0 items-center gap-2">
            <EmailThreadBackButton onBack={onBack} />
            <p className="text-ink truncate text-sm font-medium">お問い合わせ（メール）</p>
          </div>
        </EmailThreadHeader>
        <div className="text-ink-faint flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-sm">
          {/*
            INBOX-28: 初回の読み込み失敗は空白にせず、理由と再試行を出す。
            空の会話とは見せ分ける。再試行はキーボードでも押せる。
          */}
          <p>{loadError || '会話を読み込み中…'}</p>
          {loadError ? (
            <button
              type="button"
              onClick={() => setThreadRetryKey((key) => key + 1)}
              className="text-action font-semibold underline underline-offset-2"
            >
              もう一度読み込む
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <>
      {(
        /*
         * ★V8：LINE の会話と同じ頭（ConversationHead）。名前の下に「メール・件名」。
         * 対応状況・担当は1つだけ選ぶメニュー（四角のチェックは使わない。オーナー指摘）。
         */
        <ConversationHead
          name={detail.thread.customer_name || detail.thread.customer_email}
          sub={`${sourceLabel ?? ''}メール・${detail.thread.subject}`}
          subTitle={`${detail.thread.customer_email}・${sourceLabel ?? ''}メール・${detail.thread.subject}`}
          onBack={onBack}
          operator={storeAccountId ? undefined : {
            value: detail.thread.assigned_staff_id ? `staff:${detail.thread.assigned_staff_id}` : 'unassigned',
            operators,
            onChange: (next) => { void updateAssignee(next === 'unassigned' ? null : next) },
            lockedReason: viewerLock,
          }}
          status={{ value: detail.thread.status, onChange: (next) => void updateStatus(next), lockedReason: viewerLock }}
          panel={onOpenCustomerInfo ? {
            open: customerInfoOpen,
            onToggle: () => (customerInfoOpen ? onCloseCustomerInfo?.() : onOpenCustomerInfo()),
          } : undefined}
        />
      )}

      <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto bg-canvas-sunken p-4">
        {/*
          PERF-11: 初回は新しい側の100件だけ。もっと古い履歴があるときは
          押した分だけ上へ足す。取りこぼしを見せないため hasMoreOlder が
          立っている間はボタンを残す（古いWorkerは旗を返さず全件来る）。
        */}
        {detail.hasMoreOlder ? (
          <div className="flex justify-center">
            <Button variant="secondary" className="rounded-pill px-3 py-1.5 text-xs text-action disabled:opacity-50 h-auto whitespace-normal" type="button" onClick={() => loadOlder()} disabled={olderLoading}>
              {olderLoading ? '読み込み中…' : '過去のメッセージを読み込む'}
            </Button>
          </div>
        ) : null}
        {detail.messages.map((message) => (
          <div key={message.id} className={`flex items-end gap-2 ${message.direction === 'outgoing' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[86%] rounded-card px-4 py-3 shadow-card sm:max-w-[72%] ${
                message.direction === 'outgoing'
                  ? 'rounded-br-mini bg-accent-soft text-ink'
                  : 'rounded-bl-mini bg-canvas text-ink'
              }`}
            >
              <p className="text-sm leading-6 break-words whitespace-pre-wrap">{message.body_text}</p>
              {storeAccountId && message.attachments?.map(file => (
                <Button key={file.id} title={file.filename} variant="text" size="inline" onClick={() => {
                  void api.accountEmail.downloadAttachment(storeAccountId, file.id, file.filename)
                    .catch(() => setError('添付をダウンロードできませんでした。'))
                }}>{file.filename}</Button>
              ))}
              <p className="mt-2 text-right text-nano text-ink-faint">
                {dateTime(message.created_at)}
                {message.direction === 'outgoing' ? '・送信済み' : ''}
              </p>
            </div>
            {message.direction === 'outgoing' && (
              <div className="flex w-12 shrink-0 flex-col items-center">
                <div
                  className="bg-action text-on-action flex h-8 w-8 items-center justify-center rounded-pill text-micro font-bold"
                  title={message.sent_by_staff_name ?? '担当者情報なし'}
                >
                  {(message.sent_by_staff_name ?? '担').charAt(0)}
                </div>
                <span className="text-ink-faint mt-1 w-full truncate text-center text-micro">
                  {message.sent_by_staff_name ?? 'スタッフ'}
                </span>
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div data-inbox-v4="composer" data-reply-locked={replyLock ? '' : undefined} data-reply-unavailable={replyLockedReason ? '' : undefined} className="sticky bottom-0 border-t border-hairline bg-canvas px-4 py-3">
        {/*
          上段。LINE のトークと同じ：テンプレートを選択 ・ 送信の設定 …… 改行のしかた。
          U010: 横に収まらなければ次の行へ折り返す。1行に固定したままだと
          390px で右の操作が画面外へ切れ、短い文言が縦に割れて読めない。
          店舗のメールは受信専用なので、返信のための道具は出さず、返信欄だけを押せない形で置く。
          閲覧のみの人には隠さず灰色＋理由で置く。
        */}
        {replyLockedReason ? null : (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button variant="secondary" className="shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2 text-xs text-action h-auto" type="button" lockedReason={viewerLock} onClick={() => setShowTemplatePicker(true)}>
              ▧ テンプレートを選択
            </Button>
            <Button variant="secondary" className="shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2 text-xs text-action h-auto" type="button" lockedReason={viewerLock} onClick={() => setShowComposerOptions(v => !v)}>
              ⚙ {showComposerOptions ? '送信の設定を閉じる' : '送信の設定'}
            </Button>
            <Button variant="secondary" className="shrink-0 items-center whitespace-nowrap px-3 py-2 text-xs text-ink-secondary h-auto" type="button" lockedReason={viewerLock} onClick={openMemoEditor} aria-expanded={showMemoEditor}>
              内部メモ
            </Button>
          </div>
          <span className="text-ink-faint shrink-0 text-xs">
            {sendMode === 'enter' ? 'Shift + Enter で改行' : 'Enter で改行'}
          </span>
        </div>
        )}

        {showComposerOptions && !replyLock && (
          <div className="bg-canvas-sunken rounded-card mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 p-3 text-xs">
            <span className="text-ink-secondary">送信キー</span>
            <RadioCardGroup legend="送信キー" className="flex flex-wrap gap-2">
              {(
                [
                  { value: 'enter', label: 'Enter で送信' },
                  { value: 'shift-enter', label: 'Shift + Enter で送信' },
                ] as const
              ).map(opt => (
                <RadioCard
                  key={opt.value}
                  name="mail-send-mode"
                  value={opt.value}
                  checked={sendMode === opt.value}
                  onChange={() => {
                    setSendMode(opt.value)
                    // LINE 側と同じ設定を書く。別々にすると片方だけ効かない。
                    try {
                      localStorage.setItem('chat.sendMode', opt.value)
                    } catch {
                      /* 保存できないブラウザはこの画面のあいだだけ効く */
                    }
                  }}
                  title={opt.label}
                />
              ))}
            </RadioCardGroup>
            <span className="text-ink-faint">Ctrl / Command + Enter でも送れます</span>
          </div>
        )}

        <Dialog open={showMemoEditor} title="内部メモ" busy={memoSaving}
          description="担当者だけに表示され、相手には送信されません。"
          onCancel={closeMemoEditor}
          footer={<DialogActions>
            <Button type="button" disabled={memoSaving} onClick={closeMemoEditor}>キャンセル</Button>
            <Button variant="primary" type="button" busy={memoSaving} busyLabel="保存中…" onClick={() => saveMemo()} disabled={memoSaving || memoDraft === (detail.thread.notes ?? '')}>保存する</Button>
          </DialogActions>}>
          <label htmlFor="email-internal-memo" className="text-xs font-semibold text-ink-faint">メモ内容</label>
          <SharedTextArea id="email-internal-memo" value={memoDraft} disabled={memoSaving}
            onChange={(event) => setMemoDraft(event.target.value)} rows={7} autoFocus placeholder="メモを追加"
            className="mt-2 w-full resize-y rounded-control border border-hairline bg-canvas px-3 py-2 text-sm leading-6 outline-none focus:border-accent focus:ring-2 focus:ring-accent/15" />
          {memoError && <p className="text-danger mt-1 text-xs">{memoError}</p>}
        </Dialog>

        {threadStalled && (
          <p className="text-danger mb-2 text-xs">
            会話の更新を一時停止しています（接続できません）。
            <button
              type="button"
              onClick={() => setThreadRetryKey((key) => key + 1)}
              className="font-bold underline"
            >
              再試行する
            </button>
          </p>
        )}
        {error && <p className="text-danger mb-2 text-xs">{error}</p>}
        <InboxInputBox>
          <SharedTextArea
            // 送れない会話（店舗のメール）は値を出さず、欄の中の理由を常に見せる。預かった下書きは消さない。
            value={replyLockedReason ? '' : reply}
            lockedReason={replyLock}
            onChange={(e) => setReplyDraft(e.target.value)}
            onCompositionStart={() => { isComposingRef.current = true }}
            onCompositionEnd={() => { isComposingRef.current = false }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              /*
               * INBOX-24: IME変換中・変換を確定するEnterは送信しない。
               * keyCode 229 は確定キーの押下。これを送信扱いすると
               * 変換の途中の文がそのまま飛ぶ。LINE側と同じ判定。
               */
              if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) return
              if (e.metaKey || e.ctrlKey) {
                e.preventDefault()
                void sendReply()
                return
              }
              // LINE 側と同じ判定。enter は Enter 単体で送信、
              // shift-enter は Shift + Enter で送信。
              const shouldSend = sendMode === 'enter' ? !e.shiftKey : e.shiftKey
              if (shouldSend) {
                e.preventDefault()
                void sendReply()
              }
            }}
            // 店舗のメールは欄の中に送れない理由をそのまま出す（吹き出しにも同じ文）。
            placeholder={replyLockedReason ?? 'メールの返信を入力'}
            aria-label="メールの返信を入力"
            rows={3}
            className="w-full resize-none border-0 px-1 py-1 text-sm outline-none"
          />
          {/*
            U009: 差出人・返信ボタンが同じ行に詰まると 390px でボタンの
            文字が複数行に割れる。行を折り返せるようにし、ボタンは
            縮まず1行で保つ。差出人は長いときだけ省略する。
          */}
          <div className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 ${storeAccountId ? 'justify-end' : 'justify-between'}`}>
            {/* 店舗のメールは差出人がまだ決まっていないので、共通の差出人は出さない。 */}
            {storeAccountId ? null : (
              <span className="text-ink-faint min-w-0 truncate text-xs" title="差出人 contact-shed@nen-petfood.com">
                差出人 contact-shed@nen-petfood.com
              </span>
            )}
            <Button variant="primary" className="shrink-0 whitespace-nowrap px-5 py-2 hover:bg-accent-deep/90 disabled:opacity-50 border-0 h-auto" onClick={() => sendReply()} disabled={!reply.trim() || sending} lockedReason={replyLock} busy={sending} busyLabel="送信中…" widthReserve="idle">
              {'メールで返信'}
            </Button>
          </div>
        </InboxInputBox>
      </div>

      {/* 選ぶと本文が入力欄に入る。送る前に直せる（LINE 側と同じ部品）。 */}
      <TemplatePicker
        channel="email"
        open={showTemplatePicker}
        onClose={() => setShowTemplatePicker(false)}
        onPick={(content) => {
          setReplyDraft((prev) => (prev ? `${prev}\n${content}` : content))
          setShowTemplatePicker(false)
        }}
      />
    </>
  )
}
