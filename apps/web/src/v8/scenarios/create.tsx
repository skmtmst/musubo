'use client'
import { japaneseDetailOf, describeApiFailure } from '@/components/shared/api-error-message'
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from '@/components/shared/list-navigation'

import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { CalendarClock, Check, Timer } from 'lucide-react';
import type { DeliveryMode, Folder, Scenario } from '@line-crm/shared';
import { ApiError, api } from '@/lib/api';
import { CreatePage } from '@/components/templates';
import { Steps } from '@/components/templates/steps';
import FolderSelect, { FolderCreateError, folderById, folderCreator } from '@/components/shared/folder-select';
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import HelpTip from '@/components/shared/help-tip'
import Notice from '@/components/shared/notice'
import { browserDraftKey } from '@/v8/autosave/public/use-browser-draft/index'
import { scenarioDraftStatus, BrowserDraftNotice, ScenarioDraftConflictNotice } from '@/v8/autosave/public/browser-draft-notice/index'
import { forgetNewScenarioDraftKey, newScenarioDraftKey, scenarioDraftKey, useScenarioDraft } from '@/v8/autosave/public/use-scenario-draft/index'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card';
import { TextField } from '@/components/shared/text-field';
import { Field } from '@/components/shared/form-controls';
import { SettingsFormRow } from '@/components/shared/settings-form-card';
import { isForbiddenOrRateLimited, loadFailureCopy, permissionDeniedMessage } from '@/components/shared/api-error-message';
import TargetMissing from '@/components/shared/target-missing'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { useAccount } from '@/contexts/account-context';
import { captureScenarioWriteAccess, useScenarioWriteAccess } from './write-access'
import { scenarioReferenceData } from '@/components/scenarios/scenario-reference-data';
import styles from './create.module.css'
import DeliveryModeDiagram from './delivery-mode-diagram'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import ReadOnlyNotice from '@/components/shared/read-only-notice'

/*
 * ★V8 シナリオを作る①：シナリオ情報・配信方式（Pencil ）。
 *
 * 型（CreatePage）に、戻る・題・手順の輪と、左の段（シナリオ情報・配信方式）、
 * 下の帯（キャンセル・あとで決める・この方式で保存する）を渡す。右の列は無い。
 *
 * 動き（読み込み・保存・失敗時）は今までの V8（app/scenarios/mode-v8.tsx）と
 * 管理画面（app/scenarios/mode/page.tsx）と同じ。写して型に載せ直した。
 * `id` なしで開いたときはまだ行を作らない。方式の確定か
 * 「あとで決める」ではじめて作成する（N-055）。
 */

