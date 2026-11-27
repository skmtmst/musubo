import { BookOpen, CircleHelp, Copy, Info, LifeBuoy, Link as LinkIcon, Lock } from 'lucide-react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Checkbox from '@/components/shared/checkbox'
import CopyTextButton from '@/components/shared/copy-text-button'
import { emptyValue } from '@/components/shared/empty-value'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { TextField } from '@/components/shared/text-field'
import TruncatedText from '@/components/shared/truncated-text'
import { CreateStepColumns } from '@/components/templates/create-step-columns'
import { LOGIN_ACKS, WEBHOOK_ACKS, channelLengthWarning, developerChannelUrl, developerProviderUrl, musuboWebhookUrl } from './logic'
import styles from './register.module.css'
import Notice from '@/components/shared/notice'

/*
 * ★LINE新規追加_v07.pen（2026-10-18承認）②アカウント接続 Fqy29 の描画だけ。
 * register.tsx が行数の関所（apps/web/scripts/v8-guard/code-size.mjs）を越えたので
 * 切り出した。状態は持たず、register.tsx から受け取って出すだけ。
 */

const MANUAL = '/manuals/line-connect/index.html'

/* 承認済みの4段構成。現在の操作を左の列で示す。 */
const AC_OUTLINE: ReadonlyArray<{ title: string; note: string }> = [
  { title: 'Messaging APIの2項目', note: '公式アカウントで取得' },
  { title: 'プロバイダーID', note: 'LINE Developersからコピー' },
  { title: 'Webhookの設定', note: 'URLを貼り付けて3つをONに' },
  { title: 'LINEログインの2項目', note: '同じプロバイダーの中に作る' },
]

function AcOutline({ sub, onBackTo }: { sub: number; onBackTo: (step: number) => void }) {
  return (
    <Card className={styles.outlineCard} frame="ring" contentPadding="var(--tpl-htn-aside-pad)" gap="var(--tpl-htn-gap-xs)" data-design-node="g48QV">
      <p className={styles.outlineTitle}>操作ステップ</p>
      <p className={styles.outlineCount}>全{AC_OUTLINE.length}ステップ</p>
      <div className={styles.outlineGap} aria-hidden="true" />
      {AC_OUTLINE.map((row, index) => {
        const number = index + 1
        const content = (
          <span className={`${styles.outlineRow} ${number < sub ? styles.outlineDone : number === sub ? styles.outlineCurrent : styles.outlineFuture}`} aria-current={number === sub ? 'step' : undefined}>
            <span className={styles.outlineNum} aria-hidden="true">{number}</span>
            <span className={styles.outlineText}>
              <span className={styles.outlineRowTitle}>{row.title}</span>
              <span className={styles.outlineRowNote}>{row.note}</span>
            </span>
          </span>
        )
        return number < sub
          ? <Button key={row.title} type="button" variant="text" size="inline" fullWidth onClick={() => onBackTo(number)}>{content}</Button>
          : <div key={row.title}>{content}</div>
      })}
      <div className={styles.outlineSpacer} aria-hidden="true" />
      <div className={styles.outlineAuto}>
        <p className={styles.outlineAutoTitle}>musubo が自動で行うこと</p>
        {/* 承認済み v07 iaTqO：Webhook URL は自動登録されないので、ここから外した。 */}
        <p className={styles.outlineAutoBody}>アカウント名・@ID・アイコンの取り込み／LIFF（友だち追加）の作成。入力は不要です。</p>
      </div>
    </Card>
  )
}

/** ②で入れてもらう5項目。register.tsx の FormState から必要なぶんだけ受け取る。 */
export type Step2Field = 'channelId' | 'channelSecret' | 'providerId' | 'loginChannelId' | 'loginChannelSecret'

