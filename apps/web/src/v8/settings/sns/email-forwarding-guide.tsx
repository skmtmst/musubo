'use client'
import { useState } from 'react'
import SegmentedControl from '@/components/shared/segmented'
import { FORWARDING_PROVIDERS, forwardingSteps, type ForwardingProvider } from './email-connection-model'
import { Steps } from '@/components/templates/steps'
import styles from './email-card.module.css'

/**
 * お店のメールで転送を設定する手順。使っているメールを選ぶと、その場に数行の手順が出る。
 * 確認コードは別の欄（この枠の中）に出るので、手順からはそこを指すだけにする。
 */
export function EmailForwardingGuide() {
  const [provider, setProvider] = useState<ForwardingProvider>('gmail')
  const providerLabel = FORWARDING_PROVIDERS.find((item) => item.value === provider)?.label ?? ''
  return (
    <div className={styles.guide}>
      <SegmentedControl<ForwardingProvider>
        aria-label="お使いのメール"
        selectionMode="radio"
        size="compact"
        fit="content"
        equalWidth={false}
        options={FORWARDING_PROVIDERS}
        value={provider}
        onChange={setProvider}
      />
      <Steps
        label={`${providerLabel}の転送の手順`}
        layout="guidance"
        steps={forwardingSteps(provider).map(label => ({ label, state: 'todo' }))}
      />
    </div>
  )
}
