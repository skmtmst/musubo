'use client'

import { notifySaved } from '@/components/shared/toast'

import { scrollMotion } from '@/components/shared/overlay-utils'
import { useFeatureAccess } from '@/lib/use-feature-access';
import { createPageReturnHref } from '@/components/shared/create-page';
import CopyTextButton from '@/components/shared/copy-text-button'
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlignLeft, CalendarClock, CalendarDays, Hash, Image as ImageIcon, Link2, ToggleLeft, Type, Upload } from 'lucide-react';
import Link from '@/components/shared/list-navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';

import type { Folder } from '@line-crm/shared';
import { api, ApiError, describeSaveFailure } from '@/lib/api';
import { commonVarValueError, isSecretLikeVarValue, COMMON_VAR_VALUE_REQUIRED } from '@/lib/common-vars';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard';
import { useAccount } from '@/contexts/account-context';
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { CreatePage } from '@/components/templates';
import Button from '@/components/shared/button'
import DateField from '@/components/shared/date-field'
import DateTimeField from '@/components/shared/date-time-field'
import LinePreview, { LinePreviewMessage } from '@/components/shared/line-preview'
import MusuboMark from '@/components/shared/musubo-mark'
import { AffixedTextField, TextArea, TextField } from '@/components/shared/text-field'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import FolderSelect, { folderById, folderCreator } from '@/components/shared/folder-select';
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog';
import styles from './new.module.css'
import { focusFieldById } from '@/lib/use-form-errors';
import { Field } from '@/components/shared/form-controls';
import { withPermissionFailure, describeApiFailure } from '@/components/shared/api-error-message';
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import Card, { CardHeader } from '@/components/shared/card'
import { SettingsFormRow } from '@/components/shared/settings-form-card'

/*
 * ★V8 共通情報を作る（板 ）。
 *
 * 型は作る（CreatePage）：頭（戻る・題・説明）→ 左に3枚のカード（名前と差し込み名・
 * 種別と中身・使える期間）と社内メモ、右の列に秘密値の注意と差し込んだときの見え方、
 * 下の帯にキャンセル・下書きを保存・保存して公開。
 * データの口・入力検査・秘密値の守り・下書き保存は `app/contents/vars/new/new-v8.tsx`
 * から写した（import はしない）。動きの一覧は同じ場所の BEHAVIOR.md。
 */

/*
 * 種別8つ。板  のカードの並び（標準・長文・数値・URL／
 * 画像・年月日・日時・はい／いいえ）にそろえる。種別は登録後に
 * 変えられない（値の意味が変わるため）。
 */
const TYPES: Array<{ key: string; label: string; desc: string; icon: typeof Type; placeholder: string }> = [
  { key: 'text', label: '標準', desc: '電話番号・営業時間', icon: Type, placeholder: '10:00-18:00、集客セミナー' },
  { key: 'long_text', label: '長文', desc: '200文字をこえる案内', icon: AlignLeft, placeholder: '詳しいご案内' },
  { key: 'number', label: '数値', desc: '日ごとに書き換える', icon: Hash, placeholder: '10、124.3、30000' },
  { key: 'url', label: 'URL', desc: '予約ページ・地図', icon: Link2, placeholder: 'https://example.com/reserve' },
  { key: 'image', label: '画像', desc: 'ロゴ・バナーのURL', icon: ImageIcon, placeholder: 'https://example.com/logo.png' },
  { key: 'date', label: '年月日', desc: '日付', icon: CalendarDays, placeholder: '2026-09-16' },
  { key: 'datetime', label: '日時', desc: '日付と時刻', icon: CalendarClock, placeholder: '2026-09-16T10:00' },
  { key: 'boolean', label: 'はい／いいえ', desc: 'true / false', icon: ToggleLeft, placeholder: 'true' },
]

const NAME_MAX = 200
const VALUE_MAX = 200
const MEMO_MAX = 1000

const JP_SECRET_LABELS = [
  'パスワード', '合言葉', '暗証番号', 'ピン', 'PIN',
  '秘密鍵', 'シークレット', 'クライアントシークレット',
  'トークン', 'アクセストークン', 'リフレッシュトークン',
  'APIキー', 'API鍵', 'アクセスキー', '認証コード',
] as const

