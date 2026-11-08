'use client'

import Button from '@/components/shared/button'
import { useState } from 'react'
import styles from './line-resumption.module.css'

type Interval = 'month' | 'year'

export type LineResumeReviewView =
  | { kind: 'trial_remaining'; conditionName: string; freeUntil: string; nextChargeAt: string; nextLineBaseYen: number; trialPeriodLabel: string; interval: Interval }
  | { kind: 'annual_paid'; conditionName: string; paidThrough: string; renewalAt: string; nextAnnualLineBaseYen: number }
  | { kind: 'paid_expired'; conditionName: string; interval: Interval; dueOnConnectionYen: number; nextLineBaseYen: number }
  | { kind: 'unpaid'; amountDueYen: number; invoiceAt: string; periodStart: string; periodEnd: string }

export type LineResumeCompleteView =
  | { kind: 'trial_remaining'; restartedAt: string; freeUntil: string; nextChargeAt: string; nextLineBaseYen: number; interval: Interval }
  | { kind: 'annual_paid'; restartedAt: string; paidThrough: string; renewalAt: string; nextAnnualLineBaseYen: number }
  | { kind: 'paid'; restartedAt: string; chargedNowYen: number; nextChargeAt: string; nextLineBaseYen: number; interval: Interval }

const money = (value: number) => `¥${new Intl.NumberFormat('ja-JP').format(value)}`
const date = (value: string) => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
}).format(new Date(value))
const cadence = (interval: Interval) => interval === 'month' ? '月' : '年'

function StatusBand({ warning = false, title, description, badge }: {
  warning?: boolean; title: string; description: string; badge?: string
}) {
  return <div className={warning ? styles.statusWarning : styles.statusSuccess}>
    <span className={warning ? styles.iconWarning : styles.iconSuccess} aria-hidden="true">{warning ? '!' : '✓'}</span>
    <div className={styles.statusCopy}><h2>{title}</h2><p>{description}</p></div>
    {badge && <span className={warning ? styles.badgeWarning : styles.badgeSuccess}>{badge}</span>}
  </div>
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}

function ProgressSteps({ payment = false }: { payment?: boolean }) {
  const steps = payment
    ? [['過去の請求を支払う', 'Stripeの画面で確認します'], ['決済完了を確認', '結果を自動で反映します'], ['再開料金を確認', '新しい請求前に内容を確認']]
    : [['料金を確認', '適用条件と請求日を確認します'], ['カードを確認', '更新が必要な場合だけStripeへ'], ['LINEを接続', '既存の接続手順へ進みます']]
  return <ol className={styles.steps}>{steps.map(([title, note], index) =>
    <li key={title}><span className={styles.stepNumber}>{index + 1}</span><div><strong>{title}</strong><small>{note}</small></div></li>)}</ol>
}

