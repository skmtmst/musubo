'use client'
import SegmentedControl from '@/components/shared/segmented'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { LayoutTemplate, RefreshCw } from 'lucide-react'
import { api, type AutomationListItem, type AutomationTemplateSummary } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { ListPage, ListPageCards, ListPageSection } from '@/components/templates/list-page'
import Card from '@/components/shared/card'
import TruncatedText from '@/components/shared/truncated-text'
import Button from '@/components/shared/button'
import { notifySaved } from '@/components/shared/toast'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import {
  AUTOMATIONS_DESCRIPTION,
  AutomationTabs,
  ViewerBand,
  automationTabHref,
  useAutomationManage,
  useAutomationTabCounts,
} from './shell'
import styles from './templates.module.css'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'


/*
 * ★V8 オートメーションの見本（Pencil ・`/automations?tab=templates`）。
 *
 * 2026-10-07 src/v8 に一から書いた（今の V8 は 8%）。データの口・下書きを作る動き・権限・失敗時の扱いは
 * 今までの V8（app/automations/templates-v8.tsx）と同じ（BEHAVIOR.md）。違いは見せ方だけ——
 * 型（ListPage）に、タブ・きっかけの札の段・4列のカード・注記を渡す。
 */

type LoadStatus = 'loading' | 'ready' | 'error'

/** 札に出すきっかけの数（絵は「すべて」＋6つ。残りは「すべて」から見る）。 */
const MAX_TRIGGER_CHIPS = 6
/** 1行に並べる札の数（絵は「すべて」＋4つ＋「+2」。残りは「+N」で開く）。 */
const INLINE_TRIGGER_CHIPS = 4

/** きっかけの言い方（口は「友だちになったとき」。絵は「友だちになった」）。 */
export function templateTriggerText(label: string): string {
  return label.replace(/とき(?=（|$)/, '')
}

/** 札の分け方：かっこの補足を外したきっかけ（「注文が確定した（初回）」→「注文が確定した」）。 */
export function templateTriggerGroup(label: string): string {
  return templateTriggerText(label).replace(/（[^）]*）$/, '').trim()
}

/** 札にするきっかけ：先に出てきた順に6つまで。 */
export function templateTriggerChips(items: Pick<AutomationTemplateSummary, 'triggerLabel'>[]): string[] {
  const groups: string[] = []
  for (const item of items) {
    const group = templateTriggerGroup(item.triggerLabel)
    if (group && !groups.includes(group)) groups.push(group)
  }
  return groups.slice(0, MAX_TRIGGER_CHIPS)
}

