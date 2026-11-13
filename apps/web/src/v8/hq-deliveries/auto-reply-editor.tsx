'use client'

/*
 * 統括の自動応答のひな形を作る。店の自動応答と同じ手順の段（①基本設定 ②どんなときに動くか ③何を返すか ④優先順位 ⑤確認）。
 * ④優先順位は店ごとの並びで決まるため、統括では選べない（機能待ち：統括に優先順位の口が無い）。段は押せない形で出す。
 * 新しく選べる返し方は「この画面で書く」「返信しない」。保存済みの別種別は共通の見本で確認し、
 * 後処理は既存の統括候補APIにあるタグ・シナリオだけを編集し、その他の保存済み設定を引き継ぐ。
 */
import { useState, type ReactNode } from 'react'
import type { HqDeliveryTemplateDefinition } from '@line-crm/shared'
import { readLineImageContent } from '@/lib/line-image-content'
import ImageFrame from '@/components/shared/image-frame'
import Notice from '@/components/shared/notice'
import { responseTypeWord } from '@/v8/auto-replies/public/auto-reply-words/index'
import { ArrowRight, PenLine, CircleSlash } from 'lucide-react'
import { CreatePage } from '@/components/templates'
import { Steps } from '@/components/templates/steps'
import { CreateSummaryCard } from '@/components/templates/create-parts'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import Select from '@/components/shared/select'
import Toggle from '@/components/shared/toggle'
import SegmentedControl from '@/components/shared/segmented'
import LinePreview, { LinePreviewFlex, LinePreviewMessage } from '@/components/shared/line-preview'
import MusuboMark from '@/components/shared/musubo-mark'
import { TextField } from '@/components/shared/text-field'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import HqAutoReplyActions from './auto-reply-actions'
import type { HqActionResource } from './auto-reply-actions-model'
import HqMessageBody from '@/components/shared/hq-message-inserts'
import styles from './auto-reply-editor.module.css'

type StepKey = 'basic' | 'trigger' | 'reply' | 'priority' | 'confirm'
const STEP_LABELS: Record<StepKey, string> = { basic: '基本設定', trigger: 'どんなときに動くか', reply: '何を返すか', priority: '優先順位', confirm: '確認' }
const ORDER: StepKey[] = ['basic', 'trigger', 'reply', 'priority', 'confirm']
/* ④は統括では選べないので、次へは③→⑤へ飛ぶ。 */
const NEXT: Partial<Record<StepKey, StepKey>> = { basic: 'trigger', trigger: 'reply', reply: 'confirm' }

const DELAYS = [{ value: '0', label: 'すぐ返す' }, { value: '30', label: '30秒あける' }, { value: '60', label: '1分あける' }, { value: '300', label: '5分あける' }]
const SAMPLE_TOKENS: Record<string, string> = { '{{name}}': 'Kenta', '{{account.name}}': 'musubo', '{{var.store_phone}}': '03-0000-5678', '{{var.reservation_url}}': 'https://example.com/booking' }
const sample = (text: string) => text.replace(/\{\{[^}]+\}\}/g, (token) => SAMPLE_TOKENS[token] ?? '（友だち情報）')

