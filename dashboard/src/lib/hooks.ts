import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Operation } from '../api'

// Loads data once and exposes a reload(). Keeps the previous data while reloading.
export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const loadRef = useRef(load)
  loadRef.current = load

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setData(await loadRef.current())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => void reload(), deps)

  return { data, error, loading, reload }
}

// Polls an operation until it finishes, then calls onDone once.
export function useOperation(operationId: string | null, onDone?: (op: Operation) => void) {
  const [op, setOp] = useState<Operation | null>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    if (!operationId) {
      setOp(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await api.getOperation(operationId)
        if (cancelled) return
        setOp(next)
        if (next.status === 'running') timer = setTimeout(poll, 600)
        else onDoneRef.current?.(next)
      } catch {
        if (!cancelled) timer = setTimeout(poll, 2000)
      }
    }
    poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [operationId])

  return op
}