export default function Step2Connect({
  sub, badge, values, fieldErrors, touchedFields, acks, onUpdate, onTouchField, onValidateField, onToggleAck, onBackTo,
}: {
  /** ②の中の小さな段（1〜4）。 */
  sub: number
  onBackTo: (step: number) => void
  /** 「Step 1 / 4」などの札。 */
  badge: string
  /** いま入っているチャネルの4項目とプロバイダーID。 */
  values: Record<Step2Field, string>
  fieldErrors: Record<string, string>
  touchedFields: Partial<Record<Step2Field, boolean>>
  acks: Record<string, boolean>
  onUpdate: (key: Step2Field, value: string) => void
  onTouchField: (key: Step2Field) => void
  onValidateField: (key: Step2Field) => void
  onToggleAck: (key: string, next: boolean) => void
}) {
  const webhookUrl = musuboWebhookUrl(values.channelId)
  const messagingApiUrl = developerChannelUrl(values.channelId)
  const providerUrl = developerProviderUrl(values.providerId)
  const warning = (key: Step2Field) => touchedFields[key] && !fieldErrors[key] ? channelLengthWarning(key, values[key]) : null
  const warningText = (key: Step2Field) => warning(key) && <p id={`v8-${key}-warning`} className={styles.inputWarning} role="status">{warning(key)}</p>
  return (
    /* 正本 v07 ②の右の列（Step1 msf5n／Step2 RtWJZ／Step3 J84XB は同じ中身）。
       マニュアルとサポートへの案内。 */
    <CreateStepColumns data-design-node="Fqy29" outlineTitle="操作ステップ" outline={<AcOutline sub={sub} onBackTo={onBackTo} />} previewTitle="マニュアル" preview={(
      <Card className={styles.aside} layout="vertical" surface="standard" contentPadding="var(--tpl-htn-aside-pad)" gap="var(--tpl-htn-aside-gap)" aria-label="マニュアル">
        <Button external href={MANUAL} icon={<BookOpen size={16} aria-hidden="true" />}>マニュアルを開く</Button>
        <div className={styles.asideLine} aria-hidden="true" />
        <h2 className={styles.asideH3}>うまくいかないとき</h2>
        <Button href="/hq/support" icon={<LifeBuoy size={16} aria-hidden="true" />}>サポートに聞く</Button>
      </Card>
      )}>
      {sub === 1 && (
        /* Messaging API の2項目は公式アカウントマネージャーから取得する。 */
        <Card surface="standard" layout="vertical" contentPadding="var(--tpl-htn-panel-pad)" gap="var(--tpl-htn-panel-gap)" className={styles.panel} aria-label="Messaging API の情報を入れる">
          <p className={styles.subBadge}>{badge}</p>
          <div className={styles.precheckHead}>
            <h2 data-step-heading tabIndex={-1} className={styles.panelTitle}>Messaging API の情報を入れる</h2>
            <span className={styles.precheckHelpMark} title="LINE公式アカウントの本体（Messaging API チャネル）とつなぐための情報です。" aria-label="LINE公式アカウントの本体（Messaging API チャネル）とつなぐための情報です。"><CircleHelp size={16} aria-hidden="true" /></span>
          </div>
          <p className={styles.precheckLead}>Messaging API のチャネルIDとチャネルシークレットを入力します。</p>
          <div className={`${styles.precheckNote} ${styles.precheckNoteInfo}`}>
            <p className={styles.precheckNoteTitle}>LINE公式アカウントマネージャーを開いてください</p>
            <p>公式アカウントを選び、右上の「設定」→「Messaging API」を開きます。未利用なら「Messaging APIを利用する」を設定してから、Channel ID と Channel secret をコピーしてください。</p>
            <div className={styles.precheckNoteLink}>
              <Button variant="primary" external href="https://manager.line.biz/">LINE公式アカウントマネージャーを開く</Button>
            </div>
          </div>
          <div className={styles.acInputs}>
            <div className={styles.acField}>
              <Field htmlFor="v8-channel-id" label="チャネルID" error={fieldErrors.channelId}>
                <SaveErrorField names={["channelId","form.channelId","channel_id","form.channel_id"]}><TextField id="v8-channel-id" value={values.channelId} onChange={(event) => onUpdate('channelId', event.target.value)} onPaste={() => onTouchField('channelId')} onBlur={() => onValidateField('channelId')} inputMode="numeric" placeholder="例：2001234567" required aria-invalid={fieldErrors.channelId ? true : undefined} aria-describedby={warning('channelId') ? 'v8-channelId-warning' : undefined} /></SaveErrorField>
              </Field>
              <p className={styles.help}>公式アカウントマネージャーの「設定」→「Messaging API」にある「Channel ID」の右のコピーから貼り付けてください。LINEログインのチャネルIDとは異なります。</p>
              {warningText('channelId')}
            </div>
            <div className={styles.acField}>
              <Field htmlFor="v8-channel-secret" label="チャネルシークレット" error={fieldErrors.channelSecret}>
                <SaveErrorField names={["channelSecret","form.channelSecret","channel_secret","form.channel_secret"]}><TextField id="v8-channel-secret" type="password" autoComplete="new-password" value={values.channelSecret} onChange={(event) => onUpdate('channelSecret', event.target.value)} onPaste={() => onTouchField('channelSecret')} onBlur={() => onValidateField('channelSecret')} placeholder="例：abc123def456ghi789…" required aria-invalid={fieldErrors.channelSecret ? true : undefined} aria-describedby={warning('channelSecret') ? 'v8-channelSecret-warning' : undefined} /></SaveErrorField>
              </Field>
              <p className={styles.help}>同じ画面の「Channel secret」の右のコピーから貼り付けてください。</p>
              {warningText('channelSecret')}
            </div>
          </div>
          <span className={styles.secretNote}><Lock size={16} aria-hidden="true" />シークレットは保存したあと画面には出ません。あとから入れ替えはできます。</span>
        </Card>
      )}
      {sub === 2 && (
        <Card surface="standard" layout="vertical" contentPadding="var(--tpl-htn-panel-pad)" gap="var(--tpl-htn-panel-gap)" className={styles.panel} aria-label="プロバイダーIDを確認する">
          <p className={styles.subBadge}>{badge}</p>
          <div className={styles.precheckHead}>
            <h2 data-step-heading tabIndex={-1} className={styles.panelTitle}>プロバイダーIDを確認する</h2>
            <span className={styles.precheckHelpMark} title="Messaging APIチャネルのプロバイダーIDを入力します。" aria-label="Messaging APIチャネルのプロバイダーIDを入力します。"><CircleHelp size={16} aria-hidden="true" /></span>
          </div>
          <p className={styles.precheckLead}>Messaging APIチャネルのプロバイダーIDを入力します。</p>
          <div className={`${styles.precheckNote} ${styles.precheckNoteInfo}`}>
            <p className={styles.precheckNoteTitle}>LINE Developersでプロバイダー設定を開いてください</p>
            <p>Step 1で使ったMessaging APIチャネルのプロバイダーを選び、「プロバイダー設定」→「基本情報」を開きます。</p>
            <div className={styles.precheckNoteLink}>
              <Button variant="primary" external href="https://developers.line.biz/console/">LINE Developersを開く</Button>
              <p className={styles.help}>必ずこのボタンから操作してください</p>
            </div>
          </div>
          <div className={styles.acField}>
            <Field htmlFor="v8-provider-id" label="プロバイダーID" error={fieldErrors.providerId}>
              <SaveErrorField names={["providerId","form.providerId"]}><TextField id="v8-provider-id" value={values.providerId} onChange={(event) => onUpdate('providerId', event.target.value)} onPaste={() => onTouchField('providerId')} onBlur={() => onValidateField('providerId')} inputMode="numeric" placeholder="例：2005648758" required aria-invalid={fieldErrors.providerId ? true : undefined} aria-describedby={warning('providerId') ? 'v8-providerId-warning' : undefined} /></SaveErrorField>
            </Field>
            <p className={styles.help}>「プロバイダー設定」の「基本情報」にあるプロバイダーIDをコピーして、ここに貼り付けてください。</p>
            {warningText('providerId')}
          </div>
          <Notice tone="warn" heading={<>Step 1と同じプロバイダーを選んでください</>}>
            <p>別のプロバイダーのIDを入力すると、Step 4で作るLINEログインチャネルを同じアカウントにつなげられません。</p>
          </Notice>
          <div className={styles.field}>
            <p className={styles.groupLabel}>設定手順の確認</p>
            <p className={styles.help}>IDを貼り付けたら「次のステップへ」を押してください。次はWebhookの設定です。</p>
          </div>
        </Card>
      )}
      {sub === 3 && (
        /* 正本 v07 Fqy29 → ②Step2 の S1KaUa。利用者が個別 URL を「Messaging API設定」へ貼り付ける。
           貼って「更新」を押すまで3つのスイッチが出てこないため、
           URLの控えと［コピー］（Ds3E2）を置き、印は「貼り付けた」を先頭にして全4つにした。 */
        <Card surface="standard" layout="vertical" contentPadding="var(--tpl-htn-panel-pad)" gap="var(--tpl-htn-panel-gap)" className={styles.panel} aria-label="Webhook（受信のつなぎ）を設定する">
          <p className={styles.subBadge}>{badge}</p>
          <div className={styles.precheckHead}>
            <h2 data-step-heading tabIndex={-1} className={styles.panelTitle}>Webhook（受信のつなぎ）を設定する</h2>
            <span className={styles.precheckHelpMark} title="LINE からのメッセージを musubo が受け取るための通り道です。" aria-label="LINE からのメッセージを musubo が受け取るための通り道です。"><CircleHelp size={16} aria-hidden="true" /></span>
          </div>
          <div className={`${styles.precheckNote} ${styles.precheckNoteInfo}`}>
            <p className={styles.precheckNoteTitle}>LINE Developers の Webhook 設定を開いてください</p>
            <p>ステップ1で入れたチャネルIDを使って、このチャネルの「Messaging API設定」を直接開きます。プロバイダーやチャネルを選び直す必要はありません。</p>
            <div className={styles.precheckNoteLink}>
              {messagingApiUrl
                ? <Button variant="primary" external href={messagingApiUrl}>LINE Developers を開く</Button>
                : <p className={styles.help}>チャネルIDがありません。Messaging APIの情報へ戻って入力してください。</p>}
              {messagingApiUrl && <p className={styles.help}>必ずこのボタンから操作してください</p>}
            </div>
          </div>
          {/* 承認済み v07 Ds3E2「AC Webhook URL」。白い枠＋細い線で、上下の色付きの箱と見分ける。 */}
          <Card surface="bordered" layout="vertical" contentPadding="var(--tpl-htn-note-pad)" gap="var(--tpl-htn6-pre-head-gap)" data-design-node="Ds3E2">
            <p className={styles.webhookUrlTitle}><LinkIcon size={16} aria-hidden="true" />musubo の Webhook URL</p>
            <p className={styles.precheckLead}>下のURLをコピーし、「Messaging API設定」のWebhook URLに貼り付けて「更新」を押します。</p>
            <div className={styles.webhookUrlRow}>
              {/* 承認済み v07 の枠 E01lkh（高さ36・左右12・角10）。余白は1語にまとめた変数では
                  渡さない。Card は文字列を見て左右別々の余白かを決める（card.tsx の hasSides）ので、
                  var() 1つだと共通の下限 16 と突き合わされて `max(16px, 8px 10px)` になり、
                  CSS として成り立たず余白が 0 に落ちる（枠が1行ぶんに潰れて字が線に付く）。
                  ⑤の同じ形の枠（register.tsx）と同じく、値を空白で分けて渡す。 */}
              <Card layout="horizontal" surface="bordered" corner="control" contentPadding="var(--space-8) var(--space-12)">
                <span className={styles.endpointValue}><TruncatedText value={webhookUrl || String(emptyValue('unknown'))} /></span>
              </Card>
              <CopyTextButton value={webhookUrl} label="コピー" variant="secondary" icon={<Copy size={16} aria-hidden="true" />} aria-label="Webhook URL をコピー" disabled={!webhookUrl} />
            </div>
          </Card>
          <Notice tone="warn" heading={<>すでにほかのツールのURLが入っているとき</>}>
            <p>Webhook URL の欄に別の配信ツールのURLが入っている場合、あとの「接続チェック」で musubo のURLに書きかわり、そのツールの受信は止まります。使い続けたいときは、ここで「途中保存して閉じる」を押して、既存のWebhook URLを別途保存してから進めてください。</p>
          </Notice>
          <div className={styles.field}>
            <p className={styles.groupLabel}>設定手順の確認</p>
            <p className={styles.help}>URLを貼り付けて更新すると、下の3つのスイッチが出てきます。ONにしたら、それぞれチェックを入れてください。</p>
          </div>
          <div className={styles.ackList}>
            {WEBHOOK_ACKS.map((ack) => (
              <div key={ack.key}>
                <SaveErrorField names={[ack.key]}><Checkbox checked={Boolean(acks[ack.key])} onCheckedChange={(next) => onToggleAck(ack.key, next)}>{ack.label}</Checkbox></SaveErrorField>
                <p className={styles.ackNote}>{ack.note}</p>
              </div>
            ))}
          </div>
          <p className={styles.help}>4つすべてにチェックを入れると「次のステップへ」が押せるようになります。</p>
        </Card>
      )}
      {sub === 4 && (
        /* 正本 v07 Fqy29 → ②-3（J84XB）の wI40b。Callback URL は musubo が自動で登録するので
           控えの欄を置かない。開くボタンはステップ2で入力したプロバイダーIDを使う。 */
        <Card surface="standard" layout="vertical" contentPadding="var(--tpl-htn-panel-pad)" gap="var(--tpl-htn-panel-gap)" className={styles.panel} aria-label="LINEログインの情報を入れる">
          <p className={styles.subBadge}>{badge}</p>
          <div className={styles.precheckHead}>
            <h2 data-step-heading tabIndex={-1} className={styles.panelTitle}>LINEログインの情報を入れる</h2>
            <span className={styles.precheckHelpMark} title="友だち追加の窓口（LIFF）を musubo が自動で作るために使います。" aria-label="友だち追加の窓口（LIFF）を musubo が自動で作るために使います。"><CircleHelp size={16} aria-hidden="true" /></span>
          </div>
          <p className={styles.precheckLead}>友だち追加の窓口（LIFF）を musubo が自動で作るために使います。入れていただくのはこの2項目だけです。</p>
          <div className={`${styles.precheckNote} ${styles.precheckNoteInfo}`}>
            <p className={styles.precheckNoteTitle}>LINE Developers で「LINEログイン」チャネルを開いてください</p>
            <p>ステップ2で入力したプロバイダーの画面を直接開きます。LINEログインチャネルがまだなければ「新規チャネル作成」から作成し、すでにあればそのチャネルを開いて、下記2項目をコピーしてください。</p>
            <div className={styles.precheckNoteLink}>
              {providerUrl
                ? <Button variant="primary" external href={providerUrl}>LINE Developers のプロバイダーを開く</Button>
                : <p className={styles.help}>プロバイダーIDがありません。プロバイダーIDの確認へ戻って入力してください。</p>}
              {providerUrl && <p className={styles.help}>同じプロバイダー内のLINEログインチャネルを使ってください</p>}
            </div>
          </div>
          <div className={styles.acInputs}>
            <div className={styles.acField}>
              <Field htmlFor="v8-login-channel-id" label="チャネルID（LINEログイン）" error={fieldErrors.loginChannelId}>
                <SaveErrorField names={["loginChannelId","form.loginChannelId","login_channel_id","form.login_channel_id"]}><TextField id="v8-login-channel-id" value={values.loginChannelId} onChange={(event) => onUpdate('loginChannelId', event.target.value)} onPaste={() => onTouchField('loginChannelId')} onBlur={() => onValidateField('loginChannelId')} inputMode="numeric" placeholder="例：2001234567" required aria-invalid={fieldErrors.loginChannelId ? true : undefined} aria-describedby={warning('loginChannelId') ? 'v8-loginChannelId-warning' : undefined} /></SaveErrorField>
              </Field>
              <p className={styles.help}>LINEログインチャネルの「チャネル基本設定」にあります。Messaging API のIDとは違う番号です。</p>
              {warningText('loginChannelId')}
            </div>
            <div className={styles.acField}>
              <Field htmlFor="v8-login-channel-secret" label="チャネルシークレット（LINEログイン）" error={fieldErrors.loginChannelSecret}>
                <SaveErrorField names={["loginChannelSecret","form.loginChannelSecret","login_channel_secret","form.login_channel_secret"]}><TextField id="v8-login-channel-secret" type="password" autoComplete="new-password" value={values.loginChannelSecret} onChange={(event) => onUpdate('loginChannelSecret', event.target.value)} onPaste={() => onTouchField('loginChannelSecret')} onBlur={() => onValidateField('loginChannelSecret')} placeholder="例：abc123def456ghi789…" required aria-invalid={fieldErrors.loginChannelSecret ? true : undefined} aria-describedby={warning('loginChannelSecret') ? 'v8-loginChannelSecret-warning' : undefined} /></SaveErrorField>
              </Field>
              <p className={styles.help}>同じ画面の「チャネルシークレット」です。</p>
              {warningText('loginChannelSecret')}
            </div>
          </div>
          <div className={styles.field}>
            <p className={styles.groupLabel}>設定手順の確認</p>
            <p className={styles.help}>「LINEログイン」チャネルの画面で設定したら、下のチェックを入れてください。</p>
          </div>
          <div className={styles.ackList}>
            {LOGIN_ACKS.map((ack) => (
              <div key={ack.key}>
                <SaveErrorField names={[ack.key]}><Checkbox checked={Boolean(acks[ack.key])} onCheckedChange={(next) => onToggleAck(ack.key, next)}>{ack.label}</Checkbox></SaveErrorField>
                <p className={styles.ackNote}>{ack.note}</p>
              </div>
            ))}
          </div>
          <span className={styles.secretNote}><Info size={16} aria-hidden="true" />2つともチェックを入れると「次のステップへ」が押せるようになります。</span>
        </Card>
      )}
    </CreateStepColumns>
  )
}
