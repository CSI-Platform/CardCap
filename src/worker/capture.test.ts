import { describe, expect, it, vi } from 'vitest'
import { captureContact } from './capture'

function bindings(fields: Record<string, unknown>) {
  const quickAction = vi.fn(async (_action: string, options: { url: string }) => Response.json({
    result: options.url.endsWith('/contact') ? 'Acme Studio\n480-555-0101' :
      '[Contact](https://elsewhere.com/contact) [Contact us](/contact)',
  }))
  const run = vi.fn(async () => ({ response: fields }))
  return { env: { BROWSER: { quickAction }, AI: { run } } as unknown as Env, quickAction, run }
}

describe('capture drafts', () => {
  it('follows the same-site contact link and retains the source and company-only identity', async () => {
    const { env, quickAction } = bindings({ company: 'Acme Studio', phones: ['480-555-0101'], emails: ['invented@example.com'] })
    const c = await captureContact('acmestudio.com', env)
    expect(quickAction.mock.calls.map(call => call[1].url)).toEqual(['https://acmestudio.com/', 'https://acmestudio.com/contact'])
    expect(c).toMatchObject({ name: '', company: 'Acme Studio', email: '', source: { url: 'https://acmestudio.com/contact', text: 'Acme Studio\n480-555-0101' } })
  })
  it('preserves a signed name and pasted evidence without looking up a website', async () => {
    const { env, quickAction } = bindings({ company: 'Acme Studio', emails: ['jamie@example.com'] })
    const input = 'Jamie Park\nAcme Studio\njamie@example.com'
    expect(await captureContact(input, env)).toMatchObject({ name: 'Jamie Park', source: { text: input, url: '' } })
    expect(quickAction).not.toHaveBeenCalled()
  })
  it('offers paste when the website is unreadable', async () => {
    const { env, quickAction, run } = bindings({})
    quickAction.mockResolvedValueOnce(Response.json({}, { status: 403 }))
    await expect(captureContact('acmestudio.com', env)).rejects.toThrow(/paste/i)
    expect(run).not.toHaveBeenCalled()
  })
})