/** Present a server-verified renewal offer. This component never starts a charge itself. */
export function LineResumptionReview({ view, onContinue, onPayOutstanding, onBack }: {
  view: LineResumeReviewView
  onContinue: () => Promise<void> | void
  onPayOutstanding: () => Promise<void> | void
  onBack: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const unpaid = view.kind === 'unpaid'
  const title = unpaid ? '再開前にお支払いが必要です' : '利用を再開する'
  const status = view.kind === 'trial_remaining'
    ? ['無料体験の残り期間で再開できます', '最初のLINE有効化日から数えた無料期間を引き継ぎます。', '無料体験の残り']
    : view.kind === 'annual_paid'
      ? ['お支払い済み期間内は再請求しません', `LINE基本料金1個分は${date(view.paidThrough)}までお支払い済みです。`, '年払い済み']
      : view.kind === 'paid_expired'
        ? ['LINE接続成功日から有料利用を再開', '支払い済み期間は終了しています。無料体験の再適用はありません。', '有料再開']
        : ['未払いがあるため利用再開を保留しています', '支払い状況が反映されるまでLINE接続には進めません。', '再開を保留']
  const perform = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await (unpaid ? onPayOutstanding() : onContinue()) }
    catch { setError('手続きを開始できませんでした。時間をおいて再度お試しください。') }
    finally { setBusy(false) }
  }
  return <div className={styles.page}>
    <p className={styles.breadcrumb}>ホーム › 統括の設定 › 請求 › 利用再開</p>
    <h1>{title}</h1>
    <p className={styles.lead}>{unpaid
      ? '過去の未払いがあります。お支払いの完了を確認した後、再開時の料金をご案内します。'
      : '同じ会社アカウントで再開できます。料金を確認してからLINEを接続してください。'}</p>
    <StatusBand warning={unpaid} title={status[0]} description={status[1]} badge={status[2]} />
    <div className={styles.columns}>
      <section className={styles.card} aria-labelledby="resume-price-title">
        <h2 id="resume-price-title">{unpaid ? '過去の未払い' : '再開するLINEと料金'}</h2>
        {unpaid ? <><div className={styles.amountRow}><div><span>お支払いが必要な金額（税込）</span><strong>{money(view.amountDueYen)}</strong></div>
          <span className={styles.amountWarning}>未払い</span></div>
          <dl className={styles.details}><DetailRow label="請求日" value={date(view.invoiceAt)} />
            <DetailRow label="対象の利用期間" value={`${date(view.periodStart)}〜${date(view.periodEnd)}`} />
            <DetailRow label="再開手続き" value="お支払い後に再開" /></dl>
          <p className={styles.info}>この請求は利用終了後も残ります。再開分の料金とは別です。</p></>
          : <><div className={styles.amountRow}><div><span>再開するLINE公式アカウント</span><strong>1個</strong></div>
            <span className={styles.conditionBadge}>{view.conditionName}</span></div>
            <dl className={styles.details}>
              <DetailRow label="LINE接続時の請求" value={view.kind === 'paid_expired' ? `${money(view.dueOnConnectionYen)}（税込）` : '¥0'} />
              <DetailRow label="次の請求日" value={view.kind === 'trial_remaining' ? date(view.nextChargeAt)
                : view.kind === 'annual_paid' ? date(view.renewalAt)
                  : view.interval === 'month' ? 'LINE有効化日の1か月後' : 'LINE有効化日の1年後'} />
              <DetailRow label="次回のLINE基本料金" value={view.kind === 'annual_paid'
                ? `${money(view.nextAnnualLineBaseYen)}／年（税込）`
                : `${money(view.nextLineBaseYen)}／${cadence(view.interval)}（税込）`} />
            </dl>
            <p className={styles.info}>{view.kind === 'trial_remaining'
              ? `無料期間は${date(view.freeUntil)}までです。再開しても新しい${view.trialPeriodLabel}の無料期間は始まりません。`
              : view.kind === 'annual_paid'
                ? `${date(view.paidThrough)}までの1個分を二重請求せず、${date(view.renewalAt)}に更新します。`
                : 'LINE接続に成功した日に1個目の基本料金を請求します。接続前の請求はありません。'}</p></>}
      </section>
      <section className={styles.card} aria-labelledby="resume-steps-title">
        <h2 id="resume-steps-title">{unpaid ? 'お支払い後の流れ' : '再開までの流れ'}</h2>
        <p className={styles.cardLead}>{unpaid ? '決済完了を確認してから再開の料金をご案内します。'
          : '会社情報やログイン用アカウントの再登録は不要です。'}</p>
        <ProgressSteps payment={unpaid} />
        {error && <p className={styles.error} role="alert">{error}</p>}
        <Button type="button" variant="primary" className={styles.primary} busy={busy} busyLabel="処理中…" onClick={() => void perform()}>
          {unpaid ? '未払いを支払う' : '確認して次へ進む'}</Button>
      </section>
    </div>
    <div className={styles.footer}><p>{unpaid
      ? 'カード情報はmusuboに保存しません。お支払い完了後に再開の料金確認へ戻ります。'
      : view.kind === 'trial_remaining'
        ? '無料期間と初回請求日は、適用中の利用条件から表示します。カード情報はmusuboに保存しません。'
        : view.kind === 'annual_paid'
          ? 'お支払い済みの範囲は再請求しません。追加分は接続前に別途料金を確認します。'
          : '実際の請求日と次回請求日はLINE接続成功日から確定します。無料体験は再適用されません。'}</p>
      <button type="button" className={styles.back} onClick={onBack}>{unpaid ? '請求履歴を見る' : '請求に戻る'}</button></div>
  </div>
}

