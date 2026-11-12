'use client'
import { requiredInputReason } from '@/lib/required-input-reason'

import { displayText, isEditableQuestion, choiceActionText, choiceActionIcon } from './question-choice-summary'
export { choiceActionText } from './question-choice-summary'
import TapActionSummary from '@/components/shared/tap-action-summary'

import { SettingsFormRow } from '@/components/shared/settings-form-card'


import Card, { CardHeader } from '@/components/shared/card'
import { CreatePage } from '@/components/templates/create-page'
import { TextField } from '@/components/shared/text-field'
import SegmentedControl from '@/components/shared/segmented'
import { CreateSummaryCard } from '@/components/templates/create-parts'
import { isOwnerOrAdmin } from '@/lib/staff-capability';
import TapExtrasField from '@/components/shared/tap-extras-field'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from '@/components/shared/list-navigation'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { ChevronDown, GitBranch, MousePointerClick, Plus, Send, Tag as TagIcon, Trash2, type LucideIcon } from 'lucide-react'
import { tapExtrasError, type Folder, type Scenario, type Tag } from '@line-crm/shared'
import { tapExtraSaveError } from '@/lib/tap-actions'
import { api } from '@/lib/api'
import { describeApiFailure, isForbiddenOrRateLimited, loadFailureNotice } from '@/components/shared/api-error-message'
import QuestionEditor, { emptyQuestion, newChoiceKey, type QuestionChoice, type ScenarioQuestion } from '@/components/scenarios/question-editor'
import Button from '@/components/shared/button'
import { notifyToast } from '@/components/shared/toast'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog from '@/components/shared/dialog'
import { EntityPickerSummary } from '@/components/shared/entity-picker'
import LinePreview from '@/components/shared/line-preview'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import FolderSelect, { folderById, folderCreator, hostFolderCreate } from '@/components/shared/folder-select'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { useFormErrors } from '@/lib/use-form-errors'
import ValidationSummary from '@/components/shared/validation-summary'
import { FieldError } from '@/components/shared/form-controls'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { TemplateEditFrame } from '@/v8/template-edit/public/frame/index'
import type { TemplateEditHost } from '@/v8/template-edit/public/host/index'
import te from '../template-edit/edit.module.css'
import styles from './question-new.module.css'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField, SaveErrorScope, useSaveErrorReveal, useSaveFormErrors } from '@/components/shared/save-form-errors'

/*
 * ★V8 テンプレート「質問を作る・編集」（Pencil ）。
 *
 * 外枠はテンプレートの作る画面と同じ（src/v8/template-edit/frame）。左に段「名前とフォルダ」「質問」「選択肢」、
 * 右の列に「この質問を使う場所」と「届き方」（本物のスマホ）。下の帯はキャンセル・下書きを保存・保存して公開。
 * 読み込み・保存・公開（使用先があれば確認の窓）・離れる確認をこの現役の画面で扱う。
 * 見せ方を絵に合わせた：選択肢は横に並ぶカード（ボタンの文字・押されたら・押したときの返信）。
 * 「押されたら」は今の質問の部品（QuestionEditor）を窓で開いて決める（タグ・友だち情報・シナリオ・URL などの全部の設定が残る）。
 * 受け付ける URL：`/templates/questions/new`・`?id=<テンプレート>`（直す）。
 */

const MAX_CHOICES = 4

const snapshotOf = (value: { name: string; category: string; folderId: string | null; question: ScenarioQuestion }) => JSON.stringify(value)

