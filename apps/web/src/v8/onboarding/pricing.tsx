'use client'

import Button from '@/components/shared/button'
import { useMemo, useState } from 'react'
import {
  DEFAULT_MUSUBO_PRICE_SCHEDULE,
  friendAllowanceForLineCount,
  musuboPrice,
  type MusuboPriceSchedule,
  type MusuboTrialPeriod,
} from '@line-crm/shared'
import { ListPage } from '@/components/templates'
import { PageContent } from '@/components/templates/page-frame'
import { Steps } from '@/components/templates/steps'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import Checkbox from '@/components/shared/checkbox'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import Notice from '@/components/shared/notice'
import { Field } from '@/components/shared/form-controls'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
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
  initialSelection?: PricingSelection
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
  return <Field label={label} htmlFor={id} optional={false}>
    <Select aria-label={label} id={id} className={styles.plannedSelect} size="full" value={String(value)}
      onChange={(next) => onChange(Number(next))}
      options={[...(linked ? linkedCountOptions : countOptions).map((count) => ({ value: String(count), label: `${count}個` })),
        { value: '11', label: '11個以上' }]} />
  </Field>
}

export default function OnboardingPricing({ condition = DEFAULT_CONDITION, initialSelection, onContinue, onContact }: Props) {
  usePageTitle('利用開始の準備')
  usePageCrumbs([{ label: 'ホーム', href: '/hq' }])
  const [lineCount, setLineCount] = useState(initialSelection?.lineCount ?? 1)
  const [friendCountText, setFriendCountText] = useState(initialSelection?.friendCountExcludingBlocked?.toString() ?? '')
  const [googleBusinessCount, setGoogleBusinessCount] = useState(initialSelection?.googleBusinessCount ?? 1)
  const [instagramCount, setInstagramCount] = useState(initialSelection?.instagramCount ?? 1)
  const [interval, setInterval] = useState<'month' | 'year'>(initialSelection?.interval ?? 'month')
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
  const firstLinePrice = useMemo(() => musuboPrice({
    lineCount: 1,
    friendCountExcludingBlocked: 0,
    linkedAccountsByLine: [{ googleBusiness: 1, instagram: 1 }],
    interval,
    lineBasicDiscountPercent: condition.lineBasicDiscountPercent,
    schedule: condition.schedule,
  }), [condition, interval])

  const advance = async () => {
    if (!friendCountValid || busy || (!quoteRequired && !consent)) return
    setBusy(true)
    setError('')
    try {
      if (quoteRequired) await onContact(selection)
      else await onContinue(selection)
    } catch {
      setError('手続きを開始できませんでした。入力内容を確認して、もう一度お試しください。')
    } finally {
      setBusy(false)
    }
  }

  const allowance = lineCount <= 10 ? friendAllowanceForLineCount(lineCount, condition.schedule) : 0
  const nextFriendBlock = allowance + 1
  const exampleEnd = allowance + condition.schedule.extraFriendBlockSize
  const secondFriendBlock = exampleEnd + 1
  const secondExampleEnd = exampleEnd + condition.schedule.extraFriendBlockSize
  const formatCount = (count: number) => new Intl.NumberFormat('ja-JP').format(count)
  const headline = quoteRequired ? 'ご利用予定を確認' : '料金を確認'
  return <ListPage heightMode="viewport" title="利用開始の準備"
    subtitle={quoteRequired
      ? '11個以上の連携は、予定を確認してからお見積もりをご案内します。'
      : '料金を確かめてからクレジットカードを登録し、LINE公式アカウントを接続します。'}
    help="料金を確かめてからクレジットカードを登録し、LINE公式アカウントを接続します。"
    steps={<Steps label="利用開始の手順" steps={[
      { key: 'price', label: headline, state: 'current' },
      { key: 'next', label: quoteRequired ? 'お問い合わせ' : 'クレジットカードを登録', state: 'todo' },
      { key: 'connect', label: quoteRequired ? '料金をご案内' : 'LINEを接続', state: 'todo' },
    ]} />}>
    <PageContent>

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
            <Field label="既存のLINEアカウントの合計（ブロック除く）" htmlFor="friend-count" optional={false}
              note="現在の友だち数を入力（接続後に実数で確定）">
              <span className={styles.numberField}><TextField id="friend-count" type="text" inputMode="numeric" value={friendCountText}
                style={{ height: 'var(--mp-px-44)', paddingRight: 'var(--mp-px-48)' }}
                placeholder="例：2,800" aria-invalid={friendCountText !== '' && !friendCountValid}
                onChange={(event) => setFriendCountText(event.target.value.replaceAll(',', ''))} /><span aria-hidden="true">人</span></span>
            </Field>
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
          {!quoteRequired && <Checkbox checked={consent} onCheckedChange={setConsent}>
            料金条件と無料体験後のカード請求に同意します
          </Checkbox>}
          <div className={styles.detailsAction}>
            <Button type="button" variant="text" textTone="accent" onClick={() => setDetailsOpen(true)}>
              {quoteRequired ? '標準料金のしくみを見る' : '料金の詳しい条件を見る'} ↗
            </Button>
          </div>
        </section>

        <section className={styles.card} aria-labelledby="cost-heading">
          {quoteRequired ? <QuoteRequired /> : <div>
            <h2 id="cost-heading">お支払い予定料金</h2>
            <div className={styles.planHeading}>お支払いプラン</div>
            <RadioCardGroup className={styles.planGrid} legend="お支払いプラン">
              <RadioCard name="billing-interval" value="month" checked={interval === 'month'}
                onChange={() => setInterval('month')} title="月払い" height="fit" />
              <div className={styles.annualChoice}>
                <span className={styles.discountBadge}>年払いでLINE基本料金10%OFF</span>
                <RadioCard name="billing-interval" value="year" checked={interval === 'year'}
                  onChange={() => setInterval('year')} title="年払い" height="fit" />
              </div>
            </RadioCardGroup>
            <div className={styles.conditionLabel}>適用中の条件</div>
            <div className={styles.conditionValue}>{condition.name}・{trialLabel(condition.trialPeriod)}無料
              {condition.lineBasicDiscountPercent > 0 ? '・LINE基本料金' + condition.lineBasicDiscountPercent + '%OFF' : ''}</div>
            <div className={styles.today}><span>本日の請求</span><strong>¥0</strong></div>
            {!price && <p className={styles.secondary}>友だち数を入力すると、予定料金を表示します。</p>}
            {price && <>
              <div className={styles.amountRow}><span>1個を有効にした場合</span>
                <strong>{interval === 'month'
                  ? yen(firstLinePrice.lineBasicMonthlyYen) + ' / 月'
                  : yen(firstLinePrice.annualLineChargeYen) + ' / 年'}</strong></div>
              {interval === 'year' && <p className={styles.annualNote}>年払いはLINE基本料金のみ。オプション料金{yen(price.optionsMonthlyYen)}／月は毎月別に請求します。</p>}
              {lineCount === 1 && <div className={styles.amountRow}><span>友だち数{new Intl.NumberFormat('ja-JP').format(friendCount)}人の追加料金</span>
                <strong>{yen(price.friendOverageMonthlyYen)} / 月</strong></div>}
              {lineCount === 1 && price.linkedAccountSlots > 0 && <div className={styles.amountRow}><span>追加連携枠 {price.linkedAccountSlots}枠</span>
                <strong>{yen(price.linkedAccountSlotsMonthlyYen)} / 月</strong></div>}
              {interval === 'month' && (lineCount > 1 || price.linkedAccountSlots > 0 || price.friendOverageMonthlyYen > 0) && <div className={lineCount > 1 ? styles.amountRow : styles.totalRow}><span>{lineCount > 1 ? `予定の${lineCount}個すべて有効にした場合` : 'すべて有効にした場合の月額（税込）'}</span>
                <strong>{yen(price.monthlyTotalYen)} / 月</strong></div>}
              {interval === 'year' && lineCount > 1 && <div className={styles.totalRow}><span>予定の{lineCount}個すべて有効にした場合のLINE基本料金</span>
                <strong>{yen(price.annualLineChargeYen)} / 年</strong></div>}
            </>}
            <p className={styles.smallNote}>基本枠超過の友だち：1万人ごと{yen(condition.schedule.extraFriendBlockYen)}<br />
              追加連携枠：1枠{yen(condition.schedule.linkedAccountSlotYen)}／月（税込）</p>
            <p className={styles.trial}>最初のLINE有効化日から{trialLabel(condition.trialPeriod)}無料</p>
          </div>}
        </section>
      </div>
      <div className={styles.footer}>
        <p>{quoteRequired
          ? 'お問い合わせ後に料金と利用開始の手順をご案内します。クレジットカード登録はこの段階では不要です。'
          : 'カード情報はStripeが管理し、musuboには保存されません。クレジットカード登録だけでは無料体験も請求も始まりません。'}</p>
        <Button type="button" variant="primary" busy={busy} busyLabel="処理中…" disabled={!friendCountValid || (!quoteRequired && !consent)}
          onClick={() => void advance()}>{quoteRequired ? 'お問い合わせフォームへ' : '同意してクレジットカード登録へ'}</Button>
      </div>
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
      <Dialog open={detailsOpen} title="料金の詳しい条件" size="large"
        description="接続したLINE公式アカウントの数に応じて料金が決まります。"
        onCancel={() => setDetailsOpen(false)}
        footer={<DialogActions><Button type="button" variant="primary" onClick={() => setDetailsOpen(false)}>料金確認に戻る</Button></DialogActions>}>
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
            <p>友だち数はLINE公式APIの累計追加数からブロック数を引いて計算します。退会したユーザーは累計追加数に残るため、現在メッセージを届けられる人数と異なる場合があります。</p>
            {lineCount > 10
              ? <div className={styles.explainer}>LINEが11個以上の場合の友だち数の基準と超過料金は、個別のお見積もりでご案内します。</div>
              : <div className={styles.explainer}>例｜LINE {lineCount}個の場合、{formatCount(allowance)}人までは追加料金なし。<br />
                {formatCount(nextFriendBlock)}〜{formatCount(exampleEnd)}人 → 1枠分 +{yen(condition.schedule.extraFriendBlockYen)}／月<br />
                {formatCount(secondFriendBlock)}〜{formatCount(secondExampleEnd)}人 → 2枠分 +{yen(condition.schedule.extraFriendBlockYen * 2)}／月</div>}
            <p>各LINEでGoogleマイビジネスとInstagramはそれぞれ1個まで基本料金内です。多いほうの2個目から追加料金を数えます。複数LINEの追加連携枠は、それぞれの連携前に料金を確認します。</p>
          </div>
          <p>年払いはLINE基本料金のみ10%割引。友だち超過・追加連携枠は毎月別請求です。</p>
          <p>無料体験は最初のLINE有効化日から{trialLabel(condition.trialPeriod)}。有効化前はクレジットカード登録済みでも請求しません。</p>
      </Dialog>
    </PageContent>
  </ListPage>
}

function QuoteRequired() {
  return <div className={styles.quoteRequired}>
    <span className={styles.quoteBadge}>個別見積もり</span>
    <h2 id="cost-heading">料金は個別にご案内します</h2>
    <p>連携数と使い方を確認し、御社に合う料金と利用開始の手順をお伝えします。</p>
    <div className={styles.explainer}>この画面で料金や請求は確定しません。クレジットカード情報の入力もまだ不要です。</div>
    <h3>お問い合わせ後の流れ</h3>
    <ol><li>お問い合わせ内容を送信</li><li>担当者から料金をご案内</li><li>ご同意後、利用開始の準備へ</li></ol>
  </div>
}
