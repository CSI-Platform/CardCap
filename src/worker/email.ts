export async function sendLoginEmail(env: Env, to: string, link: string): Promise<void> {
  const { messageId } = await env.EMAIL.send({
    from: { name: 'CardCap', email: env.SENDER_EMAIL },
    to,
    subject: 'Your CardCap sign-in link',
    text: `Sign in to CardCap:\n\n${link}\n\nThis link works once and expires in 15 minutes. If you did not request it, ignore this email.`,
    html: `<p>Sign in to CardCap:</p><p><a href="${link}">Open CardCap</a></p><p>This link works once and expires in 15 minutes. If you did not request it, ignore this email.</p>`,
  })
  console.info(JSON.stringify({ event: 'login_email_accepted', messageId }))
}
