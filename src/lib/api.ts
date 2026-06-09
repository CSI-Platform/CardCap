export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  return parseResponse<T>(response)
}

export async function apiJson<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return parseResponse<T>(response)
}

export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch(path, {
    method: 'POST',
    body: form,
  })
  return parseResponse<T>(response)
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  const data = text ? JSON.parse(text) : {}
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : `HTTP ${response.status}`
    throw new Error(message)
  }
  return data as T
}
