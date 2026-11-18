import type { DashboardActivity, ImportActivity } from '../shared/types'
import { CaptureError } from './capture'

export async function trackImport<T>(db: D1Database, userId: string, label: string,
  action: () => Promise<{ value: T; detail: string }>): Promise<T> {
  const id = crypto.randomUUID()
  await db.prepare("INSERT INTO import_activity (id, user_id, label, state, started_at) VALUES (?, ?, ?, 'processing', ?)")
    .bind(id, userId, label.slice(0, 255), new Date().toISOString()).run()
  const finish = (state: string, detail: string) => db.prepare('UPDATE import_activity SET state = ?, detail = ? WHERE id = ? AND user_id = ?')
    .bind(state, detail, id, userId).run()
  let result
  try {
    result = await action()
  } catch (error) {
    await finish('failed', error instanceof CaptureError ? error.message : 'Import failed. Check the source and try again.')
    throw error
  }
  await finish('complete', result.detail)
  return result.value
}

export async function readActivity(db: D1Database, userId: string): Promise<DashboardActivity> {
  const now = Date.now()
  const stale = new Date(now - 60 * 60 * 1000).toISOString()
  const day = new Date(now - 24 * 60 * 60 * 1000).toISOString()
  const [recent, counts] = await db.batch([
    db.prepare(`SELECT id, label, started_at AS startedAt,
      CASE WHEN state = 'processing' AND started_at < ?1 THEN 'failed' ELSE state END AS state,
      CASE WHEN state = 'processing' AND started_at < ?1 THEN 'Processing timed out. Try again.' ELSE detail END AS detail
      FROM import_activity WHERE user_id = ?2 ORDER BY started_at DESC, rowid DESC LIMIT 8`).bind(stale, userId),
    db.prepare(`SELECT COUNT(CASE WHEN state = 'processing' AND started_at >= ?1 THEN 1 END) AS processing,
      COUNT(CASE WHEN state = 'failed' OR (state = 'processing' AND started_at < ?1) THEN 1 END) AS errors
      FROM import_activity WHERE user_id = ?2 AND started_at >= ?3`).bind(stale, userId, day),
  ])
  return { recent: recent.results as ImportActivity[], ...counts.results[0] as { processing: number; errors: number } }
}
