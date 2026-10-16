export class RequestError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export const requestResponse = async (url: string, options?: RequestInit): Promise<Response> => {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new RequestError(body?.error ?? `Request failed with status ${response.status}.`, response.status)
  }
  return response
}

export const requestJson = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await requestResponse(url, options)
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

export const createClientId = () => typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')

export const getPlayerId = () => {
  const key = 'quiz-app.player-id'
  const existing = localStorage.getItem(key)
  if (existing) {
    return existing
  }
  const id = createClientId()
  localStorage.setItem(key, id)
  return id
}

export const lookupEvent = <T,>(code: string): Promise<T> =>
  requestJson<T>(`/api/join/${encodeURIComponent(code)}`, { headers: { 'x-quiz-client-id': getPlayerId() } })

export const playerUrl = (base: string, code: string) => {
  const url = new URL('/', base || window.location.origin)
  url.searchParams.set('code', code)
  return url.href
}