export default function ScenarioCreateV8() {
  const saveErrors = useSaveFormErrors()
  const pageTitle = 'シナリオを作る'
  usePageTitle(pageTitle)
  usePageCrumbs([{ label: 'シナリオ配信', href: '/scenarios' }])
  const router = useRouter()
  const params = useSearchParams()
  const id = params.get('id') ?? ''
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const access = useScenarioWriteAccess()
  const canEdit = access.allowed
  const folderAccess = useScenarioWriteAccess('manageFolders')
  const [scenario, setScenario] = useState<Scenario | null>(null)
  // id なしは「これから作る」。読み込む行が無いので最初から入力できる。
  const [scenarioState, setScenarioState] = useState<'loading' | 'ready' | 'error'>(
    id ? 'loading' : 'ready',
  )
  const [scenarioError, setScenarioError] = useState<unknown>(null)
  const [scenarioReloadKey, setScenarioReloadKey] = useState(0)
  const [saving, setSaving] = useState<DeliveryMode | null>(null)
  // 絵どおり、はじめは「時刻で指定」（おすすめの方）を選んでおく。既存の行は保存済みの方式。
  const [selectedMode, setSelectedMode] = useState<DeliveryMode>('absolute_time')
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState('')
  const nameWrapRef = useRef<HTMLDivElement>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderId, setFolderId] = useState('')
  const [folderState, setFolderState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detailsSaving, setDetailsSaving] = useState(false)
  const detailsSavePromise = useRef<Promise<boolean> | null>(null)
  const scope = useRef({ id, accountId: selectedAccountId, loading: accountLoading })
  const mounted = useRef(true)
  if (scope.current.id !== id || scope.current.accountId !== selectedAccountId || scope.current.loading !== accountLoading) {
    scope.current = { id, accountId: selectedAccountId, loading: accountLoading }
  }
  const renderedScope = scope.current
  const detailsScope = useRef(renderedScope)
  if (detailsScope.current !== renderedScope) { detailsScope.current = renderedScope; detailsSavePromise.current = null }
  const currentScope = () => mounted.current && scope.current === renderedScope
  const editLease = captureScenarioWriteAccess()
  const folderLease = captureScenarioWriteAccess('manageFolders')
  const canSaveNow = () => currentScope() && !accountLoading && editLease()
  const liveAccess = useRef(access)
  liveAccess.current = access
  const requireWrite = () => {
    if (canSaveNow()) return true
    if (currentScope() && (liveAccess.current.known && liveAccess.current.allowed)) {
      setError('本人や権限の確認状態が変わったため、操作を中止しました。内容を確認してから、もう一度操作してください。')
    }
    return false
  }
  const created = useRef<{ scope: typeof renderedScope; id: string } | null>(null)
  const saveOperation = useRef<{ scope: typeof renderedScope } | null>(null)
  const runSave = (task: () => Promise<void>): Promise<void> => {
    if (!requireWrite() || saveOperation.current?.scope === renderedScope) return Promise.resolve()
    const ticket = { scope: renderedScope }
    saveOperation.current = ticket
    return task().finally(() => { if (saveOperation.current === ticket) saveOperation.current = null })
  }
  const [createdId, setCreatedId] = useState<string | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { setSaving(null); setDetailsSaving(false); setCreatedId(null); setError('') }, [renderedScope])

  /**
   * 名前とフォルダを先に保存する。方式を選ぶ前に閉じても、分類は残る。
   * id なし（これから作る）のときは保存先が無いので、画面の中に持つだけ。
   */
  const saveDetails = (nextFolderId = folderId, fromExplicitSave = false): Promise<boolean> => {
    if (!requireWrite()) return Promise.resolve(false)
    if (!fromExplicitSave && saveOperation.current?.scope === renderedScope) return Promise.resolve(false)
    if (!id) return Promise.resolve(true)
    if (detailsSavePromise.current) return detailsSavePromise.current
    const trimmed = name.trim()
    const nextFolder = nextFolderId || null
    if (!scenario || !trimmed) return Promise.resolve(false)
    const nameToSave = name === scenario.name ? scenario.name : trimmed
    if (nameToSave === scenario.name && nextFolder === (scenario.folderId ?? null)) {
      return Promise.resolve(true)
    }

    const operation = (async () => {
      setDetailsSaving(true)
      setError('')
      try {
        const res = await api.scenarios.update(id, { name: nameToSave, folderId: nextFolder })
        if (!requireWrite()) return false
        if (!res.success) {
          setError('シナリオ情報を保存できませんでした。時間をおいてもう一度お試しください。')
          setFolderId(scenario.folderId ?? '')
          return false
        }
        setScenario(res.data)
        scenarioReferenceData.invalidateScenario(id)
        setName(res.data.name)
        setFolderId(res.data.folderId ?? '')
        return true
      } catch (cause) {
        if (!requireWrite()) return false
        const fieldFailure = saveErrors.capture(cause)

        { if (!fieldFailure)

        setError(scenarioSaveError(cause)) }
        setFolderId(scenario.folderId ?? '');

        return false
      } finally {
        if (currentScope()) setDetailsSaving(false)
      }
    })()
    detailsSavePromise.current = operation
    void operation.finally(() => {
      if (detailsSavePromise.current === operation) detailsSavePromise.current = null
    })
    return operation
  }

  useEffect(() => {
    let active = true
    // id があるときだけ既存の行を読む。新規（id なし）は読む行が無い。
    if (id) {
      setScenarioState('loading')
      setScenarioError(null)
      void scenarioReferenceData.scenario(id)
        .then((res) => {
          if (!active) return
          if (res.success) {
            setScenario(res.data)
            setName(res.data.name)
            setFolderId(res.data.folderId ?? '')
            if (res.data.deliveryMode === 'elapsed' || res.data.deliveryMode === 'absolute_time') {
              setSelectedMode(res.data.deliveryMode)
            }
            setScenarioState('ready')
          } else {
            setScenarioError(null)
            setScenarioState('error')
          }
        })
        .catch((caught) => {
          if (active) {
            setScenarioError(caught)
            setScenarioState('error')
          }
        })
    }
    return () => { active = false }
  }, [id, scenarioReloadKey])

  /*
   * フォルダはアカウント単位。シナリオの所属アカウント（共通なら選択中の
   * アカウント）の候補だけを出し、切り替わったら取り直す（SCENARIO-20）。
   */
  const folderAccountId = scenario?.lineAccountId ?? selectedAccountId
  useEffect(() => {
    let active = true
    setFolderState('loading')
    void api.folders.list('scenario', folderAccountId ?? undefined)
      .then((res) => {
        if (!active) return
        if (res.success) {
          setFolders(res.data)
          setFolderState('ready')
        } else {
          setFolderState('error')
        }
      })
      .catch(() => {
        if (active) setFolderState('error')
      })
    return () => { active = false }
  }, [folderAccountId])

  /** 名前が空のまま押したら、欄の下にも理由を出して欄へ移す（R172）。止めたとき真。 */
  const rejectEmptyName = (): boolean => {
    if (name.trim()) return false
    // 上の帯には出さない：欄を赤くして欄の下に理由を出し、欄へ移す（2026-10-08 オーナー「重複している」）。
    setNameError('シナリオ名を入力してください')
    const input = nameWrapRef.current?.querySelector('input')
    if (input) {
      input.focus()
      input.scrollIntoView({ block: 'center' })
    }
    return true
  }

  /** 行をまだ作っていない（id なし）ときの作成。方式を確定したこの瞬間に初めて作る（N-055）。 */
  const createNew = async (mode: DeliveryMode): Promise<string | null> => {
    if (!requireWrite()) return null
    if (created.current?.scope === renderedScope) {
      setError('作成済みのシナリオがあります。下の案内から開いてください。')
      return null
    }
    const trimmed = name.trim()
    if (!trimmed) {
      rejectEmptyName()
      return null
    }
    const res = await api.scenarios.create({
      name: trimmed,
      description: null,
      triggerType: 'friend_add',
      triggerTagId: null,
      lineAccountId: selectedAccountId,
      isActive: false,
      deliveryMode: mode,
      folderId: folderId || null,
    })
    if (res.success && currentScope()) {
      created.current = { scope: renderedScope, id: res.data.id }
      setCreatedId(res.data.id)
    }
    if (!requireWrite()) return null
    if (!res.success) {
      // API の内部の文はそのまま出さない（画面は決まった言葉で断る）。
      setError('シナリオを作成できませんでした。時間をおいてもう一度お試しください。')
      return null
    }
    return res.data.id
  }

  const choose = (mode: DeliveryMode) => runSave(async () => {
    if (!requireWrite()) return
    if (id && !scenario) return
    if (detailsSavePromise.current) {
      const saved = await detailsSavePromise.current
      if (!requireWrite()) return
      if (!saved) return
    }
    setSaving(mode)
    setError('')
    setNameError('')
    const trimmed = name.trim()
    if (!trimmed) {
      rejectEmptyName()
      setSaving(null)
      return
    }
    try {
      if (!id) {
        // 新規。名前・フォルダ・方式をまとめて1回で作る。
        const createdId = await createNew(mode)
        if (!requireWrite()) { if (currentScope()) setSaving(null); return }
        if (!createdId) {
          setSaving(null)
          return
        }
        finishDraft()
        router.push(`/scenarios/first-step?id=${encodeURIComponent(createdId)}`)
        return
      }
      // 名前と方式は同じ受け口で一度に保存する。
      const res = await api.scenarios.update(id, {
        name: scenario && name === scenario.name ? scenario.name : trimmed,
        folderId: folderId || null,
        deliveryMode: mode,
      })
      if (!requireWrite()) { if (currentScope()) setSaving(null); return }
      if (!res.success) {
        setError('配信方式を保存できませんでした。時間をおいてもう一度お試しください。')
        setSaving(null)
        return
      }
      scenarioReferenceData.invalidateScenario(id)
      finishDraft()
      // 3段目へ。手順の帯が3段なので、2段で編集画面へ放り出さない。
      router.push(`/scenarios/first-step?id=${encodeURIComponent(id)}`)
    } catch (cause) {
      if (!requireWrite()) { if (currentScope()) setSaving(null); return }
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)

      setError(id ? scenarioModeError(cause) : 'シナリオを作成できませんでした。時間をおいてもう一度お試しください。') }
      setSaving(null)
    }
  })

  const continueAsDraft = () => runSave(async () => {
    if (!requireWrite()) return
    if (detailsSaving) return
    if (id && !scenario) return
    if (!id) {
      // 新規で「あとで決める」も行を作る確定操作。方式は暫定で「時刻で指定」。
      setDetailsSaving(true)
      setError('')
      setNameError('')
      try {
        const createdId = await createNew('absolute_time')
        if (!requireWrite()) return
        if (createdId) {
          finishDraft()
          router.push(`/scenarios/first-step?id=${encodeURIComponent(createdId)}`)
        }
      } catch (saveFailure) {
        if (!requireWrite()) return
        const fieldFailure = saveErrors.capture(saveFailure)
        // WEB226：通信の失敗（例外）も、方式を選んだときと同じ言葉で出す（黙って何も起きない、にしない）。
        { if (!fieldFailure)

        setError('シナリオを作成できませんでした。時間をおいてもう一度お試しください。') }
      } finally {
        if (currentScope()) setDetailsSaving(false)
      }
      return
    }
    const saved = await saveDetails(folderId, true)
    if (!requireWrite()) return
    if (saved) {
      finishDraft()
      router.push(`/scenarios/first-step?id=${encodeURIComponent(id)}`)
    } else if (!name.trim()) {
      rejectEmptyName()
    }
  })

  /*
   * 書きかけはシナリオの下書きの口（本物とは別の行・配信に使わない・30日で消える）へ残す。
   * 名前と方式を決めるまで本物のシナリオの行は作らない（N-055）。新規のキーは画面が作る UUID。
   */
  const draftAccountId = scenario?.lineAccountId ?? selectedAccountId
  const [newDraftKey, setNewDraftKey] = useState<string | null>(null)
  useEffect(() => {
    setNewDraftKey(!id && canEdit && selectedAccountId ? newScenarioDraftKey(selectedAccountId) : null)
  }, [id, canEdit, selectedAccountId])
  const browserDraft = useScenarioDraft({
    accountId: draftAccountId,
    draftKey: scenarioState === 'ready' && (!id || scenario)
      ? id ? scenarioDraftKey(id, 'info') : newDraftKey
      : null,
    // 共通（アカウントなし）のシナリオは本物に紐づけられないので、キーだけで置く。
    scenarioId: id && scenario?.lineAccountId ? id : null,
    legacyKey: browserDraftKey(['scenario-create', draftAccountId, id || 'new']),
    value: { name, folderId, mode: selectedMode },
    baseline: scenario
      ? {
          name: scenario.name,
          folderId: scenario.folderId ?? '',
          mode: scenario.deliveryMode === 'elapsed' ? 'elapsed' : 'absolute_time',
        }
      : { name: '', folderId: '', mode: 'absolute_time' },
    active: canEdit && !accountLoading,
    canSaveNow,
  })
  /** 本物を保存した・キャンセルした。下書きを消し、次の新規は新しいキーで始める。 */
  const finishDraft = () => {
    if (!canSaveNow()) return
    browserDraft.clear()
    if (!id) forgetNewScenarioDraftKey(selectedAccountId)
  }
  const cancel = () => {
    finishDraft()
    router.push('/scenarios')
  }
  const loadLatestDraft = () => {
    const latest = browserDraft.loadLatest()
    if (latest) applyDraft(latest)
  }
  const restoreBrowserDraft = () => {
    const stored = browserDraft.restore()
    if (stored) applyDraft(stored)
  }
  function applyDraft(stored: { name: string; folderId: string; mode: string }) {
    setName(stored.name)
    setFolderId(stored.folderId)
    if (stored.mode === 'elapsed' || stored.mode === 'absolute_time') setSelectedMode(stored.mode)
  }

  const selectedFolderName = folderState === 'loading'
    ? '読み込み中…'
    : folderState === 'error'
      ? '確認できません'
      : folders.find((folder) => folder.id === folderId)?.name
        ?? (folderId ? '名前を確認できません' : '未分類')
  const selectedFolderMissing = Boolean(folderId && !folders.some((folder) => folder.id === folderId))

  const locked = (Boolean(id) && !scenario) || detailsSaving || saving !== null
  const fieldsDisabled = locked || !canEdit || accountLoading
  const scenarioFailure = scenarioError ? loadFailureCopy(scenarioError, 'シナリオ') : null
  const useCommonReason = scenarioError ? isForbiddenOrRateLimited(scenarioError) : false

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage
      stepsSpacing="compact"
      boardId="dnzqC"
      title={pageTitle}
      help="名前とフォルダを決め、配信方式を選んでから1通目を設定します。作ったあとは配信方式を変えられません。"

      steps={(
        <Steps
          label="シナリオ作成の進み方"
          steps={[
            { label: 'シナリオ情報・配信方式', state: 'current' },
            { label: '1通目を設定', state: 'todo' },
          ]}
        />
      )}
      status={saving ? '作成しています' : detailsSaving ? '保存しています' : scenarioDraftStatus(browserDraft.label) ?? undefined}
      footerActions={(
        <>
          <Button type="button" onClick={cancel}>キャンセル</Button>
          <Button
            disabled={locked || !canEdit || accountLoading || !name.trim() || Boolean(createdId)}
            lockedReason={access.reason}
            disabledReason={canEdit && !accountLoading && !name.trim() ? 'シナリオ名を入力してください' : undefined}
            onClick={() => continueAsDraft()}
            busy={Boolean(detailsSaving)}
            busyLabel="処理中…"
          >
            あとで決める（下書きとして保存）
          </Button>
          <Button
            variant="primary"
            disabled={locked || !canEdit || accountLoading || !name.trim() || Boolean(createdId)}
            lockedReason={access.reason}
            disabledReason={canEdit && !accountLoading && !name.trim() ? 'シナリオ名を入力してください' : undefined}
            onClick={() => choose(selectedMode)}
            busy={saving !== null}
            busyLabel="作成中…"
          >
            <Check size={16} aria-hidden="true" />この方式で保存する
          </Button>
        </>
      )}
    >
      <div className={styles.notices} data-list-state={scenarioState} aria-busy={scenarioState === 'loading'}>
        {access.reason ? <ReadOnlyNotice need="feature" /> : null}
        {scenarioState === 'loading' ? <Notice tone="info">シナリオを読み込んでいます。</Notice> : null}
        {scenarioState === 'ready' && scenario ? (
          <Notice tone="info">「{scenario.name}」の下書きを作りました。続けて配信方式を選んでください。</Notice>
        ) : null}
        {/* id なしはまだ作っていない。確定するまで行は作らない（N-055）。 */}
        {!id ? (
          <Notice tone="info">シナリオ名と配信方式を決めると作られます。途中で閉じても一覧には残りません。</Notice>
        ) : null}
        {/* id ありの読み込み失敗は読み直し口つきの1枚。403・429 だけ共通の理由に切り替える。 */}
        {id && scenarioState === 'error' ? (
          <TargetMissing
            kind="error"
            title={useCommonReason && scenarioFailure ? scenarioFailure.title : 'シナリオを読み込めませんでした'}
            description={
              useCommonReason && scenarioFailure
                ? `配信方式の選択・保存はできません。${scenarioFailure.description}`
                : '配信方式の選択・保存はできません。通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。'
            }
            error={scenarioError ?? undefined}
            onRetry={() => setScenarioReloadKey((key) => key + 1)}
          />
        ) : null}
        {error ? <Notice tone="danger" message={error} onClose={() => setError('')} /> : null}
        {createdId ? <Notice tone="info">作成したシナリオは保存されています。<Link href={`/scenarios/detail?id=${encodeURIComponent(createdId)}`}>作成済みのシナリオを見る</Link></Notice> : null}
        <BrowserDraftNotice ago={browserDraft.pendingAgo} onRestore={restoreBrowserDraft} onDiscard={browserDraft.clear} />
        <ScenarioDraftConflictNotice ago={browserDraft.conflictAgo} onLoadLatest={loadLatestDraft} onOverwrite={browserDraft.overwrite} />
      </div>

      <Card variant="form" gap="normal" aria-label="シナリオ情報" id="scenario-step-info">
        <CardHeader size="stacked" title="シナリオ情報" />
        <SettingsFormRow layout="name-folder">
          <div ref={nameWrapRef}>
            <Field label="シナリオ名" required count={{ value: name.length, max: 60 }} error={nameError} errorId="scenario-name-error">
            <SaveErrorField names={["name"]}><TextField
              value={name}
              disabled={fieldsDisabled}
              onChange={(e) => { if (!canSaveNow()) return; setName(e.target.value); if (nameError) setNameError('') }}
              onBlur={() => void saveDetails()}
              maxLength={60}
              placeholder="例：友だち追加ウェルカム"
              invalid={Boolean(nameError)}
              aria-label="シナリオ名"
              aria-describedby={nameError ? 'scenario-name-error' : undefined}
            /></SaveErrorField>
            </Field>
          </div>
          <Field label="フォルダ" optional note={folderState !== 'ready' || detailsSaving
            ? folderState === 'loading' ? 'フォルダを読み込んでいます。' : folderState === 'error' ? 'フォルダを確認できないため、いまは変更できません。' : 'フォルダを保存しています。'
            : undefined}>
            <span title={selectedFolderName}>
              <SaveErrorField names={["folderId","folder_id"]}><FolderSelect
                value={folderId}
                disabled={fieldsDisabled || folderState !== 'ready'}
                lockedReason={access.reason}
                createDisabled={!folderAccess.allowed || accountLoading || locked}
                createLockedReason={folderAccess.reason}
                onChange={(value) => {
                  if (!requireWrite()) return
                  setFolderId(value)
                  void saveDetails(value)
                }}
                aria-label="シナリオのフォルダ"
                size="full"
                folders={[
                  ...(selectedFolderMissing ? [{ value: folderId, label: '名前を確認できません' }] : []),
                  ...folders.map(folderById),
                ]}
                // 一覧の左の列の「フォルダを追加」と同じ口（シナリオのフォルダは共有）。
                onCreate={folderCreator(async (name, color) => {
                    if (!currentScope() || accountLoading || !folderLease()) throw new FolderCreateError('本人や権限の確認状態が変わったため、フォルダの作成を中止しました。')
                    const result = await api.folders.create({ kind: 'scenario', name, color, accountId: folderAccountId })
                    if (!currentScope() || accountLoading || !folderLease()) throw new FolderCreateError('確認状態が変わりました。作成済みのフォルダは一覧で確認してください。')
                    return result
                  }, folderById, (created) => setFolders((current) => [...current, created]))}
              /></SaveErrorField>
            </span>
            {/* 保存済みのフォルダがこのアカウントの候補に無いときは理由を出す（黙って未分類に見せない）。 */}
            {folderState === 'ready' && selectedFolderMissing ? (
              <Notice tone="warn">選択中のフォルダはこのアカウントの候補にありません（別アカウントまたは削除済み）。このまま保存すると外れます。</Notice>
            ) : null}
          </Field>
        </SettingsFormRow>
      </Card>

      <Card variant="form" gap="normal" aria-label="配信方式">
        <CardHeader size="stacked" title="配信方式" help={<HelpTip label="配信方式の説明">作ったあとは変えられません</HelpTip>} />
        <SaveErrorField names={["delivery-mode","selectedMode"]}><RadioCardGroup legend="配信方式" className={styles.modeRow}>
          <RadioCard
            name="delivery-mode"
            value="absolute_time"
            checked={selectedMode === 'absolute_time'}
            onChange={() => { if (canSaveNow()) setSelectedMode('absolute_time') }}
            disabled={fieldsDisabled}
            icon={<CalendarClock size={16} aria-hidden="true" />}
            title="時刻で指定"
            note="購読開始から〇日後の〇時に届きます。決まった時刻の定期配信（メルマガ・朝の配信）に"
          >
            {/* G-5：2人がいつ受け取るかの図を各カードの中に（絵 cu3vm・dnzqC。下の見本の表は図に入ったので消した・R83uvQ）。 */}
            <DeliveryModeDiagram mode="absolute_time" selected={selectedMode === 'absolute_time'} />
          </RadioCard>
          <RadioCard
            name="delivery-mode"
            value="elapsed"
            checked={selectedMode === 'elapsed'}
            onChange={() => { if (canSaveNow()) setSelectedMode('elapsed') }}
            disabled={fieldsDisabled}
            icon={<Timer size={16} aria-hidden="true" />}
            title="経過時間で指定"
            note="購読開始から〇日と〇時間後に届きます。買った直後・予約直後のフォローに"
          >
            <DeliveryModeDiagram mode="elapsed" selected={selectedMode === 'elapsed'} />
          </RadioCard>
        </RadioCardGroup></SaveErrorField>
      </Card>
    </CreatePage></SaveErrorScope>
  )
}

function scenarioSaveError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 403) return permissionDeniedMessage('store')
    if (cause.status === 404) return 'シナリオが見つかりませんでした。一覧から開き直してください。'
  }
  return 'シナリオ情報を保存できませんでした。時間をおいてもう一度お試しください。'
}

function scenarioModeError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 400) return japaneseDetailOf(cause) || describeApiFailure(cause, '入力内容の確認')
    if (cause.status === 403) return permissionDeniedMessage('store')
    if (cause.status === 404) return 'シナリオが見つかりませんでした。一覧から開き直してください。'
  }
  return '配信方式を保存できませんでした。時間をおいてもう一度お試しください。'
}
