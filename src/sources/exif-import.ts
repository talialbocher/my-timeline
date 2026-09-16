/**
 * Photo-file adapter. Reads capture time and GPS straight out of EXIF in the
 * browser, which is the one path that gives photos *and* location without any
 * API at all — the Photos Picker strips GPS before it ever reaches an app.
 *
 * Original files are never copied into the app; only a small thumbnail and the
 * metadata are kept.
 */
import exifr from 'exifr'
import type { PhotoEvent } from '../lib/model'
import { dayKey } from '../lib/time'
import { putBlob, putEvents } from '../lib/db'
import { approxOffsetFromLon } from './timeline-parse'

export const THUMB_PX = 320

export interface ExifProgress {
  phase: 'scanning' | 'saving' | 'done'
  processed: number
  total: number
  label: string
}

export interface ExifImportOptions {
  signal?: AbortSignal
  onProgress?: (p: ExifProgress) => void
}

interface ExifTags {
  DateTimeOriginal?: Date | string
  CreateDate?: Date | string
  OffsetTimeOriginal?: string
  latitude?: number
  longitude?: number
  ExifImageWidth?: number
  ExifImageHeight?: number
}

const IMAGE_RE = /\.(jpe?g|png|heic|heif|tiff?|webp|avif)$/i
const VIDEO_RE = /\.(mp4|mov|m4v|avi|3gp)$/i

export async function importPhotoFiles(
  files: File[],
  opts: ExifImportOptions = {},
): Promise<number> {
  const candidates = files.filter(
    (f) => IMAGE_RE.test(f.name) || VIDEO_RE.test(f.name),
  )
  const events: PhotoEvent[] = []
  let processed = 0

  for (const file of candidates) {
    opts.signal?.throwIfAborted()
    const event = await readOne(file)
    if (event) events.push(event)
    processed++
    if (processed % 10 === 0 || processed === candidates.length) {
      opts.onProgress?.({
        phase: 'scanning',
        processed,
        total: candidates.length,
        label: `Read ${processed} of ${candidates.length}`,
      })
    }
  }

  opts.onProgress?.({
    phase: 'saving',
    processed,
    total: candidates.length,
    label: 'Saving',
  })
  await putEvents(events)
  opts.onProgress?.({
    phase: 'done',
    processed: events.length,
    total: candidates.length,
    label: `Added ${events.length} photos`,
  })
  return events.length
}

async function readOne(file: File): Promise<PhotoEvent | null> {
  const isVideo = VIDEO_RE.test(file.name)
  let tags: ExifTags = {}
  if (!isVideo) {
    try {
      tags = ((await exifr.parse(file, {
        tiff: true,
        exif: true,
        gps: true,
        pick: [
          'DateTimeOriginal',
          'CreateDate',
          'OffsetTimeOriginal',
          'ExifImageWidth',
          'ExifImageHeight',
        ],
      })) ?? {}) as ExifTags
      const gps = await exifr.gps(file).catch(() => null)
      if (gps) {
        tags.latitude = gps.latitude
        tags.longitude = gps.longitude
      }
    } catch {
      /* Not every file carries readable EXIF; fall back to the file date. */
    }
  }

  const captured = toMs(tags.DateTimeOriginal ?? tags.CreateDate) ?? file.lastModified
  if (!Number.isFinite(captured)) return null

  const tzOffsetMin =
    parseExifOffset(tags.OffsetTimeOriginal) ??
    (tags.longitude != null ? approxOffsetFromLon(tags.longitude) : undefined)

  // Content-addressed enough that re-importing the same library updates rather
  // than duplicates, without hashing megabytes of pixels.
  const id = `exif:${file.name}:${file.size}:${captured}`
  const thumbKey = `photo:${id}`

  if (!isVideo) {
    const thumb = await makeThumbnail(file)
    if (thumb) await putBlob(thumbKey, thumb)
  }

  return {
    id,
    source: 'exif',
    kind: 'photo',
    start: captured,
    tzOffsetMin,
    day: dayKey(captured, tzOffsetMin),
    lat: tags.latitude,
    lon: tags.longitude,
    filename: file.name,
    isVideo,
    width: tags.ExifImageWidth,
    height: tags.ExifImageHeight,
    thumbKey,
  }
}

function toMs(value: Date | string | undefined): number | null {
  if (!value) return null
  if (value instanceof Date) return value.getTime()
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** EXIF writes offsets as "+09:00". */
function parseExifOffset(value?: string): number | undefined {
  if (!value) return undefined
  const m = value.match(/^([+-])(\d{2}):(\d{2})$/)
  if (!m) return undefined
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

async function makeThumbnail(file: File): Promise<Blob | null> {
  // Most camera JPEGs embed a thumbnail already — decoding a 48-megapixel
  // original just to shrink it would make importing a library unbearable.
  try {
    const embedded = await exifr.thumbnail(file)
    if (embedded) return new Blob([embedded as ArrayBuffer], { type: 'image/jpeg' })
  } catch {
    /* fall through to decoding */
  }

  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, THUMB_PX / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.8),
    )
  } catch {
    return null
  }
}
