/**
 * Gmail adapter (live OAuth).
 *
 * Only header metadata is requested — From, To, Subject, Date — never message
 * bodies. Ten years of mail is far too much to show verbatim, so by default we
 * skip the bulk categories (promotions, social, updates, forums) and keep
 * actual correspondence, which is what reads as "what I did that day".
 */
import { googleFetch } from './google-auth'
import type { MessageEvent } from '../lib/model'
import { dayKey } from '../lib/time'
import { putEvents } from '../lib/db'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

export interface SyncProgress {
  phase: 'listing' | 'fetching' | 'saving' | 'done'
  fetched: number
  total: number
  label: string
}

export interface GmailSyncOptions {
  /** Inclusive 'YYYY-MM-DD'. */
  after: string
  /** Exclusive 'YYYY-MM-DD'. */
  before: string
  /** Keep bulk mail (promotions/social/updates/forums) instead of dropping it. */
  includeBulk?: boolean
  /** Hard ceiling so a decade-wide sync can't run unbounded. */
  maxMessages?: number
  signal?: AbortSignal
  onProgress?: (p: SyncProgress) => void
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>
  nextPageToken?: string
  resultSizeEstimate?: number
}

interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  internalDate?: string
  snippet?: string
  payload?: { headers?: Array<{ name: string; value: string }> }
}

function buildQuery(opts: GmailSyncOptions): string {
  const parts = [`after:${opts.after.replace(/-/g, '/')}`, `before:${opts.before.replace(/-/g, '/')}`]
  if (!opts.includeBulk) {
    parts.push('-category:promotions', '-category:social', '-category:updates', '-category:forums')
  }
  // Drafts and spam are noise in a life timeline.
  parts.push('-in:spam', '-in:drafts')
  return parts.join(' ')
}

export async function syncGmail(opts: GmailSyncOptions): Promise<number> {
  const { signal, onProgress, maxMessages = 5000 } = opts
  const query = buildQuery(opts)
  const ids: Array<{ id: string; threadId: string }> = []
  let pageToken: string | undefined

  do {
    signal?.throwIfAborted()
    const url = new URL(`${API}/messages`)
    url.searchParams.set('q', query)
    url.searchParams.set('maxResults', '500')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await googleFetch('gmail', url.toString(), { signal })
    const body = (await res.json()) as GmailListResponse
    for (const m of body.messages ?? []) {
      if (ids.length >= maxMessages) break
      ids.push(m)
    }
    pageToken = ids.length >= maxMessages ? undefined : body.nextPageToken
    onProgress?.({
      phase: 'listing',
      fetched: ids.length,
      total: ids.length,
      label: `Found ${ids.length} messages`,
    })
  } while (pageToken)

  if (ids.length === 0) {
    onProgress?.({ phase: 'done', fetched: 0, total: 0, label: 'No mail in this range' })
    return 0
  }

  const events: MessageEvent[] = []
  let done = 0
  const CONCURRENCY = 12

  // A hand-rolled pool beats Promise.all over 5000 requests: it keeps the
  // browser's connection limit busy without queueing thousands of fetches.
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < ids.length) {
      signal?.throwIfAborted()
      const mine = ids[cursor++]
      try {
        const msg = await fetchMessage(mine.id, signal)
        const ev = toEvent(msg)
        if (ev) events.push(ev)
      } catch (err) {
        // One unreadable message shouldn't abort a decade-long sync.
        if ((err as Error).name === 'AbortError') throw err
      }
      done++
      if (done % 25 === 0 || done === ids.length) {
        onProgress?.({
          phase: 'fetching',
          fetched: done,
          total: ids.length,
          label: `Reading message ${done} of ${ids.length}`,
        })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker))

  onProgress?.({ phase: 'saving', fetched: done, total: ids.length, label: 'Saving' })
  await putEvents(events)
  onProgress?.({
    phase: 'done',
    fetched: events.length,
    total: ids.length,
    label: `Added ${events.length} messages`,
  })
  return events.length
}

async function fetchMessage(id: string, signal?: AbortSignal): Promise<GmailMessage> {
  const url = new URL(`${API}/messages/${id}`)
  url.searchParams.set('format', 'metadata')
  for (const h of ['From', 'To', 'Subject', 'Date']) {
    url.searchParams.append('metadataHeaders', h)
  }
  const res = await googleFetch('gmail', url.toString(), { signal })
  return (await res.json()) as GmailMessage
}

function header(msg: GmailMessage, name: string): string {
  const hit = msg.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  )
  return hit?.value ?? ''
}

/** "Talia Albocher <t@example.com>" -> "Talia Albocher"; bare addresses pass through. */
function displayName(addressList: string): string {
  const first = addressList.split(',')[0]?.trim() ?? ''
  const named = first.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (named) {
    const name = named[1].trim()
    return name || named[2]
  }
  return first
}

function toEvent(msg: GmailMessage): MessageEvent | null {
  const ms = Number(msg.internalDate)
  if (!Number.isFinite(ms) || ms <= 0) return null
  const sent = msg.labelIds?.includes('SENT') ?? false
  const counterparty = displayName(header(msg, sent ? 'To' : 'From'))
  // Gmail's internalDate is UTC; the Date header carries the offset the message
  // was actually written at, which is the one that belongs on the timeline.
  const tzOffsetMin = offsetFromDateHeader(header(msg, 'Date'))
  return {
    id: `gmail:${msg.id}`,
    source: 'gmail',
    kind: 'message',
    start: ms,
    tzOffsetMin,
    day: dayKey(ms, tzOffsetMin),
    subject: header(msg, 'Subject') || '(no subject)',
    counterparty: counterparty || 'unknown',
    direction: sent ? 'sent' : 'received',
    threadId: msg.threadId,
    snippet: msg.snippet,
  }
}

function offsetFromDateHeader(value: string): number | undefined {
  const m = value.match(/([+-])(\d{2})(\d{2})\s*$/)
  if (!m) return undefined
  const sign = m[1] === '-' ? -1 : 1
  return sign * (Number(m[2]) * 60 + Number(m[3]))
}
