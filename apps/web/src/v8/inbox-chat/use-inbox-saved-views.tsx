'use client'
import { type SavedViewDraft } from '@/components/chats/saved-view-dialog';
import { api } from '@/lib/api';
import { clampSearchQuery } from '@/lib/search-query';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InboxSavedView, SAVED_VIEW_URL_KEY, StatusFilter, buildInboxUrl } from './inbox-model';
import { normalizeSavedViewConditions, type InboxSavedViewConditions } from './saved-view-types';

export const SAVED_VIEWS_LOAD_ERROR = '保存した検索を読み込めませんでした'

type Options = {
  operators: { id: string; name: string; }[]
  setNameQuery: Dispatch<SetStateAction<string>>
  setStatusFilter: Dispatch<SetStateAction<StatusFilter>>
  setAssigneeFilter: Dispatch<SetStateAction<string>>
  setQuickFilter: Dispatch<SetStateAction<"all" | "reply" | "overdue">>
  setUnreadOnly: Dispatch<SetStateAction<boolean>>
  params: ReturnType<typeof useSearchParams>
  router: ReturnType<typeof useRouter>
  selectedAccountId: string | null
  savedViewParam: string
  accountsLoading: boolean
  setDebouncedNameQuery: Dispatch<SetStateAction<string>>
  channel: "email" | "all" | "line"
  quickFilter: "all" | "reply" | "overdue"
  nameQuery: string
  statusFilter: StatusFilter
  assigneeFilter: string
  unreadOnly: boolean
}

