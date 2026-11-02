'use client'

import CopyTextButton from '@/components/shared/copy-text-button';
import { notifySaved } from '@/components/shared/toast';
import { useFeatureAccess } from '@/lib/use-feature-access';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Copy, FlaskConical, Smartphone, Upload } from 'lucide-react';
import { liffActionUrl, emptyLayout, resolveCustomerFormTheme, formThemeContrastError, newBlockId, validateFormForPublish, parseFormReferences, type FormBlock, type FormLayout, type FormOptions, type FormSection, type PublicFormReference } from '@line-crm/shared';
import { CreatePage } from '@/components/templates';
import Button from '@/components/shared/button';
import Dialog from '@/components/shared/dialog';
import Notice from '@/components/shared/notice';
import OperationTargetSummary from '@/components/shared/operation-target-summary';
import HelpTip from '@/components/shared/help-tip';
import { SaveConflictBand, SaveConflictCompareDialog, useSaveConflict } from '@/components/shared/save-conflict';
import ListState from '@/components/shared/list-state';
import TargetMissing from '@/components/shared/target-missing';
import { Tabs } from '@/components/shared/tabs';
import { classifyApiFailure, describeApiFailure } from '@/components/shared/api-error-message';
import { validateFormLayoutForSave } from '@/components/forms/form-definition-validation';
import { normalizeSectionName } from '@/components/forms/section-name';
import { takenFormAnswerNames, uniqueFormCopyName } from '@/components/forms/form-definition-operations';
import { EMPTY_REFS, type FormRefs } from '@/components/forms/form-refs';
import { api, ApiError, bookingApi, fetchApi } from '@/lib/api';
import { useAccount } from '@/contexts/account-context';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard';
import { useNarrowViewport } from '@/lib/use-narrow-viewport';
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog';
import { usePageTitle } from '@/components/shell/page-chrome';
import PageResourceScope, { usePageResourceTask } from '@/components/shell/page-resource-scope';
import { resolveResourceTitle } from '@/lib/resource-title';
import { canManageRole, useStaffRole } from '@/lib/staff-role';
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason';
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock';
import { useDraftAutosave } from '@/v8/autosave/public/use-draft-autosave/index'
import { requestUnsavedAction } from '@/lib/unsaved-action';
import { hqFormPortableReferenceError } from '@/components/forms/hq-form-definition-adapter';
import type { FormEditHost } from './host';
import { conflictMessage, conflictTitle, describeConflictDiff, describePublishChanges, firstInputBlockId, formSavedContentMatches, ogImageUrlError, readPage, readTab, type ConflictSide, type EditTab, type FormSavedContent } from './model';
import { ContentTab } from './content-tab';
import { AfterTab } from './after-tab';
import { AppearanceTab } from './appearance-tab';
import { FormNameField, formNameRequirement } from './form-name-field';
import { FormEditAttemptContext } from './field-issues';
import { focusFieldById } from '@/lib/use-form-errors';
import { useCustomerLook } from '@/components/shared/use-customer-look';
import { FormPhone } from './phone';
import styles from './edit.module.css';
import { useCreatedDraft } from './use-created-draft'
import { readFormDraftCreation, rememberFormDraftCreation } from '@/lib/form-draft-session'
import { routingError, routingOf, withRouting, type FormRouting } from './routing-model';
import { formatNumber as polishFormatNumber } from '@/lib/format';
import TextLink from '@/components/shared/text-link';
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import ReadOnlyNotice from '@/components/shared/read-only-notice';
import { TAB_ITEMS, TAB_NODE, type Snapshot } from "./edit-gap-parts"
function FormEditInner({ host }: { host?: FormEditHost }) {
  const captureResource = usePageResourceTask()
  const saveErrors = useSaveFormErrors()
  const params = useSearchParams()
  const router = useRouter()
  const requestedId = params.get('id') ?? ''
  const rawDraftToken = params.get('new') ?? ''
  const draftToken = !host && !requestedId && /^[A-Za-z0-9_-]{16,128}$/.test(rawDraftToken) ? rawDraftToken : null
  /* 統括のひな形から使うとき（host.ts）。読み込み・保存は呼ぶ側。 */
  const hostRef = useRef(host)
  hostRef.current = host
  const { selectedAccount, selectedAccountId } = useAccount()
  const [createdId, setCreatedId] = useState(() => selectedAccountId && draftToken ? readFormDraftCreation(selectedAccountId, draftToken) ?? '' : '')
  const locallyCreatedId = useRef<string | null>(null)
  const id = requestedId || createdId
  const customerLook = useCustomerLook(host ? null : selectedAccountId)
  const narrow = useNarrowViewport()
  const role = useStaffRole()
  const draftDeleteLock = usePermissionLockReason(canManageRole(role), 'manager')
    ?? (!canManageRole(role) ? PERMISSION_LOCK_REASON.manager : undefined)
  const featureAccess = useFeatureAccess('forms')
  const canEdit = host ? !host.readOnly : featureAccess
  const readOnly = host ? Boolean(host.readOnly) : !canEdit

  /* 一覧・動作指定と同じ共通関数で、友だちに配るURLを作る。 */
  const liffId = selectedAccount?.liffId ?? null
  const answerUrl = (() => {
    if (!liffId || !id) return null
    try { return liffActionUrl({ liffId, kind: 'form', formId: id }) } catch { return null }
  })()

  const [editTab, setEditTab] = useState<EditTab>(() => readTab(params.get('tab')))
  /* 統括から使うときは、最初の描画から読み込んだ中身で出す（空の一瞬に保存を押させない）。 */
  const [name, setName] = useState(() => host?.initial.name ?? '')
  const [nameError, setNameError] = useState<string | null>(null)
  const changeName = (next: string) => {
    setName(next)
    if (next.trim()) setNameError(null)
  }
  const blurName = () => setNameError(name.trim() ? null : 'フォーム名を入力してください')
  const [description, setDescription] = useState(() => host?.initial.description ?? '')
  const [isActive, setIsActive] = useState(!host && !draftToken)
  const [submitCount, setSubmitCount] = useState(0)
  const [onSubmitTagId, setOnSubmitTagId] = useState(() => host?.initial.onSubmitTagId ?? '')
  const [ogTitle, setOgTitle] = useState('')
  const [ogDescription, setOgDescription] = useState('')
  const [ogImageUrl, setOgImageUrl] = useState('')
  const [layout, setLayoutState] = useState<FormLayout>(() => host?.initial.layout ?? emptyLayout())
  const [page, setPage] = useState(0)
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  /* 保存を押したか。押したあとだけ、欄の赤とタブの赤い印を出す。 */
  const [attempted, setAttempted] = useState(false)
  const [refs, setRefs] = useState<FormRefs>(EMPTY_REFS)
  const [loading, setLoading] = useState(!host)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [formLoaded, setFormLoaded] = useState(Boolean(host))
  const title = resolveResourceTitle({ name, loaded: formLoaded, pendingTitle: '回答フォーム編集', emptyTitle: 'フォーム名未設定' })
  /* 統括へ埋め込むときの帯の題は親の画面に合わせる。 */
  usePageTitle(host ? '回答フォーム' : title)
  const [formLoadFailed, setFormLoadFailed] = useState<'missing' | 'forbidden' | 'error' | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [bookingStaffErrors,setBookingStaffErrors]=useState<Record<string, boolean>>({})
  const bookingStaffAccount = useRef(selectedAccountId)
  const [referencesError,setReferencesError]=useState(false)
  const savedSnapshot = useRef<string | null>(null)
  /** 読み込んだ時点の編集の版(#723)。読み込みと保存成功のときだけ入れ替える。 */
  const [contentRevision, setContentRevision] = useState<number | null>(null)
  /* 保存の直前に読む版。自動保存のあと描き直す前に手の保存が走っても、新しい版で送る。 */
  const contentRevisionRef = useRef<number | null>(null)
  contentRevisionRef.current = contentRevision
  const [publishedVersionId, setPublishedVersionId] = useState<string | null>(null)
  const [publishedContentRevision, setPublishedContentRevision] = useState<number | null>(null)
  const [testToken, setTestToken] = useState<string | null>(null)
  const [testBusy, setTestBusy] = useState(false)
  const [testError, setTestError] = useState('')
  const [showPublish, setShowPublish] = useState(false)
  /*
   * 公開の確かめの「変わること」は、いま公開中の版との違い。
   * 公開中の版は、account_id を付けない取得（お客さまに見えている形）で読む。
   * 読めないとき（未公開・受付停止・通信失敗）は、保存した下書きとの違いに戻す。
   */
  const [publishedSide, setPublishedSide] = useState<ConflictSide | null>(null)
  const [publishedReferences, setPublishedReferences] = useState<Map<string, PublicFormReference> | null>(null)
  /*
   * ほかの人が先に保存していたとき（409）。入力は捨てない。
   * 帯・比べる窓・読み直しは共通の save-conflict（動きの点検 16 番）。
   */
  const saveConflict = useSaveConflict<ConflictSide>({
    // 「違いを比べる」。最新を取って比べるだけで、画面は書き換えない。
    fetchLatest: async () => {
      if (!id || !selectedAccountId) return null
      const res = await api.forms.get(id, selectedAccountId)
      if (!res.success) return null
      return { name: res.data.name, description: res.data.description ?? '', layout: res.data.layout ?? emptyLayout() }
    },
    reload: () => reloadAfterConflict(),
  })
  const conflict = saveConflict.conflict
  const clearConflict = saveConflict.clear
  const [previewOpen, setPreviewOpen] = useState(false)
  /** 最初の読み込みで ?page= を当てたか（読み直しでページを戻さない）。 */
  const pageFromUrl = useRef(false)

  // 元に戻す / やり直す。
  const undoStack = useRef<FormLayout[]>([])
  const redoStack = useRef<FormLayout[]>([])
  const setLayout = useCallback((next: FormLayout | ((prev: FormLayout) => FormLayout)) => {
    setLayoutState((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next
      undoStack.current = [...undoStack.current.slice(-49), prev]
      redoStack.current = []
      return resolved
    })
  }, [])

  /** フォーム本体の読み込み。初回と、競合で「最新を読み込んで続ける」を押したとき。 */
  const loadForm = useCallback(async () => {
    if (!id || !selectedAccountId) return false
    const res = await api.forms.get(id, selectedAccountId)
    if (!res.success) return false
    const nextLayout = res.data.layout ?? emptyLayout()
    const loaded: Snapshot = {
      name: res.data.name,
      description: res.data.description ?? '',
      isActive: res.data.isActive,
      onSubmitTagId: res.data.onSubmitTagId ?? '',
      ogTitle: res.data.ogTitle ?? '',
      ogDescription: res.data.ogDescription ?? '',
      ogImageUrl: res.data.ogImageUrl ?? '',
      layout: nextLayout,
    }
    setName(loaded.name)
    setDescription(loaded.description)
    setIsActive(loaded.isActive)
    setSubmitCount(res.data.submitCount ?? 0)
    setOnSubmitTagId(loaded.onSubmitTagId)
    setOgTitle(loaded.ogTitle)
    setOgDescription(loaded.ogDescription)
    setOgImageUrl(loaded.ogImageUrl)
    setLayoutState(nextLayout)
    setContentRevision(res.data.contentRevision ?? null)
    setPublishedVersionId(res.data.publishedVersionId ?? null)
    setPublishedContentRevision(res.data.publishedContentRevision ?? null)
    clearConflict()
    if (!pageFromUrl.current) {
      pageFromUrl.current = true
      const index = readPage(params.get('page'), nextLayout.sections.length)
      setPage(index)
      setSelectedBlockId(params.get('block') ?? firstInputBlockId(nextLayout.sections[index]?.blocks ?? []))
    }
    savedSnapshot.current = JSON.stringify(loaded)
    setFormLoaded(true)
    return true
  }, [id, selectedAccountId, params, clearConflict])

  const reloadAfterConflict = async () => {
    setError('')
    setNotice('')
    try {
      await loadForm()
      setNotice('最新の内容を読み込みました')
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)

      setError('読み込みに失敗しました。もう一度読み込んでください。') }
    }
  }

  /* 中身の参照状態と公開の確かめでは公開中の版を読む（account_id が無いと公開中の版を返す）。 */
  useEffect(() => {
    if ((!showPublish && editTab !== 'content') || !id || !publishedVersionId) {
      setPublishedSide(null)
      setPublishedReferences(null)
      return
    }
    let alive = true
    setPublishedReferences(null)
    void (async () => {
      try {
        const res = await fetchApi<{ success: boolean; data?: { name?: string; description?: string | null; layout?: FormLayout; references?: PublicFormReference[] } }>(
          `/api/forms/${encodeURIComponent(id)}?view=published`,
          { suppressFeatureDisabledEvent: true },
        )
        if (!alive) return
        setPublishedSide(res.success && res.data?.layout
          ? { name: res.data.name ?? '', description: res.data.description ?? '', layout: res.data.layout }
          : null)
        setPublishedReferences(res.success && Array.isArray(res.data?.references)
          ? new Map(res.data.references.flatMap((row) => (row && typeof row.blockId === 'string' ? [[row.blockId, row] as const] : [])))
          : null)
      } catch (saveFailure) {
        if (showPublish) saveErrors.capture(saveFailure);

        if (alive) {
          setPublishedSide(null)
          setPublishedReferences(null)
        }
      }
    })();

    return () => { alive = false }
  }, [showPublish, editTab, id, publishedVersionId, contentRevision, saveErrors])

  useEffect(() => {
    setFormLoadFailed(null)
    const hosted = hostRef.current
    if (hosted) {
      /* 統括のひな形：読み込んだ中身を入れるだけ（店の口は呼ばない）。 */
      const initial = hosted.initial
      const loaded: Snapshot = {
        name: initial.name, description: initial.description, isActive: false, onSubmitTagId: initial.onSubmitTagId,
        ogTitle: '', ogDescription: '', ogImageUrl: '', layout: initial.layout,
      }
      setName(loaded.name)
      setDescription(loaded.description)
      setIsActive(loaded.isActive)
      setOnSubmitTagId(loaded.onSubmitTagId)
      setLayoutState(loaded.layout)
      setRefs(hosted.refs)
      const index = readPage(params.get('page'), loaded.layout.sections.length)
      pageFromUrl.current = true
      setPage(index)
      setSelectedBlockId(params.get('block') ?? firstInputBlockId(loaded.layout.sections[index]?.blocks ?? []))
      const baseline = hosted.baseline
      savedSnapshot.current = JSON.stringify(baseline ? {
        ...loaded, name: baseline.name, description: baseline.description, layout: baseline.layout, onSubmitTagId: baseline.onSubmitTagId,
      } : loaded)
      setFormLoaded(true)
      setLoading(false)
      return
    }
    // 自分の初回保存で得たIDへの切替では、保存中に追記された入力を読み込みで消さない。
    if (id && locallyCreatedId.current === id) return
    void (async () => {
      try {
        // 参照一覧は選んでいる公式アカウントに絞る（別アカウントのタグ等を混ぜない）。
        const tagPath = selectedAccountId ? `/api/tags?lineAccountId=${encodeURIComponent(selectedAccountId)}` : '/api/tags'
        const accountFilter = selectedAccountId ? { accountId: selectedAccountId } : undefined
        const [tagRes, ffRes, scenarioRes, reminderRes, templateRes] = await Promise.all([
          fetchApi<{ success: boolean; data: Array<{ id: string; name: string }> }>(tagPath),
          selectedAccountId ? api.friendFields.list(selectedAccountId, undefined, { suppressFeatureDisabledEvent: true }) : Promise.resolve({ success: true as const, data: [] }),
          api.scenarios.list(accountFilter),
          api.reminders.list(accountFilter),
          api.templates.list(undefined, selectedAccountId ?? undefined),
        ])
        if(!tagRes.success || !ffRes.success || !scenarioRes.success || !reminderRes.success || !templateRes.success){setReferencesError(true);throw new Error('references unavailable')}
        setRefs({
          tags: tagRes.data.map((t) => ({ id: t.id, name: t.name })),
          friendFields: ffRes.data.map((f) => ({ id: f.id, name: f.name, ecIsMaster: f.ecIsMaster })),
          scenarios: scenarioRes.data.map((s) => ({ id: s.id, name: s.name })),
          reminders: reminderRes.data.map((r) => ({ id: r.id, name: r.name })),
          templates: templateRes.data.map((t) => ({ id: t.id, name: t.name, type: t.messageType })),
          bookingMenus: [],
          bookingMenuStaff: {},
        })
        // 「予約を入れる」欄のメニュー選び。本体の読み込みを待たせない。読めなくても欄は置ける。
        if (selectedAccountId) {
          bookingApi
            .listMenus(selectedAccountId)
            .then((menuRes) => {
              const bookingMenus = (menuRes.menus ?? [])
                .filter((m) => m.is_active === 1)
                .map((m) => ({ id: m.id, name: m.name, durationMinutes: m.duration_minutes }))
              setRefs((prev) => ({ ...prev, bookingMenus }))
            })
            .catch(() => {})
        }
        if (draftToken && !id) {
          const initial: Snapshot = { name: '', description: '', isActive: false, onSubmitTagId: '', ogTitle: '', ogDescription: '', ogImageUrl: '', layout }
          savedSnapshot.current = JSON.stringify(initial)
          setFormLoaded(true)
        } else {
          const ok = await loadForm()
          if (!ok && id && selectedAccountId) setFormLoadFailed('missing')
        }
      } catch (caught) {
        const fieldFailure = saveErrors.capture(caught);

        if (caught instanceof ApiError && caught.status === 404) setFormLoadFailed('missing')
        else if (classifyApiFailure(caught) === 'forbidden') setFormLoadFailed('forbidden')
        else {
          { if (!fieldFailure)
          setError('読み込みに失敗しました。もう一度読み込んでください。') }
          setFormLoadFailed('error')
        }
      } finally {
        setLoading(false)
      }
    })()
    // loadForm は params を読むが、読み込み直すのは id・アカウント・再試行のときだけ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reloadKey, selectedAccountId, saveErrors])

  useEffect(() => {
    if (bookingStaffAccount.current !== selectedAccountId) {
      bookingStaffAccount.current = selectedAccountId
      setBookingStaffErrors({})
    }
  }, [selectedAccountId])

  // 「予約を入れる」欄の担当選び。欄のメニューが決まったものだけ読む。
  useEffect(() => {
    if (hostRef.current || !selectedAccountId) return
    const menuIds = new Set<string>()
    for (const section of layout.sections) {
      for (const b of section.blocks) {
        if (b.kind === 'input' && b.type === 'booking' && b.booking?.menuId) menuIds.add(b.booking.menuId)
      }
    }
    const missing = [...menuIds].filter((menuId) => refs.bookingMenuStaff?.[menuId] === undefined && !bookingStaffErrors[menuId])
    if (missing.length === 0) return
    let cancelled = false
    void (async () => {
      const results = await Promise.all(missing.map(async(menuId)=>{
        try {
          const res=await bookingApi.listMenuStaff(selectedAccountId,menuId)
          return { menuId, staff: res.staff.map(s=>({id:s.id,name:s.display_name})) }
        } catch { return { menuId, staff: null } }
      }))
      if(cancelled)return
      const entries = results.flatMap(({ menuId, staff }) => staff === null ? [] : [[menuId, staff] as const])
      const failed = results.filter((result) => result.staff === null)
      if(entries.length) setRefs(prev=>({...prev,bookingMenuStaff:{...(prev.bookingMenuStaff??{}),...Object.fromEntries(entries)}}))
      if(failed.length) setBookingStaffErrors(prev=>({...prev,...Object.fromEntries(failed.map(({menuId})=>[menuId,true]))}))
    })()
    return () => {
      cancelled = true
    }
  }, [selectedAccountId, layout, refs.bookingMenuStaff,bookingStaffErrors])

  /* ---------------- ページとブロック ---------------- */

  const blocks = useMemo(() => layout.sections[page]?.blocks ?? [], [layout, page])
  /* タブの札の赤い印。保存を押したあとだけ、そのタブの直す欄の数を出す。 */
  const tabErrors: Record<EditTab, number> = attempted ? {
    content: (name.trim() ? 0 : 1) + layout.sections.reduce((n, s) => n + s.blocks.filter((b) => b.kind === 'input' && !b.label.trim()).length, 0) + (parseFormReferences(layout.references ?? []) === null ? 1 : 0),
    after: 0,
    appearance: (name.trim() ? 0 : 1) + (ogImageUrlError(ogImageUrl) ? 1 : 0) + (formThemeContrastError(resolveCustomerFormTheme(layout.options,customerLook.look ?? undefined)) ? 1 : 0),
  } : { content: 0, after: 0, appearance: 0 }
  const setBlocks = (next: FormBlock[]) =>
    setLayout((prev) => ({ ...prev, sections: prev.sections.map((s, i) => (i === page ? { ...s, blocks: next } : s)) }))

  const selectPage = (index: number) => {
    setPage(index)
    setSelectedBlockId(firstInputBlockId(layout.sections[index]?.blocks ?? []))
  }

  const addSection = () => {
    const section: FormSection = { id: newBlockId('s'), name: `ページ${layout.sections.length + 1}`, blocks: [] }
    setLayout((prev) => ({ ...prev, sections: [...prev.sections, section] }))
    setPage(layout.sections.length)
    setSelectedBlockId(null)
  }

  const renameSection = (index: number, next: string) => {
    const normalized = normalizeSectionName(next)
    if (normalized === null) return false
    setLayout((prev) => ({ ...prev, sections: prev.sections.map((s, i) => (i === index ? { ...s, name: normalized } : s)) }))
    return true
  }

  const duplicateSection = (index: number) => {
    const source = layout.sections[index]
    if (!source) return
    const taken = takenFormAnswerNames(layout)
    const copy: FormSection = {
      id: newBlockId('s'),
      name: `${source.name}のコピー`,
      blocks: source.blocks.map((b) => {
        if (b.kind !== 'input') return { ...b, id: newBlockId() }
        const copyName = uniqueFormCopyName(b.name, taken)
        taken.add(copyName)
        return { ...b, id: newBlockId(), name: copyName }
      }),
    }
    setLayout((prev) => ({ ...prev, sections: [...prev.sections.slice(0, index + 1), copy, ...prev.sections.slice(index + 1)] }))
    setPage(index + 1)
    setSelectedBlockId(null)
  }

  /** ページを消す。そのページへ飛ばしていた選択肢は「次へ進む」に戻す。 */
  const removeSection = (index: number) => {
    if (layout.sections.length <= 1) return
    const target = layout.sections[index]
    if (!target) return
    setLayout((prev) => ({
      ...prev,
      sections: prev.sections
        .filter((_, i) => i !== index)
        .map((s) => ({
          ...s,
          blocks: s.blocks.map((b) =>
            b.kind === 'input' && b.choices
              ? { ...b, choices: b.choices.map((c) => (c.jumpToSectionId === target.id ? { ...c, jumpToSectionId: null } : c)) }
              : b,
          ),
        })),
    }))
    setPage(Math.max(0, index - 1))
    setSelectedBlockId(null)
  }

  const addBlock = (block: FormBlock) => {
    setBlocks([...blocks, block])
    setSelectedBlockId(block.id)
  }

  const patchBlock = (blockId: string, patch: Partial<FormBlock>) =>
    setBlocks(blocks.map((b) => (b.id === blockId ? ({ ...b, ...patch } as FormBlock) : b)))

  const moveBlock = (blockId: string, to: number) => {
    const from = blocks.findIndex((b) => b.id === blockId)
    if (from < 0 || to < 0 || to >= blocks.length || from === to) return
    const next = [...blocks]
    const [row] = next.splice(from, 1)
    next.splice(to, 0, row)
    setBlocks(next)
  }

  const duplicateBlock = (blockId: string) => {
    const index = blocks.findIndex((b) => b.id === blockId)
    if (index < 0) return
    const source = blocks[index]
    // 回答キーが重なると片方の答えが消える。既存の名前と突き合わせて一意にする。
    const copy: FormBlock = source.kind === 'input'
      ? { ...source, id: newBlockId(), name: uniqueFormCopyName(source.name, takenFormAnswerNames(layout)) }
      : { ...source, id: newBlockId() }
    const next = [...blocks]
    next.splice(index + 1, 0, copy)
    setBlocks(next)
    setSelectedBlockId(copy.id)
  }

  const removeBlock = (blockId: string) => {
    setBlocks(blocks.filter((b) => b.id !== blockId))
    /* ブロックを消すときは参照も一緒に消す。残っていると公開時に 422 で止まる。 */
    setLayout((prev) => (prev.references?.some((row) => row.blockId === blockId) ? { ...prev, references: prev.references.filter((row) => row.blockId !== blockId) } : prev))
    if (selectedBlockId === blockId) setSelectedBlockId(null)
  }

  const inputCount = layout.sections.reduce((n, s) => n + s.blocks.filter((b) => b.kind === 'input').length, layout.header.filter((b) => b.kind === 'input').length)

  const patchRouting = (next: FormRouting) => setLayout((prev) => withRouting(prev, next))
  const patchOptions = (next: Partial<FormOptions>) => setLayout((prev) => ({ ...prev, options: { ...prev.options, ...next } }))

  /* ---------------- 未保存の確認 ---------------- */

  const current: Snapshot = { name, description, isActive, onSubmitTagId, ogTitle, ogDescription, ogImageUrl, layout }
  const currentSnapshot = JSON.stringify(current)
  const currentSnapshotRef = useRef(currentSnapshot)
  currentSnapshotRef.current = currentSnapshot
  const dirty = savedSnapshot.current !== null && currentSnapshot !== savedSnapshot.current

  useEffect(() => {
    if (loading || readOnly) return
    hostRef.current?.onDraftChange?.({ name, description, layout, onSubmitTagId })
  }, [loading, readOnly, name, description, layout, onSubmitTagId])

  const discardChanges = useCallback(() => {
    const snapshot = savedSnapshot.current
    if (!snapshot) return
    const saved = JSON.parse(snapshot) as Snapshot
    hostRef.current?.onDraftChange?.({ name: saved.name, description: saved.description, layout: saved.layout, onSubmitTagId: saved.onSubmitTagId })
    setName(saved.name)
    setDescription(saved.description)
    setIsActive(saved.isActive)
    setOnSubmitTagId(saved.onSubmitTagId)
    setOgTitle(saved.ogTitle)
    setOgDescription(saved.ogDescription)
    setOgImageUrl(saved.ogImageUrl)
    setLayoutState(saved.layout)
    undoStack.current = []
    redoStack.current = []
    setSelectedBlockId(null)
  }, [])

  const createdDraft = useCreatedDraft({ accountId: host ? null : selectedAccountId, id, revision: contentRevision,
    loaded: formLoaded && !loading, published: Boolean(publishedVersionId), canEdit, canDelete: canManageRole(role) && !draftDeleteLock, captureResource, waitForSave: () => saveInFlight.current })
  const { leaveTarget, confirmLeave, cancelLeave, disarm } = useUnsavedGuard({ dirty: dirty || createdDraft.owned, busy: saving || createdDraft.busy || Boolean(host?.busy), onDiscard: discardChanges })
  const finishLeave = () => { if (captureResource()()) { disarm(); confirmLeave() } }
  const cancelDraftLeave = () => { createdDraft.clearError(); cancelLeave() }

  /** タブを替える。URL の ?tab= も合わせる（画面の中の移動なので離脱の確認は出さない）。 */
  const changeTab = (next: EditTab) => {
    setEditTab(next)
    if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') return
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('tab', next)
      window.history.replaceState(window.history.state, '', url.toString())
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      /* URL を書けない環境（試験）では画面だけ替える */
    }
  }

  /* ---------------- 保存・公開 ---------------- */

  /** 保存を断る理由（無ければ null）。自動保存の「通せる形か」にも同じものを使う。 */
  /*
   * 保存を断る理由と、直す欄の場所。tab と target があれば、そのタブを開いて欄へ移り、
   * 欄の真下に理由を出す（inline）。欄に結び付かないものだけ上の帯に出す。
   */
  type SaveProblem = { message: string; name?: boolean; tab?: EditTab; target?: string; page?: number; blockId?: string; inline?: boolean }
  const saveProblem = (publishAfter: boolean): SaveProblem | null => {
    if (!host && !selectedAccountId) return { message: 'LINE公式アカウントを選んでください' }
    if (formNameRequirement.check(name)) return { message: 'フォーム名を入力してください', name: true, tab: editTab === 'content' ? 'content' : 'appearance', target: 'fe-name', inline: true }
    const allBlocks = layout.header.concat(layout.sections.flatMap((s) => s.blocks))
    const untitledPage = layout.sections.findIndex((s) => s.blocks.some((b) => b.kind === 'input' && !b.label.trim()))
    if (untitledPage >= 0) {
      const block = layout.sections[untitledPage].blocks.find((b) => b.kind === 'input' && !b.label.trim())!
      return { message: 'タイトルが空のブロックがあります', tab: 'content', page: untitledPage, blockId: block.id, target: `fe-q-${block.id}`, inline: true }
    }
    if (allBlocks.find((b) => b.kind === 'input' && !b.label.trim())) return { message: 'タイトルが空のブロックがあります' }
    // 回答キーが重なると片方の答えが消える。保存の直前にも止める。
    const seenNames = new Set<string>()
    const dup = allBlocks.find((b) => {
      if (b.kind !== 'input') return false
      if (seenNames.has(b.name)) return true
      seenNames.add(b.name)
      return false
    })
    if (dup) return { message: '回答キーが重なっています。複製した入力欄を確認してください' }
    const layoutError = validateFormLayoutForSave(layout)
    if (layoutError) return { message: layoutError }
    if (parseFormReferences(layout.references ?? []) === null) return { message: '公開用の参照の形が正しくありません。中身のタブで対応付けを直してください', tab: 'content' }
    const routingProblem = routingError(routingOf(layout))
    if (routingProblem) return { message: routingProblem.message }
    const ogImageError = ogImageUrlError(ogImageUrl)
    if (ogImageError) return { message: ogImageError, tab: 'appearance', target: 'fe-og-image', inline: true }
    // 文字と背景の差が 4.5:1 未満の組み合わせは保存できない（保存APIも同じ検査をする）。
    const contrastError = formThemeContrastError(resolveCustomerFormTheme(layout.options,customerLook.look ?? undefined))
    if (contrastError) return { message: contrastError, tab: 'appearance', target: 'fe-colors', inline: true }
    // 公開に進むときだけ、公開前の検査（分岐の循環・消えた行き先など）を通す。
    if (publishAfter) {
      const publishError = validateFormForPublish(layout)
      if (publishError) return { message: publishError }
    }
    if (host) {
      /* 店にだけある友だち情報・テンプレート・リマインダ・画像は、ひな形に入れられない（配った先の ID に直せない）。 */
      const portableError = hqFormPortableReferenceError({ name, description, layout, onSubmitTagId, onSubmitScenarioId: '', saveToMetadata: true })
      return portableError ? { message: portableError } : null
    }
    if (contentRevisionRef.current === null && !(draftToken && !id)) return { message: '読み込みが終わっていません。少し待ってから、もう一度お試しください' }
    return null
  }

  /*
   * 自動保存と手の保存が重なると、同じ版を2回送って競合に見える。
   * 送っている途中の保存を待ち、最新の版で送る。
   */
  const saveInFlight = useRef<Promise<unknown> | null>(null)
  const hostSaving = useRef(false)

  /**
   * 保存する。silent は自動保存：保存中の印・赤い帯・トーストを出さない（失敗は保存の帯に出る）。
   * 競合（409）だけは自動でも帯を出す（このまま書くと相手の変更が消えるため）。
   */
  const save = async (publishAfter = false, { silent = false, leaving = false }: { silent?: boolean; leaving?: boolean } = {}): Promise<boolean> => {
    if (!canEdit || createdDraft.deleting.current) return false
    const isCurrent = captureResource()
    if (!isCurrent()) return false
    const problem = saveProblem(publishAfter)
    if (problem) {
      if (silent) return false
      setAttempted(true)
      setNameError(problem.name ? problem.message : null)
      /* 欄に結び付く誤りは、そのタブ・ページ・ブロックを開いて欄へ移り、欄の真下に出す。 */
      setError(problem.inline ? '' : problem.message)
      if (problem.tab) {
        if (problem.tab !== editTab) changeTab(problem.tab)
        if (problem.page !== undefined) setPage(problem.page)
        if (problem.blockId) setSelectedBlockId(problem.blockId)
        if (problem.target) focusFieldById(problem.target)
      }
      return false
    }
    if (!silent) setNameError(null)
    if (host) {
      /* 統括：保存（と配る）は呼ぶ側。publishAfter は［保存して配る］。 */
      if (host.busy || hostSaving.current) return false
      hostSaving.current = true
      setSaving(true)
      setError('')
      try {
        const saved = await host.onSave({ name: name.trim(), description: description.trim(), layout, onSubmitTagId }, publishAfter)
        if (!isCurrent() || !saved) return false
        savedSnapshot.current = currentSnapshot
        return true
      } catch (cause) {
        if (isCurrent() && !saveErrors.capture(cause)) setError(describeApiFailure(cause, '保存'))
        return false
      } finally {
        hostSaving.current = false
        if (isCurrent()) setSaving(false)
      }
    }
    if (!selectedAccountId) return false
    while (saveInFlight.current) await saveInFlight.current.catch(() => undefined)
    if (!isCurrent()) return false
    let targetId = id || locallyCreatedId.current || ''
    let expectedRevision = contentRevisionRef.current
    if (expectedRevision === null && (targetId || !draftToken)) return false
    if (!silent && isCurrent()) {
      setSaving(true)
      setError('')
      setNotice('')
    }
    // 送った中身。409 のときに「自分の再送か」を確かめるために残す。
    const sentContent: FormSavedContent = {
      name: name.trim(),
      description: description.trim() || null,
      layout,
      onSubmitTagId: onSubmitTagId || null,
      // 未公開の下書きは publish API が成功するまで受付中にしない。
      isActive: publishedVersionId ? isActive : false,
      ogTitle: ogTitle.trim() || null,
      ogDescription: ogDescription.trim() || null,
      ogImageUrl: ogImageUrl.trim() || null,
    }
    const confirmOwnSave = async (): Promise<number | null> => {
      try {
        const latest = await api.forms.get(targetId, selectedAccountId)
        if (!latest.success) return null
        const actual: FormSavedContent = {
          name: latest.data.name,
          description: latest.data.description,
          layout: latest.data.layout,
          onSubmitTagId: latest.data.onSubmitTagId,
          isActive: latest.data.isActive,
          ogTitle: latest.data.ogTitle,
          ogDescription: latest.data.ogDescription,
          ogImageUrl: latest.data.ogImageUrl,
        }
        return formSavedContentMatches(sentContent, actual) ? latest.data.contentRevision : null
      } catch (saveFailure) {
        if (isCurrent()) saveErrors.capture(saveFailure);

        return null
      }
    }
    let reconciledOwnSave = false
    let settle: () => void = () => {}
    saveInFlight.current = new Promise<void>((resolve) => { settle = resolve })
    try {
      if (!targetId && draftToken) {
        const created = await api.forms.createDraft(selectedAccountId, undefined, draftToken)
        if (!created.success) throw new Error(created.error)
        if (!isCurrent()) return false
        const revision = created.data.contentRevision
        if (!Number.isSafeInteger(revision) || !revision || revision < 1) throw new Error('作成した下書きの版を確認できませんでした')
        targetId = created.data.id
        expectedRevision = revision
        locallyCreatedId.current = targetId
        rememberFormDraftCreation(selectedAccountId, draftToken, targetId)
        createdDraft.created(targetId, revision)
        contentRevisionRef.current = revision
        setContentRevision(revision)
        setCreatedId(targetId)
      }
      if (expectedRevision === null) return false
      let res: Awaited<ReturnType<typeof api.forms.update>>
      try {
        res = await api.forms.update(targetId, selectedAccountId, { ...sentContent, expectedContentRevision: expectedRevision })
      } catch (updateError) {
        if (isCurrent()) saveErrors.capture(updateError);

        if (!(updateError instanceof ApiError) || updateError.status !== 409 || updateError.code === 'restaurant_course_unavailable') throw updateError
        const ownRevision = await confirmOwnSave();

        if (ownRevision === null) throw updateError
        reconciledOwnSave = true
        res = { success: true, data: { id: targetId, contentRevision: ownRevision, updatedAt: '' } }
      }
      if (!res.success) {
        if (!silent && isCurrent()) setError(res.error)
        return false
      }
      contentRevisionRef.current = res.data.contentRevision
      if (isCurrent()) {
        createdDraft.saved(res.data.contentRevision, silent && !reconciledOwnSave, targetId)
        setContentRevision(res.data.contentRevision)
        clearConflict()
      }
      if (publishAfter) {
        const published = await api.forms.publish(targetId, selectedAccountId, res.data.contentRevision)
        if (!published.success) {
          if (isCurrent()) setError(published.error)
          return false
        }
        if (!isCurrent()) return false
        setPublishedVersionId(published.data.id)
        setPublishedContentRevision(published.data.contentRevision)
        setIsActive(true)
        const message = published.data.replayed ? 'この版は公開済みです' : 'この版を公開しました'
        notifySaved(message)
        savedSnapshot.current = JSON.stringify({ ...current, isActive: true })
      } else {
        if (!isCurrent()) return false
        if (!silent) {
          notifySaved('下書きを保存しました')
        }
        savedSnapshot.current = reconciledOwnSave
          ? JSON.stringify({
              name: sentContent.name,
              description: sentContent.description ?? '',
              isActive: sentContent.isActive,
              onSubmitTagId: sentContent.onSubmitTagId ?? '',
              ogTitle: sentContent.ogTitle ?? '',
              ogDescription: sentContent.ogDescription ?? '',
              ogImageUrl: sentContent.ogImageUrl ?? '',
              layout: sentContent.layout,
            })
          : currentSnapshot
      }
      if (draftToken && !leaving && currentSnapshotRef.current === currentSnapshot) {
        const tab = readTab(new URLSearchParams(window.location.search).get('tab'))
        disarm()
        router.replace(`/form-submissions/edit?id=${encodeURIComponent(targetId)}&tab=${tab}`, { scroll: false })
      }
      return true
    } catch (e) {
      if (!isCurrent()) return false
      const fieldFailure = saveErrors.capture(e)
      // ほかの人が先に保存していた（409）。入力はそのまま残し、読み直すかは運用者が決める。
      if (e instanceof ApiError && e.code === 'restaurant_course_unavailable') {
        setError('選んだメニューが見つかりません。メニューを選び直してください。')
        return false
      }
      if (e instanceof ApiError && e.status === 409) {
        const data = e.data as { updatedAt?: unknown } | null
        const updatedAt = typeof data?.updatedAt === 'string' ? data.updatedAt : ''
        saveConflict.mark(updatedAt)
        { if (!fieldFailure)
        setError(conflictMessage(updatedAt)) }
        return false
      }
      if (silent) return false
      { if (!fieldFailure)
      setError(describeApiFailure(e, '保存', {
        scope: 'store',
      })) }
      return false
    } finally {
      saveInFlight.current = null
      settle()
      if (!silent && isCurrent()) setSaving(false)
    }
  }

  /*
   * 入力が止まって2秒で下書きへ静かに保存する（一斉配信と同じ）。保存先は
   * 下書きなので、公開中の内容は変わらない。閲覧のみの人には動かさない。
   */
  const autosave = useDraftAutosave({
    fingerprint: currentSnapshot,
    dirty,
    active: !host && canEdit,
    enabled: formLoaded && !loading && !conflict && saveProblem(false) === null,
    paused: leaveTarget !== null || saving || createdDraft.busy || showPublish,
    save: () => save(false, { silent: true }),
  })

  /* 公開前の試し：試し合言葉を取って試しURLを作る。試しは保存済みの下書きに出る。 */
  const startTest = async () => {
    if (!canEdit || !selectedAccountId || !id || testBusy) return
    setTestBusy(true)
    setTestError('')
    try {
      const res = await api.forms.issueTestToken(id, selectedAccountId)
      if (!res.success) throw new Error(res.error)
      setTestToken(res.data.token)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setTestError('試し合言葉を作れませんでした。もう一度お試しください。') }
    } finally {
      setTestBusy(false)
    }
  }
  const testUrl = answerUrl && testToken ? `${answerUrl}${answerUrl.includes('?') ? '&' : '?'}test_token=${encodeURIComponent(testToken)}` : null


  /* ---------------- 対象が無いとき ---------------- */

  if (!host && !id && !draftToken) {
    return <SaveErrorScope errors={saveErrors}><TargetMissing kind="unspecified" title="編集する回答フォームが指定されていません" description="一覧から編集するフォームを選び直してください。" backHref="/form-submissions" backLabel="回答フォーム一覧へ戻る" /></SaveErrorScope>
  }
  if (!host && !loading && !selectedAccountId) {
    return <SaveErrorScope errors={saveErrors}><ListState kind="empty" title="LINE公式アカウントを選んでください" description="選ぶとフォームを編集できます。" /></SaveErrorScope>
  }
  if (!loading && formLoadFailed === 'missing') {
    return <SaveErrorScope errors={saveErrors}><TargetMissing kind="not-found" title="このフォームは見つかりません" description="削除されたか、リンクが古くなっています。一覧から選び直してください。" accountName={selectedAccount?.name} backHref="/form-submissions" backLabel="回答フォーム一覧へ戻る" /></SaveErrorScope>
  }
  if (!loading && formLoadFailed === 'error' && !formLoaded) {
    return (
      <SaveErrorScope errors={saveErrors}><TargetMissing
        kind="error"
        title="フォームを読み込めませんでした"
        description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。"
        onRetry={() => {
          setLoading(true)
          setReloadKey((k) => k + 1)
        }}
      /></SaveErrorScope>
    )
  }
  if (!loading && formLoadFailed === 'forbidden' && !formLoaded) {
    return <SaveErrorScope errors={saveErrors}><TargetMissing kind="not-found" title="このフォームを開く権限がありません" description="選んでいるアカウントでは開けません。アカウントを選び直すか、管理者に権限を確認してください。" accountName={selectedAccount?.name} backHref="/form-submissions" backLabel="回答フォーム一覧へ戻る" /></SaveErrorScope>
  }

  /* ---------------- 画面 ---------------- */

  const statusLine = host ? host.statusLine : !publishedVersionId
    ? '下書き・まだ公開していません'
    : dirty || (publishedContentRevision !== null && contentRevision !== null && publishedContentRevision !== contentRevision)
      ? '下書き・公開中と違います'
      : '公開中の版と同じです'
  const saveStatus = host ? (dirty ? '保存していない変更があります' : undefined) : autosave.label
    ? <span aria-live="polite" data-autosave-status>{autosave.failed ? '自動保存できませんでした' : autosave.label}</span>
    : dirty ? '保存していない変更があります' : undefined
  const shortState = statusLine.split('（')[0]
  const retryAutosave = autosave.failed && !conflict

  const savedSide: ConflictSide | null = (() => {
    if (!savedSnapshot.current) return null
    const saved = JSON.parse(savedSnapshot.current) as Snapshot
    return { name: saved.name, description: saved.description, layout: saved.layout }
  })()
  const publishChanges = describePublishChanges(publishedSide ?? savedSide, { name, description, layout })

  /* 「答え終わったあと」のタブでは、質問の画面ではなくお礼の画面を映す。 */
  const phone = (
    <FormPhone formName={name} accountLook={customerLook.look} layout={layout} pageIndex={page} accountName={host ? host.accountName : selectedAccount?.name ?? '公式アカウント'} bookingMenus={refs.bookingMenus ?? []} fixedNext={editTab !== 'after'} focusBlockId={editTab === 'after' ? null : selectedBlockId} thanks={editTab === 'after' ? { text: layout.options.thanksText ?? '', url: layout.options.thanksUrl ?? null } : undefined} />
  )

  const preview = (
    <div className={styles.rail} data-fe-rail>
      <Button className={styles.previewOpen} onClick={() => setPreviewOpen(true)}>
        <Smartphone size={16} aria-hidden="true" />
        LINEでの見え方を見る
      </Button>
      {host ? (
        /* 統括：回答用URLは配った先のアカウントごとに出る。ここは配った先だけ。 */
        <section className={styles.urlBox} aria-label="配った先">
          <h2 className={styles.urlTitle}>配った先</h2>
          <p className={styles.urlNote}>{host.distributedLine}</p>
        </section>
      ) : (
      <section className={styles.urlBox} aria-label="回答用URL">
        <h2 className={styles.urlTitle}>回答用URL</h2>
        {answerUrl ? (
          <>
            <div className={styles.urlRow}>
              {/* 長いURLも末尾まで読めるよう折り返す。表示・title・コピーは同じ全文。 */}
              <span className={styles.urlValue} title={answerUrl}>{answerUrl}</span>
              <CopyTextButton variant="secondary" icon={<Copy size={16} aria-hidden="true" />} value={answerUrl} label="コピーする" aria-label="回答用URLをコピー" />
            </div>
            <p className={styles.urlNote}>{publishedVersionId ? '友だちに配るURLです。LINEの中で開きます。' : '公開すると開けます。公開前は回答を受け付けません。'}</p>
            {canEdit ? (
              <div className={styles.urlTest}>
                <Button onClick={() => void startTest()} disabled={testBusy} busy={testBusy} busyLabel="用意しています…" title="保存済みの下書きをお客さま画面で開きます。試しの回答は集計に入りません">
                  <FlaskConical size={16} aria-hidden="true" />
                  <span className={styles.testWide}>公開前に試す（試しのURLを作る）</span>
                  <span className={styles.testNarrow}>公開前に試す</span>
                </Button>
              </div>
            ) : null}
            {testError ? <Notice tone="danger" className={styles.urlErrorNoticePlacement} >{testError}</Notice> : null}
            {testUrl ? (
              <TextLink external href={testUrl}   className={styles.urlLink}>試しの画面へ</TextLink>
            ) : null}
          </>
        ) : (
          <p className={styles.urlNote}>{draftToken && !id ? '最初に下書きを保存すると、回答用URLが表示されます。' : '回答用URLを発行する設定がまだありません。LINEアカウント設定を確認してください。'}</p>
        )}
      </section>
      )}
      <div className={styles.phoneArea}>{phone}</div>
    </div>
  )

  const hostBusy = saving || Boolean(host?.busy)
  const footerActions = host ? (
    <>
      <Button onClick={() => requestUnsavedAction(host.onCancel)} disabled={hostBusy}>キャンセル</Button>
      {host.readOnly ? null : (
        <>
          <Button onClick={() => void save(false)} disabled={hostBusy} busy={hostBusy} busyLabel="保存中…" title="ひな形を保存（配った先は変わりません）">
            下書きを保存
          </Button>
          <Button variant="primary" onClick={() => void save(true)} disabled={hostBusy} title="保存したあとに、配るアカウントを選べます" busy={Boolean(hostBusy)} busyLabel="処理中…">
            保存して配る
          </Button>
        </>
      )}
    </>
  ) : (
    <>
      <Button href="/form-submissions">キャンセル</Button>
      {canEdit ? (
        <>
          {!conflict ? <Button variant={retryAutosave ? 'primary' : 'secondary'} onClick={() => void save(false).then((ok) => { if (ok) autosave.markSaved() })} disabled={saving} busy={saving} busyLabel="保存中…" title="フォームを保存（公開中の内容は変わりません）">
            下書きを保存
          </Button> : null}
          {conflict ? (
            <Button variant="primary" onClick={() => void saveConflict.compare()} disabled={saveConflict.compareBusy || saving}>
              比べてから保存
            </Button>
          ) : (
            <Button variant={retryAutosave ? 'secondary' : 'primary'} onClick={() => setShowPublish(true)} disabled={saving}>
              <Upload size={16} aria-hidden="true" />
              この版を公開
            </Button>
          )}
        </>
      ) : null}
    </>
  )

  /* 競合は画面の通知欄へ出し、プレビューの表示幅に依存させない。 */
  const conflictBand = canEdit && conflict ? (
      <SaveConflictBand
        designNode="J1pdB"
        title={conflictTitle(conflict.updatedAt, name)}
        compareBusy={saveConflict.compareBusy}
        onCompare={() => void saveConflict.compare()}
        onReload={() => void saveConflict.reloadLatest()}
      />
  ) : undefined

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage
      boardId={narrow ? 'ITBAB' : conflict ? 'J1pdB' : TAB_NODE[editTab]}
      title={title}
      help="回答フォームの内容・回答後の動作・受付条件を設定します。"
      separator="none"
      stepsSpacing="compact"
      steps={(
        <div className={styles.tabs}>
          <Tabs label="編集する内容" items={TAB_ITEMS.map((t) => ({ label: t.label, current: editTab === t.key, errorCount: tabErrors[t.key], onClick: () => changeTab(t.key) }))} />
        </div>
      )}
      notice={readOnly ? <ReadOnlyNotice >閲覧のみで見ています。変える操作は管理者に頼んでください。</ReadOnlyNotice> : conflictBand}
      preview={preview}
      footerActions={footerActions}
      status={<span className={styles.saveSummary} data-status-line><span>{saveStatus ?? shortState}</span><HelpTip label="公開・配布の状態">{statusLine}</HelpTip></span>} dirty={false}
    >
      <FormEditAttemptContext.Provider value={attempted}>
      <div className={styles.root} data-fe-root>
        {host?.notice}
        {referencesError?<ListState kind="error" title="候補を読み込めませんでした" onRetry={()=>{setReferencesError(false);setError('');setReloadKey(value=>value+1)}}/>:null}
        {Object.keys(bookingStaffErrors).length > 0 ? <ListState kind="error" title="予約の担当を読み込めませんでした" onRetry={()=>setBookingStaffErrors({})}/>:null}
        {!conflict && error ? <Notice tone="danger" message={error} onClose={() => setError('')} /> : null}
        {notice ? <Notice tone="success" message={notice} onClose={() => setNotice('')} /> : null}
        {loading || !formLoaded ? (
          <ListState kind="loading" />
        ) : editTab === 'content' ? (
          <ContentTab
            readOnly={!canEdit}
            nameField={<FormNameField value={name} error={nameError} readOnly={!canEdit} onChange={changeName} onBlur={blurName} />}
            layout={layout}
            page={page}
            blocks={blocks}
            refs={refs}
            bookingStaffErrors={bookingStaffErrors}
            selectedBlockId={selectedBlockId}
            inputCount={inputCount}
            accountId={host ? null : selectedAccountId}
            portable={Boolean(host)}
            onSelectPage={selectPage}
            onAddPage={addSection}
            onRenamePage={renameSection}
            onDuplicatePage={duplicateSection}
            onRemovePage={removeSection}
            canUndoPageRemoval
            onSelectBlock={setSelectedBlockId}
            onAddBlock={addBlock}
            onPatchBlock={patchBlock}
            onMoveBlock={moveBlock}
            onDuplicateBlock={duplicateBlock}
            onRemoveBlock={removeBlock}
            routing={routingOf(layout)}
            onChangeRouting={host ? undefined : patchRouting}
            references={layout.references ?? []}
            referenceStates={publishedReferences}
            hasPublishedVersion={Boolean(publishedVersionId)}
            onChangeReferences={host ? () => {} : (next) => setLayout((prev) => ({ ...prev, references: next }))}
          />
        ) : editTab === 'after' ? (
          <AfterTab readOnly={!canEdit} options={layout.options} refs={refs} onSubmitTagId={onSubmitTagId} onChangeOptions={patchOptions} onChangeSubmitTag={setOnSubmitTagId} />
        ) : (
          <AppearanceTab
            readOnly={!canEdit}
            options={layout.options}
            accountLook={customerLook.look}
            accountLookError={customerLook.error}
            accountId={host ? null : selectedAccountId}
            portable={Boolean(host)}
            name={name}
            nameError={nameError}
            description={description}
            ogTitle={ogTitle}
            ogDescription={ogDescription}
            ogImageUrl={ogImageUrl}
            onChangeOptions={patchOptions}
            onChangeName={changeName}
            onBlurName={blurName}
            onChangeDescription={setDescription}
            onChangeOgTitle={setOgTitle}
            onChangeOgDescription={setOgDescription}
            onChangeOgImageUrl={setOgImageUrl}
          />
        )}
      </div>
      </FormEditAttemptContext.Provider>

      <UnsavedLeaveDialog open={leaveTarget !== null} subject="フォームへの変更" busy={saving || createdDraft.busy}
        description={createdDraft.owned ? '自動で作られた下書きがあります。残すか、消して移るか選んでください。' : undefined}
        saveLabel={createdDraft.owned ? '下書きを残して移る' : '下書きに保存して移る'} discardLabel={createdDraft.owned ? '下書きを消して移る' : undefined}
        discardDisabled={createdDraft.owned && !canManageRole(role)} discardLockedReason={createdDraft.owned ? draftDeleteLock : undefined}
        error={createdDraft.error} saveDisabled={!canEdit || loading || Boolean(host?.busy)} onSave={() => save(false, { leaving: true })} onSavedLeave={finishLeave}
        onConfirm={createdDraft.owned ? () => void createdDraft.discard(finishLeave) : confirmLeave} onCancel={cancelDraftLeave} />

      <Dialog
        open={canEdit && showPublish}
        title="この版を公開する"
        designHeaderPadding="var(--tpl-fm2-dialog-head-pad)"
        busy={saving}
        error={error || undefined}
        designNode="Z9wXm"
        designWidth={640}
        designTop={220}
        footer={<></>}
        onCancel={() => setShowPublish(false)}
      >
        {/* 絵は頭（題と×）・説明・変わること・残ること・ボタンを 14 ずつで並べる。共通の窓の中身の余白（上下24）を詰める。 */}
        <div className={styles.publishBody}>
          <OperationTargetSummary accounts={[{ id: selectedAccountId ?? '' }]} />
          <p className={styles.publishLead}>公開すると、配っている URL を開いた人に新しい内容が出ます。</p>
          <div className={styles.changes}>
            <p className={styles.changesTitle}>
              {publishedContentRevision !== null && contentRevision !== null && publishedContentRevision !== contentRevision
                ? `変わること（版${publishedContentRevision} → 版${contentRevision}）`
                : '変わること'}
            </p>
            {publishChanges.length === 0 ? (
              <p className={styles.changeLine}>保存した下書きをそのまま公開します</p>
            ) : (
              publishChanges.map((line, index) => (
                <p key={index} className={styles.changeLine} data-kind={line.kind}>
                  {line.kind === 'add' ? '＋ ' : line.kind === 'remove' ? '－ ' : '・'}
                  {line.text}
                </p>
              ))
            )}
          </div>
          <ul className={styles.publishNotes}>
            <li>・すでに集まった回答（{polishFormatNumber(submitCount)} 件）は消えません。消した質問の答えも残ります。</li>
            <li>{publishedContentRevision !== null ? `・公開するまで、いまの版${publishedContentRevision}がそのまま使われます。` : '・公開するまで、いまの版がそのまま使われます。'}</li>
          </ul>
          {/* 絵の操作は真ん中（下の帯と同じ）。窓の既定の右寄せの帯は使わない。 */}
          <div className={styles.publishActions}>
            <Button onClick={() => setShowPublish(false)} disabled={saving}>キャンセル</Button>
            <Button
              variant="primary"
              disabled={saving}
              busy={saving}
              busyLabel="公開しています…"
              onClick={() => {
                void (async () => {
                  const ok = await save(true)
                  if (ok) setShowPublish(false)
                })()
              }}
            >
              <Upload size={16} aria-hidden="true" />
              この版を公開
            </Button>
          </div>
        </div>
      </Dialog>

      <SaveConflictCompareDialog
        open={canEdit && saveConflict.compareOpen}
        busy={saveConflict.compareBusy}
        error={saveConflict.compareError}
        {...(saveConflict.latest
          ? describeConflictDiff({ name, description, layout }, saveConflict.latest)
          : { lines: null, omitted: 0 })}
        onReload={() => void saveConflict.reloadLatest()}
        onCancel={saveConflict.closeCompare}
      />

      <Dialog open={previewOpen} title="LINEでの見え方" description="お客さまのスマホに出る形です。" onCancel={() => setPreviewOpen(false)}>
        <div className={styles.phoneDialog}>{phone}</div>
      </Dialog>
    </CreatePage></SaveErrorScope>
  )
}

export default function FormEditV8({ host }: { host?: FormEditHost } = {}) {
  // useSearchParams は Suspense の中でしか使えない（静的書き出しのため）。
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <PageResourceScope enabled={!host} queryKeys={['id', 'new']}><FormEditInner host={host} /></PageResourceScope>
    </Suspense>
  )
}