const JP_SECRET_SEPARATOR = String.raw`(?:\s*[=:：]\s*|[\s　]+|の?は\s*|が\s*)?[「『"'　]*`
const JP_SECRET_VALUE = String.raw`[A-Za-z0-9][A-Za-z0-9_.+/=-]{3,}`

const SENSITIVE_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:password|passwd|pwd|secret|token|api[_ -]?key|access[_ -]?key|channel[_ -]?secret)\s*[=:：]\s*\S{4,}/i,
  new RegExp(`(?:${JP_SECRET_LABELS.join('|')})${JP_SECRET_SEPARATOR}${JP_SECRET_VALUE}`),
  /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}\b/i,
] as const

function looksLikeSensitiveValue(input: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(input))
}

function sensitiveFieldLabels(value: string, memo: string): string[] {
  return [
    ...(looksLikeSensitiveValue(value) ? ['値'] : []),
    ...(looksLikeSensitiveValue(memo) ? ['社内メモ'] : []),
  ]
}

/* 欄へ移る。閉じた段は開き、スクロールしてからフォーカスする。 */
function focusField(id: string) {
  focusFieldById(id)
}

function focusTargetForReason(message: string): string | null {
  if (message.includes('代替値')) return 'cv-fallback-value'
  if (message.includes('有効開始')) return 'cv-valid-from'
  if (message.includes('有効終了')) return 'cv-valid-until'
  if (message.includes('名前')) return 'cv-name'
  if (message.includes('メモ')) return 'cv-memo'
  if (message.includes('値')) return 'cv-value'
  return null
}

/* 1欄ぶんの確かめ。文は「何をすれば直るか」を1文で書く。 */
function validateVarName(value: string): string | null {
  return value.trim() ? null : '共通情報名を入力してください'
}

const VAR_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/

function validateVarKey(value: string): string | null {
  if (!value.trim()) return '差し込み名を入力してください'
  return VAR_KEY_PATTERN.test(value.trim())
    ? null
    : '差し込み名は半角の英小文字で始め、英小文字・数字・下線だけで32文字までにしてください'
}

/*
 * 欄の下の赤い1行。4欄で同じ形にするため1か所にまとめる。
 * 直書きの className を欄ごとに増やさない（design-debt の計数）。
 */
function VarFieldError({ message }: { message: string }) {
  if (!message) return null
  return <p className={styles.fieldError} role="alert">{message}</p>
}

function suggestKey(name: string): string {
  const ascii = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!ascii || !/^[a-z]/.test(ascii)) return ''
  return ascii.slice(0, 32)
}

