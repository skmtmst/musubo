'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Folder, Template } from '@line-crm/shared'
import { api } from '@/lib/api'
import { readTemplateText } from '@/lib/template-message-text'
import { useAccount } from '@/contexts/account-context'
import type {
  TemplateFolderOption,
  TemplateFolderStatus,
} from './template-folder-select'
import { TemplatePickerView, type TemplatePickCheck, type TemplatePickerSideKey } from '@/v8/inbox-chat/public/template-picker-view/index'

type TemplateLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 今の相手で確かめた結果（送信と同じ解決器）。確かめられなかった時は failed（「問題なし」にしない）。 */
type PickPreview = { status: 'ready'; content: string; unresolved: string[] } | { status: 'failed' }
type PreviewTarget = { id: string; name: string; content: string }
const EMPTY_PREVIEWS: ReadonlyMap<string, PickPreview> = new Map()
const previewKey = (target: PreviewTarget) => `${target.id}\u0000${target.content}`

/**
 * 一覧口が返す使用数。shared の `Template` には無いが、GET /api/templates
 * は usageCount・月間/累計の送信数を返す。「よく使う」はこれで並べる。
 */
type UsageAwareTemplate = Template & {
  usageCount?: number
  monthlySendCount?: number | null
  totalSendCount?: number | null
}

function textTemplates(items: UsageAwareTemplate[]): UsageAwareTemplate[] {
  return items.map(template => ({ ...template, messageContent: readTemplateText(template.messageContent) }))
}

/** 「よく使う」の並べ方。直近の送信数→累計→使用箇所数の順で見る。 */
function usageScore(template: UsageAwareTemplate): number {
  return template.monthlySendCount ?? template.totalSendCount ?? template.usageCount ?? 0
}

/**
 * テンプレートを選ぶ（★V8）。
 *
 * 受信箱の入力欄から開く。選ぶと本文が入力欄に入り、送る前に直せる。
 * 設計の「コピーして編集」はテンプレート管理側の操作なので、ここには置かない。
 *
 * 文字だけのテンプレートを選ばせる。画像やカルーセルは、そのまま入力欄に
 * 入れても文字として送られてしまうので、選べないようにしてある。
 */

