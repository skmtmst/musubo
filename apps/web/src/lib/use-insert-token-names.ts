'use client'

import { useEffect, useRef, useState } from 'react'
import { referenceTokenNames } from '@/components/shared/insert-tokens'
import { EMPTY_REFERENCES, loadTemplateReferences, requestTemplateReferences, type TemplateReferences, type TemplateReferenceState } from './template-references'

/** アカウントが変わったら、以前の項目名も遅れて届いた応答も表示しない。 */
export function useInsertReferences(accountId: string | null) {
  const scope = useRef({ accountId })
  if (scope.current.accountId !== accountId) scope.current = { accountId }
  const requestScope = scope.current
  const generation = useRef(0)
  const [loaded, setLoaded] = useState<{ scope: typeof requestScope; references: TemplateReferences; state: TemplateReferenceState }>({ scope: requestScope, references: EMPTY_REFERENCES, state: accountId ? 'loading' : 'idle' })
  useEffect(() => {
    const current = ++generation.current
    if (!accountId) return
    void requestTemplateReferences({ accountId, load: loadTemplateReferences, generation: current, currentGeneration: () => generation.current }).then(result => {
      if (result !== null) setLoaded({ scope: requestScope, references: result === 'failed' ? EMPTY_REFERENCES : result, state: result === 'failed' ? 'failed' : 'ready' })
    })
    return () => { generation.current = current + 1 }
  }, [accountId, requestScope])
  return loaded.scope === requestScope ? loaded : { accountId, references: EMPTY_REFERENCES, state: accountId ? 'loading' as const : 'idle' as const }
}

/** 札の名前の表。共通情報を読み終えたときだけ、一覧に無いキーを「名前なし」と言い切れる。 */
export function useInsertTokenNames(accountId: string | null) {
  const { references, state } = useInsertReferences(accountId)
  return { ...referenceTokenNames(references), varsComplete: state === 'ready' }
}