export default function NewCommonVarV8() {
  const saveErrors = useSaveFormErrors()

  const [copied, setCopied] = useState(false)
  usePageTitle('共通情報を作る')
  usePageCrumbs([
    { label: 'ホーム', href: '/' },
    { label: '共通情報', href: '/contents/vars' },
  ])
  const { selectedAccountId, selectedAccount, loading: accountLoading, error: accountError } = useAccount()
  const latestAccountRef = useRef(selectedAccountId)
  latestAccountRef.current = selectedAccountId
  const router = useRouter()

  /*
   * 登録の口は `requireRole('owner', 'admin')` で閉じている。staff には
   * 閲覧のみの帯を出して保存の押し口を押せない形にする（閉さない）。
   */
  const canWrite = useFeatureAccess('commonVars')

  const [folders, setFolders] = useState<Folder[]>([])
  const [name, setName] = useState('')
  const [folderId, setFolderId] = useState('')
  const [varKey, setVarKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [type, setType] = useState('text')
  const [value, setValue] = useState('')
  const [memo, setMemo] = useState('')
  const [validFrom, setValidFrom] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [expiryBehavior, setExpiryBehavior] = useState<'stop' | 'fallback'>('stop')
  const [fallbackValue, setFallbackValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [valueFieldError, setValueFieldError] = useState('')
  const [fallbackFieldError, setFallbackFieldError] = useState('')
  /* 名前・差し込み名は欄から離れたとき（blur）に確かめ、直したらその場で消す。 */
  const [nameFieldError, setNameFieldError] = useState('')
  const [keyFieldError, setKeyFieldError] = useState('')
  const [periodFieldError, setPeriodFieldError] = useState('')
  const [secretWarningFields, setSecretWarningFields] = useState<string[] | null>(null)
  const valueRef = useRef<HTMLInputElement>(null)
  const secretWarningRef = useRef<HTMLDivElement>(null)
  const boundAccountRef = useRef(selectedAccountId)

  const [foldersError, setFoldersError] = useState(false)
  const loadFolders = useCallback(async () => {
    try {
      const res = await api.folders.list('common_var')
      if (res.success) {
        setFolders(res.data)
        setFoldersError(false)
      } else {
        setFoldersError(true)
      }
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setFoldersError(true)
    }
  }
  }, [saveErrors])

  useEffect(() => {
    void loadFolders()
  }, [loadFolders])

  useEffect(() => {
    if (selectedAccountId === boundAccountRef.current) return
    const hadDraft = Boolean(name || varKey || value || memo || secretWarningFields)
    boundAccountRef.current = selectedAccountId
    setName('')
    setFolderId('')
    setVarKey('')
    setKeyTouched(false)
    setType('text')
    setValue('')
    setMemo('')
    setValidFrom('')
    setValidUntil('')
    setExpiryBehavior('stop')
    setFallbackValue('')
    setSecretWarningFields(null)
    setSaving(false)
    setError(hadDraft ? 'LINEアカウントが切り替わったため、入力をやり直してください' : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 切替検知のみに使うため、フォーム値は依存に入れない
  }, [selectedAccountId])

  useEffect(() => {
    if (secretWarningFields) secretWarningRef.current?.scrollIntoView({ behavior: scrollMotion(), block: 'center' })
  }, [secretWarningFields])

  const valueErrorMessageRef = useRef('')
  const fallbackErrorMessageRef = useRef('')
  useEffect(() => {
    setValueFieldError('')
    const message = valueErrorMessageRef.current
    valueErrorMessageRef.current = ''
    if (message) setError((current) => (current === message ? '' : current))
  }, [value, type])
  useEffect(() => {
    setFallbackFieldError('')
    const message = fallbackErrorMessageRef.current
    fallbackErrorMessageRef.current = ''
    if (message) setError((current) => (current === message ? '' : current))
  }, [fallbackValue, type])

  const dirty = Boolean(
    name || varKey || value || memo || folderId ||
    validFrom || validUntil || fallbackValue ||
    type !== 'text' || expiryBehavior !== 'stop',
  )
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: saving })

  const spec = TYPES.find((t) => t.key === type) ?? TYPES[0]

  const save = async (allowSensitive = false, asDraft = false) => {
    if (saving) return
    if (!selectedAccountId) {
      setError('LINEアカウントを選択してください')
      return
    }
    if (selectedAccountId !== boundAccountRef.current) {
      setSecretWarningFields(null)
      setError('LINEアカウントが切り替わったため、入力をやり直してください')
      return
    }
    const accountAtRequest = selectedAccountId
    /*
     * 欄の誤りは下の帯ではなく、その欄の真下に全部出し、上から1つ目へ移る。
     * 帯に残すのはアカウントの選び直しなど欄に結び付かないものだけ。
     */
    const nameProblem = validateVarName(name) ?? ''
    const keyProblem = validateVarKey(varKey) ?? ''
    const valueProblem = commonVarValueError(type, value) ?? ''
    const periodProblem = validFrom && validUntil && validFrom >= validUntil ? '有効終了は有効開始より後にしてください' : ''
    const fallbackProblem = expiryBehavior !== 'fallback' ? ''
      : !fallbackValue ? '期限切れ時に使う代替値を入力してください'
        : commonVarValueError(type, fallbackValue, '代替値') ?? ''
    setNameFieldError(nameProblem)
    setKeyFieldError(keyProblem)
    setValueFieldError(valueProblem)
    valueErrorMessageRef.current = ''
    setPeriodFieldError(periodProblem)
    setFallbackFieldError(fallbackProblem)
    fallbackErrorMessageRef.current = ''
    const firstProblem = nameProblem ? 'cv-name' : keyProblem ? 'cv-key' : valueProblem ? 'cv-value' : periodProblem ? 'cv-valid-from' : fallbackProblem ? 'cv-fallback-value' : null
    if (firstProblem) {
      setError('')
      focusField(firstProblem)
      return
    }
    if (expiryBehavior === 'fallback') {
      const fallbackError = commonVarValueError(type, fallbackValue, '代替値')
      if (fallbackError) {
        setError(fallbackError)
        setFallbackFieldError(fallbackError)
        fallbackErrorMessageRef.current = fallbackError
        focusField('cv-fallback-value')
        return
      }
    }
    const secretField = isSecretLikeVarValue(value)
      ? 'cv-value'
      : expiryBehavior === 'fallback' && isSecretLikeVarValue(fallbackValue)
        ? 'cv-fallback-value'
        : null
    if (secretField) {
      const message = '鍵やトークンのような秘密の値は共通情報に保存できません。外部連携の設定へ登録してください'
      if (!saveErrors.fail("expiryBehavior", message))
      setError(message)
      if (secretField === 'cv-value') {
        setValueFieldError(message)
        valueErrorMessageRef.current = message
      } else {
        setFallbackFieldError(message)
        fallbackErrorMessageRef.current = message
      }
      focusField(secretField)
      return
    }
    const sensitiveFields = sensitiveFieldLabels(value, memo)
    if (sensitiveFields.length > 0 && !allowSensitive) {
      setSecretWarningFields(sensitiveFields)
      setError('')
      return
    }
    setSaving(true)
    setSecretWarningFields(null)
    setError('')
    try {
      const payload = {
        accountId: accountAtRequest,
        name: name.trim(),
        varKey: varKey.trim(),
        type,
        value,
        memo,
        folderId: folderId || null,
        validFrom: validFrom || null,
        validUntil: validUntil || null,
        expiryBehavior,
        fallbackValue: expiryBehavior === 'fallback' ? fallbackValue : null,
        status: asDraft ? 'draft' as const : 'active' as const,
      }
      const res = await api.commonVars.create(payload)
      if (accountAtRequest !== latestAccountRef.current) return
      if (!res.success) {
        setError(res.error)
        const target = focusTargetForReason(res.error)
        if (target === 'cv-value') {
          setValueFieldError(res.error)
          valueErrorMessageRef.current = res.error
        } else if (target === 'cv-fallback-value') {
          setFallbackFieldError(res.error)
          fallbackErrorMessageRef.current = res.error
        }
        return
      }
      notifySaved(asDraft ? '共通情報の下書きを保存しました。' : '共通情報を作成しました。')
      router.push(createPageReturnHref('/contents/vars', res.data.id))
    } catch (e) {
      const fieldFailure = saveErrors.capture(e);

      if (e instanceof ApiError && e.status === 409) {
        { if (!fieldFailure)

        setError('その差し込み名は既に使われています') }
        focusField('cv-key')
      } else {
        { if (!fieldFailure)
        setError(withPermissionFailure(e, describeSaveFailure(e), 'store')) }
        if (e instanceof ApiError && (e.status === 400 || e.status === 422)) {
          const detail = describeApiFailure(e, '入力内容の確認')
          const target = e.status === 422 ? 'cv-key' : focusTargetForReason(e.message)
          if (target) focusField(target)
          if (target === 'cv-value') {
            { if (!fieldFailure)
            setValueFieldError(detail) }
            valueErrorMessageRef.current = detail
          } else if (target === 'cv-fallback-value') {
            { if (!fieldFailure)
            setFallbackFieldError(detail) }
            fallbackErrorMessageRef.current = detail
          }
        }
      }
    } finally {
      setSaving(false)
    }
  }

  const saveDisabled = saving || !canWrite
  const previewName = name.trim() || '共通情報'

  const previewAccountName = !accountLoading && !accountError && selectedAccountId && selectedAccount?.id === selectedAccountId
    ? selectedAccount.displayName?.trim() || selectedAccount.name.trim() || 'アカウント名未取得'
    : 'アカウント名未取得'

  const preview = (
    <>
      <Notice tone="warn" heading="秘密の値は入れないでください">
        パスワード・APIキー・トークンなどは保存できません（入れると止めます）。配信文に誤って差し込まれるおそれがあります。外部連携の設定に登録してください。
      </Notice>
      <LinePreview caption="差し込んだ例" accountName={previewAccountName} note="差し込んだときの見え方です。名前と中身を入れると、ここが変わります。">
        <LinePreviewMessage accountName={previewAccountName} avatar={<MusuboMark />} time="10:00">
          {`いつもありがとうございます。\n${previewName}は ${value || emptyValue('unconfigured')} です。`}
        </LinePreviewMessage>
      </LinePreview>
    </>
  )

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage
      boardId="p82v9"
      title="共通情報を作る"
      help="保存しただけでは差し込まれません。公開すると使えるようになります"
      identity={<></>}
      preview={preview}
      footerActions={(
        <>
          <Button href="/contents/vars">キャンセル</Button>
          {/* 閲覧のみには押せない保存を置かない（隠す）。 */}
          {canWrite ? (
            <>
              <Button type="button" disabled={saveDisabled} onClick={() => save(false, true)} busy={Boolean(saving)} busyLabel="処理中…">
                下書きを保存
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={saveDisabled}
                onClick={() => save()}
                busy={saving}
                busyLabel="保存中…"
              >
                <Upload size={16} aria-hidden="true" />
                保存して公開
              </Button>
            </>
          ) : null}
        </>
      )} dirty={false}
    >
      {canWrite ? null : (
        <div className={styles.roBand}><ReadOnlyNotice role="status"></ReadOnlyNotice></div>
      )}

      {!accountLoading && !selectedAccountId && (
        <Notice tone="warn" message="共通情報を登録するLINEアカウントを選択してください。" />
      )}

      <Card variant="form" gap="normal" aria-labelledby="cv-new-name-heading">
        <CardHeader size="stacked" titleId="cv-new-name-heading" title="名前と差し込み名" />
        <SettingsFormRow layout="name-folder">
          <div className={styles.field}><Field density="input" required label="共通情報名（友だちには見えません）" htmlFor="cv-name"><SaveErrorField names={["name"]}><TextField
              id="cv-name"
              type="text"
              maxLength={NAME_MAX}
              value={name}
              onChange={(e) => {
                const next = e.target.value
                setName(next)
                if (!keyTouched) setVarKey(suggestKey(next))
                if (nameFieldError && validateVarName(next) === null) setNameFieldError('')
              }}
              onBlur={() => setNameFieldError(validateVarName(name) ?? '')}
              placeholder="例：営業時間"
              aria-invalid={nameFieldError ? true : undefined}
              title={`${name.length}/${NAME_MAX}文字`}
            /></SaveErrorField>
<VarFieldError message={nameFieldError} /></Field></div>
          <div className={styles.field}><Field density="input" label="フォルダ" htmlFor="cv-folder"><div className={styles.selectBox}>
              <SaveErrorField names={["folderId","folder_id"]}><FolderSelect size="full"
                aria-label="フォルダ"
                id="cv-folder"
                value={folderId}
                onChange={(value) => setFolderId(value)}
                folders={folders.map(folderById)}
                onCreate={canWrite && selectedAccountId
                ? folderCreator((name, color) => api.folders.create({ kind: 'common_var', name, color, accountId: selectedAccountId }), folderById, (created) => setFolders((current) => [...current, created]))
                : undefined}
              /></SaveErrorField>
            </div>
{foldersError ? (
              <div className={styles.folderError} data-folders-state="error">
                <p className={styles.fieldHint}>フォルダの一覧を読み込めませんでした。未分類のまま登録できます。</p>
                <Button type="button" onClick={() => loadFolders()} busyLabel="処理中…">
                  再読み込み
                </Button>
              </div>
            ) : null}</Field></div>
        </SettingsFormRow>
        <div className={styles.field}><Field density="input" note={<>
            半角の英小文字で始め、英小文字・数字・下線だけ・32文字まで。変えるとテンプレートの差し込みが空になるため、あとから変えられません。
          </>} required label="差し込み名（あとから変えられません）" htmlFor="cv-key"><div className={styles.keyRow}>
            <SaveErrorField names={["varKey","keyTouched","var_key","key_touched"]}><AffixedTextField
                monospace
                startAdornment="{{var."
                endAdornment="}}"
                id="cv-key"
                type="text"
                value={varKey}
                onChange={(e) => {
                  const next = e.target.value
                  setKeyTouched(true)
                  setVarKey(next)
                  if (keyFieldError && validateVarKey(next) === null) setKeyFieldError('')
                }}
                onBlur={() => setKeyFieldError(validateVarKey(varKey) ?? '')}
                placeholder="例：shop_hours"
                aria-invalid={keyFieldError ? true : undefined}
              /></SaveErrorField>
            <CopyTextButton label="コピーする" value={`{{var.${varKey.trim()}}}`} aria-label="差し込み名をコピー" disabled={!varKey.trim()} />
          </div>
<VarFieldError message={keyFieldError} />
</Field></div>
      </Card>

      <Card variant="form" gap="normal" aria-labelledby="cv-new-type-heading">
        <CardHeader size="stacked" titleId="cv-new-type-heading" title="種別と中身" meta="種別は作ったあと変えられません" />
        <RadioCardGroup legend="種別" className={styles.typeGrid}>
          {TYPES.map((entry) => {
            const Icon = entry.icon
            const checked = type === entry.key
            return (
              <RadioCard
                key={entry.key}
                variant="card"
                name="common-var-type"
                value={entry.key}
                checked={checked}
                title={entry.label}
                note={entry.desc}
                icon={<Icon size={16} aria-hidden="true" />}
                onChange={() => {
                  setType(entry.key)
                  setValue('')
                }}
                onClick={() => setValue('')}
              />
            )
          })}
        </RadioCardGroup>
        <div className={styles.field}><Field density="input" label="中身" htmlFor="cv-value" required={COMMON_VAR_VALUE_REQUIRED.has(type)}>{type === 'boolean' ? (
            <SaveErrorField names={["value"]}><Select size="full" aria-label="中身" id="cv-value" error={valueFieldError || undefined} value={value} onChange={(next) => { setValue(next); setSecretWarningFields(null) }} options={[{ value: '', label: '選んでください' }, { value: 'true', label: 'true' }, { value: 'false', label: 'false' }]} /></SaveErrorField>
          ) : type === 'long_text' ? (
            <SaveErrorField names={["value"]}><TextArea
              id="cv-value"
              maxLength={10000}
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setSecretWarningFields(null)
              }}
              placeholder={`例：${spec.placeholder}`}
              aria-invalid={valueFieldError ? true : undefined}
              rows={3}
              title={`${value.length}/10000文字`}
            /></SaveErrorField>
          ) : type === 'date' ? (
            <SaveErrorField names={["value"]}><DateField
              id="cv-value"
              invalid={Boolean(valueFieldError)}
              value={value}
              onChange={(v) => { setValue(v); setSecretWarningFields(null) }}
            /></SaveErrorField>
          ) : type === 'datetime' ? (
            <SaveErrorField names={["value"]}><DateTimeField
              id="cv-value"
              invalid={Boolean(valueFieldError)}
              value={value}
              onChange={(v) => { setValue(v); setSecretWarningFields(null) }}
            /></SaveErrorField>
          ) : (
            <SaveErrorField names={["value"]}><TextField
              ref={valueRef}
              id="cv-value"
              type={type === 'number' ? 'number' : 'text'}
              maxLength={type === 'number' ? undefined : VALUE_MAX}
              value={value}
              onChange={(e) => { setValue(e.target.value); setSecretWarningFields(null) }}
              placeholder={`例：${spec.placeholder}`}
              aria-invalid={valueFieldError ? true : undefined}
              title={type === 'number' ? undefined : `${value.length}/${VALUE_MAX}文字`}
            /></SaveErrorField>
          )}
