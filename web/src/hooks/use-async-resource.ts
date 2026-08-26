import { useCallback, useEffect, useRef, useState } from "react"

interface AsyncResourceOptions<T> {
  initialData: T
  errorMessage: string
  onBackgroundError?: (message: string) => void
}

export function useAsyncResource<T>(
  loader: () => Promise<T>,
  { initialData, errorMessage, onBackgroundError }: AsyncResourceOptions<T>
) {
  const backgroundErrorRef = useRef(onBackgroundError)
  const requestRef = useRef(0)
  const [data, setData] = useState<T>(() => initialData)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    backgroundErrorRef.current = onBackgroundError
  }, [onBackgroundError])

  const reload = useCallback(
    async (showLoading = false) => {
      const request = ++requestRef.current
      if (showLoading) setLoading(true)
      setError("")

      try {
        const nextData = await loader()
        if (request === requestRef.current) setData(nextData)
      } catch (cause) {
        if (request !== requestRef.current) return
        const message =
          cause instanceof Error && cause.message ? cause.message : errorMessage
        setError(message)
        if (!showLoading) backgroundErrorRef.current?.(message)
      } finally {
        if (request === requestRef.current) setLoading(false)
      }
    },
    [errorMessage, loader]
  )

  useEffect(() => {
    void reload(true)
    return () => {
      requestRef.current += 1
    }
  }, [reload])

  return { data, error, loading, reload }
}
