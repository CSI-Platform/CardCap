import { envValue } from './config'

export async function sendLoginEmail(env: Env, to: string, link: string): Promise<void> {
  const apiKey = envValue(env, 'RESEND_API_KEY')
  if (!apiKey) {
    console.log(JSON.stringify({ level: 'info', message: 'magic link (dev, email not sent)', to, link }))
    return
  }
  const sender = envValue(env, 'SENDER_EMAIL')
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: `CardCap <${sender}>`,
      to: [to],
      subject: 'Your CardCap sign-in link',
      text: `Sign in to CardCap:\n\n${link}\n\nThis link works once and expires in 15 minutes. If you didn't request it, ignore this email.`,
      html: `<p>Sign in to CardCap:</p><p><a href="${link}">Open CardCap</a></p><p>This link works once and expires in 15 minutes. If you didn't request it, ignore this email.</p>`,
    }),
  })
  if (!response.ok) {
    console.error(JSON.stringify({ level: 'error', message: 'resend send failed', status: response.status }))
    throw new Error("Couldn't send the email — try again")
  }
}
