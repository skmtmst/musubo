'use client'

import { useEffect, useState } from 'react'
import type { AccountStyle } from '@line-crm/shared'
import { ArrowRight, Info } from 'lucide-react'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import HelpTip from '@/components/shared/help-tip'
import { STYLE_EXPERIENCE_SCRIPT } from '@/v8/onboarding/style-experience-player'
import { ProgressBar } from '@/components/shared/progress'
import { StyleChoiceStep, StyleChoiceSwitcher, STYLE_CHOICE_START_ID, StyleChoiceStatus, StyleChooseAction } from '@/v8/onboarding/public/style-choice'
import { readRegistrationPresentation, rememberRegistrationPresentation } from './registration-storage'
import styles from '@/v8/onboarding/wizard.module.css'

/** 登録の④でも、はじめの質問と同じ見本を見てからスタイルを選ぶ。 */
export default function RegistrationStyleDialog({ open, accountName, choice, busy, ready, error, onChoose, onSave, onClose, presentationKey = null }: {
  accountName?: string
  presentationKey?: string | null
  open: boolean
  choice: AccountStyle | ''
  busy: boolean
  ready: boolean
  error: string
  onChoose: (style: AccountStyle) => void
  onSave: (style: AccountStyle) => void
  onClose: () => void
}) {
  const [initial] = useState(() => readRegistrationPresentation(presentationKey))
  const [demoOpen, setDemoOpen] = useState(initial.demoOpen === true)
  const [demoPage, setDemoPage] = useState(initial.demoPage ?? 0)
  const [viewing, setViewing] = useState<AccountStyle>(choice || initial.viewing || 'restaurant')
  useEffect(() => { if (!open) { setDemoOpen(false); setDemoPage(0) } }, [open])
  useEffect(() => {
    rememberRegistrationPresentation(presentationKey, { viewing, demoOpen, demoPage })
  }, [presentationKey, viewing, demoOpen, demoPage])
  const viewStyle = (style: AccountStyle) => { setViewing(style); onChoose(style) }
  if (!open) return null
  return <Dialog
    open
    title="使い方のスタイルを選ぶ"
    titleHelp={<HelpTip label="使い方のスタイルの説明">ダッシュボードと初期設定が、選んだスタイルに合わせて変わります。あとから設定で変更できます。</HelpTip>}
    initialFocusId={STYLE_CHOICE_START_ID}
    size="wide"
    designTop={60}
    fitViewport
    contentLayout="form"
    steps={<StyleChoiceSwitcher viewing={viewing} onView={viewStyle} chosen={choice || null} disabled={busy} />}
    designNode="xxpM9"
    onCancel={demoOpen ? () => setDemoOpen(false) : onClose}
    busy={busy}
    error={error}
    footerDivider={false}
    designFooterPadding="16px 24px"
    designContentPadding="16px 24px 24px"
    footer={demoOpen ? <DialogActions leadingAction={<Button onClick={() => { if (demoPage > 0) setDemoPage(demoPage - 1) }} aria-disabled={demoPage === 0} disabled={busy}>前のページ</Button>}>
      <StyleChooseAction primary viewing={viewing} chosen={choice || null} onChoose={onChoose} disabled={busy} />
      <Button onClick={() => { if (demoPage < 4) setDemoPage(demoPage + 1) }} aria-disabled={demoPage === 4} disabled={busy}>次のページ</Button>
    </DialogActions> : <DialogActions>
      <Button type="button" variant="primary" onClick={() => onSave(viewing)} disabled={busy || !ready} busy={busy} busyLabel="保存しています…">{STYLE_EXPERIENCE_SCRIPT.styles[viewing].label}で次へ<ArrowRight size={16} aria-hidden="true" /></Button>
    </DialogActions>}
  >
    <div className={styles.body}>
      <div className={styles.progress}>
        <span className={styles.progressCount}>登録の手順 4 / 5</span>
        <ProgressBar appearance="quota" className={styles.track} value={4} max={5} label="登録の進み" />
        <span className={styles.progressName}>使い方のスタイル</span>
      </div>
      <StyleChoiceStatus chosen={choice || null} emptyText={`次へで選ぶスタイル：${STYLE_EXPERIENCE_SCRIPT.styles[viewing].label}`} />
      <StyleChoiceStep videoPreview accountName={accountName} viewing={viewing} onView={viewStyle} chosen={choice || null} onChoose={onChoose} disabled={busy} switcher="external" detail={demoOpen} onDetailChange={setDemoOpen} demoPage={demoPage} onDemoPage={setDemoPage} />
      <p className={styles.where}><Info aria-hidden="true" className={styles.whereIcon} />あとから変えられます（設定 › アカウント）。</p>
    </div>
  </Dialog>
}
