'use client'

import { requiredText } from '@/lib/form-requirement'
import { knownValue } from '@/lib/known-value'
const FIELD_REQUIREMENTS = {
  name: requiredText("共通アクション名を入力してください"),
}

import { CommonActionAddActions, CommonActionStepEditor } from './common-action-sequence'
import ActionList from '@/components/shared/action-list'
import { ACTION_LABELS } from './version-diff'
import { stepSummary } from './common-action-summary'
export { stepSummary } from './common-action-summary'
import { createPageReturnHref } from '@/components/shared/create-page'
import { useEffect, useRef, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Check } from 'lucide-react'
import { useAccount } from '@/contexts/account-context'
import { api, describeSaveFailure, type CommonActionResources, type CommonActionStep } from '@/lib/api'
import { newCommonActionStep, newStepId } from '@/components/automations/common-action-editor'
import { describeApiFailure, isForbiddenOrRateLimited, loadFailureNotice } from '@/components/shared/api-error-message'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { CreatePage } from '@/components/templates'
import Button from '@/components/shared/button'

import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import { Field } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import { useCanManageCommonActions } from '@/components/automations/use-common-action-permission'

import styles from './common-action-new.module.css'
import { withPermissionFailure } from '@/components/shared/api-error-message'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

/*
 * ★V8-B 共通アクションを作る（Pencil ）。
 *
 * 型（CreatePage）の左に段「どんなアクションか」「処理を上から順に並べる」「失敗したとき」、右の列に
 * 「版のこと」「つながる先」「気をつけること」。下の帯はキャンセル・下書きを保存を真ん中に。
 * データの口・保存（下書き＋要求キー）・選択肢の読み込みと失敗の扱いは今の V8（共通アクションの既存API）と同じ。
 * 見せ方を絵に合わせた：処理は番号つきの1行（何を・どれを）で並べ、行を押すとその処理の設定を開く。
 * 並べ替え・削除は閉じた行の右端から行う。「失敗したとき」は全部の処理の「失敗したとき」をまとめて決める（行ごとに変えることもできる）。
 */

const EMPTY_RESOURCES: CommonActionResources = {
  tags: [], scenarios: [], templates: [], webhooks: [], richMenus: [], commonActions: [],
}

const FAILURE_OPTIONS = [
  { value: 'stop', label: 'ここで止める（残りの処理はしない）' },
  { value: 'continue', label: '次の処理へ進む' },
]