/** Card updates and LINE connection are distinct gates after accepting the resumption price. */
export function LineResumptionHandover({ phase, onPrimary, onBack }: {
  phase: 'card_required' | 'ready'
  onPrimary: () => Promise<void> | void
  onBack: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const card = phase === 'card_required'
  const perform = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await onPrimary() }
    catch { setError('手続きを開始できませんでした。時間をおいて再度お試しください。') }
    finally { setBusy(false) }
  }
  return <div className={styles.page}>
    <p className={styles.breadcrumb}>ホーム › 統括の設定 › 請求 › 利用再開</p>
    <h1>{card ? 'お支払い方法を確認' : 'LINEを接続して再開'}</h1>
    <p className={styles.lead}>{card
      ? '再開時の料金は確認済みです。登録済みカードの更新が必要な場合だけ手続きします。'
      : '料金とお支払い方法を確認しました。続けてLINE公式アカウントを接続してください。'}</p>
    <section className={styles.handoverCard} aria-label="再開手続きの確認">
      <StatusBand warning={card} title={card ? 'カードの確認が必要です' : '再開の準備ができました'}
        description={card
          ? 'カードの有効期限が切れているか、お支払い方法を確認できません。Stripeの画面で更新してください。'
          : '会社アカウントはそのまま使えます。既存のLINE接続手順で、1個目のLINEを有効化します。'} />
      <div className={styles.progressBox}><strong>再開手続きの状態</strong>
        <p>✓　再開時の料金と請求日を確認済み</p>
        <p>{card ? '○　カードの更新待ち・LINE未接続' : '✓　カード確認済み・LINE接続待ち'}</p></div>
      <p className={styles.handoverNote}>{card
        ? 'カード情報はStripeが管理します。更新だけでは新しいLINE基本料金の請求は始まりません。'
        : '料金が発生する場合は、LINE接続の成功時に確定します。接続を中断しても利用は再開しません。'}</p>
    </section>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.bottom}><button type="button" className={styles.back} onClick={onBack}>再開料金の確認に戻る</button>
      <Button type="button" variant="primary" className={styles.bottomPrimary} busy={busy} busyLabel="処理中…" onClick={() => void perform()}>
        {card ? 'Stripeでカードを更新' : 'LINEアカウントを接続'}</Button></div>
  </div>
}

/** Shown only after the existing LINE wizard confirms an active connection. */
export function LineResumptionComplete({ view, onAccounts }: { view: LineResumeCompleteView; onAccounts: () => void }) {
  const trial = view.kind === 'trial_remaining'
  const annual = view.kind === 'annual_paid'
  const statusTitle = trial ? '無料体験の残り期間で再開しました'
    : annual ? 'お支払い済みの期間で利用を再開しました' : '有料利用を再開しました'
  const charge = view.kind === 'paid' ? view.chargedNowYen : 0
  return <div className={styles.page}>
    <p className={styles.breadcrumb}>ホーム › アカウント › 登録完了</p>
    <h1>LINEの利用を再開しました</h1>
    <p className={styles.lead}>LINEの接続確認が完了し、musuboの機能を再び利用できます。</p>
    <section className={styles.completeCard} aria-label="利用再開の結果">
      <div className={styles.completeHeading}><span className={styles.iconSuccess} aria-hidden="true">✓</span><h2>{statusTitle}</h2></div>
      <p>{trial ? '適用中の利用条件の残り期間を引き継ぎます。再開しても無料期間は最初からやり直しません。'
        : annual ? '支払い済みの1個分のLINE基本料金を二重請求しません。'
          : '無料体験の再適用はありません。請求はLINEの接続成功時から始まります。'}</p>
      <div className={styles.completeSummary}><div><span>有効なLINE公式アカウント</span><strong>1個</strong></div>
        <div><span>再開日のLINE基本料金</span><strong className={styles.greenAmount}>{money(charge)}</strong></div>
        <p>再開日：{date(view.restartedAt)}<br />
          {trial ? <>元の無料期間終了：{date(view.freeUntil)}<br />初回請求予定：{date(view.nextChargeAt)}（{cadence(view.interval)}額 {money(view.nextLineBaseYen)}・税込）</>
            : annual ? <>お支払い済みの期間：{date(view.paidThrough)}まで<br />次の年次更新：{date(view.renewalAt)}（{money(view.nextAnnualLineBaseYen)}・税込）</>
              : <>今回の請求：{money(view.chargedNowYen)}（税込）<br />次の請求予定：{date(view.nextChargeAt)}（{cadence(view.interval)}額 {money(view.nextLineBaseYen)}・税込）</>}</p>
      </div>
      <p className={styles.completeHint}>LINEを増やすときは、接続前に増分の料金をご確認いただけます。</p>
    </section>
    <div className={styles.bottom}><p>再開後の料金と請求日は、請求画面でも確認できます。</p>
      <button type="button" className={styles.bottomPrimary} onClick={onAccounts}>アカウント一覧へ</button></div>
  </div>
}