function QuestionNew({ host }: { host?: TemplateEditHost }) {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const params = useSearchParams()
  /* 統括の入口（host）では店のテンプレートを読まない（新しく作るだけ）。 */
  const id = host ? null : params.get('id')
  const { selectedAccountId, accounts, loading: accountLoading } = useAccount()
  const scopeKey = JSON.stringify([id, selectedAccountId])
  const scope = useRef({ key: scopeKey, generation: 0 })
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey, generation: scope.current.generation + 1 }
  const loadedScope = useRef(-1)
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  usePageTitle(host ? 'テンプレート' : id ? '質問を編集' : '質問を作る')
  usePageCrumbs([{ label: 'ホーム', href: '/' }, { label: 'テンプレート', href: '/templates' }], !host)
  /* 統括の編集（host.initialContent）：保存してある質問から始める。形が合わなければ空から。 */
  const [hostInitial] = useState(() => {
    const content = host?.initialContent
    return content?.kind === 'question' && isEditableQuestion(content.question as unknown as ScenarioQuestion) ? { name: content.name, question: content.question as unknown as ScenarioQuestion } : null
  })
  const editVersion = useRef<{ expectedVersion: number; expectedDraftRevision: number } | null>(null)
  const createdDraft = useRef<{ id: string; generation: number } | null>(null)
  const [name, setName] = useState(hostInitial?.name ?? '')
  const [category, setCategory] = useState('未分類')
  const [folderId, setFolderId] = useState<string | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  /* 「押されたら」の窓：開いている選択肢と、窓の中の下書き（［決める］で戻す・［キャンセル］で捨てる）。 */
  const [actionIndex, setActionIndex] = useState<number | null>(null)
  const [actionDraft, setActionDraft] = useState<ScenarioQuestion | null>(null)
  const [templateAccountId, setTemplateAccountId] = useState<string | null>(null)
  const [templateAccountKnown, setTemplateAccountKnown] = useState(false)
  const [initialQuestion] = useState<ScenarioQuestion>(() => hostInitial?.question ?? emptyQuestion())
  const [question, setQuestion] = useState<ScenarioQuestion>(initialQuestion)
  const [usageCount, setUsageCount] = useState(0)
  const [loading, setLoading] = useState(Boolean(id))
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState('')
  const publishFormKey = JSON.stringify([name, category, folderId, question])
  const publishFormScope = useRef({ key: publishFormKey })
  if (publishFormScope.current.key !== publishFormKey) publishFormScope.current = { key: publishFormKey }
  const [publishTarget, setPublishTarget] = useState<{ accountId: string; allAccounts: boolean; generation: number; version: { expectedVersion: number; expectedDraftRevision: number }; form: typeof publishFormScope.current } | null>(null)
  const publishTicket = useRef<object | null>(null)
  const renderedPublishTicket = publishTicket.current
  const canMutate = useFeatureAccess('templates')
  const canMutateRef = useRef(canMutate)
  canMutateRef.current = canMutate
  const [savedSnapshot, setSavedSnapshot] = useState(() => snapshotOf({ name: hostInitial?.name ?? '', category: '未分類', folderId: null, question: initialQuestion }))

  const folderAccountId = id ? templateAccountId : selectedAccountId
  useEffect(() => {
    setFolders([])
    if (!folderAccountId || host) return
    let cancelled = false
    void api.folders.list('template', folderAccountId).then((res) => {
      if (!cancelled && res.success) setFolders(res.data)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [folderAccountId])

  /* 「押されたら」の名前（タグ・シナリオ）。読めなくても設定は消えない（名前の代わりに種類を出す）。 */
  useEffect(() => {
    if (!selectedAccountId || host) return
    let cancelled = false
    void Promise.allSettled([api.tags.list({ accountId: selectedAccountId }), api.scenarios.list({ accountId: selectedAccountId })]).then(([tagResult, scenarioResult]) => {
      if (cancelled) return
      if (tagResult.status === 'fulfilled' && tagResult.value.success) setTags(tagResult.value.data)
      if (scenarioResult.status === 'fulfilled' && scenarioResult.value.success) setScenarios(scenarioResult.value.data)
    })
    return () => { cancelled = true }
  }, [selectedAccountId])

  useEffect(() => {
    if (!id || !selectedAccountId) return
    let cancelled = false
    const requestScope = scope.current.generation
    setLoading(true)
    setError('')
    void api.templates.get(id)
      .then((template) => {
        if (cancelled || requestScope !== scope.current.generation) return
        if (!template.success || !template.data.question || !isEditableQuestion(template.data.question)) {
          setError('質問テンプレートを読み込めませんでした。')
          return
        }
        editVersion.current = { expectedVersion: template.data.publishedVersion, expectedDraftRevision: template.data.draftRevision }
        setName(template.data.name)
        setTemplateAccountId(template.data.accountId ?? null)
        setTemplateAccountKnown(Object.prototype.hasOwnProperty.call(template.data, 'accountId') && template.data.accountId !== undefined)
        loadedScope.current = requestScope
        setCategory(template.data.category || '未分類')
        setFolderId(template.data.folderId ?? null)
        setQuestion(template.data.question)
        setSavedSnapshot(snapshotOf({ name: template.data.name, category: template.data.category || '未分類', folderId: template.data.folderId ?? null, question: template.data.question }))
        setUsageCount(Object.values(template.data.usedBy).reduce((total, items) => total + items.length, 0))
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(isForbiddenOrRateLimited(caught) ? loadFailureNotice(caught, '質問テンプレート') : '質問テンプレートを読み込めませんでした。')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id, selectedAccountId])

  const dirty = snapshotOf({ name, category, folderId, question }) !== savedSnapshot
  /* 保存で落ちた欄は、その欄を赤くして真下に理由を出し、1つ目の欄へ移る。 */
  const fields = useFormErrors()
  fields.define('name', 'テンプレート名', () => (name.trim() ? null : 'テンプレート名を入力してください。'), { required: true })
  fields.define('text', '質問文', () => (question.text.trim() ? null : '質問文を入力してください。'), { required: true })
  question.choices.forEach((choice, index) => {
    fields.define(`extras-${index}`, `選択肢 ${index + 1} の追加処理`, () => tapExtrasError({ tagIds: choice.addTagIds, scoreChange: choice.scoreChange }))
    fields.define(`choice-${index}`, `選択肢 ${index + 1} のボタンの文字`, () => (!choice.label.trim() ? 'ボタンの文字を入力してください。' : choice.label.length > 20 ? 'ボタンの文字は20文字以内で入力してください。' : null), { required: true })
  })
  const { leaveTarget, confirmLeave, cancelLeave, disarm } = useUnsavedGuard({ dirty, busy: saving || publishing, subject: '質問への変更' })
  /* H-18原文の再読込対策：入力が変わるたび呼ぶ側へ一時下書きを渡す。保存と同じ形。 */
  const questionDraftSnapshot = JSON.stringify([name, question])
  useEffect(() => {
    if (!host?.onDraftChange) return
    try {
      host.onDraftChange({ kind: 'question', name, question: question as unknown as Record<string, unknown>, messageContent: question.intro?.trim() || question.text })
    } catch { /* 組み立て不可の途中入力は通知しない */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionDraftSnapshot])

  const save = async (questionStatus: 'draft' | 'published', confirmedVersion?: { expectedVersion: number; expectedDraftRevision: number }, onSaved?: () => void): Promise<boolean> => {
    if (host) {
      if (fields.submit().length > 0) { setError(''); return false }
      setError('')
      disarm()
      host.onSave({ kind: 'question', name: name.trim(), question: question as unknown as Record<string, unknown>, messageContent: question.intro?.trim() || question.text }, questionStatus === 'published')
      return false
    }
    if (!selectedAccountId) { setError('上のバーでLINE公式アカウントを選んでください。'); return false }
    if (fields.submit().length > 0) { setError(''); return false }
    setSaving(true)
    setError('')
    const generation = scope.current.generation
    const savedId = id ?? (createdDraft.current?.generation === generation ? createdDraft.current.id : null)
    let saved = false
    const payload = {
      accountId: selectedAccountId,
      name: name.trim(),
      category: category.trim() || '未分類',
      messageType: 'text',
      messageContent: question.intro?.trim() || question.text,
      question,
      questionStatus,
      folderId,
    }
    try {
      const result = savedId ? await api.templates.update(savedId, { ...payload, ...(confirmedVersion ?? editVersion.current) }) : await api.templates.create(payload)
      if (!result.success) { setError(result.error || '保存できませんでした。時間をおいて、もう一度お試しください。'); return false }
      if (!alive.current || generation !== scope.current.generation) return false
      const templateId = result.data.id || savedId
      if (!id && templateId) createdDraft.current = { id: templateId, generation }
      editVersion.current = { expectedVersion: result.data.publishedVersion, expectedDraftRevision: result.data.draftRevision }
      saved = true
      onSaved?.()
      if (questionStatus === 'published') {
        if (!templateId || !canMutateRef.current) { setError('下書きは保存しましたが、公開できませんでした。一覧で確認してください。'); return false }
        const published = await api.templates.publish(templateId, editVersion.current)
        if (!alive.current || generation !== scope.current.generation) return false
        if (!published.success) { setError('下書きは保存しましたが、公開できませんでした。もう一度お試しください。'); return false }
      }
      return true
    } catch (caught) {
      const extraError = tapExtraSaveError(caught)
      if (extraError) { fields.setServerErrors(Object.fromEntries(question.choices.map((_, ci) => [`extras-${ci}`, extraError]))); return false }
      if (!saveErrors.capture(caught, fields))

 setError(saved && questionStatus === 'published' ? '下書きは保存しましたが、公開できませんでした。もう一度お試しください。' : describeApiFailure(caught, '保存', { scope: 'store' }));

      return false
    } finally {
      setSaving(false)
    }
  }
  const leaveToList = () => { disarm(); notifyToast('質問を保存しました', { tone: 'success' }); router.push('/templates?tab=question') }
  const onSaveDraft = async () => { if (await save('draft')) leaveToList() }
  /* 使われている質問を公開すると利用先へ新しい内容が届くので、使用先があれば確認の窓を挟む。 */
  const onPublish = async () => {
    if (id && templateAccountId && templateAccountId !== selectedAccountId) return
    if (id && usageCount > 0) {
      const version = editVersion.current
      if (!selectedAccountId || !canMutateRef.current || loadedScope.current !== scope.current.generation) return
      if (!version || !Number.isSafeInteger(version.expectedVersion) || !Number.isSafeInteger(version.expectedDraftRevision)) { setError('質問の版を確認できません。読み直してから公開してください。'); return }
      publishTicket.current = {}
      setPublishTarget({ accountId: templateAccountId ?? '', allAccounts: templateAccountKnown && templateAccountId === null, generation: scope.current.generation, version: { ...version }, form: publishFormScope.current })
      return
    }
    setPublishing(true)
    try { if (await save('published')) leaveToList() } finally { setPublishing(false) }
  }

  const setChoice = (index: number, patch: Partial<QuestionChoice>) =>
    setQuestion((current) => ({ ...current, choices: current.choices.map((choice, i) => i === index ? { ...choice, ...patch } : choice) }))
  const openAction = (index: number) => { setActionDraft(question); setActionIndex(index) }
  const closeAction = () => { setActionIndex(null); setActionDraft(null) }
  const applyAction = () => {
    if (actionIndex === null || !actionDraft) return
    const next = actionDraft.choices[actionIndex]
    setQuestion((current) => ({ ...current, choices: current.choices.map((choice, i) => (i === actionIndex && next ? { ...next, label: choice.label, reply: choice.reply } : choice)) }))
    closeAction()
  }
  const removeChoice = (index: number) =>
    setQuestion((current) => ({ ...current, choices: current.choices.filter((_, i) => i !== index) }))
  const addChoice = () =>
    setQuestion((current) => ({ ...current, choices: [...current.choices, { key: newChoiceKey(), label: '', behavior: 'none' }] }))

  if (loading || (accountLoading && !host)) return <SaveErrorScope errors={saveErrors}><ListState kind="loading" title="質問テンプレートを読み込んでいます" /></SaveErrorScope>

  if (host ? host.readOnly : !canMutate) {
    return (
      <SaveErrorScope errors={saveErrors}><CreatePage boardId="l87p1J" title="質問テンプレート" help="質問テンプレートの作成・変更はオーナーと管理者だけができます" readOnly footerActions={null}>
        <p className={styles.note}>一覧で中身を確認できます。</p>
        <></>
      </CreatePage></SaveErrorScope>
    )
  }

  const inputReason = requiredInputReason([
    { label: 'テンプレート名', value: name },
    { label: '質問文', value: question.text },
    ...question.choices.map((choice, index) => ({ label: `選択肢 ${index + 1} のボタンの文字`, value: choice.label })),
  ])
  const publishReason = inputReason || (!host && id && templateAccountId && templateAccountId !== selectedAccountId ? 'この質問のLINEアカウントを選んでから公開してください。' : undefined)
  const busy = saving || publishing || Boolean(host?.busy)
  const previewAccountName = host ? host.accountName : accounts.find((account) => account.id === (id ? templateAccountId : selectedAccountId))?.name
  const phone = (
    <LinePreview title={null} note="質問の見え方（見本 141さんの場合）" accountName={previewAccountName ?? undefined}>
      <div className={styles.bubble}>
        {question.intro?.trim() ? <p className={styles.bubbleIntro}>{displayText(question.intro)}</p> : null}
        <p className={styles.bubbleText}>{displayText(question.text) || '質問文を入力すると、ここに出ます。'}</p>
        {question.choices.map((choice, index) => (
          <p key={choice.key ?? index} className={styles.bubbleChoice}>{choice.label || `選択肢${index + 1}`}</p>
        ))}
      </div>
    </LinePreview>
  )

  return (
    <SaveErrorScope errors={saveErrors}><>
      <TemplateEditFrame
        inputReason={inputReason}
        boardId="l87p1J"
        title={id ? '質問を編集' : '質問を作る'}
        description="ボタンで答えてもらい、答えでタグなどを付ける"
        side={(
          <>
            <CreateSummaryCard title="この質問を使う場所" rows={[]} description={id ? `使用先 ${usageCount}か所` : '保存すると、一斉配信・シナリオから選べます。'}>
              {host ? null : <p className={te.sideText}><Link href="/scenarios">シナリオで使う</Link></p>}
            </CreateSummaryCard>
            <h2 className={te.previewHead}>届き方</h2>
            <div className={te.phone}>{phone}</div>
          </>
        )}
        footerActions={(
          <>
            <Button type="button" onClick={() => (host ? host.onCancel() : requestUnsavedAction(() => router.push('/templates')))} disabled={busy}>キャンセル</Button>
            <Button type="button" onClick={() => void onSaveDraft()} disabled={busy} busy={saving && !publishing}>下書きを保存</Button>
            <Button type="button" variant="primary" onClick={() => void onPublish()} disabled={busy || Boolean(publishReason)} disabledReason={publishReason} busy={publishing || Boolean(host?.busy)}>{host ? null : <Send size={16} aria-hidden="true" />}{host ? host.primaryLabel ?? '保存する' : '保存して公開'}</Button>
          </>
        )}
      >
        {host?.notice}
        {error ? <Notice tone="danger" message={error} /> : null}
        <ValidationSummary problems={fields.listProblems()} onFocusFirst={fields.focusFirst} minProblems={2} />

        <Card variant="form" gap="normal" aria-labelledby="q-name">
          <CardHeader size="stacked" title="名前とフォルダ" titleId="q-name" />
          <SettingsFormRow layout="name-folder">
            <Field label="テンプレート名" requirement={fields.requirement('name')}><SaveErrorField names={["name"]}><TextField {...fields.bind('name')} value={name} maxLength={120} placeholder="例：継続の意思をうかがう" aria-invalid={fields.invalid('name') || undefined} aria-describedby={fields.invalid('name') ? 'q-name-error' : undefined} onChange={(event) => setName(event.target.value)} /></SaveErrorField><FieldError id="q-name-error">{fields.error('name')}</FieldError></Field>
            <Field label="フォルダ">
              <SaveErrorField names={["folder","host.folder","folderId","folder_id"]}><FolderSelect
                size="full"
                aria-label="フォルダ"
                value={host ? host.folder : folderId ?? ''}
                onChange={(value) => {
                  if (host) { host.onFolderChange(value); return }
                  const next = value || null
                  setFolderId(next)
                  setCategory(folders.find((folder) => folder.id === next)?.name ?? '未分類')
                }}
                folders={host ? host.folders : folders.map(folderById)}
                colors
                onCreate={host
                  ? hostFolderCreate(host)
                  : canMutate && folderAccountId
                    ? folderCreator((name, color) => api.folders.create({ kind: 'template', name, color, accountId: folderAccountId }), folderById, (created) => setFolders((current) => [...current, created]))
                    : undefined}
              /></SaveErrorField>
            </Field>
          </SettingsFormRow>
        </Card>

        <Card variant="form" gap="normal" aria-labelledby="q-question">
          <CardHeader size="stacked" title="質問" titleId="q-question" />
          <Field label="前文（空なら送らない）"><SaveErrorField names={["intro","question.intro"]}><TextField value={question.intro ?? ''} maxLength={4500} placeholder="例：いつもありがとうございます。" onChange={(event) => setQuestion((current) => ({ ...current, intro: event.target.value }))} /></SaveErrorField></Field>
          <Field label="質問文（160文字まで）" requirement={fields.requirement('text')}><SaveErrorField names={["text","question.text"]}><TextField {...fields.bind('text')} value={question.text} maxLength={160} placeholder="例：来月も定期便を続けますか？" aria-invalid={fields.invalid('text') || undefined} aria-describedby={fields.invalid('text') ? 'q-text-error' : undefined} onChange={(event) => setQuestion((current) => ({ ...current, text: event.target.value }))} /></SaveErrorField></Field>
          <FieldError id="q-text-error">{fields.error('text')}</FieldError>
          <Field label="答え方" optional={false}><SegmentedControl fit="content" aria-label="答え方" value={question.tapMode} options={[{ value: 'single', label: '1つだけ選ぶ' }, { value: 'multiple', label: 'いくつでも選ぶ' }]} onChange={tapMode => setQuestion(current => ({ ...current, tapMode }))} /></Field>
        </Card>

        <Card variant="form" gap="normal" aria-labelledby="q-choices">
          <CardHeader title="選択肢" titleId="q-choices" size="stacked" meta="答えをどこに残すかを、選択肢ごとに決めます" />
          <div className={styles.choices}>
            {question.choices.map((choice, index) => {
              return (
              <div key={choice.key ?? index} className={styles.choice}>
                <div className={styles.choiceHead}>
                  <span className={styles.choiceNo}>{`選択肢 ${index + 1}`}</span>
                  <Button type="button" variant="text" textTone="danger" disabled={question.choices.length <= 1} title={question.choices.length <= 1 ? '選択肢は1つ以上必要です。' : undefined} onClick={() => removeChoice(index)} aria-label={`選択肢 ${index + 1} を削除する`}><Trash2 size={16} aria-hidden="true" />削除する</Button>
                </div>
                <Field label="ボタンの文字（20文字まで）" requirement={fields.requirement(`choice-${index}`)}><SaveErrorField names={[`choices.${index}.label`,"label","choice.label"]}><TextField {...fields.bind(`choice-${index}`)} value={choice.label} maxLength={20} aria-invalid={fields.invalid(`choice-${index}`) || undefined} aria-describedby={fields.invalid(`choice-${index}`) ? `q-choice-${index}-error` : undefined} onChange={(event) => setChoice(index, { label: event.target.value })} /></SaveErrorField></Field>
                <FieldError id={`q-choice-${index}-error`}>{fields.error(`choice-${index}`)}</FieldError>
                {host ? (
                  <div {...fields.bind(`extras-${index}`)}><TapExtrasField error={fields.error(`extras-${index}`)} name={`選択肢${index + 1}`} unavailable={choice.behavior === 'tel' || choice.behavior === 'mail' ? '電話・メールを開く動きではタグ・加点を使えません。' : undefined} value={{ tagIds: choice.addTagIds, scoreChange: choice.scoreChange }} tags={tags} accountId={null} onChange={extra => setChoice(index, { addTagIds: extra.tagIds, scoreChange: extra.scoreChange })} /></div>
                ) : (
                  <Field label="押されたら" optional={false}>
                    <ChoiceActionErrorReveal index={index} onReveal={openAction} />
                    <div {...fields.bind(`extras-${index}`)}><TapActionSummary label={`選択肢 ${index + 1} の押されたら`} icon={choiceActionIcon(choice)} name={choiceActionText(choice, tags, scenarios)} invalid={fields.invalid(`extras-${index}`)} compact onOpen={() => openAction(index)} /></div>
                    <FieldError id={`q-extras-${index}-error`}>{fields.error(`extras-${index}`)}</FieldError>
                  </Field>
                )}
                <Field label="押したときの返信"><SaveErrorField names={[`choices.${index}.reply`,"reply","choice.reply"]}><TextField value={choice.reply ?? ''} maxLength={4500} onChange={(event) => setChoice(index, { reply: event.target.value })} /></SaveErrorField></Field>
              </div>
              )
            })}
          </div>
          <span>
            <Button type="button" variant="text" disabled={question.choices.length >= MAX_CHOICES} title={question.choices.length >= MAX_CHOICES ? `選択肢は${MAX_CHOICES}つまでです。` : undefined} onClick={addChoice}>
              <Plus size={16} aria-hidden="true" />{`選択肢を足す（最大 ${MAX_CHOICES} つ）`}
            </Button>
          </span>
        </Card>
      </TemplateEditFrame>

      {/* 押したときの動きは今の部品（QuestionEditor）を窓で開いて決める（タグ・友だち情報・シナリオ・URL など全部の設定）。 */}
      {!host && actionIndex !== null && actionDraft ? (() => {
        const draftChoice = actionDraft.choices[actionIndex]
        if (!draftChoice) return null
        return (
          <Dialog open title={`選択肢 ${actionIndex + 1}「${draftChoice.label || `選択肢${actionIndex + 1}`}」を押されたら`} size="medium" confirmLabel="決める" onConfirm={applyAction} onCancel={closeAction}>
            <QuestionEditor value={actionDraft} onChange={setActionDraft} choiceOnly={actionIndex} choiceColumns />
            <TapExtrasField name={`選択肢${actionIndex + 1}`} unavailable={draftChoice.behavior === 'tel' || draftChoice.behavior === 'mail' ? '電話・メールを開く動きではタグ・加点を使えません。' : undefined} value={{ tagIds: draftChoice.addTagIds, scoreChange: draftChoice.scoreChange }} tags={tags} accountId={selectedAccountId} onChange={extra => setActionDraft((current) => current ? { ...current, choices: current.choices.map((c, i) => (i === actionIndex ? { ...c, addTagIds: extra.tagIds, scoreChange: extra.scoreChange } : c)) } : current)} />
          </Dialog>
        )
      })() : null}
      <ConfirmDialog
        open={publishTarget !== null && publishTarget.generation === scope.current.generation}
        title="この質問を公開しますか？"
        description={`この質問は ${usageCount}か所で使われています。公開すると、シナリオや一斉配信へ新しい内容が届きます。`}
        confirmLabel="公開する"
        busy={saving || publishing}
        confirmDisabled={publishTarget !== null && publishTarget.form !== publishFormScope.current}
        confirmDisabledReason="内容が変わりました。閉じて確認し直してください。"
        error={error || undefined}
        designNode="cuR8I"
        onConfirm={async () => {
          if (!alive.current || !canMutateRef.current || !publishTarget || !renderedPublishTicket || renderedPublishTicket !== publishTicket.current || publishTarget.generation !== scope.current.generation || publishTarget.form !== publishFormScope.current) return
          setPublishing(true)
          try {
            let savedBeforeFailure = false
            if (await save('published', publishTarget.version, () => { savedBeforeFailure = true })) { publishTicket.current = null; setPublishTarget(null); leaveToList(); return }
            // 保存が通ってから公開に失敗した場合、確認時の版は自分の保存で古くなる。
            // 最新の対象・利用先と版を読み直して、あらためて確認してもらう。
            if (savedBeforeFailure) {
              const target = publishTarget
              publishTicket.current = null
              setPublishTarget(null)
              editVersion.current = null
              try {
                const latest = await api.templates.get(id!)
                if (!alive.current || target.generation !== scope.current.generation) return
                if (!latest.success || !latest.data.question || !isEditableQuestion(latest.data.question) || target.form !== publishFormScope.current) {
                  setError('最新の質問を確認できませんでした。読み直してから公開してください。')
                  return
                }
                const latestQuestion = latest.data.question
                const data = latest.data
                editVersion.current = { expectedVersion: data.publishedVersion, expectedDraftRevision: data.draftRevision }
                setTemplateAccountId(data.accountId ?? null)
                setTemplateAccountKnown(Object.prototype.hasOwnProperty.call(data, 'accountId') && data.accountId !== undefined)
                setName(data.name)
                setCategory(data.category || '未分類')
                setFolderId(data.folderId ?? null)
                setQuestion(latestQuestion)
                setSavedSnapshot(snapshotOf({ name: data.name, category: data.category || '未分類', folderId: data.folderId ?? null, question: latestQuestion }))
                setUsageCount(Object.values(data.usedBy).reduce((total, items) => total + items.length, 0))
                setError('下書きは保存しましたが、公開できませんでした。最新の内容を確認し、もう一度公開してください。')
              } catch {
                if (alive.current && target.generation === scope.current.generation) setError('最新の質問を読み直せませんでした。読み直してから公開してください。')
              }
            }
          } finally {
            setPublishing(false)
          }
        }}
        onCancel={() => { publishTicket.current = null; setPublishTarget(null) }}
      >{publishTarget ? <OperationTargetSummary allAccounts={publishTarget.allAccounts} accounts={publishTarget.allAccounts ? [] : [{ id: publishTarget.accountId }]} /> : null}</ConfirmDialog>
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="質問への変更" onConfirm={confirmLeave} onCancel={cancelLeave} />
    </></SaveErrorScope>
  )
}

/** `host` を渡すと統括のテンプレートの入口から使う（template-edit/host.ts）。押したときの動き（店のタグ・シナリオ）は出さない。 */
export default function QuestionNewV8({ host }: { host?: TemplateEditHost } = {}) {
  return (
    <Suspense fallback={<ListState kind="loading" title="質問テンプレートを準備しています" />}>
      <QuestionNew host={host} />
    </Suspense>
  )
}

/* 閉じた「押されたら」の欄に保存エラーが返ったら、その選択肢の窓を開いて理由を見せる。 */
const CHOICE_ACTION_FIELDS = ['behavior', 'url', 'tel', 'mail', 'userMessage', 'user_message', 'hideUserMessage', 'hide_user_message', 'repeatReply', 'repeat_reply']
function ChoiceActionErrorReveal({ index, onReveal }: { index: number; onReveal: (index: number) => void }) {
  useSaveErrorReveal(CHOICE_ACTION_FIELDS.map((name) => `choices.${index}.${name}`), useCallback(() => onReveal(index), [index, onReveal]))
  return null
}
