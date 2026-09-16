/**
 * Google Photos adapter (live OAuth, Picker API).
 *
 * Since the March 2025 scope changes the Library API only returns media an app
 * itself created, so whole-library reads are gone. The Picker API is the
 * supported replacement: it opens Google's own picker, you choose what to let
 * in, and the app receives just those items. Picker metadata carries capture
 * time but Google strips GPS, so photos contribute *when*, not *where* — the
 * Timeline and EXIF adapters are what put you on the map.
 *
 * Thumbnails are downloaded and stored locally because picker base URLs expire
 * about an hour after the session.
 */
import { googleFetch, getAccessToken } from './google-auth'
import type { PhotoEvent } from '../lib/model'
import { dayKey } from '../lib/time'
import { putBlob, putEvents } from '../lib/db'

const API = 'https://photospicker.googleapis.com/v1'

export const THUMB_PX = 320

interface PickingSession {
  id: string
  pickerUri: string
  mediaItemsSet: boolean
  pollingConfig?: { pollInterval?: string; timeoutIn?: string }
}

interface PickedMediaItem {
  id: string
  createTime?: string
  type?: 'PHOTO' | 'VIDEO' | 'TYPE_UNSPECIFIED'
  mediaFile?: {
    baseUrl?: string
    mimeType?: string
    filename?: string
    mediaFileMetadata?: {
      width?: number
      height?: number
      videoMetadata?: unknown
    }
  }
}

export interface PickerProgress {
  phase: 'opening' | 'waiting' | 'importing' | 'done'
  fetched: number
  total: number
  label: string
}

export interface PickerOptions {
  signal?: AbortSignal
  onProgress?: (p: PickerProgress) => void
  /** Called with the picker URL so the UI can surface it if the popup is blocked. */
  onPickerUri?: (uri: string) => void
}

export async function importFromPhotosPicker(opts: PickerOptions = {}): Promise<number> {
  const { signal, onProgress, onPickerUri } = opts
  onProgress?.({ phase: 'opening', fetched: 0, total: 0, label: 'Opening Google Photos' })

  const createRes = await googleFetch('photosPicker', `${API}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal,
  })
  const session = (await createRes.json()) as PickingSession

  onPickerUri?.(session.pickerUri)
  // Opened from the click handler upstream where possible; this is the fallback.
  const popup = window.open(session.pickerUri, '_blank', 'noopener,noreferrer')
  if (!popup) {
    onProgress?.({
      phase: 'waiting',
      fetched: 0,
      total: 0,
      label: 'Popup blocked — use the picker link below',
    })
  }

  const ready = await pollUntilPicked(session, { signal, onProgress })
  if (!ready) {
    onProgress?.({ phase: 'done', fetched: 0, total: 0, label: 'Picker timed out' })
    return 0
  }

  const items = await listPickedItems(session.id, signal)
  onProgress?.({
    phase: 'importing',
    fetched: 0,
    total: items.length,
    label: `Importing ${items.length} items`,
  })

  const events: PhotoEvent[] = []
  let done = 0
  for (const item of items) {
    signal?.throwIfAborted()
    const ev = await importItem(item, signal)
    if (ev) events.push(ev)
    done++
    onProgress?.({
      phase: 'importing',
      fetched: done,
      total: items.length,
      label: `Importing ${done} of ${items.length}`,
    })
  }

  await putEvents(events)
  // The session holds a reference to your selection; drop it once imported.
  await deleteSession(session.id).catch(() => undefined)

  onProgress?.({
    phase: 'done',
    fetched: events.length,
    total: items.length,
    label: `Added ${events.length} photos`,
  })
  return events.length
}

async function pollUntilPicked(
  session: PickingSession,
  opts: PickerOptions,
): Promise<boolean> {
  const intervalMs = parseDuration(session.pollingConfig?.pollInterval) ?? 3000
  const timeoutMs = parseDuration(session.pollingConfig?.timeoutIn) ?? 10 * 60_000
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    opts.signal?.throwIfAborted()
    await sleep(intervalMs, opts.signal)
    const res = await googleFetch('photosPicker', `${API}/sessions/${session.id}`, {
      signal: opts.signal,
    })
    const current = (await res.json()) as PickingSession
    if (current.mediaItemsSet) return true
    opts.onProgress?.({
      phase: 'waiting',
      fetched: 0,
      total: 0,
      label: 'Waiting for you to finish picking…',
    })
  }
  return false
}

async function listPickedItems(
  sessionId: string,
  signal?: AbortSignal,
): Promise<PickedMediaItem[]> {
  const items: PickedMediaItem[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`${API}/mediaItems`)
    url.searchParams.set('sessionId', sessionId)
    url.searchParams.set('pageSize', '100')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await googleFetch('photosPicker', url.toString(), { signal })
    const body = (await res.json()) as {
      mediaItems?: PickedMediaItem[]
      nextPageToken?: string
    }
    items.push(...(body.mediaItems ?? []))
    pageToken = body.nextPageToken
  } while (pageToken)
  return items
}

async function importItem(
  item: PickedMediaItem,
  signal?: AbortSignal,
): Promise<PhotoEvent | null> {
  const createTime = item.createTime
  if (!createTime) return null
  const ms = Date.parse(createTime)
  if (!Number.isFinite(ms)) return null

  const isVideo =
    item.type === 'VIDEO' || Boolean(item.mediaFile?.mediaFileMetadata?.videoMetadata)
  const thumbKey = `photo:${item.id}`

  const baseUrl = item.mediaFile?.baseUrl
  if (baseUrl) {
    try {
      const token = await getAccessToken('photosPicker')
      // `=w..-h..` asks Google for a thumbnail; `-c` crops it square.
      const res = await fetch(`${baseUrl}=w${THUMB_PX}-h${THUMB_PX}-c`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      })
      if (res.ok) await putBlob(thumbKey, await res.blob())
    } catch {
      /* Thumbnail is a nicety; the event still belongs on the timeline. */
    }
  }

  // Picker metadata has no offset, so the capture instant files under the
  // viewing device's local day.
  return {
    id: `photos:${item.id}`,
    source: 'photos',
    kind: 'photo',
    start: ms,
    day: dayKey(ms),
    filename: item.mediaFile?.filename ?? 'photo',
    isVideo,
    width: item.mediaFile?.mediaFileMetadata?.width,
    height: item.mediaFile?.mediaFileMetadata?.height,
    thumbKey,
    remoteId: item.id,
  }
}

async function deleteSession(sessionId: string): Promise<void> {
  await googleFetch('photosPicker', `${API}/sessions/${sessionId}`, { method: 'DELETE' })
}

/** Protobuf durations arrive as "3.5s". */
function parseDuration(value?: string): number | null {
  if (!value) return null
  const m = value.match(/^([\d.]+)s$/)
  return m ? Math.round(Number(m[1]) * 1000) : null
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(id)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}
