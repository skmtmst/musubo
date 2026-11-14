export function gap3Respond(
  method: string,
  pathname: string,
  body?: Record<string, unknown>,
  query?: URLSearchParams,
): [status: number, response: { success: boolean; data: unknown }] | undefined
