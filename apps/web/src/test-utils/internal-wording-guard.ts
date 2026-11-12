import ts from 'typescript'

const forbidden = ['中身の版', 'テスト領域', 'Harness']

/** 注釈や識別子を除き、画面に出る可能性がある文字列だけを確かめる。 */
export function findInternalWording(source: string, kind: ts.ScriptKind): string[] {
 const found = new Set<string>()
 const file = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, kind)
 const visit = (node: ts.Node) => {
  if ((ts.isStringLiteral(node) && !(node.text === 'X-Line-Harness-Source' && ts.isPropertyAssignment(node.parent) && node.parent.name === node)) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
   for (const word of forbidden) if (node.text.includes(word)) found.add(word)
  }
  ts.forEachChild(node, visit)
 }
 visit(file)
 return forbidden.filter(word => found.has(word))
}
