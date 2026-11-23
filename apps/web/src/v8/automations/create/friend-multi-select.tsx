'use client'

import { RequiredBadge } from '@/components/shared/form-controls'
import { FRIEND_SELECT_LIMIT, normalizeFriendIds } from './trigger-helpers'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import FriendPickerField from '@/components/shared/friend-picker-field'
import { formatNumber } from '@/lib/format'

export function FriendMultiSelect({
  accountId,
  selectedIds,
  names,
  onChange,
  error
}: {
  accountId: string | null
  selectedIds: ReadonlyArray<string>
  names: Record<string, string>
  onChange: (ids: string[], nextNames: Record<string, string>) => void
  error?: string
}) {
  const ids = normalizeFriendIds(selectedIds)
      return <SaveErrorField names={["query","search"]}><div>
      <p className="text-label">
        対象の友だち（{formatNumber(ids.length)} 人）<RequiredBadge />
      </p>
        <FriendPickerField label="対象の友だち" accountId={accountId} multiple
          value={ids} names={names}
          onChange={onChange} error={error} maxSelected={FRIEND_SELECT_LIMIT} /><p className="text-caption">100人まで選べます。
      </p>
    </div></SaveErrorField>
}
