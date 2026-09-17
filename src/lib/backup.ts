/**
 * Whole-archive backup, as a single `.timeline.zip`.
 *
 * This is how the timeline moves between devices when there is no server to
 * sync through — and on iOS it is the only way, because an installed
 * home-screen app cannot run the Google consent flow and does not share
 * storage with Safari. Ingest on a computer, export, drop the file into the
 * app on the phone.
 *
 * The archive is plain: `events.json` plus the photo thumbnails. Nothing is
 * encrypted, so treat the file as you would the photos themselves.
 */
import { Zip, ZipDeflate, ZipPassThrough, unzip } from 'fflate'
import type { TimelineEvent } from './model'
import { db, putEvents, recomputeDays } from './db'

const MANIFEST = 'events.json'
const BLOB_DIR = 'thumbnails/'
const FORMAT_VERSION = 1

export interface BackupProgress {
  phase: 'reading' | 'packing' | 'writing' | 'done'
  label: string
  fraction?: number
}

interface Manifest {
  format: number
  exportedAt: string
  events: TimelineEvent[]
}

export interface BackupOptions {
  includeThumbnails?: boolean
  onProgress?: (p: BackupProgress) => void
}

export async function exportBackup(opts: BackupOptions = {}): Promise<Blob> {
  const { includeThumbnails = true, onProgress } = opts
  const database = await db()

  onProgress?.({ phase: 'reading', label: 'Reading the archive' })
  const events = await database.getAll('events')

  const parts: Uint8Array[] = []
  const zip = new Zip()
  const finished = new Promise<void>((resolve, reject) => {
    zip.ondata = (err, chunk, final) => {
      if (err) return reject(err)
      if (chunk) parts.push(chunk)
      if (final) resolve()
    }
  })

  onProgress?.({ phase: 'packing', label: `Packing ${events.length} events` })
  const manifest: Manifest = {
    format: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    events,
  }
  // The manifest is JSON and compresses well; the thumbnails are already JPEG
  // and would only get bigger, so they are stored rather than deflated.
  const manifestEntry = new ZipDeflate(MANIFEST, { level: 6 })
  zip.add(manifestEntry)
  manifestEntry.push(new TextEncoder().encode(JSON.stringify(manifest)), true)

  if (includeThumbnails) {
    const keys = (await database.getAllKeys('blobs')) as string[]
    let done = 0
    for (const key of keys) {
      const row = await database.get('blobs', key)
      if (!row) continue
      const entry = new ZipPassThrough(BLOB_DIR + encodeURIComponent(key))
      zip.add(entry)
      entry.push(new Uint8Array(await row.blob.arrayBuffer()), true)
      done++
      if (done % 50 === 0 || done === keys.length) {
        onProgress?.({
          phase: 'packing',
          label: `Packing thumbnail ${done} of ${keys.length}`,
          fraction: keys.length ? done / keys.length : undefined,
        })
      }
    }
  }

  onProgress?.({ phase: 'writing', label: 'Writing the file' })
  zip.end()
  await finished

  const blob = new Blob(parts as BlobPart[], { type: 'application/zip' })
  onProgress?.({ phase: 'done', label: `${formatBytes(blob.size)} ready`, fraction: 1 })
  return blob
}

export interface RestoreResult {
  events: number
  thumbnails: number
}

export async function importBackup(
  file: File,
  opts: { onProgress?: (p: BackupProgress) => void } = {},
): Promise<RestoreResult> {
  const { onProgress } = opts
  onProgress?.({ phase: 'reading', label: `Reading ${file.name}` })

  const bytes = new Uint8Array(await file.arrayBuffer())
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(bytes, (err, data) => (err ? reject(err) : resolve(data)))
  })

  const manifestBytes = entries[MANIFEST]
  if (!manifestBytes) {
    throw new Error(`${file.name} is not a My Timeline backup — no ${MANIFEST} inside.`)
  }

  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest
  if (manifest.format !== FORMAT_VERSION) {
    throw new Error(
      `That backup is format ${manifest.format}; this version reads ${FORMAT_VERSION}.`,
    )
  }

  onProgress?.({ phase: 'packing', label: `Restoring ${manifest.events.length} events` })

  const database = await db()
  let thumbnails = 0
  for (const [name, data] of Object.entries(entries)) {
    if (!name.startsWith(BLOB_DIR)) continue
    const key = decodeURIComponent(name.slice(BLOB_DIR.length))
    await database.put('blobs', {
      key,
      blob: new Blob([data as BlobPart], { type: 'image/jpeg' }),
    })
    thumbnails++
  }

  // putEvents is keyed on id, so restoring over an existing archive merges
  // rather than duplicating, and refreshes the day rollups as it goes.
  await putEvents(manifest.events)
  await recomputeDays(new Set(manifest.events.map((e) => e.day)))

  onProgress?.({
    phase: 'done',
    label: `Restored ${manifest.events.length} events and ${thumbnails} thumbnails`,
    fraction: 1,
  })
  return { events: manifest.events.length, thumbnails }
}

/** Hand the file to the browser; on iOS this lands in Files. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoked on the next turn of the event loop, once the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function backupFilename(): string {
  return `my-timeline-${new Date().toISOString().slice(0, 10)}.timeline.zip`
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