<VarFieldError message={valueFieldError} /></Field></div>
      </Card>

      <Card variant="form" gap="normal" aria-labelledby="cv-new-period-heading">
        <CardHeader size="stacked" titleId="cv-new-period-heading" title="使える期間" meta="空なら期間を決めません。予約した配信は、送り始める時刻で判断します" />
        <SettingsFormRow layout="columns" columns={3}>

          <Field density="input" label="始まり" htmlFor="cv-valid-from"><SaveErrorField names={["validFrom","valid_from"]}><DateTimeField id="cv-valid-from" value={validFrom} onChange={(next) => { setValidFrom(next); setPeriodFieldError('') }} invalid={Boolean(periodFieldError)} /></SaveErrorField></Field>
          <Field density="input" label="終わり" htmlFor="cv-valid-until"><SaveErrorField names={["validUntil","valid_until"]}><DateTimeField id="cv-valid-until" value={validUntil} onChange={(next) => { setValidUntil(next); setPeriodFieldError('') }} invalid={Boolean(periodFieldError)} /></SaveErrorField></Field>
          <div className={styles.selectBox}>
            <Field density="input" label="期間の外では" htmlFor="cv-expiry-behavior"><SaveErrorField names={["expiryBehavior","expiry_behavior"]}><Select size="full" aria-label="期間の外では" id="cv-expiry-behavior" value={expiryBehavior} onChange={(next) => setExpiryBehavior(next as 'stop' | 'fallback')} options={[{ value: 'stop', label: '配信を止める' }, { value: 'fallback', label: '代替値を使う' }]} /></SaveErrorField></Field>
          </div>
        </SettingsFormRow>
        <VarFieldError message={periodFieldError} />
        {expiryBehavior === 'fallback' && (
          <div className={styles.field}><Field density="input" label="代替値" htmlFor="cv-fallback-value">{type === 'boolean' ? (
              <SaveErrorField names={["fallbackValue","fallback_value"]}><Select size="full" aria-label="代替値" id="cv-fallback-value" error={fallbackFieldError || undefined} value={fallbackValue} onChange={(next) => setFallbackValue(next)} options={[{ value: '', label: '選んでください' }, { value: 'true', label: 'true' }, { value: 'false', label: 'false' }]} /></SaveErrorField>
            ) : type === 'date' ? (
              <SaveErrorField names={["fallbackValue","fallback_value"]}><DateField id="cv-fallback-value" invalid={Boolean(fallbackFieldError)} value={fallbackValue} onChange={setFallbackValue} /></SaveErrorField>
            ) : type === 'datetime' ? (
              <SaveErrorField names={["fallbackValue","fallback_value"]}><DateTimeField id="cv-fallback-value" invalid={Boolean(fallbackFieldError)} value={fallbackValue} onChange={setFallbackValue} /></SaveErrorField>
            ) : (
              <SaveErrorField names={["fallbackValue","fallback_value"]}><TextField
                id="cv-fallback-value"
                type={type === 'number' ? 'number' : 'text'}
                value={fallbackValue}
                onChange={(e) => setFallbackValue(e.target.value)}
                  aria-invalid={fallbackFieldError ? true : undefined}
              /></SaveErrorField>
            )}
<VarFieldError message={fallbackFieldError} /></Field></div>
        )}
      </Card>

      <div className={styles.field}><Field density="input" label="社内メモ" htmlFor="cv-memo"><SaveErrorField names={["memo"]}><TextField
          id="cv-memo"
          type="text"
          maxLength={MEMO_MAX}
          value={memo}
          onChange={(e) => {
            setMemo(e.target.value)
            setSecretWarningFields(null)
          }}
          placeholder="例：臨時休業のときは「臨時のお知らせ」も直す"
        /></SaveErrorField></Field></div>

      {secretWarningFields && (
        <Notice tone="warn" ref={secretWarningRef} role="alertdialog" aria-labelledby="cv-secret-warning-title" aria-describedby="cv-secret-warning-description" action={<>
          <div className={styles.secretConfirmActions}>
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                const firstField = secretWarningFields[0]
                setSecretWarningFields(null)
                if(firstField === '社内メモ') focusField('cv-memo')
                else valueRef.current?.focus()
              }}
            >
              入力に戻って修正する
            </Button>
            <Button type="button" disabled={saving} onClick={() => save(true)} busy={Boolean(saving)} busyLabel="処理中…">
              内容を確認して作る
            </Button>
          </div>
        </>}>
          <h2 id="cv-secret-warning-title" className={styles.secretConfirmTitle}>
            秘密値の可能性がある内容を確認してください
          </h2>
          <p id="cv-secret-warning-description" className={styles.secretConfirmText}>
            {secretWarningFields.join('・')}に、パスワードやトークンなどの秘密値らしい内容があります。
            共通情報には保存せず、安全な保管場所へ移してください。
          </p>
        </Notice>
      )}

      {error && <Notice tone="danger" className={styles.formErrorNoticePlacement} >{error}</Notice>}

      <UnsavedLeaveDialog open={leaveTarget !== null} subject="入力した共通情報" onConfirm={confirmLeave} onCancel={cancelLeave} />
    </CreatePage></SaveErrorScope>
  )
}
