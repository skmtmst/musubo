export const FRIEND_IMPORT_COLUMNS = {
  lineUid: ['LINEユーザーID', 'line_user_id', 'lineUid'],
  displayName: ['LINE表示名', 'display_name', 'displayName'],
  realName: ['本名', 'real_name', 'realName'],
  systemDisplayName: ['システム表示名', 'system_display_name', 'systemDisplayName'],
} as const
export const FRIEND_IMPORT_HEADERS = Object.values(FRIEND_IMPORT_COLUMNS).map((names) => names[0])

export type FriendImportRow = {
  lineUid: string
  displayName: string | null
  realName: string | null
  systemDisplayName: string | null
}

/*
 * R113: 引用符を意識して行を割る。書き出しは改名・改行を含む名前を
 * `"..."` で包む正しいCSVにするため、先に改行で割ると1人ぶんが
 * 複数行に割れて余分なUID行ができる。`""` は `"` 1つに戻す。
 */
export function splitCsvRecords(text: string): string[][] {
  if (typeof text !== 'string') return []
  const source = text.replace(/^\uFEFF/, '')
  const records: string[][] = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  let touched = false
  const pushCell = () => {
    cells.push(cell)
    cell = ''
  }
  const pushRecord = () => {
    pushCell()
    records.push(cells)
    cells = []
    touched = false
  }
  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"'
          index += 2
        } else {
          quoted = false
          index += 1
        }
      } else {
        cell += character
        index += 1
      }
      touched = true
      continue
    }
    if (character === '"' && cell.length === 0) {
      quoted = true
      touched = true
      index += 1
    } else if (character === ',') {
      pushCell()
      index += 1
    } else if (character === '\r' || character === '\n') {
      pushRecord()
      index += character === '\r' && source[index + 1] === '\n' ? 2 : 1
    } else {
      cell += character
      touched = true
      index += 1
    }
  }
  if (!quoted && (touched || cells.length > 0)) pushRecord()
  return records
}

/*
 * R113: 書き出しが表計算の数式化け防止に付けた `'` を外す。
 * 付くのは先頭が `= + - @` の値だけなので、その形の先頭 `'` だけを外す。
 * それ以外の `'`（「'hello」など名前そのもの）は残す。
 */
function unprotectCsvCell(value: string | null): string | null {
  if (value == null) return null
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value
}

export function parseFriendCsv(text: string): FriendImportRow[] {
  const records = splitCsvRecords(text)
    .filter((cells) => cells.some((cell) => cell.trim() !== ''))
  if (records.length < 2) return []
  const headers = records[0].map((value) => value.trim())
  const headerIndex = (...names: string[]) => headers.findIndex((value) => names.includes(value))
  const uid = headerIndex(...FRIEND_IMPORT_COLUMNS.lineUid)
  if (uid < 0) return []
  const display = headerIndex(...FRIEND_IMPORT_COLUMNS.displayName)
  const real = headerIndex(...FRIEND_IMPORT_COLUMNS.realName)
  const system = headerIndex(...FRIEND_IMPORT_COLUMNS.systemDisplayName)
  const value = (cells: string[], position: number) => position < 0
    ? null
    : unprotectCsvCell(cells[position]?.trim() || null)

  return records.slice(1).map((cells) => {
    return {
      lineUid: value(cells, uid) ?? '',
      displayName: value(cells, display),
      realName: value(cells, real),
      systemDisplayName: value(cells, system),
    }
  }).filter((row) => row.lineUid)
}
