'use client'

import { useMemo, useState } from 'react'
import {
  DEFAULT_MUSUBO_PRICE_SCHEDULE,
  musuboPrice,
  type MusuboPriceSchedule,
  type MusuboTrialPeriod,
} from '@line-crm/shared'
import { ListPage } from '@/components/templates'
import { PageContent } from '@/components/templates/page-frame'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import CloseButton from '@/components/shared/close-button'
import styles from './pricing.module.css'

export interface OnboardingCondition {
  name: string
  trialPeriod: MusuboTrialPeriod
  lineBasicDiscountPercent: number
  schedule: MusuboPriceSchedule
}

export interface PricingSelection {
  lineCount: number
  friendCountExcludingBlocked: number | null
  googleBusinessCount: number
  instagramCount: number
  interval: 'month' | 'year'
}

interface Props {
  condition?: OnboardingCondition
  onContinue: (selection: PricingSelection) => Promise<void>
  onContact: (selection: PricingSelection) => Promise<void>
}

const DEFAULT_CONDITION: OnboardingCondition = {
  name: '通常条件',
  trialPeriod: { unit: 'days', value: 30 },
  lineBasicDiscountPercent: 0,
  schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE,
}

const yen = (amount: number) => '¥' + new Intl.NumberFormat('ja-JP').format(amount)
const trialLabel = (period: MusuboTrialPeriod) => period.value + (period.unit === 'months' ? 'か月' : '日')
const countOptions = Array.from({ length: 10 }, (_, index) => index + 1)
const linkedCountOptions = Array.from({ length: 11 }, (_, index) => index)

function PlannedCountSelect({ label, id, value, onChange, linked = false }: {
  label: string
  id: string
  value: number
  onChange: (value: number) => void
  linked?: boolean
}) {
  return <label className={styles.field} htmlFor={id}>
    <span>{label}</span>
    <select id={id} value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {(linked ? linkedCountOptions : countOptions).map((count) => <option value={count} key={count}>{count}個</option>)}
      <option value={11}>11個以上</option>
    </select>
  </label>
}