export function useInboxSavedViews({ operators, setNameQuery, setStatusFilter, setAssigneeFilter, setQuickFilter, setUnreadOnly, params, router, selectedAccountId, savedViewParam, accountsLoading, setDebouncedNameQuery, channel, quickFilter, nameQuery, statusFilter, assigneeFilter, unreadOnly }: Options) {

  const [saveDialogOpen, setSaveDialogOpen] = useState(false)

  const [savedViews, setSavedViews] = useState<InboxSavedView[]>([])

  const [savedViewsOpen, setSavedViewsOpen] = useState(false)

  const [savedViewMenuId, setSavedViewMenuId] = useState<string | null>(null)

  const [savedViewName, setSavedViewName] = useState('')

  const [savedViewError, setSavedViewError] = useState('')
  const [failedAccountId, setFailedAccountId] = useState<string | null>(null)
  const loadError = selectedAccountId && failedAccountId === selectedAccountId ? SAVED_VIEWS_LOAD_ERROR : ''

  const [savingView, setSavingView] = useState(false)

  const [savedViewSuccess, setSavedViewSuccess] = useState(false)

  /*
   * savedViews が「どのアカウント分」か。アカウント切替で一覧が
   * 取り直される間、前のアカウントの一覧でURLのIDを誤適用しない(N-021)。
   */
  const [savedViewsAccountId, setSavedViewsAccountId] = useState<string | null>(null)

  // URLの保存検索IDが見つからなかったときの案内。適用せず既定条件へ戻したことを伝える。
  const [savedViewNotice, setSavedViewNotice] = useState('')

  /*
    保存した検索の要約で、担当者IDを名前にするための対応表。
    **引けないときは名前を作らない**——`savedViewSummary` が人数で言う。
  */
  const operatorNames = useMemo(
    () => new Map(operators.map((operator) => [operator.id, operator.name])),
    [operators],
  )

  // 保存検索一覧の取得がどのアカウントに向けたものか。切替中に遅れて届いた
  // 旧アカウントの応答で、新しいアカウントの一覧を上書きしない(N-021)。
  const savedViewsRequestAccountRef = useRef<string | null>(null)
  const savedViewsRequestSeq = useRef(0)
  const selectedAccountRef = useRef(selectedAccountId)
  selectedAccountRef.current = selectedAccountId
  useEffect(() => () => { savedViewsRequestSeq.current += 1 }, [])

  /*
   * 処理済みのURL savedView値。router.replace の反映より描画が先に走る
   * 隙間に、復元効果が同じIDをもう一度適用して手動の条件変更を
   * 上書きするのを防ぐ(N-021)。
   */
  const savedViewConsumedRef = useRef<string | null>(null)

  /*
    保存検索の条件を画面の絞り込みへ写す。戻り値は条件が指す channel。
    ドロップダウンからの適用と、URLからの復元の両方が同じ手順を使う(N-021)。

    **形を確かめてから読む。** 受信箱より前に作られた行は
    `{ all: [], any: [] }` の形で入っていて、`conditions.statuses.length` を
    そのまま読むと受信箱ごと真っ白になる。
  */
  const applySavedViewConditions = useCallback((view: InboxSavedView): 'all' | 'line' | 'email' => {
    const conditions = normalizeSavedViewConditions(view.conditions)
    setNameQuery(clampSearchQuery(conditions.query ?? ''))
    setStatusFilter(conditions.statuses.length === 1 ? conditions.statuses[0] : 'all')
    setAssigneeFilter(conditions.assignees.length === 1 ? conditions.assignees[0] : 'all')
    /*
      N-020: 保存時の絞り込みをそのまま戻す。以前は due だけを見て
      「要返信」が「すべて」へ潰れ、未読だけ表示も落ちていた。
      古い行の quickFilter は normalizeSavedViewConditions が due から復元済み。
    */
    setQuickFilter(conditions.quickFilter)
    setUnreadOnly(conditions.unread === 'mine')
    return conditions.channels.length === 1 ? conditions.channels[0] : 'all'
  }, [setAssigneeFilter, setNameQuery, setQuickFilter, setStatusFilter, setUnreadOnly])

  /*
    手で条件を変えたら、URLの savedView は現在の条件を指さなくなる。
    残すと再読込・URL共有で古い条件が復活するので外す(N-021)。
    channel・friend・thread など他の指定はそのまま残す。
  */
  const dropSavedViewParam = useCallback(() => {
    const current = params.get(SAVED_VIEW_URL_KEY)
    if (!current) return
    // URLの更新が届くまでの間に復元効果が同じIDを再適用しないよう、
    // 外す時点で処理済みにする(N-021)。
    savedViewConsumedRef.current = current
    const next = new URLSearchParams(params.toString())
    next.delete(SAVED_VIEW_URL_KEY)
    const text = next.toString()
    router.replace(text ? `/chats?${text}` : '/chats')
  }, [params, router])

  const loadSavedViews = useCallback(async () => {
    const accountId = selectedAccountId
    const seq = ++savedViewsRequestSeq.current
    // 切替や再読み込み後の古い応答では、新しい一覧を上書きしない。
    savedViewsRequestAccountRef.current = accountId
    const current = () => savedViewsRequestSeq.current === seq && savedViewsRequestAccountRef.current === accountId && selectedAccountRef.current === accountId
    if (!accountId) {
      setSavedViews([])
      setSavedViewsAccountId(null)
      return
    }
    try {
      const response = await api.chats.savedViews.list(accountId)
      if (!current()) return
      if (!response.success) throw new Error('saved_views_load_failed')
      if (response.success) {
        setSavedViews(response.data.map((view) => ({
          ...view,
          conditions: normalizeSavedViewConditions(view.conditions),
        })))
        setSavedViewsAccountId(accountId)
        setFailedAccountId(null)
      }
    } catch {
      if (!current()) return
      setFailedAccountId(accountId)
    }
  }, [selectedAccountId])

  useEffect(() => {
    void loadSavedViews()
  }, [loadSavedViews])

  /*
    URLの `savedView=<id>` を、いま選んでいるアカウントの保存検索へ照合して復元する(N-021)。

    - 一覧はアカウントごとに取り直す。現在のアカウント分が届くまでは
      何もしない。届く前に前のアカウントの一覧で探すと、別アカウントの
      IDを誤って適用する。
    - IDが見つからない（削除済み・別アカウント・不正）ときは適用せず、
      既定条件へ戻して案内し、URLからも外す。残すと再読込のたびに
      同じ案内が出る。
    - 見つかったときは条件を写す。保存された channel が今と違えば
      URL側をそろえる（channel はURLが正本）。
    - 手で条件を変えたときは dropSavedViewParam が先にIDを外すので、
      ここで古い条件が再上書きされることはない。
  */
  useEffect(() => {
    if (!savedViewParam) {
      // URLから外れたら処理済み印も戻す。同じ検索を選び直せるようにする。
      savedViewConsumedRef.current = null
      return
    }
    // 同じ値は一度だけ処理する。手動変更で外した直後の再適用を防ぐ。
    if (savedViewConsumedRef.current === savedViewParam) return
    if (accountsLoading) return
    if (selectedAccountId && savedViewsAccountId !== selectedAccountId) return
    savedViewConsumedRef.current = savedViewParam
    const view = savedViews.find((item) => item.id === savedViewParam)
    if (!view) {
      setNameQuery('')
      setDebouncedNameQuery('')
      setStatusFilter('all')
      setQuickFilter('all')
      setAssigneeFilter('all')
      setUnreadOnly(false)
      setSavedViewNotice('URLの保存した検索は見つかりませんでした。削除されたか、別のLINEアカウントの検索の可能性があります。既定の条件で表示しています。')
      dropSavedViewParam()
      return
    }
    const nextChannel = applySavedViewConditions(view)
    setSavedViewNotice('')
    if (nextChannel !== channel) {
      const next = new URLSearchParams(params.toString())
      if (nextChannel === 'all') next.delete('channel')
      else next.set('channel', nextChannel)
      const text = next.toString()
      router.replace(text ? `/chats?${text}` : '/chats')
    }
  }, [savedViewParam, savedViews, savedViewsAccountId, selectedAccountId, accountsLoading, channel, params, router, applySavedViewConditions, dropSavedViewParam, setNameQuery, setDebouncedNameQuery, setStatusFilter, setQuickFilter, setAssigneeFilter, setUnreadOnly])

  const currentSavedViewConditions = (draft?: Omit<SavedViewDraft, 'name' | 'favorite'>): InboxSavedViewConditions => {
    /*
      N-020: 「未読だけ表示」とクイック絞り込み（要返信／期限超過）も保存する。
      quickFilter の overdue は旧軸 due にも写して、古いWorkerの件数計算が
      同じ条件で数えられるようにする。
    */
    const savedQuickFilter = draft?.quickFilter ?? quickFilter
    return {
      version: 1,
      // #625: 保存する検索語も画面と同じ上限へそろえる。
      query: clampSearchQuery(nameQuery.trim()),
      channels: (draft?.channel ?? channel) === 'all'
        ? ['line', 'email']
        : [(draft?.channel ?? channel) as 'line' | 'email'],
      statuses: (draft?.status ?? statusFilter) === 'all'
        ? ['unread', 'in_progress', 'on_hold', 'resolved']
        : [(draft?.status ?? statusFilter) as Exclude<StatusFilter, 'all'>],
      assignees: (draft?.assignee ?? assigneeFilter) === 'all' ? [] : [draft?.assignee ?? assigneeFilter],
      unread: (draft?.unreadOnly ?? unreadOnly) ? 'mine' : 'all',
      quickFilter: savedQuickFilter,
      messageTypes: [],
      receivedFrom: null,
      receivedTo: null,
      sort: 'newest',
      due: savedQuickFilter === 'overdue' ? 'overdue' : 'all',
    }
  }

  const applySavedView = (view: InboxSavedView) => {
    const nextChannel = applySavedViewConditions(view)
    setSavedViewNotice('')
    // savedView=<id> をURLへ残す。残さないと再読込・共有で条件が消える(N-021)。
    savedViewConsumedRef.current = view.id
    router.push(buildInboxUrl(nextChannel, view.id))
    setSavedViewsOpen(false)
  }
  return { saveDialogOpen, setSaveDialogOpen, savedViews, savedViewsOpen, setSavedViewsOpen, savedViewMenuId, setSavedViewMenuId, setSavedViewName, savedViewError: savedViewError || loadError, setSavedViewError, savingView, savedViewSuccess, setSavedViewSuccess, savedViewNotice, operatorNames, dropSavedViewParam, loadSavedViews, currentSavedViewConditions, savedViewName, setSavingView, applySavedView }
}
