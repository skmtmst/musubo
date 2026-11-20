'use client'

import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import Button, { type ButtonProps } from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import { RowMenu, type RowMenuProps } from '@/components/shared/row-actions'
import { headingActionNodes, actionLabel } from './page-action-nodes'
import PageActionMenu from './page-action-menu'

/** 題の右は副操作1つ（文字）・主操作1つ・その他のメニュー。操作と無効条件は元のボタンを保つ。 */
export default function PageHeadingActions({ children }: { children: ReactNode }) {
  const nodes = headingActionNodes(children)
  const buttons = nodes.filter((node): node is ReactElement<ButtonProps> => isValidElement<ButtonProps>(node) && node.type === Button && !node.props.hidden)
  const gatedPrimary = nodes.find((node): node is ReactElement<ButtonProps> => isValidElement<ButtonProps>(node) && node.type === PermissionGatedButton && node.props.variant === 'primary' && !node.props.hidden)
  const primary = buttons.find(node => node.props.variant === 'primary') ?? gatedPrimary
  const secondary = buttons.find(node => node !== primary && node.props.variant !== 'primary' && !/danger/.test(node.props.variant ?? '') && !/削除|消す/.test(actionLabel(node.props.children)))
  const menus = nodes.filter((node): node is ReactElement<RowMenuProps> => isValidElement(node) && node.type === RowMenu)
  const extras = buttons.filter(node => node !== primary && node !== secondary)
  const other = nodes.filter(node => node !== primary && !buttons.includes(node as ReactElement<ButtonProps>) && !menus.includes(node as ReactElement<RowMenuProps>))
  return <span data-page-heading-actions>
    {other}
    {secondary ? cloneElement(secondary, { variant: 'text' }) : null}
    {primary}
    {extras.length ? <><PageActionMenu buttons={extras} menu={menus[0]} label="その他の操作" />{menus.slice(1)}</> : menus}
  </span>
}
