/** 追加ボタンは本文とは別の Flex として LINE に送る。 */
export function broadcastButtonsFlex(buttons: ReadonlyArray<{ label: string; value: string; type?: string }>) {
  return { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: buttons.map(button => ({
    type: 'button', action: button.type === 'postback'
      ? { type: 'postback', label: button.label, data: button.value }
      : { type: 'uri', label: button.label, uri: button.value },
  })) } }
}

/** 予約の案内で自動追加されるメッセージ。送信とプレビューの両方が使う。 */
export function requiredRestaurantFollowupParts(trigger: string, content: string): Array<{ id: string; messageType: string; messageContent: string }> {
  const parts: Array<{ id: string; messageType: string; messageContent: string }> = []
  if (trigger === 'reservation_24h' && !['restaurant_going', 'restaurant_change', 'restaurant_cancel'].every(key => content.includes(`{{var.${key}}}`))) {
    parts.push({ id: 'confirmation', messageType: 'flex', messageContent: JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'ご予約について', wrap: true }] }, footer: { type: 'box', layout: 'vertical', contents: [
      { type: 'button', action: { type: 'postback', label: '行きます', data: '{{var.restaurant_going}}' } },
      { type: 'button', action: { type: 'postback', label: '変更したい', data: '{{var.restaurant_change}}' } },
      { type: 'button', action: { type: 'postback', label: '取り消す', data: '{{var.restaurant_cancel}}' } },
    ] } }) })
  }
  if (trigger === 'waitlist_invited' && !['waitlist_book_url', 'waitlist_decline_url'].every(key => content.includes(`{{var.${key}}}`))) {
    parts.push({ id: 'invitation', messageType: 'text', messageContent: 'この時間で予約する：{{var.waitlist_book_url}}\n今回は見送る：{{var.waitlist_decline_url}}' })
  }
  return parts
}
