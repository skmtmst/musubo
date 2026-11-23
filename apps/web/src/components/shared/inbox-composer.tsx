import { forwardRef, type HTMLAttributes, type Ref, type TextareaHTMLAttributes } from 'react'
import Button, { type ButtonProps } from './button'
import InsertTextField, { type InsertTextFieldHandle, type InsertTextFieldProps } from './insert-text-field'
import './inbox-composer-tokens.css'
import styles from './inbox-composer.module.css'

type PartProps = HTMLAttributes<HTMLDivElement>
export function InboxComposerTools(props: PartProps) { return <div {...props} className={styles.tools} /> }
export function InboxInputBox(props: PartProps) { return <div {...props} data-input-field className={styles.input} /> }
export function InboxDraftArea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) { return <textarea {...props} className={styles.draft} /> }
/**
 * 差し込みを札で見せる返信の文。保存・送信の値は {{…}} の文字のまま。
 * 線と輪は外枠（InboxInputBox）が持ち、高さは文に合わせて上限まで伸び、超えた分は中でスクロールする。
 */
export const InboxDraftEditor = forwardRef<InsertTextFieldHandle, Omit<InsertTextFieldProps, 'className' | 'compact' | 'editorSize' | 'rows'>>(function InboxDraftEditor(props, ref) {
  return <InsertTextField {...props} ref={ref} className={styles.draftEditor} />
})
export function InboxDraftCount(props: HTMLAttributes<HTMLParagraphElement>) { return <p {...props} className={styles.count} /> }
export function InboxComposerBottom(props: PartProps) { return <div {...props} className={styles.bottom} /> }
export function InboxComposerActions(props: HTMLAttributes<HTMLSpanElement>) { return <span {...props} className={styles.actions} /> }
export function InboxToolButton(props: ButtonProps) { return <Button {...props} variant="secondary" size="inbox-tool" className={styles.tool} /> }
