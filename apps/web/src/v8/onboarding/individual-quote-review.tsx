'use client'

import Button from '@/components/shared/button'
import { useMemo, useState } from 'react'
import Checkbox from '@/components/shared/checkbox'
import {
  individualQuoteAccess,
  musuboIndividualQuotePrice,
  type MusuboIndividualQuote,
} from '@line-crm/shared'
import styles from './individual-quote-review.module.css'

interface Props {
  quote: MusuboIndividualQuote
  now: string
  onAccept: (quoteNumber: string) => Promise<void>
  onResumeCardRegistration: (quoteNumber: string) => void
  onRequestReissue: (quoteNumber: string) => Promise<void>
  onOpenLatestQuote: () => void
}

const money = (yen: number) => `¥${new Intl.NumberFormat('ja-JP').format(yen)}`
const dateJst = (iso: string) => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(iso))

export default function IndividualQuoteReview({ quote, now, onAccept, onResumeCardRegistration,
  onRequestReissue, onOpenLatestQuote }: Props) {
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const result = useMemo(() => {
    try { return { access: individualQuoteAccess(quote, now), price: musuboIndividualQuotePrice(quote) } }
    catch { return null }
  }, [quote, now])
  const perform = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try { await action() }
    catch { setError('処理を完了できませんでした。時間をおいて再度お試しください。') }
    finally { setBusy(false) }
  }

  if (!result) return <div className={styles.page}><h1>お見積もりを表示できません</h1>
    <p>見積もりの内容を確認できませんでした。担当者へお問い合わせください。</p></div>

  const { access, price } = result
  const firstLine = quote.plannedLinkedAccountsByLine[0]
  const trialText = quote.trialPeriod.unit === 'months'
    ? `${quote.trialPeriod.value}か月` : `${quote.trialPeriod.value}日間`

  if (access !== 'available') {
    const accepted = access === 'accepted'
    const expired = access === 'expired'
    return <div className={styles.page}>
      <div className={styles.breadcrumb}>ホーム › 利用開始の準備 › お見積もりの確認</div>
      <h1>{accepted ? '見積もりの同意は完了しています' : expired ? 'お見積もりの有効期限が切れました' : '新しいお見積もりをご確認ください'}</h1>
      <p className={styles.lead}>{accepted ? '料金条件は確定済みです。続きのカード登録から手続きを再開できます。'
        : expired ? '期限内の同意がなかったため、この見積もりからカード登録には進めません。'
          : 'このリンクの見積もりは新しい内容に差し替えられました。'}</p>
      <div className={styles.statusCard}>
        <div className={accepted ? styles.statusIconSuccess : styles.statusIconWarning} aria-hidden="true">{accepted ? '✓' : '!'}</div>
        <div className={styles.statusContent}>
          <div className={styles.statusHead}><h2>{accepted ? 'カード登録から再開できます' : expired ? '新しい見積もりをご依頼ください' : '新しい見積もりをご確認ください'}</h2>
            <span className={accepted ? styles.badgeSuccess : styles.badgeWarning}>{accepted ? '同意済み' : expired ? '期限切れ' : '旧リンク無効'}</span></div>
          <p>{accepted ? '見積もり期限内に同意した単価と適用条件は確定しています。カード登録がまだでも、期限後にそのまま続けられます。'
            : expired ? '料金条件を確認して新しい見積もりをお送りします。新しい内容への同意後にカード登録へ進めます。'
              : '変更前の見積もりには同意できません。登録メールアドレスへお送りした新しい見積もりで料金をご確認ください。'}</p>
          <dl className={styles.statusDetails}><div><dt>{accepted ? '同意した見積もり' : '元の見積もり番号'}</dt><dd>{quote.quoteNumber}</dd></div>
            <div><dt>{accepted ? '同意日時' : '有効期限'}</dt><dd>{dateJst(accepted ? quote.acceptedAt! : quote.expiresAt)}</dd></div></dl>
          <h3>このあとの流れ</h3>
          <ol>{(accepted ? ['Stripeでカードを登録', '既存のウィザードでLINEを接続', 'LINE有効化日から無料期間を開始']
            : expired ? ['再発行を依頼', '運営が料金を確認してメールでご案内', '新しい見積もりに同意してカード登録']
              : ['新しいご案内メールを確認', '変更後の料金と有効期限を確認', '新しい見積もりに同意してカード登録'])
            .map((step) => <li key={step}>{step}</li>)}</ol>
          <p className={styles.note}>{accepted ? '見積もりの再同意は不要です。カード登録だけでは請求も無料期間も始まりません。'
            : expired ? '再発行前にカードの登録や請求が始まることはありません。'
              : '未同意の旧見積もりは無効です。新しい見積もりの内容を確認して同意してください。'}</p>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <Button type="button" variant="primary" className={styles.primary} busy={busy} busyLabel="処理中…" onClick={() => {
            if (accepted) onResumeCardRegistration(quote.quoteNumber)
            else if (expired) void perform(() => onRequestReissue(quote.quoteNumber))
            else onOpenLatestQuote()
          }}>{accepted ? 'カード登録を再開する' : expired ? '再発行を依頼する' : '最新のお見積もりを開く'}</Button>
        </div>
      </div>
    </div>
  }

  return <div className={styles.page}>
    <div className={styles.breadcrumb}>ホーム › 利用開始の準備 › お見積もりの確認</div>
    <h1>お見積もりの確認</h1>
    <p className={styles.lead}>料金と無料期間をご確認のうえ、同意してカード登録へお進みください。</p>
    <ol className={styles.steps}><li className={styles.current}>見積もりを確認</li><li>カードを登録</li><li>LINEを接続</li></ol>
    <div className={styles.columns}>
      <section className={styles.card} aria-labelledby="quote-summary">
        <p className={styles.eyebrow}>個別見積もり · {quote.quoteNumber}</p>
        <h2 id="quote-summary">予定の連携がすべて有効になった場合</h2>
        {quote.interval === 'month' ? <div className={styles.amount}>{money(price.plannedMonthlyTotalYen!)}<small>／月（税込）</small></div>
          : <><div className={styles.amount}>{money(price.finalAnnualLineChargeYen!)}<small>／年（税込）</small></div>
            <p className={styles.annualNote}>オプション料金 {money(price.optionsMonthlyYen)}／月は毎月別に請求します。</p></>}
        <p className={styles.scope}>LINE {quote.plannedLineCount}個{firstLine && quote.plannedLineCount === 1
          ? `・Googleマイビジネス${firstLine.googleBusiness}個・Instagram${firstLine.instagram}個` : ''}の予定で計算しています。</p>
        <div className={styles.rule} />
        <h3>料金の内訳</h3>
        <dl className={styles.breakdown}>
          <div><dt>LINE基本料金・{quote.plannedLineCount}個</dt><dd>{quote.interval === 'month' ? `${money(price.finalLineBasicMonthlyYen)}／月` : `${money(price.finalAnnualLineChargeYen!)}／年`}</dd></div>
          {price.headquartersMonthlyYen > 0 && <div><dt>統括機能</dt><dd>{money(price.headquartersMonthlyYen)}／月</dd></div>}
          {price.linkedSlots > 0 && <div><dt>追加連携枠・{price.linkedSlots}枠</dt><dd>{money(price.linkedAccountSlotsMonthlyYen)}／月</dd></div>}
          {price.friendOverageMonthlyYen > 0 && <div><dt>友だち数の追加料金</dt><dd>{money(price.friendOverageMonthlyYen)}／月</dd></div>}
        </dl>
        <div className={styles.info}><strong>料金は接続した分から決まります</strong><p>各サービスの1個目は基本料金内です。追加連携を増やす前に、料金の増分を確認できます。</p></div>
      </section>
      <section className={styles.card} aria-labelledby="quote-terms">
        <h2 id="quote-terms">適用する利用条件</h2>
        <dl className={styles.terms}><div><dt>無料期間</dt><dd>{trialText}</dd></div>
          <div><dt>カード登録時の請求</dt><dd>{money(0)}</dd></div>
          <div><dt>見積もり有効期限</dt><dd>{dateJst(quote.expiresAt)}</dd></div></dl>
        <p className={styles.small}>無料期間は最初のLINEを有効化した日から始まります。終了後の初回請求日は、LINE有効化後に表示します。</p>
        <Checkbox className={styles.consent} checked={agreed} onCheckedChange={setAgreed}>
          料金条件・無料期間・今後の請求について確認し、同意します
        </Checkbox>
        <p className={styles.small}>同意した単価と適用条件は確定します。請求額は実際の連携数で決まり、期限後もカード登録を再開できます。カード情報はmusuboに保存しません。</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <Button type="button" variant="primary" className={styles.primary} busy={busy} busyLabel="処理中…" disabled={!agreed}
          onClick={() => void perform(async () => {
            await onAccept(quote.quoteNumber)
            onResumeCardRegistration(quote.quoteNumber)
          })}>同意してカード登録へ</Button>
      </section>
    </div>
  </div>
}
