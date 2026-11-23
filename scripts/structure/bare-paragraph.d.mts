export type BareParagraph = { file: string; line: number; fingerprint: string }
export type BareParagraphException = { file: string; fingerprint: string; count: number; reason: string }
export function findBareParagraphs(): BareParagraph[]
export function unexpectedParagraphs(found: BareParagraph[], baseline: BareParagraphException[]): BareParagraph[]
