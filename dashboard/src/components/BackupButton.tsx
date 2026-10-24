import { useState } from 'react'
import { DatabaseBackup } from 'lucide-react'
import { api } from '../api'
import { useOperation } from '../lib/hooks'
import { Button, Spinner } from './ui'

// Starts a manual backup and shows progress on the button itself.
export function BackupButton({
  appId,
  onDone,
  onError,
  disabled,
}: {
  appId: string
  onDone: () => void
  onError: (message: string) => void
  disabled?: boolean
}) {
  const [operationId, setOperationId] = useState<string | null>(null)
  const op = useOperation(operationId, (finished) => {
    setOperationId(null)
    if (finished.status === 'succeeded') onDone()
    else onError('The backup failed. Check the job logs in CloudWatch.')
  })
  const busy = operationId !== null
  const step = op?.steps.find((s) => s.state === 'running')

  async function start() {
    try {
      const created = await api.createBackup(appId)
      setOperationId(created.id)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Button variant="secondary" size="lg" onClick={start} disabled={busy || disabled}>
      {busy ? <Spinner /> : <DatabaseBackup className="size-5" />}
      {busy ? (step ? `${step.label}…` : 'Starting…') : 'Back up now'}
    </Button>
  )
}