export default function AutomationTemplatesV8() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('オートメーション')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const router = useRouter()
  const { selectedAccountId, loading: accountLoading } = useAccount()
  /* 閲覧のみには「この見本で下書きを作る」「見本から作る」を置かない（2026-10-06 オーナー決定）。 */
  const canManage = useAutomationManage()
  const canEdit = canManage === true
  const viewerOnly = canManage === false

  const [items, setItems] = useState<AutomationTemplateSummary[]>([])
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [rules, setRules] = useState<AutomationListItem[] | null>(null)
  const [trigger, setTrigger] = useState('')
  const [creating, setCreating] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const operationKeysRef = useRef<Record<string, string>>({})
  const requestRef = useRef(0)
  const saveScope = useRef({ accountId: selectedAccountId, generation: 0, mounted: true })
  if (saveScope.current.accountId !== selectedAccountId) saveScope.current = { ...saveScope.current, accountId: selectedAccountId, generation: saveScope.current.generation + 1 }
  useEffect(() => { saveScope.current.mounted = true; return () => { saveScope.current.mounted = false } }, [])
  useEffect(() => { setCreating(null) }, [selectedAccountId])

  const load = useCallback(async () => {
    const requestId = ++requestRef.current
    if (!selectedAccountId) {
      setItems([])
      setStatus('ready')
      return
    }
    setStatus('loading')
    setActionError('')
    try {
      const [templatesRes, listRes] = await Promise.all([
        api.automations.templates(selectedAccountId),
        api.automations.list({ accountId: selectedAccountId }).catch(() => null),
      ])
      if (requestId !== requestRef.current) return
      if (!templatesRes.success) throw new Error(templatesRes.error)
      setItems(templatesRes.data)
      setRules(listRes && listRes.success ? listRes.data : null)
      setStatus('ready')
    } catch (saveFailure) {
      if (requestId !== requestRef.current) return
      saveErrors.capture(saveFailure)
      setItems([]);

      setStatus('error')
    }
  }, [selectedAccountId, saveErrors])

  useEffect(() => {
    if (accountLoading)
 return
    void load();

    return () => { requestRef.current += 1 }
  }, [accountLoading, load])
  useEffect(() => { setTrigger('') }, [selectedAccountId])

  const currentRules = rules?.filter((rule) => rule.status !== 'archived') ?? null
  const tabCounts = useAutomationTabCounts(currentRules ? currentRules.length : null)
  const chips = useMemo(() => templateTriggerChips(items), [items])
  const [chipsOpen, setChipsOpen] = useState(false)
  const hiddenChipCount = chipsOpen ? 0 : Math.max(0, chips.length - INLINE_TRIGGER_CHIPS)
  const shownChips = hiddenChipCount > 0
    ? chips.slice(0, INLINE_TRIGGER_CHIPS).concat(chips.indexOf(trigger) >= INLINE_TRIGGER_CHIPS ? [trigger] : [])
    : chips
  const visible = useMemo(
    () => (trigger ? items.filter((item) => templateTriggerGroup(item.triggerLabel) === trigger) : items),
    [items, trigger],
  )

  const create = async (item: AutomationTemplateSummary) => {
    if (!selectedAccountId || creating || !canEdit) return
    const generation = saveScope.current.generation
    const current = () => saveScope.current.mounted && saveScope.current.generation === generation
    setCreating(item.key)
    setActionError('')
    // 同じ操作のやり直しだけが同じ鍵を使う（別の新規作成は別の鍵）。
    const slot = `${selectedAccountId}:${item.key}`
    const operationKey = operationKeysRef.current[slot] ?? (operationKeysRef.current[slot] = crypto.randomUUID())
    try {
      const response = await api.automations.createDraftFromTemplate(item.key, selectedAccountId, operationKey)
      if (!current()) return
      if (!response.success) throw new Error(response.error)
      delete operationKeysRef.current[slot]
      notifySaved('見本から下書きを作りました。')
      router.push(`/automations/drafts?id=${encodeURIComponent(response.data.id)}`)
    } catch (saveFailure) {
      if (!current()) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionError('下書きを作れませんでした。状態を読み直してから、もう一度お試しください。') }
      setCreating(null)
    }
  }

  /* ===== 本文 ===== */
  let body: ReactNode
  if (accountLoading || status === 'loading') {
    body = <ListState kind="loading" title="見本を読み込んでいます" />
  } else if (!selectedAccountId) {
    body = <ListState kind="empty" title="LINE公式アカウントを選んでください" description="見本から作る下書きは、選んだアカウントだけに保存します。" />
  } else if (status === 'error') {
    body = (
      <ListState
        kind="error"
        title="見本を表示できませんでした"
        description="まだ下書きは作っていません。再読み込みしてから選んでください。"
        onRetry={() => void load()}
      />
    )
  } else {
    body = (
      <>
        <ListPageSection><div className={styles.tools}>
          <span className={styles.toolsLabel}>きっかけ</span>
          <div role="group" aria-label="きっかけで絞り込む" className={styles.chips}>
            <SegmentedControl aria-label="きっかけで絞り込む" fit="content" value={trigger} onClear={() => setTrigger('')} onChange={setTrigger} options={[
              { value: '', label: 'すべて', count: items.length }, ...shownChips.map((chip) => ({ value: chip, label: chip })),
            ]} />
            {hiddenChipCount > 0 ? (
              <Button variant="text" aria-expanded={false} onClick={() => setChipsOpen(true)}>
                {`+${hiddenChipCount}`}
              </Button>
            ) : null}
          </div>
          <Button variant="secondary" onClick={() => load()} busyLabel="処理中…">
            <RefreshCw size={16} aria-hidden="true" />見本を再読み込み
          </Button>
        </div>
        {actionError ? <Notice tone="danger">{actionError}</Notice> : null}</ListPageSection>
        {visible.length === 0 ? (
          <ListState kind="empty" emptyPreset={trigger ? 'filtered' : 'readonly'} title={trigger ? '条件に合う見本はありません' : '使える見本はまだありません'} description={trigger ? 'きっかけの絞り込みを外すと、すべて出ます。' : 'このアカウントで使える見本が登録されると、ここに表示されます。'} action={trigger ? <Button onClick={() => setTrigger('')}>条件を外す</Button> : undefined} />
        ) : (
          <section role="list" aria-label="見本"><ListPageCards columns={4}>
            {visible.map((item) => {
              const triggerText = templateTriggerText(item.triggerLabel)
              return (
                <Card key={item.key} role="listitem" layout="vertical" padding="compact" gap="tight">
                  <h2 className={styles.cardTitle} title={item.name}>{item.name}</h2>
                  <dl className={styles.facts}>
                    <div className={styles.fact}>
                      <dt>きっかけ</dt>
                      <dd title={triggerText}><TruncatedText value={triggerText} /></dd>
                    </div>
                    <div className={styles.fact}>
                      <dt>すること</dt>
                      <dd title={item.actionLabel}><TruncatedText value={item.actionLabel} /></dd>
                    </div>
                  </dl>
                  {canEdit ? (
                    <Button
                      variant="secondary"
                      disabled={creating !== null}
                      busy={creating === item.key}
                      busyLabel="下書きを作っています…"
                      onClick={() => void create(item)}
                    >
                      この見本で下書きを作る
                    </Button>
                  ) : null}
                </Card>
              )
            })}
          </ListPageCards></section>
        )}
        <ListPageSection><p className={styles.note}>実行まで確認できた見本だけを、ここへ表示します。見本に実データは入っていません。見本から作る下書きは、選んだアカウントだけに保存します。</p></ListPageSection>
      </>
    )
  }

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      boardId="c7dxp"
      headingSize="regular"
      title="オートメーション"
      help={AUTOMATIONS_DESCRIPTION}
      actions={canEdit
        ? <Button href={automationTabHref('templates')}><LayoutTemplate size={16} aria-hidden="true" />見本から作る</Button>
        : null}
      tabs={<AutomationTabs active="templates" counts={tabCounts} />}
      stats={<>
        {viewerOnly ? <ViewerBand /> : null}
      </>}
    >
      {status === 'ready' && items.length > 0 ? body : <ListPageSection>{body}</ListPageSection>}
    </ListPage></SaveErrorScope>
  )
}