export default function OnboardingPricing({ condition = DEFAULT_CONDITION, onContinue, onContact }: Props) {
  usePageTitle('利用開始の準備')
  usePageCrumbs([{ label: 'ホーム', href: '/hq' }])
  const [lineCount, setLineCount] = useState(1)
  const [friendCountText, setFriendCountText] = useState('')
  const [googleBusinessCount, setGoogleBusinessCount] = useState(1)
  const [instagramCount, setInstagramCount] = useState(1)
  const [interval, setInterval] = useState<'month' | 'year'>('month')
  const [consent, setConsent] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const friendCount = Number(friendCountText.replaceAll(',', ''))
  const quoteRequired = lineCount > 10 || (lineCount === 1 && (googleBusinessCount > 10 || instagramCount > 10))
  const friendCountValid = (quoteRequired && friendCountText === '') || (/^\d{1,9}$/.test(friendCountText.replaceAll(',', '')) && Number.isSafeInteger(friendCount))
  const selection: PricingSelection = {
    lineCount,
    friendCountExcludingBlocked: friendCountText === '' ? null : friendCountValid ? friendCount : null,
    googleBusinessCount,
    instagramCount,
    interval,
  }
  const price = useMemo(() => {
    if (quoteRequired || !friendCountValid) return null
    return musuboPrice({
      lineCount,
      friendCountExcludingBlocked: friendCount,
      linkedAccountsByLine: Array.from({ length: lineCount }, () => ({
        googleBusiness: lineCount === 1 ? googleBusinessCount : 1,
        instagram: lineCount === 1 ? instagramCount : 1,
      })),
      interval,
      lineBasicDiscountPercent: condition.lineBasicDiscountPercent,
      schedule: condition.schedule,
    })
  }, [condition, friendCount, friendCountValid, googleBusinessCount, instagramCount, interval, lineCount, quoteRequired])

  const advance = async () => {
    if (!friendCountValid || busy || (!quoteRequired && !consent)) return
    setBusy(true)
    setError('')
    try {
      if (quoteRequired) await onContact(selection)
      else await onContinue(selection)
    } catch {
      setError('手続きを開始できませんでした。入力内容を確認して、もう一度お試しください。')
      setBusy(false)
    }
  }

  const allowance = price?.friendAllowance ?? 0
  const nextFriendBlock = allowance + 1
  const exampleEnd = allowance + condition.schedule.extraFriendBlockSize
  const headline = quoteRequired ? 'ご利用予定を確認' : '料金を確認'
  return <ListPage heightMode="viewport" title="利用開始の準備" help="料金を確かめてからカードを登録し、LINE公式アカウントを接続します。">
    <PageContent>
      <p className={styles.lead}>{quoteRequired
        ? '11個以上の連携は、予定を確認してからお見積もりをご案内します。'
        : '料金を確かめてからカードを登録し、LINE公式アカウントを接続します。'}</p>
      <ol className={styles.steps} aria-label="利用開始の手順">
        {[headline, quoteRequired ? 'お問い合わせ' : 'カードを登録', quoteRequired ? '料金をご案内' : 'LINEを接続'].map((label, index) =>
          <li key={label} className={index === 0 ? styles.currentStep : ''}><span>{index + 1}</span>{label}</li>)}
      </ol>

      <div className={styles.columns}>
        <section className={styles.card} aria-labelledby="planned-heading">
          <h2 id="planned-heading">{quoteRequired ? 'ご利用予定の確認' : '利用料金のご確認'}</h2>
          <p className={styles.secondary}>{quoteRequired
            ? '11個以上のご利用は個別見積もりです。分かる範囲の予定を確認してお問い合わせください。'
            : '予定数は見積り用。実際に有効になったLINE数で請求します。'}</p>
          <div className={styles.inputGrid}>
            <PlannedCountSelect label="連携するLINEアカウント数" id="line-count" value={lineCount} onChange={(count) => {
              setLineCount(count)
              if (count > 1) {
                setGoogleBusinessCount(1)
                setInstagramCount(1)
              }
            }} />
            <label className={styles.field} htmlFor="friend-count">
              <span>既存のLINEアカウントの合計（ブロック除く）</span>
              <span className={styles.numberField}><input id="friend-count" type="text" inputMode="numeric" value={friendCountText}
                placeholder="現在の友だち数" aria-invalid={friendCountText !== '' && !friendCountValid}
                onChange={(event) => setFriendCountText(event.target.value.replaceAll(',', ''))} /><span>人</span></span>
              <small>接続後に実数で確定します</small>
            </label>
          </div>
          {friendCountText !== '' && !friendCountValid && <p className={styles.error}>友だち数は0以上の整数で入力してください。</p>}
          {lineCount === 1 && <>
            <h3 className={styles.groupTitle}>このLINEに連携するアカウント数</h3>
            <div className={styles.inputGrid}>
              <PlannedCountSelect linked label="Googleマイビジネス" id="google-count" value={googleBusinessCount} onChange={setGoogleBusinessCount} />
              <PlannedCountSelect linked label="Instagramアカウント" id="instagram-count" value={instagramCount} onChange={setInstagramCount} />
            </div>
          </>}
          {lineCount === 1 && !quoteRequired && <div className={styles.explainer}>
            GoogleマイビジネスとInstagramは、それぞれ1個までLINEの基本料金に含まれます。
            追加料金は数が多いほうの2個目から、1個につき月額{yen(condition.schedule.linkedAccountSlotYen)}（税込）です。
            たとえばGoogleマイビジネス2個・Instagram1個なら、追加は1個分です。
          </div>}
          {lineCount > 1 && lineCount <= 10 && <div className={styles.explainer}>
            各LINEでGoogleマイビジネスとInstagramの連携数を設定します。各サービス1個目は基本料金内。
            2個目以降の連携前に追加料金を確認します。ここで表示する予定料金には追加連携枠を含みません。
          </div>}
          <p className={styles.note}>{quoteRequired
            ? '友だち数は概算でも大丈夫です。正確な連携数が未定の場合もご相談いただけます。'
            : lineCount === 1
              ? '未接続のLINE・連携先は請求対象外です。LINEまたは連携先が11個以上なら個別にご案内します。'
              : '未接続のLINE・連携先は請求対象外です。連携先の追加分は、各LINEの接続時に確認します。'}</p>
          {!quoteRequired && <label className={styles.consent}>
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>料金条件と無料体験後のカード請求に同意します</span>
          </label>}
          <button type="button" className={styles.detailsLink} onClick={() => setDetailsOpen(true)}>
            {quoteRequired ? '標準料金のしくみを見る' : '料金の詳しい条件を見る'} ↗
          </button>
        </section>

        <section className={styles.card} aria-labelledby="cost-heading">
          {quoteRequired ? <QuoteRequired /> : <div>
            <h2 id="cost-heading">お支払い予定料金</h2>
            <div className={styles.planHeading}>お支払いプラン</div>
            <div className={styles.planGrid}>
              <button type="button" aria-pressed={interval === 'month'} className={interval === 'month' ? styles.planSelected : styles.plan}
                onClick={() => setInterval('month')}>月払い</button>
              <div className={styles.annualChoice}>
                <span className={styles.discountBadge}>年払いでLINE基本料金10%OFF</span>
                <button type="button" aria-pressed={interval === 'year'} className={interval === 'year' ? styles.planSelected : styles.plan}
                  onClick={() => setInterval('year')}>年払い</button>
              </div>
            </div>
            <div className={styles.conditionLabel}>適用中の条件</div>
            <div className={styles.conditionValue}>{condition.name}・{trialLabel(condition.trialPeriod)}無料
              {condition.lineBasicDiscountPercent > 0 ? '・LINE基本料金' + condition.lineBasicDiscountPercent + '%OFF' : ''}</div>
            <div className={styles.today}><span>本日の請求</span><strong>¥0</strong></div>
            {!price && <p className={styles.secondary}>友だち数を入力すると、予定料金を表示します。</p>}
            {price && <>
              <div className={styles.amountRow}><span>{interval === 'month'
                ? price.linkedAccountSlots > 0 ? 'LINE 1個の基本料金（追加連携枠を除く）' : lineCount + '個すべてを有効にした場合'
                : 'LINE基本料金（年払い）'}</span>
                <strong>{interval === 'month'
                  ? yen(price.lineBasicMonthlyYen + price.headquartersMonthlyYen) + ' / 月'
                  : yen(price.annualLineChargeYen) + ' / 年'}</strong></div>
              {interval === 'year' && <p className={styles.annualNote}>年払いはLINE基本料金のみ。オプション料金{yen(price.optionsMonthlyYen)}／月は毎月別に請求します。</p>}
              <div className={styles.amountRow}><span>友だち数{new Intl.NumberFormat('ja-JP').format(friendCount)}人の追加料金</span>
                <strong>{yen(price.friendOverageMonthlyYen)} / 月</strong></div>
              {price.linkedAccountSlots > 0 && <div className={styles.amountRow}><span>{interval === 'month'
                ? `追加連携枠${price.linkedAccountSlots}枠を利用した場合`
                : `追加連携枠 ${price.linkedAccountSlots}枠`}</span>
                <strong>{yen(interval === 'month'
                  ? price.lineBasicMonthlyYen + price.headquartersMonthlyYen + price.linkedAccountSlotsMonthlyYen
                  : price.linkedAccountSlotsMonthlyYen)} / 月</strong></div>}
            </>}
            <p className={styles.smallNote}>基本枠超過の友だち：1万人ごと{yen(condition.schedule.extraFriendBlockYen)}<br />
              追加連携枠：1枠{yen(condition.schedule.linkedAccountSlotYen)}／月（税込）</p>
            <p className={styles.trial}>最初のLINE有効化日から{trialLabel(condition.trialPeriod)}無料</p>
          </div>}
        </section>
      </div>
      <div className={styles.footer}>
        <p>{quoteRequired
          ? 'お問い合わせ後に料金と利用開始の手順をご案内します。カード登録はこの段階では不要です。'
          : 'カード情報はStripeが管理し、musuboには保存されません。カード登録だけでは無料体験も請求も始まりません。'}</p>
        <button type="button" className={styles.primary} disabled={busy || !friendCountValid || (!quoteRequired && !consent)}
          onClick={() => void advance()}>{busy ? '処理中…' : quoteRequired ? 'お問い合わせフォームへ' : '同意してカード登録へ'}</button>
      </div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {detailsOpen && <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setDetailsOpen(false)
      }}>
        <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="details-heading">
          <CloseButton className={styles.close} onClick={() => setDetailsOpen(false)} />
          <h2 id="details-heading">料金の詳しい条件</h2>
          <p>接続したLINE公式アカウントの数に応じて料金が決まります。</p>
          <div className={styles.detailBlock}>
            <h3>LINE公式アカウントの基本料金（税込）</h3>
            <dl><div><dt>1個目</dt><dd>{yen(condition.schedule.firstLineYen)} / 月</dd></div>
              <div><dt>2〜5個目</dt><dd>各 {yen(condition.schedule.secondToFifthLineYen)} / 月</dd></div>
              <div><dt>6〜10個目</dt><dd>各 {yen(condition.schedule.sixthToTenthLineYen)} / 月</dd></div></dl>
            <p>2個以上を管理する場合、統括料金{yen(condition.schedule.headquartersYen)}／月（税込）が加わります。</p>
          </div>
          <div className={styles.detailBlock}>
            <h3>利用量による追加料金</h3>
            <p>友だち数の基準：1個 3,000人／2〜5個 15,000人／6〜10個 50,000人</p>
            <p>基準を超えた人数を10,000人単位で切り上げ、1枠ごとに{yen(condition.schedule.extraFriendBlockYen)}／月（税込）です。</p>
            <div className={styles.explainer}>例｜LINE {lineCount <= 10 ? lineCount : 1}個の場合、{new Intl.NumberFormat('ja-JP').format(allowance || 3_000)}人までは追加料金なし。{new Intl.NumberFormat('ja-JP').format(nextFriendBlock || 3_001)}〜{new Intl.NumberFormat('ja-JP').format(exampleEnd || 13_000)}人は1枠分です。</div>
            <p>各LINEでGoogleマイビジネスとInstagramはそれぞれ1個まで基本料金内です。多いほうの2個目から追加料金を数えます。複数LINEの追加連携枠は、それぞれの連携前に料金を確認します。</p>
          </div>
          <p>年払いはLINE基本料金のみ10%割引。友だち超過・追加連携枠は毎月別請求です。</p>
          <p>無料体験は最初のLINE有効化日から{trialLabel(condition.trialPeriod)}。有効化前はカード登録済みでも請求しません。</p>
          <button type="button" className={styles.primary} onClick={() => setDetailsOpen(false)}>料金確認に戻る</button>
        </section>
      </div>}
    </PageContent>
  </ListPage>
}

function QuoteRequired() {
  return <div className={styles.quoteRequired}>
    <span className={styles.quoteBadge}>個別見積もり</span>
    <h2 id="cost-heading">料金は個別にご案内します</h2>
    <p>連携数と使い方を確認し、御社に合う料金と利用開始の手順をお伝えします。</p>
    <div className={styles.explainer}>この画面で料金や請求は確定しません。カード情報の入力もまだ不要です。</div>
    <h3>お問い合わせ後の流れ</h3>
    <ol><li>お問い合わせ内容を送信</li><li>担当者から料金をご案内</li><li>ご同意後、利用開始の準備へ</li></ol>
  </div>
}
