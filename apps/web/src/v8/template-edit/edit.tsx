'use client'

/*
 * ★V8 テンプレートの作る・編集の入口（/templates/edit）。
 * 受け付ける指定は今の画面と同じ：?id=（編集）・?visual=1（見本の中身）・
 * ?kind=coupon|research（資産の作る画面）・?kind=rich_message（リッチメッセージを作る ）・
 * ?example=<見本の番号>（見本から作る F-5：メッセージを作るに見本の名前と本文を入れて開く）。
 */
import { useSearchParams } from 'next/navigation'
import TargetMissing from '@/components/shared/target-missing'
import TemplateMessageEditor from './message'
import TemplateAssetEditor from './asset'
import TemplateRichEditor from './rich'
import TemplateRichVideoEditor from './rich-video'

export default function TemplateEditV8() {
  const params = useSearchParams()
  const id = params.get('id')
  const kind = params.get('kind')
  const visual = params.get('visual') === '1'
  const example = params.get('example')
  const knownKind = kind === null || kind === '' || kind === 'message' || kind === 'rich_video' || kind === 'rich_message' || kind === 'coupon' || kind === 'research'
  if (!knownKind || (kind === 'rich_message' && id)) return <TargetMissing kind="unspecified" pageHeading title="テンプレートの種類を確認できません" description="一覧から対象を選び直してください。" backHref="/templates" backLabel="テンプレート一覧へ戻る" />
  if (kind === 'rich_video') return <TemplateRichVideoEditor key={`${id ?? 'new'}`} id={id} visual={visual} />
  if (kind === 'rich_message') return <TemplateRichEditor visual={visual} />
  if (kind === 'coupon' || kind === 'research') return <TemplateAssetEditor key={`${kind}:${id ?? 'new'}`} id={id} kind={kind} visual={visual} />
  return <TemplateMessageEditor id={id} visual={visual} example={example} />
}
