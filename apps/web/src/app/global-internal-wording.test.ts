import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { findInternalWording } from '@/test-utils/internal-wording-guard'

it('画面の文字列の禁止語を検出し、意味が適切な表現は残す', () => {
 const sample = `<div>中身の版</div><p>テスト領域</p><p>Harness</p><p>未計測・受信専用・検証中</p>`
 expect(findInternalWording(sample, ts.ScriptKind.TSX)).toEqual(['中身の版', 'テスト領域', 'Harness'])
 expect(findInternalWording(`const headers = { 'X-Line-Harness-Source': 'manual' }`, ts.ScriptKind.TS)).toEqual([])
 expect(findInternalWording(`const labels = { '中身の版': 1, 'Harness': 2 }`, ts.ScriptKind.TS)).toEqual(['中身の版', 'Harness'])
})
it('アプリ・画面・共通部品の全ソースに禁止語を表示しない', () => {
 const root = path.resolve(__dirname, '..')
 const hits:string[]=[]
 const visit=(dir:string) => {
  for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
   const p=path.join(dir,e.name)
   if(e.isDirectory()) { if(e.name !== 'test-utils') visit(p); continue }
   if(!/\.tsx?$/.test(e.name) || /\.(?:test|spec)\./.test(e.name)) continue
   const words=findInternalWording(fs.readFileSync(p,'utf8'),e.name.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS)
   if(words.length) hits.push(`${path.relative(root,p)}: ${words.join(', ')}`)
  }
 }
 visit(root)
 expect(hits).toEqual([])
})
