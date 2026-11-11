/**
 * 静的書き出しされる管理画面の環境限定機能。
 * 値が無い本番ビルドを安全側へ倒すため、明示的な true だけを有効にする。
 */
export function googleBusinessUiEnabled(
  value = process.env.NEXT_PUBLIC_GOOGLE_BUSINESS_ENABLED,
): boolean {
  return value?.trim().toLowerCase() === 'true'
}

export function restaurantTestUiEnabled(
  value = process.env.NEXT_PUBLIC_RESTAURANT_TEST_ENABLED,
): boolean {
  return value?.trim().toLowerCase() === 'true'
}

/**
 * 会話の AI（G2：受信箱の要約・返信案、自動応答の Q&A・AI が答えた記録）の入口。
 * 2026-10-16 オーナー決定  でこちらの AI は出さない。コードは残し、明示的な true の時だけ入口を出す（既定オフ）。
 * AI とつなぐ接続（MCP）は別物でこの旗の対象外。
 */
export function conversationAiUiEnabled(
  value = process.env.NEXT_PUBLIC_CONVERSATION_AI_ENABLED,
): boolean {
  return value?.trim().toLowerCase() === 'true'
}

/** Google だけを飲食店の試験スイッチから分ける。似た名前のパスは含めない。 */
export function environmentFeatureForPath(path: string): 'google-business' | 'restaurant-test' | null {
  if (path === '/settings/google-hours') return 'google-business'
  if (path === '/restaurant-test/google' || path.startsWith('/restaurant-test/google/')) return 'google-business'
  if (path === '/restaurant-test' || path.startsWith('/restaurant-test/') || path === '/settings/booking-media' || path === '/settings/delivery') return 'restaurant-test'
  return null
}

export function environmentFeatureUiEnabled(path: string): boolean {
  const feature = environmentFeatureForPath(path)
  return feature === 'google-business' ? googleBusinessUiEnabled() : feature === 'restaurant-test' ? restaurantTestUiEnabled() : true
}
