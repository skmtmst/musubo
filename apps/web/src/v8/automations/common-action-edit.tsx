'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAccount } from '@/contexts/account-context'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import {
  api,
  ApiError,
  type CommonActionResources,
  type CommonActionStep,
} from '@/lib/api'
import CommonActionEditor from '@/components/automations/common-action-editor'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { notifySaved } from '@/components/shared/toast'
import { describeApiFailure, isSaveConflict } from '@/components/shared/api-error-message'
import { Field } from '@/components/shared/form-controls'
import { CreatePage } from '@/components/templates'
import Card, { CardHeader } from '@/components/shared/card'
import TargetMissing from '@/components/shared/target-missing'
import { useCanManageCommonActions } from '@/components/automations/use-common-action-permission'
import { TextArea, TextField } from '@/components/shared/text-field'
import BranchEditors, { newBranchStep, updateBranchStep, type BranchPatch } from './branch-editor'
import { mergeOrderedActions, stepNumbers } from './action-order'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'


const EMPTY_RESOURCES: CommonActionResources = {
  tags: [], scenarios: [], templates: [], webhooks: [], richMenus: [], commonActions: [],
}
function EditCommonActionInner() {
  const saveErrors = useSaveFormErrors()
  const canManage = useCanManageCommonActions()
  const searchParams = useSearchParams()
  const id = searchParams.get('id') ?? ''
  const router = useRouter()
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [actions, setActions] = useState<CommonActionStep[]>([])
  const [baseline, setBaseline] = useState<string | null>(null)
  const dirty = baseline !== null && JSON.stringify({ name, description, actions }) !== baseline
  const [draftVersionId, setDraftVersionId] = useState('')
  /* 監査 R473: 読み取り時の改訂番号。保存時に照合し、先行保存があれば409で止まる。 */
  const [draftRevision, setDraftRevision] = useState(1)
  const [saveConflict, setSaveConflict] = useState(false)
  const [resources, setResources] = useState<CommonActionResources>(EMPTY_RESOURCES)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /** 取得の失敗の内訳（保存の失敗とは分ける）。 */
  const [loadFailure, setLoadFailure] = useState<'missing' | 'forbidden' | 'no-draft' | 'error' | null>(null)
  /** 失敗したあとの「もう一度読み込む」で取り直すための番号。 */
  const [reloadKey, setReloadKey] = useState(0)
  const saveScope = useRef({ accountId: selectedAccountId, id, active: true })
  if (saveScope.current.accountId !== selectedAccountId || saveScope.current.id !== id) saveScope.current = { accountId: selectedAccountId, id, active: true }
  useEffect(() => {
    const scope = saveScope.current
    scope.active = true
    setSaving(false)
    return () => { scope.active = false }
  }, [selectedAccountId, id])

  useEffect(() => {
    // U096: 対象が無いURLでは取りに行かない。無いまま叩くと
    // 「API error: 404」のような技術の言葉がそのまま画面に出る。
    if (!id) {
      setLoading(false)
      return
    }
    if (accountLoading || canManage !== true || !selectedAccountId) {
      if (!accountLoading) setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    /* 監査 R584: 再読込を始めたら古い取得失敗文を消す。残ると復旧が分からない。 */
    setError('')
    setLoadFailure(null)
    Promise.all([
      api.commonActions.get(id, selectedAccountId),
      api.commonActions.resources(selectedAccountId, id),
    ]).then(([detailResponse, resourceResponse]) => {
      if (cancelled) return
      if (!detailResponse.success || !resourceResponse.success) throw new Error('下書きを読み込めませんでした')
      const detail = detailResponse.data
      const draft = detail.versions.find((version) => version.id === detail.currentDraftVersionId)
      /*
       * 監査 R583: 下書きなしは通信の失敗ではない。再読込では直らないので
       * 通信障害の1枚にせず、版の画面で新版を作る案内にする。
       */
      if (!draft) {
        setError('編集中の下書きがありません。公開済みの版はそのままです。')
        setLoadFailure('no-draft')
        return
      }
      setName(detail.name)
      setDescription(detail.description ?? '')
      setActions(draft.actions)
      setBaseline(JSON.stringify({ name: detail.name, description: detail.description ?? '', actions: draft.actions }))
      setDraftVersionId(draft.id)
      setDraftRevision(draft.draftRevision ?? 1)
      setSaveConflict(false)
      /* 監査 R584: 復旧後は古い取得失敗文を残さない。編集欄の下に出し直さない。 */
      setError('')
      setResources(resourceResponse.data)
    }).catch((caught) => {
      /*
        U096: 生の `API error: 404` を主文にしない。消えた・権限が無い・
        通信の失敗を言い分け、直し方を文に入れる。
      */
      if (cancelled) return
      if (caught instanceof ApiError && caught.status === 404) {
        setError('この共通アクションは削除されたか、別のLINEアカウントのものです。')
        setLoadFailure('missing')
      } else if (caught instanceof ApiError && caught.status === 403) {
        setError('この共通アクションを編集する権限がありません。')
        setLoadFailure('forbidden')
      } else {
        setError(describeApiFailure(caught, '読み込み'))
        setLoadFailure('error')
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [accountLoading, canManage, id, reloadKey, selectedAccountId])

  const save = async () => {
    if (!selectedAccountId || !draftVersionId) {
      setError('編集中の下書きを確認できません')
      return
    }
    if (!name.trim() || actions.length === 0) {
      setError(!name.trim() ? '共通アクション名を入力してください' : '処理を1つ以上追加してください')
      return
    }
    const scope = saveScope.current
    const current = () => scope.active && saveScope.current === scope
    setSaving(true)
    setError('')
    setSaveConflict(false)
    try {
      const response = await api.commonActions.updateDraft(id, selectedAccountId, {
        expectedDraftVersionId: draftVersionId,
        expectedDraftRevision: draftRevision,
        name: name.trim(),
        description: description.trim() || null,
        actions,
      })
      if (!current()) return
      if (!response.success) throw new Error(response.error)
      notifySaved('共通アクションの下書きを保存しました。')
      router.push(`/common-actions/versions?id=${encodeURIComponent(id)}`)
    } catch (caught) {
      if (!current()) return
      saveErrors.capture(caught)
      setError(describeApiFailure(caught, '保存'))
      // 監査 R473: 先行保存との競合は入力を保持したまま、読み直しへ導く。
      if (isSaveConflict(caught)) setSaveConflict(true)
    } finally {
      if (current()) setSaving(false)
    }
  }

  const plainActions = actions.filter((action) => action.type !== 'branch')
  const updateBranch = (branchId: string, patch: BranchPatch) => {
    setActions((current) => current.map((step) => step.id === branchId ? updateBranchStep(step, patch) : step))
  }

  // U096: 対象未指定を専用の案内にする。取得に行かず、一覧へ戻す。
  if (!id) {
    return (
      <TargetMissing
        kind="unspecified"
        title="編集する共通アクションが指定されていません"
        description="一覧から編集する共通アクションを選び直してください。"
        backHref="/common-actions"
        backLabel="共通アクション一覧へ戻る"
      />
    )
  }
  /*
    U096: アカウント未選択と「対象が無い」を分ける。未選択のまま描くと
    空っぽの編集画面が出て、何が足りないか分からない。
  */
  if (!accountLoading && !selectedAccountId) return (
    <ListState kind="empty" title="共通アクションを編集するLINEアカウントを選んでください"
      description="上部の切替でLINEアカウントを選ぶと、その共通アクションの下書きを編集できます。"
      action={<Button href="/common-actions">共通アクション一覧へ戻る</Button>} />
  )
  if (canManage === null || loading) return <ListState kind="loading" title="下書きを読み込んでいます" />
  if (!canManage) return (
    <ListState kind="forbidden" title="共通アクションは閲覧のみです"
      description="編集するには、オーナーまたは管理者の権限が必要です。"
      action={<Button href="/common-actions">共通アクション一覧へ戻る</Button>} />
  )

  /*
    対象が無い（取得失敗）ときは、見出し・入力・右の案内・固定バー
    のどれも出さない。代わりに ★管理画面 TargetMissing を出す。
  */
  if (error && !draftVersionId && loadFailure === 'forbidden') {
    return (
      <ListState
        kind="forbidden"
        title="この共通アクションを編集する権限がありません"
        description="権限のある人に確認するか、別のLINEアカウントを選んでください。"
        action={<Button href={`/common-actions/versions?id=${encodeURIComponent(id)}`}>版の画面へ戻る</Button>}
      />
    )
  }
  if (error && !draftVersionId && loadFailure === 'missing') {
    return (
      <TargetMissing
        kind="not-found"
        title="この共通アクションは見つかりません"
        description="削除されたか、別のLINEアカウントのものです。版の画面から選び直してください。"
        backHref={`/common-actions/versions?id=${encodeURIComponent(id)}`}
        backLabel="版の画面へ戻る"
      />
    )
  }
  /*
   * 監査 R583: 下書きなしは通信障害ではない。再読込の口ではなく、
   * ★管理画面 TargetMissing で版の画面（前の版から新版を作る入口）へ戻す。
   */
  if (error && !draftVersionId && loadFailure === 'no-draft') {
    return (
      <TargetMissing
        kind="not-found"
        title="編集中の下書きがありません"
        description="公開済みの版はそのままです。版の画面で前の版から新版を作ると、編集を続けられます。"
        backHref={`/common-actions/versions?id=${encodeURIComponent(id)}`}
        backLabel="版の画面へ戻る"
      />
    )
  }
  if (error && !draftVersionId) {
    return (
      <TargetMissing
        kind="error"
        title="下書きを読み込めませんでした"
        description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。"
        onRetry={() => setReloadKey((k) => k + 1)}
      />
    )
  }

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage title="下書きの中身を編集" dirty={dirty || saving} contentDisabled={saving}
        help="公開済みの版は変えず、新しい下書きだけを編集します。"
      busy={saving}
      status={saving ? '下書きを保存しています' : '公開済みの版には影響しません'}
      footerActions={(
          <>
            <Button href={`/common-actions/versions?id=${encodeURIComponent(id)}`}>キャンセル</Button>
            <Button variant="primary" onClick={() => void save()} disabled={saving}>下書きを保存する</Button>
          </>
        )}
      preview={<>
          <Card spacing="normal">
            <CardHeader title="保存しても利用先は変わりません" />
            <p className="text-ink-secondary mt-2 text-sm leading-6">下書きを保存したあと、版の画面で公開します。さらに利用先ごとの更新が必要です。</p>
          </Card>
          <Card spacing="normal">
            <CardHeader title="公開前の確認" />
            <p className="text-ink-secondary mt-2 text-sm leading-6">参照先、失敗時の動き、処理の順番が正しいかを確認してください。循環や使えない参照は公開時に止まります。</p>
          </Card>
        </>} hidePreviewWhenNarrow
    >
        <div className="space-y-4">
          <Card spacing="normal">
            <CardHeader title="名前と説明" />
            <div className="mt-4 space-y-4">
              <Field label="共通アクション名"><SaveErrorField names={["name"]}><TextField value={name} onChange={(event) => setName(event.target.value)} maxLength={120} className="mt-1" /></SaveErrorField></Field>
              <Field label="説明"><SaveErrorField names={["description"]}><TextArea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} className="mt-1" /></SaveErrorField></Field>
            </div>
          </Card>
          <section>
            <h2 className="text-ink mb-3 font-semibold">順番に動かす処理</h2>
            {/* 監査 R474: 分岐の位置を保ち、通常処理の編集で順序を変えない。番号は実行順。 */}
            <CommonActionEditor value={plainActions} resources={resources} stepNumbers={stepNumbers(actions)} onChange={(next) => setActions((current) => mergeOrderedActions(current, next))} />
            <BranchEditors
              steps={actions}
              resources={resources}
              onUpdate={updateBranch}
              onRemove={(branchId) => setActions((current) => current.filter((step) => step.id !== branchId))}
            />
            <Button className="mt-3" onClick={() => setActions((current) => [...current, newBranchStep()])}>条件で分ける</Button>
          </section>
        </div>

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {saveConflict ? (
        <div className="mt-4">
          <Button onClick={() => requestUnsavedAction(() => { setSaveConflict(false); setReloadKey((key) => key + 1) })}>最新の内容を読み込み直す</Button>
        </div>
      ) : null}
    </CreatePage></SaveErrorScope>
  )
}

export default function EditCommonActionPage() {
  return (
    <Suspense fallback={<div className="text-ink-faint p-6 text-sm">下書きを読み込んでいます</div>}>
      <EditCommonActionInner />
    </Suspense>
  )
}
