/** 認証設定の読み取り用の見本。該当しない要求は null。 */
export function trustedLoginAuthRead(method: string, pathname: string): { success: true; data: unknown } | null
