import type { FormAvailability } from '@line-crm/shared';
import { formatDateTimeLong } from '../lib/datetime.js';

export { choiceReceptionLabel } from '../lib/form-reception.js';
export default function FormReception({ availability }: { availability?: FormAvailability }) {
  if (!availability) return null;
  return <div className="space-y-1 text-xs text-ink-secondary" aria-label="回答の受付条件">
    {availability.deadlineAt && <p>{Number.isFinite(Date.parse(availability.deadlineAt)) ? `締め切り：${formatDateTimeLong(availability.deadlineAt)}` : '締め切りを確認できません'}</p>}
    {availability.oncePerFriend && <p>回答はお一人さま1回までです</p>}
    {availability.totalRemaining != null && <p>{Number.isSafeInteger(availability.totalRemaining) && availability.totalRemaining >= 0 ? `受付上限まで残り${availability.totalRemaining}件（送信時に確定します）` : '受付の残り件数を確認できません'}</p>}
    {!availability.accepting && <p>{availability.reason || 'このフォームは現在受付を停止しています'}</p>}
  </div>;
}
