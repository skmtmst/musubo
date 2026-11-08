'use client'

import Button from '@/components/shared/button'
import { useMemo, useState } from 'react'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import { musuboIndividualQuotePrice, suggestMusuboQuoteAnnualLineCharge,
  type MusuboIndividualQuote, type MusuboPriceSchedule } from '@line-crm/shared'
import styles from './individual-quote-editor.module.css'

interface Props {
  initialQuote: MusuboIndividualQuote
  recipientEmail: string
  onSaveDraft: (quote: MusuboIndividualQuote) => Promise<void>
  onSend: (quote: MusuboIndividualQuote) => Promise<void>
}

const money = (yen: number) => `¥${new Intl.NumberFormat('ja-JP').format(yen)}`
const jstLocal = (iso: string) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(iso)).replace(' ', 'T')
const localToIso = (value: string) => `${value}:00+09:00`

export default function IndividualQuoteEditor({ initialQuote, recipientEmail, onSaveDraft, onSend }: Props) {
  const [draft, setDraft] = useState<MusuboIndividualQuote>({
    ...initialQuote, finalSchedule: {
      ...initialQuote.finalSchedule,
      friendAllowanceForElevenOrMore: initialQuote.plannedLineCount > 10
        ? initialQuote.finalSchedule.friendAllowanceForElevenOrMore ?? 50_000
        : initialQuote.finalSchedule.friendAllowanceForElevenOrMore,
    },
    plannedLinkedAccountsByLine: initialQuote.plannedLinkedAccountsByLine.map((counts) => ({ ...counts })),
  })
  const [review, setReview] = useState(false)
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const price = useMemo(() => {
    try { return musuboIndividualQuotePrice(draft) } catch { return null }
  }, [draft])
  const changeSchedule = (key: keyof MusuboPriceSchedule, amount: number | undefined) => {
    setDraft((current) => ({ ...current, finalSchedule: { ...current.finalSchedule, [key]: amount } }))
    setError('')
  }
  const setInterval = (interval: 'month' | 'year') => {
    let finalAnnualLineChargeYen: number | null = null
    if (interval === 'year') {
      try { finalAnnualLineChargeYen = suggestMusuboQuoteAnnualLineCharge(draft.finalSchedule, draft.plannedLineCount) }
      catch { finalAnnualLineChargeYen = null }
    }
    setDraft((current) => ({ ...current, interval, finalAnnualLineChargeYen }))
    setError('')
  }
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try { await action() }
    catch { setError('保存または送信を完了できませんでした。入力と通信状態を確認してください。') }
    finally { setBusy(false) }
  }
  const save = async (showReview: boolean) => {
    if (!price) { setError('必要な料金と有効期限を入力してください。'); return }
    await run(async () => { await onSaveDraft(draft); if (showReview) setReview(true) })
  }
  const trial = `${draft.trialPeriod.value}${draft.trialPeriod.unit === 'months' ? 'か月' : '日'}無料`
  const summary = `LINE ${draft.plannedLineCount}個予定 · 友だち ${new Intl.NumberFormat('ja-JP').format(draft.plannedFriendCountExcludingBlocked)}人`

  if (review) return <div className={styles.page}>
    <p className={styles.breadcrumb}>ホーム › 個別見積もり › 送信前確認</p>
    <h1>個別見積もりの送信前確認</h1>
    <p className={styles.lead}>お客様に見える見積もりとメールを確認してから、登録メールアドレスへ送信します。</p>
    <div className={styles.reviewGrid}>
      <section className={styles.card} aria-labelledby="mail-review-title">
        <h2 id="mail-review-title">送信するメール</h2>
        <dl className={styles.compact}><div><dt>宛先</dt><dd>{recipientEmail}</dd></div>
          <div><dt>件名</dt><dd>【musubo】個別見積もりのご案内</dd></div></dl>
        <div className={styles.mailPreview}>
          <div className={styles.brand}>m <span>musubo</span></div>
          <p className={styles.greenLabel}>個別見積もりのご案内</p>
          <h3>お見積もりをご用意しました</h3>
          <p>ご利用予定に合わせた料金をご用意しました。内容を確認し、ご同意いただくとカード登録とLINE接続に進めます。</p>
          <div className={styles.mailPrice}>予定の連携がすべて有効になった場合<br />
            <strong>{draft.interval === 'month' ? `${money(price!.plannedMonthlyTotalYen!)}／月（税込）`
              : `${money(price!.finalAnnualLineChargeYen!)}／年（税込）`}</strong>
            {draft.interval === 'year' && <small>オプション料金 {money(price!.optionsMonthlyYen)}／月は毎月別に請求します。</small>}</div>
          <div className={styles.mailButton}>お見積もりを確認する</div>
          <p>カード登録だけでは請求も無料期間も始まりません。</p>
        </div>
      </section>
      <section className={styles.card} aria-labelledby="send-check-title">
        <h2 id="send-check-title">送信前の確認</h2>
        <p>この見積もりをお客様に送ります。</p>
        <dl className={styles.compact}>
          <div><dt>会社</dt><dd>{draft.companyName}</dd></div>
          <div><dt>見積もり番号</dt><dd>{draft.quoteNumber}</dd></div>
          <div><dt>見積もり有効期限</dt><dd>{jstLocal(draft.expiresAt).replace('T', ' ')}</dd></div>
          <div><dt>お支払いプラン</dt><dd>{draft.interval === 'month' ? '月払い' : '年払い'}</dd></div>
          <div><dt>予定料金</dt><dd>{draft.interval === 'month' ? `${money(price!.plannedMonthlyTotalYen!)}／月（税込）`
            : `${money(price!.finalAnnualLineChargeYen!)}／年（税込）＋オプション${money(price!.optionsMonthlyYen)}／月`}</dd></div>
          <div><dt>適用条件</dt><dd>{trial}</dd></div>
        </dl>
        <p className={styles.small}>送信後の変更は新しい番号で再発行します。期限前の同意で単価と適用条件が確定し、カード登録は期限後も可能です。</p>
      </section>
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.actions}>{!sent && <button type="button" className={styles.secondary} onClick={() => setReview(false)}>料金条件を編集する</button>}
      <Button type="button" variant="primary" className={styles.primary} busy={busy} busyLabel="送信中…" disabled={sent}
        onClick={() => void run(async () => { await onSend(draft); setSent(true) })}>
        {sent ? '送信済み' : 'この内容でメールを送信'}</Button></div>
    {sent && <p className={styles.sent} role="status">登録メールアドレスへ見積もりを送信しました。</p>}
  </div>

  return <div className={styles.page}>
    <p className={styles.breadcrumb}>ホーム › 利用条件 › 個別見積もり</p>
    <h1>個別見積もりの料金条件</h1>
    <p className={styles.lead}>お問い合わせ内容に合わせて会社ごとの料金を作成します。送信前にお客様向けの表示を確認できます。</p>
    <div className={styles.target}><strong>{draft.companyName}</strong><span>{summary}</span></div>
    <div className={styles.columns}>
      <div className={styles.editorStack}>
        <section className={styles.card} aria-labelledby="basic-price-title"><h2 id="basic-price-title">LINE基本料金</h2>
          <p className={styles.small}>適用条件を反映した最終単価を初期入力します。送信前に会社ごとの金額を調整できます。</p>
          <div className={styles.fieldGrid}>
            {([
              ['firstLineYen', '1個目'], ['secondToFifthLineYen', '2〜5個目・1個あたり'],
              ['sixthToTenthLineYen', '6〜10個目・1個あたり'],
            ] as const).map(([key, label]) => <label className={styles.field} key={key}><span>{label}</span>
              <TextField type="number" min={0} step={1} value={draft.finalSchedule[key]}
                onChange={(event) => changeSchedule(key, Number(event.target.value))} /></label>)}
            {draft.plannedLineCount > 10 && <label className={styles.field}><span>11個目以降・1個あたり <b>必須</b></span>
              <TextField type="number" min={0} step={1} placeholder="金額を入力"
                value={draft.finalSchedule.eleventhAndLaterLineYen ?? ''}
                onChange={(event) => changeSchedule('eleventhAndLaterLineYen', event.target.value === '' ? undefined : Number(event.target.value))} /></label>}
            {draft.plannedLineCount > 10 && <label className={styles.field}><span>友だち数の基準（11個以上）</span>
              <TextField type="number" min={0} step={1} value={draft.finalSchedule.friendAllowanceForElevenOrMore ?? 50_000}
                onChange={(event) => changeSchedule('friendAllowanceForElevenOrMore', Number(event.target.value))} />
              <small>この人数を超えると、1万人単位で追加料金がかかります。</small></label>}
          </div>
        </section>
        <section className={styles.card} aria-labelledby="option-price-title"><h2 id="option-price-title">オプション料金</h2>
          <p className={styles.small}>統括はLINE2個以上で加算。追加連携枠は各LINEの連携数から計算します。</p>
          <div className={styles.fieldGrid}>
            {([['headquartersYen', '統括オプション（月額）'], ['linkedAccountSlotYen', '追加連携枠・1枠あたり（月額）']] as const)
              .map(([key, label]) => <label className={styles.field} key={key}><span>{label}</span>
                <TextField type="number" min={0} step={1} value={draft.finalSchedule[key]}
                  onChange={(event) => changeSchedule(key, Number(event.target.value))} /></label>)}
          </div>
        </section>
        <section className={styles.card} aria-labelledby="quote-rules-title"><h2 id="quote-rules-title">この見積もりに適用する共通ルール</h2>
          <p className={styles.small}>友だち数の超過分は1万人ごとに{money(draft.finalSchedule.extraFriendBlockYen)}／月。年払い割引はLINE基本料金のみです。特別割引は最終単価に反映済みです。</p>
          {draft.interval === 'year' && <label className={styles.field}><span>LINE基本料金・最終年額（税込）</span>
            <TextField type="number" min={0} step={1} value={draft.finalAnnualLineChargeYen ?? ''}
              onChange={(event) => setDraft((current) => ({ ...current, finalAnnualLineChargeYen: event.target.value === '' ? null : Number(event.target.value) }))} />
            <small>この金額を保存し、請求時に再割引しません。</small></label>}
        </section>
      </div>
      <section className={styles.card} aria-labelledby="quote-preview-title"><h2 id="quote-preview-title">見積もりプレビュー</h2>
        <span className={styles.badge}>下書き</span>
        <p className={styles.previewLabel}>利用予定</p><strong>{summary}</strong>
        <p className={styles.small}>追加連携枠は各LINEへの連携予定を確認して計算します。</p>
        <div className={styles.priceBox}><span>{draft.interval === 'month' ? '月払いの予定料金（税込）' : 'LINE基本料金・年払い（税込）'}</span>
          <strong>{price ? draft.interval === 'month' ? `${money(price.plannedMonthlyTotalYen!)}／月` : `${money(price.finalAnnualLineChargeYen!)}／年` : '—'}</strong>
          <small>{price ? draft.interval === 'year' ? `オプション料金 ${money(price.optionsMonthlyYen)}／月を別請求`
            : `追加連携 ${price.linkedSlots}枠を含む予定料金` : '必要な金額を入力すると表示します'}</small></div>
        <div className={styles.field}><span>お支払いプラン</span><Select aria-label="お支払いプラン" size="full" value={draft.interval}
          onChange={(value) => setInterval(value as 'month' | 'year')}
          options={[{ value: 'month', label: '月払い' }, { value: 'year', label: '年払い' }]} /></div>
        <label className={styles.field}><span>見積もり有効期限</span>
          <input type="datetime-local" value={jstLocal(draft.expiresAt)}
            onChange={(event) => { if (event.target.value) setDraft((current) => ({ ...current, expiresAt: localToIso(event.target.value) })) }} />
          <small>発行日から30日を初期入力します。</small></label>
        <p className={styles.small}>{trial}。送信後の変更は新しい番号で再発行します。期限前の同意で単価と適用条件が確定します。</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}><button type="button" className={styles.secondary} disabled={busy || !price}
          onClick={() => void save(false)}>下書きを保存</button>
          <button type="button" className={styles.primary} disabled={busy || !price}
            onClick={() => void save(true)}>お客様向けの表示を確認</button></div>
        <p className={styles.small}>送信前の下書きです。お客様にはまだ表示されません。</p>
      </section>
    </div>
  </div>
}