export default function TemplatePicker({
  open,
  onClose,
  onPick,
  onPickPack,
  chatId,
  channel = 'line',
  canPick = true,
  lockedReason,
}: {
  open: boolean
  onClose: () => void
  onPick: (content: string) => void
  /*
   * G-4: テンプレートのパック呼出し。複数選んだ本文を選んだ順の配列で
   * 渡す。渡された画面だけ「まとめて選ぶ」の切替が出る。
   * （受信箱は1回のpushで最大5通まとめて送れる。）
   */
  onPickPack?: (contents: string[]) => void
  // N-026: 差し込みを含むテンプレートのプレビューを、送信と同じ解決器で
  // 表示するために会話IDを受け取る。無いときは生の本文を見せる従来表示。
  chatId?: string | null
  channel?: 'line' | 'email'
  canPick?: boolean
  lockedReason?: string
}) {
  const { selectedAccountId } = useAccount()
  // PERF-12: templates は「届いた区画」だけ。全件を持たず、絞り込みは
  // サーバーに任せる。total は絞り込み後の総数。
  const [templates, setTemplates] = useState<UsageAwareTemplate[]>([])
  const [total, setTotal] = useState(0)
  const [folderCounts, setFolderCounts] = useState<Record<string, number> | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [folderId, setFolderId] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [category, setCategory] = useState<'all' | 'frequent'>('all')
  // パック呼出しの下書き。選んだ順が送る順になる（あいさつ→案内→締め）。
  // 本文ごと持つのは、絞り込みを変えて一覧から外れても選んだものが
  // 消えないようにするため。
  const [packMode, setPackMode] = useState(false)
  const [packItems, setPackItems] = useState<Array<{ id: string; name: string; content: string }>>([])
  const [templatesStatus, setTemplatesStatus] = useState<TemplateLoadStatus>('idle')
  const [foldersStatus, setFoldersStatus] = useState<TemplateFolderStatus>('loading')
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadedAccountId, setLoadedAccountId] = useState<string | null>(selectedAccountId)
  /*
   * 確かめた結果の控え。開く・閉じる・アカウント・会話が変わるたびに世代を進め、
   * 前の世代の結果と遅れて届いた応答は使わない（行き来しても前の相手の値を出さない）。
   */
  const previewScopeRef = useRef({ key: '', generation: 0 })
  const previewScopeKey = `${open ? 'open' : 'closed'}\u0000${selectedAccountId ?? ''}\u0000${chatId ?? ''}`
  if (previewScopeRef.current.key !== previewScopeKey) previewScopeRef.current = { key: previewScopeKey, generation: previewScopeRef.current.generation + 1 }
  const previewGeneration = previewScopeRef.current.generation
  const [previewCache, setPreviewCache] = useState<{ generation: number; items: ReadonlyMap<string, PickPreview> }>({ generation: 0, items: EMPTY_PREVIEWS })
  const previewItems = previewCache.generation === previewGeneration ? previewCache.items : EMPTY_PREVIEWS
  const previewRequested = useRef(new Set<string>())
  const accountDataCurrent = loadedAccountId === selectedAccountId
  const emptyTemplates = useMemo<UsageAwareTemplate[]>(() => [], [])
  const emptyFolders = useMemo<Folder[]>(() => [], [])
  const scopedTemplates = accountDataCurrent ? templates : emptyTemplates
  const scopedFolders = accountDataCurrent ? folders : emptyFolders
  const visibleTemplatesStatus = accountDataCurrent ? templatesStatus : 'loading'
  const visibleFoldersStatus = accountDataCurrent ? foldersStatus : 'loading'
  // 連打・連続入力で遅れて届いた古い応答を混ぜない。
  const listGenRef = useRef(0)
  // 次に取るページ番号。重複除去で件数とページがずれても狂わないよう、
  // 件数からは割り出さずに持つ。
  const nextPageRef = useRef(1)

  /*
   * INBOX-14: 共通のオーバーレイ約束。開いたら窓の中へフォーカス、
   * Tab は窓の中で回し、Escape で閉じ、閉じたら起点（テンプレートを
   * 開いたボタン）へフォーカスを戻す。未挿入で閉じても下書きは変えない。
   */
  const searchInputRef = useRef<HTMLInputElement>(null)
  /*
   * 初期フォーカスは検索欄へ。useOverlayFocus は先頭の閉じるボタンへ
   * 合わせるため、同じフレームの後に続くこの予約で検索欄へ移す。
   */
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!open) {
      setLoadingMore(false)
      // 閉じている間に前回分を捨て、次に開いた最初の描画から
      // 未取得状態にする（effect後の一瞬だけ前アカウントを出さない）。
      listGenRef.current += 1
      setTemplates([])
      setTotal(0)
      setFolderCounts(null)
      setFolders([])
      setSelectedId('')
      setPreviewId(null)
      setFolderId('')
      setSearch('')
      setDebouncedSearch('')
      setCategory('all')
      setPackMode(false)
      setPackItems([])
      setTemplatesStatus('loading')
      setFoldersStatus('loading')
      setLoadedAccountId(selectedAccountId)
      return
    }
    let cancelled = false
    // LINEアカウントを切り替えたあとに前アカウントの内容を一瞬でも
    // 見せない。開くたびに未取得へ戻し、0件と区別する。
    setFolders([])
    setFoldersStatus('loading')
    // 置き場（099 で templates.folder_id が入っている）。
    // テンプレートと同じく選択中アカウントで絞る。渡さないと
    // 可視範囲の全部が並び、別アカウントの置き場が出る（N-147）。
    void api.folders.list('template', selectedAccountId ?? undefined).then((res) => {
      if (cancelled) return
      if (res.success) {
        setFolders(res.data)
        setFoldersStatus('ready')
      } else {
        setFoldersStatus('error')
      }
    }).catch(() => {
      if (!cancelled) setFoldersStatus('error')
    })
    return () => {
      cancelled = true
    }
  }, [open, selectedAccountId])

  // 検索欄は1打鍵ごとに取りに行かず、少し間を置いてから確定する。
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => setDebouncedSearch(search), 250)
    return () => window.clearTimeout(timer)
  }, [search, open])

  /*
   * PERF-12: 一覧の区画取得。検索・フォルダ・分類が変わるたびに
   * 1ページ目から取り直す。サーバー側で絞り込みを済ませてから切るので、
   * 「届いた分だけを絞った偽の0件」にはならない。
   */
  useEffect(() => {
    if (!open) return
    const myGen = ++listGenRef.current
    const account = selectedAccountId ?? undefined
    setLoadingMore(false)
    setTemplatesStatus('loading')
    void api.templates.listPage({
      accountId: account,
      q: debouncedSearch.trim() || undefined,
      folderId: folderId || undefined,
      quick: category === 'all' ? undefined : category,
      messageType: 'text',
      textOnly: true,
      page: 1,
      limit: 100,
      folderCounts: true,
    }).then((res) => {
      if (listGenRef.current !== myGen) return
      if (res.success) {
        setTemplates(textTemplates(res.data.items as unknown as UsageAwareTemplate[]))
        setTotal(res.data.total)
        if (res.data.folderCounts) setFolderCounts(res.data.folderCounts)
        nextPageRef.current = 2
        setTemplatesStatus('ready')
      } else {
        setTemplatesStatus('error')
      }
    }).catch(() => {
      if (listGenRef.current === myGen) setTemplatesStatus('error')
    })
  }, [open, selectedAccountId, debouncedSearch, folderId, category])

  /** 次の区画を下へ足す。区画の間で重なった分は id で除く。 */
  const loadMore = () => {
    if (loadingMore || templates.length >= total) return
    const myGen = ++listGenRef.current
    const page = nextPageRef.current
    setLoadingMore(true)
    void api.templates.listPage({
      accountId: selectedAccountId ?? undefined,
      q: debouncedSearch.trim() || undefined,
      folderId: folderId || undefined,
      quick: category === 'all' ? undefined : category,
      messageType: 'text',
      textOnly: true,
      page,
      limit: 100,
    }).then((res) => {
      if (listGenRef.current !== myGen) return
      if (res.success) {
        setTemplates((prev) => {
          const seen = new Set(prev.map((t) => t.id))
          return [...prev, ...textTemplates(res.data.items as unknown as UsageAwareTemplate[]).filter((t) => !seen.has(t.id))]
        })
        setTotal(res.data.total)
        nextPageRef.current = page + 1
      }
    }).catch(() => undefined).finally(() => {
      if (listGenRef.current === myGen) setLoadingMore(false)
    })
  }

  /** 置き場ごとの件数はサーバー集計。届くまでは数を出さない。 */
  const folderOptions = useMemo<TemplateFolderOption[]>(() => {
    const children = new Map<string | null, Folder[]>()
    for (const folder of scopedFolders) {
      const parentId = scopedFolders.some((candidate) => candidate.id === folder.parentId)
        ? folder.parentId
        : null
      children.set(parentId, [...(children.get(parentId) ?? []), folder])
    }
    const countOf = (id: string) => folderCounts?.[id] ?? 0
    const countReady = folderCounts !== null
    const allCount = countReady
      ? Object.values(folderCounts).reduce((sum, n) => sum + n, 0)
      : null
    const options: TemplateFolderOption[] = [
      { value: '', label: 'すべてのフォルダ', count: allCount },
    ]
    for (const parent of children.get(null) ?? []) {
      const childFolders = children.get(parent.id) ?? []
      const count = countReady
        ? countOf(parent.id) + childFolders.reduce((sum, child) => sum + countOf(child.id), 0)
        : null
      options.push({ value: parent.id, label: parent.name, count })
      for (const child of childFolders) {
        options.push({
          value: child.id,
          label: child.name,
          count: countReady ? countOf(child.id) : null,
          depth: 1,
        })
      }
    }
    options.push({
      value: '__none__',
      label: '未分類',
      count: countReady ? countOf('') : null,
    })
    return options
  }, [folderCounts, scopedFolders])

  /*
   * PERF-12: 絞り込みはサーバー済み。「よく使う」もサーバーが実績順で
   * 返すので、ここでは先頭5件を切るだけ。
   */
  const shown = useMemo(
    () => category === 'frequent' ? scopedTemplates.slice(0, 5) : scopedTemplates,
    [category, scopedTemplates],
  )

  /*
   * INBOX-13: 選択は「いま見えている候補」の中だけで解決する。
   * 検索・フォルダ・分類で一覧から外れたテンプレートを選んだままに
   * しない。選択が結果外になったら結果の先頭へ明示的に切り替え、
   * 0件なら未選択（挿入不可）にする。
   */
  const selectedTemplate = useMemo(
    () => shown.find((t) => t.id === selectedId) ?? shown[0] ?? null,
    [selectedId, shown],
  )
  const previewTemplate = shown.find(template => template.id === previewId) ?? null

  /* INBOX-15: よく使うの実績が1件も無いときは、推測と実績を区別して断る。 */
  const frequentHasUsage = useMemo(
    () => category === 'frequent' && shown.some((t) => usageScore(t as UsageAwareTemplate) > 0),
    [category, shown],
  )

  /*
   * 差し込みを含むテンプレートは、送信と同じ解決器の結果をプレビューに出す。
   * 確かめるのは見ている1件と、まとめて送るときに選んだもの（最大5件）だけ。一覧の全部には問い合わせない。
   */
  const previewTargets = useMemo<PreviewTarget[]>(() => {
    // 入れるもの（選択中）と、右に中身を見ているものは別々に確かめる（同じとは限らない）。
    const list: PreviewTarget[] = []
    const add = (target: PreviewTarget) => { if (!list.some((item) => item.id === target.id)) list.push(target) }
    for (const template of [selectedTemplate, previewTemplate]) if (template) add({ id: template.id, name: template.name, content: template.messageContent })
    if (packMode) packItems.forEach(add)
    return list.filter((target) => target.content.includes('{{'))
  }, [selectedTemplate, previewTemplate, packMode, packItems])
  useEffect(() => {
    if (!open || !chatId) return
    const generation = previewGeneration
    // 前の世代の問い合わせの印は持ち越さない（開き直し・相手の切り替えで取り直す）。
    if (![...previewRequested.current].every((key) => key.startsWith(`${generation}\u0000`))) {
      previewRequested.current = new Set([...previewRequested.current].filter((key) => key.startsWith(`${generation}\u0000`)))
    }
    for (const target of previewTargets) {
      const key = previewKey(target)
      const requestKey = `${generation}\u0000${key}`
      if (previewItems.has(key) || previewRequested.current.has(requestKey)) continue
      previewRequested.current.add(requestKey)
      const store = (result: PickPreview) => {
        if (previewScopeRef.current.generation !== generation) return
        setPreviewCache((prev) => {
          const items = new Map(prev.generation === generation ? prev.items : EMPTY_PREVIEWS)
          items.set(key, result)
          return { generation, items }
        })
      }
      void api.chats.renderPreview(chatId, { content: target.content, messageType: 'text' })
        .then((res) => store(res.success ? { status: 'ready', content: res.data.content, unresolved: res.data.unresolved } : { status: 'failed' }))
        .catch(() => store({ status: 'failed' }))
    }
  }, [open, chatId, previewGeneration, previewTargets, previewItems])

  const pickerTemplates = useMemo(() => shown.map((template) => ({ id: template.id, name: template.name, content: template.messageContent })), [shown])

  if (!open) return null

  const selected = selectedTemplate
  const resultOf = (target: PreviewTarget) => (chatId ? previewItems.get(previewKey(target)) : undefined)
  /* 一覧・右の中身は、それぞれのテンプレートで確かめた値を見せる。 */
  const resolvedPreviews: Record<string, string> = {}
  for (const target of previewTargets) {
    const result = resultOf(target)
    if (result?.status === 'ready') resolvedPreviews[target.id] = result.content
  }
  /*
   * 注意は口が実際に解決できなかった差し込みだけで出す（予約がある相手には予約の値が入る）。
   * 1通のときは入力欄に入れる選択中のもので決める（右で別のものを見ていても混ぜない）。
   * まとめて送るときは、選んだもの全部の結果を合わせ、該当するテンプレートの名前を添える。
   */
  const pickCheck: TemplatePickCheck | null = (() => {
    if (!chatId) return null
    const pack = packMode && onPickPack
    const targets: PreviewTarget[] = pack
      ? packItems.filter((item) => item.content.includes('{{'))
      : selected && selected.messageContent.includes('{{') ? [{ id: selected.id, name: selected.name, content: selected.messageContent }] : []
    const results = targets.map((target) => ({ target, result: resultOf(target) }))
    const unresolvedResults = results.filter(({ result }) => result?.status === 'ready' && result.unresolved.length > 0)
    if (unresolvedResults.length) {
      return {
        status: 'unresolved',
        names: [...new Set(unresolvedResults.flatMap(({ result }) => (result?.status === 'ready' ? result.unresolved : [])))],
        // 右で別のものを見ているときは、どれの話かを名前で添える。
        templates: pack || (previewTemplate && previewTemplate.id !== selected?.id) ? unresolvedResults.map(({ target }) => target.name) : [],
      }
    }
    return results.some(({ result }) => result?.status === 'failed') ? { status: 'failed' } : null
  })()

  const togglePackItem = (template: UsageAwareTemplate) => {
    setPackItems((prev) => {
      const inPack = prev.some((item) => item.id === template.id)
      if (inPack) return prev.filter((item) => item.id !== template.id)
      return prev.length >= 5 ? prev : [...prev, { id: template.id, name: template.name, content: template.messageContent }]
    })
  }

  const canPickNow = canPick && !lockedReason
  const confirmPick = () => {
    if (!canPickNow) return
    if (packMode && onPickPack) {
      if (packItems.length === 0) return
      onPickPack(packItems.map((item) => item.content))
    } else {
      if (!selected) return
      onPick(selected.messageContent)
    }
    onClose()
  }

  /*
   * ★V8（ 段2「4. テンプレートを選ぶ」）：左はテンプレートの画面と同じフォルダの列。
   * 「予約」「EC」の文字で拾う絞り込みはフォルダに統一したので出さない（注）。
   */
  const sideActive: TemplatePickerSideKey = category === 'frequent'
    ? 'frequent'
    : folderId === '__none__'
      ? 'none'
      : folderId
        ? `folder:${folderId}`
        : 'all'
  const countReady = folderCounts !== null
  const colorOf = new Map(scopedFolders.map((folder) => [folder.id, folder.color]))
  return (
    <TemplatePickerView
      accountId={selectedAccountId}
      onClose={onClose}
      channel={channel}
      canPick={canPickNow}
      lockedReason={lockedReason}
      search={search}
      onSearch={setSearch}
      searchInputRef={searchInputRef}
      side={{
        active: sideActive,
        allCount: folderOptions[0]?.count ?? null,
        noneCount: countReady ? folderCounts?.[''] ?? 0 : null,
        folders: folderOptions
          .filter((option) => option.value && option.value !== '__none__')
          .map((option) => ({ id: option.value, name: option.label, color: colorOf.get(option.value) ?? null, count: option.count, depth: option.depth })),
        status: visibleFoldersStatus === 'error' ? 'error' : visibleFoldersStatus === 'ready' ? 'ready' : 'loading',
      }}
      onPickSide={(key) => {
        if (key === 'frequent') { setCategory('frequent'); setFolderId(''); return }
        setCategory('all')
        setFolderId(key === 'all' ? '' : key === 'none' ? '__none__' : key.slice('folder:'.length))
      }}
      status={visibleTemplatesStatus}
      emptyText={search.trim() || folderId || category !== 'all' ? '見つかりませんでした。' : '文字のテンプレートがまだありません。'}
      frequentNote={category === 'frequent' && visibleTemplatesStatus === 'ready' && shown.length > 0 && !frequentHasUsage}
      templates={pickerTemplates}
      selectedId={selected?.id ?? null}
      previewId={previewTemplate?.id ?? null}
      onPreview={(id) => {
        setPreviewId(id)
        setSelectedId(id)
        if (!packMode) return
        const template = shown.find(item => item.id === id)
        if (!template) return
        setPackItems(items => items.some(item => item.id === id) || items.length >= 5
          ? items
          : [...items, { id: template.id, name: template.name, content: template.messageContent }])
      }}
      onClosePreview={() => setPreviewId(null)}
      onSelect={(id) => {
        setSelectedId(id)
        if (previewId !== null) setPreviewId(id)
        if (!packMode) return
        const template = shown.find((item) => item.id === id)
        if (template) togglePackItem(template)
      }}
      canPack={Boolean(onPickPack)}
      packMode={packMode}
      onPackMode={(next) => { setPackMode(next); setPackItems([]) }}
      packItems={packItems}
      remaining={visibleTemplatesStatus === 'ready' && category !== 'frequent' ? Math.max(0, total - templates.length) : 0}
      loadingMore={loadingMore}
      onLoadMore={loadMore}
      resolvedPreviews={resolvedPreviews}
      check={pickCheck}
      onConfirm={confirmPick}
      confirmDisabled={packMode && onPickPack ? packItems.length === 0 : !selected}
    />
  )
}
