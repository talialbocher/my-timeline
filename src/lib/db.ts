/**
 * Local store. Everything the app knows lives here, in IndexedDB on the
 * device. No data is ever sent anywhere: the only network calls this app makes
 * are the ones you authorize to Google's own APIs to read your data in.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { DaySummary, SourceId, TimelineEvent } from './model'
import { dayKey } from './time'
import { centroid, type LatLon } from './geo'

interface TimelineDB extends DBSchema {
  events: {
    key: string
    value: TimelineEvent
    indexes: { 'by-day': string; 'by-start': number }
  }
  days: {
    key: string
    value: DaySummary
  }
  blobs: {
    key: string
    value: { key: string; blob: Blob }
  }
  meta: {
    key: string
    value: { key: string; value: unknown }
  }
}

let dbPromise: Promise<IDBPDatabase<TimelineDB>> | null = null

export function db(): Promise<IDBPDatabase<TimelineDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TimelineDB>('my-timeline', 1, {
      upgrade(database) {
        const events = database.createObjectStore('events', { keyPath: 'id' })
        events.createIndex('by-day', 'day')
        events.createIndex('by-start', 'start')
        database.createObjectStore('days', { keyPath: 'day' })
        database.createObjectStore('blobs', { keyPath: 'key' })
        database.createObjectStore('meta', { keyPath: 'key' })
      },
    })
  }
  return dbPromise
}

/**
 * Write events and refresh the affected day rollups. Idempotent on id, so
 * re-running a sync overwrites rather than duplicates.
 */
export async function putEvents(events: TimelineEvent[]): Promise<number> {
  if (events.length === 0) return 0
  const database = await db()
  const touchedDays = new Set<string>()

  const tx = database.transaction('events', 'readwrite')
  await Promise.all([
    ...events.map((e) => {
      touchedDays.add(e.day)
      return tx.store.put(e)
    }),
    tx.done,
  ])

  await recomputeDays(touchedDays)
  return touchedDays.size
}

export async function recomputeDays(days: Iterable<string>): Promise<void> {
  const database = await db()
  for (const day of days) {
    const events = await database.getAllFromIndex('events', 'by-day', day)
    const summary = summarize(day, events)
    if (summary) await database.put('days', summary)
    else await database.delete('days', day)
  }
}

function summarize(day: string, events: TimelineEvent[]): DaySummary | null {
  if (events.length === 0) return null
  const sources = new Set<SourceId>()
  const points: LatLon[] = []
  let photoCount = 0
  let videoCount = 0
  let messageCount = 0
  let distanceKm = 0
  const places: Array<{ name: string; ms: number; category: boolean }> = []

  for (const e of events) {
    sources.add(e.source)
    if (e.lat != null && e.lon != null) points.push([e.lat, e.lon])
    switch (e.kind) {
      case 'photo':
        if (e.isVideo) videoCount++
        else photoCount++
        break
      case 'message':
        messageCount++
        break
      case 'move':
        distanceKm += e.distanceKm
        break
      case 'visit':
        places.push({
          name: e.place,
          ms: (e.end ?? e.start) - e.start,
          category: e.nameIsCategory ?? false,
        })
        break
    }
  }

  // The day's headline is the place you gave the most time to, ignoring the
  // one you almost certainly slept at if there is anything else to say.
  places.sort((a, b) => b.ms - a.ms)
  const headline = pickHeadline(places)
  const c = centroid(points)

  return {
    day,
    photoCount,
    videoCount,
    messageCount,
    placeCount: places.length,
    distanceKm,
    lat: c?.[0],
    lon: c?.[1],
    headline,
    sources: [...sources],
  }
}

function pickHeadline(
  places: Array<{ name: string; ms: number; category: boolean }>,
): string | undefined {
  if (places.length === 0) return undefined
  const homeish = /\b(home|house|apartment|apt)\b/i
  const notHome = places.filter((p) => !homeish.test(p.name))
  // A proper place name beats a bare category, and both beat "Home".
  const named = notHome.find((p) => !p.category && p.name !== 'Unnamed place')
  return (named ?? notHome[0] ?? places[0]).name
}

export async function getDay(day: string): Promise<TimelineEvent[]> {
  const database = await db()
  const events = await database.getAllFromIndex('events', 'by-day', day)
  return events.sort((a, b) => a.start - b.start)
}

export async function getDaySummaries(): Promise<Map<string, DaySummary>> {
  const database = await db()
  const all = await database.getAll('days')
  return new Map(all.map((d) => [d.day, d]))
}

/** Oldest and newest days that have any content, for bounding navigation. */
export async function getRange(): Promise<{ first: string; last: string } | null> {
  const database = await db()
  const tx = database.transaction('events')
  const idx = tx.store.index('by-start')
  const firstCur = await idx.openCursor(null, 'next')
  const lastCur = await idx.openCursor(null, 'prev')
  if (!firstCur || !lastCur) return null
  const first = dayKey(firstCur.value.start, firstCur.value.tzOffsetMin)
  const last = dayKey(lastCur.value.start, lastCur.value.tzOffsetMin)
  await tx.done
  return { first, last }
}

export async function putBlob(key: string, blob: Blob): Promise<void> {
  const database = await db()
  await database.put('blobs', { key, blob })
}

export async function getBlob(key: string): Promise<Blob | undefined> {
  const database = await db()
  return (await database.get('blobs', key))?.blob
}

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const database = await db()
  const row = await database.get('meta', key)
  return row ? (row.value as T) : fallback
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const database = await db()
  await database.put('meta', { key, value })
}

export interface StoreStats {
  events: number
  days: number
  photos: number
  bySource: Record<string, number>
  estimatedBytes?: number
  quotaBytes?: number
}

export async function stats(): Promise<StoreStats> {
  const database = await db()
  const all = await database.getAll('events')
  const bySource: Record<string, number> = {}
  let photos = 0
  for (const e of all) {
    bySource[e.source] = (bySource[e.source] ?? 0) + 1
    if (e.kind === 'photo') photos++
  }
  const result: StoreStats = {
    events: all.length,
    days: await database.count('days'),
    photos,
    bySource,
  }
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate()
    result.estimatedBytes = est.usage
    result.quotaBytes = est.quota
  }
  return result
}

/** Remove everything a single source contributed, leaving other sources intact. */
export async function clearSource(source: SourceId): Promise<void> {
  const database = await db()
  const all = await database.getAll('events')
  const doomed = all.filter((e) => e.source === source)
  const days = new Set(doomed.map((e) => e.day))
  const tx = database.transaction(['events', 'blobs'], 'readwrite')
  for (const e of doomed) {
    tx.objectStore('events').delete(e.id)
    if (e.kind === 'photo' && e.thumbKey) tx.objectStore('blobs').delete(e.thumbKey)
  }
  await tx.done
  await recomputeDays(days)
}

export async function clearAll(): Promise<void> {
  const database = await db()
  const tx = database.transaction(['events', 'days', 'blobs'], 'readwrite')
  await Promise.all([
    tx.objectStore('events').clear(),
    tx.objectStore('days').clear(),
    tx.objectStore('blobs').clear(),
    tx.done,
  ])
}