export default function HqAutoReplyEditor({ title, help, notice, canEdit, busy, name, description, settings, references, onName, onDescription, onSetting, onActions, onCancel, onSave }: {
  title: string; help: ReactNode; notice: ReactNode; canEdit: boolean; busy: boolean
  name: string; description: string; settings: Record<string, unknown> | undefined
  references?: HqDeliveryTemplateDefinition['references']
  onName: (value: string) => void; onDescription: (value: string) => void; onSetting: (key: string, value: unknown) => void
  onActions?: (actions: unknown[], resources: HqActionResource[]) => void
  onCancel: () => void; onSave: () => void
}) {
  const [step, setStep] = useState<StepKey>('basic')
  const s = settings ?? {}
  const text = String(s.responseContent ?? '')
  const silent = s.responseType === 'silent'
  const templateId = typeof s.templateId === 'string' ? s.templateId : ''
  const template = references?.find(ref => ref.kind === 'template' && ref.sourceId === templateId)
  const responseType = typeof s.responseType === 'string' && s.responseType ? s.responseType : 'text'
  const textReply = !silent && !templateId && responseType === 'text'
  const preservedReply = !silent && !textReply
  const replyLabel = silent ? '返信しない' : templateId ? `テンプレート${template ? `「${template.name}」` : '（名前を確認できません）'}` : textReply ? `テキスト ${text.length}字` : responseTypeWord(responseType).label
  const actionCount = Array.isArray(s.actions) ? s.actions.length : s.actions == null ? 0 : null
  const afterLabel = actionCount === null ? '確認できません' : actionCount ? `${actionCount}つ` : 'なし'
  const image = !templateId && responseType === 'image' ? readLineImageContent(text) : null
  const keyword = String(s.keyword ?? '')
  const storeName = String(s.name ?? '')
  const done = (key: StepKey) => key === 'basic' ? Boolean(name.trim() && storeName.trim()) : key === 'trigger' ? Boolean(keyword.trim()) : key === 'reply' ? silent || Boolean(templateId) || Boolean(text.trim()) : false
  const index = ORDER.indexOf(step)
  const steps = ORDER.map((key, i) => ({
    key, label: STEP_LABELS[key],
    state: key === 'priority' ? 'todo' as const : i < index && done(key) ? 'done' as const : 'todo' as const,
    reachable: key !== 'priority' && (i <= index || ORDER.slice(0, i).filter((k) => k !== 'priority').every(done)),
    onSelect: key === 'priority' ? undefined : () => setStep(key),
  }))
  const req = (label: string, required: boolean) => ({ label, requirement: canEdit ? { required } : undefined, optional: canEdit && !required })
  const inserts = [...new Set((text.match(/\{\{[^}]+\}\}/g) ?? []).map((token) => token === '{{name}}' ? '名前（無いときは「お客さま」）' : token === '{{account.name}}' ? '店名' : token === '{{var.store_phone}}' ? '店の電話番号' : token === '{{var.reservation_url}}' ? '予約ページ' : '友だち情報'))]
  const next = NEXT[step]

  const preview = <>
    <CreateSummaryCard title="送るものの確認" rows={[
      { key: 'kind', label: '返すもの', value: replyLabel },
      { key: 'after', label: '後の処理', value: afterLabel },
      ...(inserts.length && textReply ? [{ key: 'inserts', label: '差し込み', value: inserts.join('・') }] : []),
    ]} />
    <LinePreview accountName="musubo">
      <div className={styles.talk}>
        <LinePreviewMessage direction="outgoing" accountName="musubo" avatar={null} time="10:12">{keyword ? `${keyword}したいです` : '（キーワードを含むメッセージ）'}</LinePreviewMessage>
        {silent ? null : <LinePreviewMessage density="compact" accountName="musubo" avatar={<MusuboMark />} time="10:12" bare={preservedReply && !templateId}>
          {templateId ? `${replyLabel}を使います。内容は配布先の同じ名前のテンプレートで確認してください。`
            : responseType === 'flex' ? <LinePreviewFlex content={text} />
            : responseType === 'image' && image ? <ImageFrame title="保存済みの返信画像" value={image.previewImageUrl} previewAlt="返信画像のプレビュー" readOnly />
            : textReply ? text.trim() ? sample(text) : '（返す文を書くと、ここに出ます）' : '保存済みの返信内容の見本を表示できません。'}
        </LinePreviewMessage>}
      </div>
    </LinePreview>
  </>

  return <CreatePage step={index} dirty={false} busy={busy} boardId="T5ljMA" title={title} help={help} notice={notice}
    steps={<Steps label="自動応答のひな形を作る手順" steps={steps} currentKey={step} readOnly={!canEdit} summaries={{ basic: name, trigger: keyword, reply: replyLabel }} />}
    preview={preview}
    footerActions={<>
      {/* ページ内に戻るは置かない（決まり）。前の段へは上の手順の段から戻る。 */}
      <Button disabled={busy} onClick={onCancel}>キャンセル</Button>
      {canEdit ? <Button disabled={busy || !name.trim()} title={!name.trim() ? '統括での名前を入力してください。' : undefined} onClick={onSave} busy={busy} busyLabel="保存中…">下書きとして保存</Button> : null}
      {next ? <Button variant="primary" disabled={busy || !done(step)} onClick={() => setStep(next)}>{`次へ：${STEP_LABELS[next]}`}<ArrowRight size={16} aria-hidden="true" /></Button> : null}
    </>}>
    {step === 'basic' ? <Card variant="form" gap="normal">
      <CardHeader size="stacked" title="基本設定" />
      <div className={styles.grid}>
        <Field {...req('統括での名前', true)} htmlFor="hq-ar-name"><SaveErrorField names={['name']}>{canEdit ? <TextField id="hq-ar-name" value={name} onChange={(event) => onName(event.target.value)} placeholder="例：予約変更のご案内" /> : <span>{name}</span>}</SaveErrorField></Field>
        <Field {...req('店に届く名前', true)} htmlFor="hq-ar-store-name"><SaveErrorField names={['definition.settings.name']}>{canEdit ? <TextField id="hq-ar-store-name" value={storeName} onChange={(event) => onSetting('name', event.target.value)} /> : <span>{storeName}</span>}</SaveErrorField></Field>
        <Field {...req('説明', false)} htmlFor="hq-ar-desc"><SaveErrorField names={['description']}>{canEdit ? <TextField id="hq-ar-desc" value={description} onChange={(event) => onDescription(event.target.value)} /> : <span>{description}</span>}</SaveErrorField></Field>
      </div>
    </Card> : null}

    {step === 'trigger' ? <Card variant="form" gap="normal">
      <CardHeader size="stacked" title="どんなときに動くか" />
      <div className={styles.grid}>
        <Field {...req('キーワード', true)} htmlFor="hq-ar-keyword"><SaveErrorField names={['keyword', 'definition.settings.keyword']}>{canEdit ? <TextField id="hq-ar-keyword" value={keyword} onChange={(event) => onSetting('keyword', event.target.value)} placeholder="例：予約変更" /> : <span>{keyword}</span>}</SaveErrorField></Field>
        <Field {...req('一致方法', true)}>{canEdit ? <Select aria-label="一致方法" value={String(s.matchType ?? 'contains')} options={[{ value: 'contains', label: '含む' }, { value: 'exact', label: '完全一致' }]} onChange={(value) => onSetting('matchType', value)} /> : <span>{s.matchType === 'exact' ? '完全一致' : '含む'}</span>}</Field>
      </div>
    </Card> : null}

    {step === 'reply' ? <>
      <Card variant="form" gap="normal">
        <CardHeader size="stacked" title="返すもの" />
        {canEdit && !preservedReply ? <SegmentedControl aria-label="返すもの" size="compact" value={silent ? 'silent' : 'text'} onChange={(value) => onSetting('responseType', value)}
          options={[{ value: 'text', label: <span className={styles.choice}><PenLine size={16} aria-hidden="true" />この画面で書く</span> }, { value: 'silent', label: <span className={styles.choice}><CircleSlash size={16} aria-hidden="true" />返信しない（記録だけ）</span> }]} /> : null}
        {preservedReply ? <Notice tone="info">{`${replyLabel}を保存しています。この画面では返信内容を変更できません。ほかの設定を保存しても、その内容は引き継がれます。`}</Notice> : silent ? <p className={styles.note}>返信はしません。キーワードに当たったことだけを店の記録に残します。</p>
          : <SaveErrorField names={['responseContent', 'definition.settings.responseContent']}><HqMessageBody value={text} label="返信内容" onChange={(value) => onSetting('responseContent', value)} readOnly={!canEdit} disabled={busy} /></SaveErrorField>}
      </Card>
      {onActions ? <HqAutoReplyActions value={s.actions} references={references} canEdit={canEdit} busy={busy} onChange={onActions} /> : null}
      <Card variant="form" gap="normal">
        <CardHeader size="stacked" title="細かい決まり" />
        <div className={styles.rules}>
          <div className={styles.rule}><span>返すまで待つ時間</span>{canEdit ? <Select aria-label="返すまで待つ時間" disabled={busy} value={String(s.replyDelaySeconds ?? 0)} options={DELAYS} onChange={(value) => onSetting('replyDelaySeconds', Number(value) || null)} /> : <span>{DELAYS.find((item) => item.value === String(s.replyDelaySeconds ?? 0))?.label ?? '—'}</span>}</div>
          <div className={styles.rule}><span>同じ人へ続けて返さない</span><span className={styles.ruleEnd}>{s.cooldownMinutes ? <small>{`${s.cooldownMinutes}分あける`}</small> : null}{canEdit ? <Toggle label="同じ人へ続けて返さない" disabled={busy} checked={Boolean(s.cooldownMinutes)} onChange={(on) => onSetting('cooldownMinutes', on ? 60 : null)} /> : <span>{s.cooldownMinutes ? 'オン' : 'オフ'}</span>}</span></div>
          <div className={styles.rule}><span>担当者が対応中のトークには返さない</span>{canEdit ? <Toggle label="担当者が対応中のトークには返さない" disabled={busy} checked={Boolean(s.skipWhenOperatorActive)} onChange={(on) => onSetting('skipWhenOperatorActive', on)} /> : <span>{s.skipWhenOperatorActive ? 'オン' : 'オフ'}</span>}</div>
          <div className={styles.rule}><span>1人につき1回だけ返す<small>オフのときは、同じ人が何度送っても返す（上の「続けて返さない」の時間は守る）</small></span>{canEdit ? <Toggle label="1人につき1回だけ返す" disabled={busy} checked={Boolean(s.oncePerFriend)} onChange={(on) => onSetting('oncePerFriend', on)} /> : <span>{s.oncePerFriend ? 'オン' : 'オフ'}</span>}</div>
        </div>
      </Card>
    </> : null}

    {step === 'confirm' ? <Card variant="form" gap="normal">
      <CardHeader size="stacked" title="確認" />
      <dl className={styles.confirm}>
        <dt>統括での名前</dt><dd>{name || '—'}</dd>
        <dt>店に届く名前</dt><dd>{storeName || '—'}</dd>
        <dt>キーワード</dt><dd>{keyword ? `「${keyword}」を${s.matchType === 'exact' ? '完全一致' : '含む'}` : '—'}</dd>
        <dt>返すもの</dt><dd>{replyLabel}</dd>
        <dt>後の処理</dt><dd>{afterLabel}</dd>
        <dt>優先順位</dt><dd>配った先の店で、ほかの自動応答との順番を決めます。</dd>
      </dl>
      <p className={styles.note}>保存すると、配るアカウントを選べます。店には下書きとして届きます。</p>
    </Card> : null}
  </CreatePage>
}