export function CommonActionNew() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('共通アクションを作る')
  usePageCrumbs([{ label: 'ホーム', href: '/' }, { label: '共通アクション', href: '/common-actions' }])
  const canManage = useCanManageCommonActions()
  const router = useRouter()
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [actions, setActions] = useState<CommonActionStep[]>([newCommonActionStep()])
  const initialActions = useRef(JSON.stringify(actions))
  const [resources, setResources] = useState<CommonActionResources>(EMPTY_RESOURCES)
  const [resourcesLoading, setResourcesLoading] = useState(true)
  const [resourcesFailed, setResourcesFailed] = useState(false)
  const [resourcesError, setResourcesError] = useState('')
  const [resourcesReloadKey, setResourcesReloadKey] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [inputError, setInputError] = useState<{ target: string; message: string } | null>(null)
  const [requestKey] = useState(() => newStepId())

  useEffect(() => {
    if (!inputError) return
    const control = document.getElementById(inputError.target)
    control?.focus()
    control?.scrollIntoView?.({ block: 'center' })
  }, [inputError])

  useEffect(() => {
    if (accountLoading || canManage !== true || !selectedAccountId) {
      if (!accountLoading) setResourcesLoading(false)
      return
    }
    let cancelled = false
    setResourcesLoading(true)
    setResourcesFailed(false)
    setResourcesError('')
    api.commonActions.resources(selectedAccountId)
      .then((response) => {
        if (cancelled) return
        if (!response.success) {
          setResourcesFailed(true)
          setResourcesError(response.error || '選択肢を読み込めませんでした。通信の状態を確認して、もう一度読み込んでください。')
          return
        }
        setResources(response.data)
        setResourcesFailed(false)
        setResourcesError('')
      })
      .catch((caught) => {
        if (cancelled) return
        setResourcesFailed(true)
        if (isForbiddenOrRateLimited(caught)) {
          setResourcesError(loadFailureNotice(caught, '選択肢'))
          return
        }
        const message = describeApiFailure(caught, '読み込み')
        setResourcesError(message && !/^API error: /.test(message) ? message : '選択肢を読み込めませんでした。通信の状態を確認して、もう一度読み込んでください。')
      })
      .finally(() => {
        if (!cancelled) setResourcesLoading(false)
      })
    return () => { cancelled = true }
  }, [accountLoading, canManage, selectedAccountId, resourcesReloadKey])

  const save = async () => {

    if (!selectedAccountId) return setError('LINE公式アカウントを選んでください')
    setError('')
    if ((FIELD_REQUIREMENTS.name.check(name) !== null)) return setInputError({ target: 'ca-name', message: '共通アクション名を入力してください' })
    if (actions.length === 0) return setInputError({ target: 'ca-add-step', message: '処理を1つ以上追加してください' })
    setInputError(null)
    setSaving(true)
    setError('')
    try {
      const response = await api.commonActions.create(selectedAccountId, {
        name: name.trim(),
        description: description.trim() || null,
        actions,
        clientRequestKey: requestKey,
      })
      if (!response.success) throw new Error(response.error)
      router.push(createPageReturnHref('/common-actions', response.data.id))
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)

      setError(withPermissionFailure(caught, describeSaveFailure(caught), 'store')) }
    } finally {
      setSaving(false)
    }
  }
  /* 失敗したとき：全部の処理が同じならその値、違えば「処理ごとに違う」。 */
  const failureValues = new Set(actions.map((step) => step.onFailure))
  const failureValue = failureValues.size === 1 ? [...failureValues][0] : 'mixed'
  const setAllFailure = (value: string) => {
    if (value !== 'stop' && value !== 'continue') return
    setActions((current) => current.map((step) => ({ ...step, onFailure: value })))
  }

  if (canManage === null) return <SaveErrorScope errors={saveErrors}><ListState kind="loading" /></SaveErrorScope>
  if (!canManage) {
    return (
      <SaveErrorScope errors={saveErrors}><div data-design-node="j2hfkS">
        <ListState
          kind="forbidden"
          title="共通アクションは閲覧のみです"
          description="作成するには、オーナーまたは管理者の権限が必要です。"
          action={<Button href="/common-actions">共通アクション一覧へ戻る</Button>}
        />
      </div></SaveErrorScope>
    )
  }

  const aside = (
    <div className={styles.aside}>
      <section className={styles.sideCard}>
        <h2 className={styles.sideTitle}>版のこと</h2>
        <div className={styles.kvRow}><span>いま公開中</span><strong>まだありません</strong></div>
        <div className={styles.kvRow}><span>保存すると</span><strong>版 1 の下書き</strong></div>
        <p className={styles.sideNote}>公開すると、ルール・シナリオ・リッチメニュー・回答フォーム・自動応答から選べるようになります。</p>
        <span className={styles.sideLink} title="保存したあと、版の画面で公開します。公開した版は書き換わらず、直すときは新しい版を作ります。">版のしくみ</span>
      </section>
      <section className={styles.sideCard}>
        <h2 className={styles.sideTitle}>つながる先</h2>
        <p className={styles.sideNote}>公開すると、ここに使っている所が出ます</p>
        {['オートメーション', 'シナリオ配信', 'リッチメニュー', '回答フォーム', '自動応答'].map((label) => (
          <div key={label} className={styles.kvRow}><span>{label}</span><strong>0</strong></div>
        ))}
      </section>
      <section className={styles.sideCard}>
        <h2 className={styles.sideTitle}>気をつけること</h2>
        <p className={styles.sideText}>・公開しても、使っている所は今の版のまま。使う所ごとに新しい版へ切り替えます<br />・待つ時間のあいだに条件が変わると、そのときの条件で分けます</p>
      </section>
    </div>
  )

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage
      dirty={Boolean(name || description || JSON.stringify(actions) !== initialActions.current)}
      busy={saving}
      boardId="j2hfkS"
      title="共通アクションを作る"
      help="いくつもの所から呼び出せる「処理のまとまり」を作ります。ここでは下書きを保存し、公開は版の画面から行います。使う所はいまの版のまま。使う所ごとに新しい版へ更新します。"
      preview={aside} previewLabel="版とつながる先を見る" previewTitle="版とつながる先"
      footerActions={<>
        <Button href="/common-actions">キャンセル</Button>
        <Button
          variant="primary"
          onClick={() => save()}
          disabled={saving || resourcesLoading || resourcesFailed}
          title={resourcesFailed ? '選択肢を読み込めていないため保存できません' : undefined}
          busy={saving}
          busyLabel="保存中"
        >
          <Check size={16} aria-hidden="true" />下書きを保存
        </Button>
      </>}
    >
      {error ? <Notice tone="danger" message={error} /> : null}

      <section className={styles.card} aria-labelledby="ca-what">
        <div className={styles.cardHead}><h2 className={styles.cardTitle} id="ca-what">どんなアクションか</h2></div>
        <Field label="名前" htmlFor="ca-name" error={inputError?.target === 'ca-name' ? inputError.message : undefined} requirement={FIELD_REQUIREMENTS.name}>
          <SaveErrorField names={["name"]}><TextField id="ca-name" value={name} maxLength={120} placeholder="例：購入のお礼" onChange={(event) => { setName(event.target.value); if (inputError?.target === 'ca-name') setInputError(null) }} /></SaveErrorField>
        </Field>
        <Field label="説明"><SaveErrorField names={["description"]}><TextField value={description} maxLength={200} placeholder="使う場面や目的を書きます" onChange={(event) => setDescription(event.target.value)} /></SaveErrorField></Field>
      </section>

      <section className={styles.card} aria-labelledby="ca-steps">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle} id="ca-steps">処理を上から順に並べる</h2>
          <p className={styles.cardNote}>上から1つずつ動きます。↑↓で並べ替えます</p>
        </div>
        {resourcesLoading ? <ListState kind="loading" title="選択肢を読み込んでいます" /> : null}
        {!resourcesLoading && resourcesFailed ? (
          <Notice tone="danger" ><p>{`${resourcesError} 入力した名前や処理はそのままです。`}</p><Button onClick={() => setResourcesReloadKey((key) => key + 1)}>選択肢をもう一度読み込む</Button></Notice>
        ) : null}
        <ActionList value={actions} onChange={setActions} choices={[]} appearance="numbered" idOf={step => step.id}
          kindOf={step => knownValue(ACTION_LABELS, step.type, '処理')} titleOf={step => stepSummary(step, resources)}
          addActions={<CommonActionAddActions actions={actions} onChange={next => { setActions(next); if (inputError?.target === 'ca-add-step') setInputError(null) }} resources={resources} resourcesFailed={resourcesFailed} />}
          renderEditor={(step, _update, index) => <CommonActionStepEditor step={step} index={index} actions={actions} onChange={setActions} resources={resources} resourcesFailed={resourcesFailed} />}
        />
        {inputError?.target === 'ca-add-step' ? <p className={styles.inputError} role="alert">{inputError.message}</p> : null}
      </section>

      <section className={styles.card} aria-labelledby="ca-failure">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle} id="ca-failure">失敗したとき</h2>
          <p className={styles.cardNote}>送れなかった・タグが無いなど</p>
        </div>
        <div className={styles.field}>
          <span className={styles.pickLabel} id="ca-failure-pick">失敗したときにすること</span>
          <SaveErrorField names={["failureValue","allFailure","failure_value","all_failure"]}><Select
            size="full"
            aria-label="失敗したときにすること"
            value={failureValue}
            onChange={setAllFailure}
            options={failureValue === 'mixed' ? [{ value: 'mixed', label: '処理ごとに違う（行を開いて確かめる）' }, ...FAILURE_OPTIONS] : FAILURE_OPTIONS}
          /></SaveErrorField>
        </div>
      </section>
    </CreatePage></SaveErrorScope>
  )
}
