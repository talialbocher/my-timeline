/**
 * Location import from files. This is the only route to location history that
 * still exists: Google retired the Location History API and moved Timeline
 * on-device, so the data has to come from an export you hold.
 *
 * Accepts a phone Timeline export (.json), legacy Takeout files, or a whole
 * Takeout .zip, and never uploads any of it.
 */
import { unzip } from 'fflate'
import type { TimelineEvent } from '../lib/model'
import { putEvents } from '../lib/db'
import { peek, streamArrayItems } from '../lib/json-stream'
import {
  detectFormat,
  parseLatLng,
  parseSemanticSegments,
  parseTimelineObjects,
  segmentRawFixes,
  type RawFix,
  type TimelineFormat,
} from './timeline-parse'

export interface ImportProgress {
  phase: 'reading' | 'parsing' | 'saving' | 'done'
  label: string
  /** 0-1 where known, otherwise undefined for an indeterminate bar. */
  fraction?: number
}

export interface ImportResult {
  events: number
  days: number
  format: TimelineFormat
  file: string
}

export interface ImportOptions {
  signal?: AbortSignal
  onProgress?: (p: ImportProgress) => void
}

export async function importLocationFiles(
  files: File[],
  opts: ImportOptions = {},
): Promise<ImportResult[]> {
  const results: ImportResult[] = []
  for (const file of files) {
    opts.signal?.throwIfAborted()
    if (/\.zip$/i.test(file.name)) {
      results.push(...(await importZip(file, opts)))
    } else {
      const result = await importJsonFile(file, opts)
      if (result) results.push(result)
    }
  }
  opts.onProgress?.({ phase: 'done', label: summarize(results), fraction: 1 })
  return results
}

function summarize(results: ImportResult[]): string {
  const events = results.reduce((sum, r) => sum + r.events, 0)
  const days = results.reduce((sum, r) => sum + r.days, 0)
  if (events === 0) return 'No location data found in those files'
  return `Imported ${events.toLocaleString()} events across ${days.toLocaleString()} days`
}

async function importJsonFile(
  file: File,
  opts: ImportOptions,
): Promise<ImportResult | null> {
  const head = await peek(file)
  const format = detectFormat(head)
  opts.onProgress?.({ phase: 'reading', label: `Reading ${file.name}` })

  if (format === 'records') {
    return await importRecordsStreaming(file, opts)
  }

  if (format === 'unknown') {
    return { events: 0, days: 0, format, file: file.name }
  }

  opts.onProgress?.({ phase: 'parsing', label: `Parsing ${file.name}` })
  const root = JSON.parse(await file.text()) as unknown
  const events =
    format === 'semantic-segments'
      ? parseSemanticSegments(root)
      : parseTimelineObjects(root)

  opts.onProgress?.({ phase: 'saving', label: `Saving ${events.length} events` })
  const days = await putEvents(events)
  return { events: events.length, days, format, file: file.name }
}

/**
 * Records.json is processed a fix at a time so a multi-gigabyte file never
 * lands in memory, and segmented day by day so stay-detection stays local.
 */
async function importRecordsStreaming(
  file: File,
  opts: ImportOptions,
): Promise<ImportResult> {
  const fixes: RawFix[] = []
  let totalEvents = 0
  const touchedDays = new Set<string>()

  interface RecordRow {
    timestamp?: string
    timestampMs?: string
    latitudeE7?: number
    longitudeE7?: number
    accuracy?: number
  }

  const flushEvery = 200_000
  async function flush(): Promise<void> {
    if (fixes.length === 0) return
    const events: TimelineEvent[] = segmentRawFixes(fixes)
    totalEvents += events.length
    for (const e of events) touchedDays.add(e.day)
    await putEvents(events)
    fixes.length = 0
  }

  for await (const row of streamArrayItems<RecordRow>(
    file.stream(),
    'locations',
    (bytes) =>
      opts.onProgress?.({
        phase: 'parsing',
        label: `Reading ${file.name}`,
        fraction: file.size ? Math.min(0.99, bytes / file.size) : undefined,
      }),
  )) {
    opts.signal?.throwIfAborted()
    // A fix accurate to worse than 200 m tells you the city, not the place.
    if (row.accuracy != null && row.accuracy > 200) continue
    const point = parseLatLng(row)
    if (!point) continue
    const ms = row.timestamp ? Date.parse(row.timestamp) : Number(row.timestampMs)
    if (!Number.isFinite(ms)) continue
    fixes.push({ ms, point })

    // Flushing on a whole-batch boundary risks splitting a stay across two
    // batches; at 200k fixes that is one stay in years of data, and the cost
    // of holding everything in memory instead is the whole point of streaming.
    if (fixes.length >= flushEvery) await flush()
  }
  await flush()

  return {
    events: totalEvents,
    days: touchedDays.size,
    format: 'records',
    file: file.name,
  }
}

const LOCATION_PATH = /(location\s*history|semantic\s*location|timeline)/i

async function importZip(file: File, opts: ImportOptions): Promise<ImportResult[]> {
  opts.onProgress?.({ phase: 'reading', label: `Unpacking ${file.name}` })
  const buffer = new Uint8Array(await file.arrayBuffer())

  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(
      buffer,
      {
        filter: (f) =>
          /\.json$/i.test(f.name) && LOCATION_PATH.test(f.name) && f.size > 0,
      },
      (err, data) => (err ? reject(err) : resolve(data)),
    )
  })

  const names = Object.keys(entries).sort()
  const results: ImportResult[] = []
  let index = 0

  for (const name of names) {
    opts.signal?.throwIfAborted()
    index++
    opts.onProgress?.({
      phase: 'parsing',
      label: `${name.split('/').pop()} (${index}/${names.length})`,
      fraction: index / names.length,
    })
    const text = new TextDecoder().decode(entries[name])
    const format = detectFormat(text.slice(0, 4096))
    if (format === 'unknown') continue

    let events: TimelineEvent[] = []
    try {
      const root = JSON.parse(text) as unknown
      if (format === 'semantic-segments') events = parseSemanticSegments(root)
      else if (format === 'timeline-objects') events = parseTimelineObjects(root)
      else if (format === 'records') {
        const rows = (root as { locations?: Array<Record<string, unknown>> }).locations ?? []
        const fixes: RawFix[] = []
        for (const row of rows) {
          const point = parseLatLng(row)
          const ms = row.timestamp
            ? Date.parse(String(row.timestamp))
            : Number(row.timestampMs)
          if (point && Number.isFinite(ms)) fixes.push({ ms, point })
        }
        events = segmentRawFixes(fixes)
      }
    } catch {
      continue // A corrupt month shouldn't sink the rest of the archive.
    }

    const days = await putEvents(events)
    results.push({ events: events.length, days, format, file: name })
  }

  return results
}
