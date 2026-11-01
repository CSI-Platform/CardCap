// API client. Errors carry what the screen needs to tell people the truth:
//  - 'session-ended': the server said 401, or an edge login redirect came back instead of JSON
//  - 'denied': the server said 403
//  - 'network': the request never got an answer
//  - 'http': any other failure
export type ApiErrorKind = 'session-ended' | 'denied' | 'network' | 'http'

export class ApiError extends Error {
  readonly status: number
  readonly kind: ApiErrorKind
  readonly path: string
  readonly loginUrl?: string
  readonly logoutUrl?: string

  constructor(message: string, init: { status: number; kind: ApiErrorKind; path: string; loginUrl?: string; logoutUrl?: string }) {
    super(message)
    this.name = 'ApiError'
    this.status = init.status
    this.kind = init.kind
    this.path = init.path
    this.loginUrl = init.loginUrl
    this.logoutUrl = init.logoutUrl
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  return parseResponse<T>(path, await send(path, { headers: { accept: 'application/json' } }))
}

export async function apiJson<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  const response = await send(path, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return parseResponse<T>(path, response)
}

export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const form = new FormData()
  form.append('file', file)
  return parseResponse<T>(path, await send(path, { method: 'POST', body: form }))
}

// Never follow redirects: an expired edge session answers with a redirect to the login provider, which the browser
// would block with an unreadable network error. With redirect: 'manual' it arrives as an "opaque redirect" we can name.
async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { ...init, redirect: 'manual' })
  } catch {
    throw new ApiError("Can't reach CardCap. Check your connection and try again.", { status: 0, kind: 'network', path })
  }
}

async function parseResponse<T>(path: string, response: Response): Promise<T> {
  if (response.type === 'opaqueredirect') {
    throw new ApiError('Your session ended. Sign in again to keep working.', { status: 0, kind: 'session-ended', path })
  }
  const text = await response.text()
  let data: Record<string, unknown> = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      // A sign-in page or proxy error page came back instead of JSON.
      if (response.ok) {
        throw new ApiError('Your session ended. Sign in again to keep working.', { status: response.status, kind: 'session-ended', path })
      }
    }
  }
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : `HTTP ${response.status}`
    const kind: ApiErrorKind = response.status === 401 ? 'session-ended' : response.status === 403 ? 'denied' : 'http'
    throw new ApiError(message, {
      status: response.status,
      kind,
      path,
      loginUrl: relativeEdgeUrl(data.loginUrl),
      logoutUrl: relativeEdgeUrl(data.logoutUrl),
    })
  }
  return data as T
}

// Only same-site Access paths are ever followed; anything else (for example an absolute URL) is ignored.
export function relativeEdgeUrl(value: unknown): string | undefined {
  return typeof value === 'string' && /^\/cdn-cgi\/access\/[A-Za-z0-9/_-]*$/.test(value) ? value : undefined
}
