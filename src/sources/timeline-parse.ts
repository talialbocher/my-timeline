/**
 * Parsers for every Google location export format still in circulation.
 *
 * Three exist and they are mutually incompatible:
 *  1. On-device Timeline export (2024+): `{ semanticSegments: [...] }`, or a
 *     bare array on iOS. This is the only format still being produced.
 *  2. Legacy Takeout "Semantic Location History": `{ timelineObjects: [...] }`,
 *     one file per month.
 *  3. Legacy Takeout "Records.json": `{ locations: [...] }` — raw GPS fixes,
 *     routinely a gigabyte over ten years, so it is streamed, not parsed whole.
 */
import type { MoveEvent, TimelineEvent, TravelMode, VisitEvent } from '../lib/model'
import { dayKey } from '../lib/time'
import { haversineKm, inferMode, pathLengthKm, simplifyPath, type LatLon } from '../lib/geo'

export type TimelineFormat = 'semantic-segments' | 'timeline-objects' | 'records' | 'unknown'

export function detectFormat(head: string): TimelineFormat {
  if (/"semanticSegments"\s*:/.test(head)) return 'semantic-segments'
  if (/"timelineObjects"\s*:/.test(head)) return 'timeline-objects'
  if (/"locations"\s*:/.test(head)) return 'records'
  // iOS writes a bare array of segments with no wrapper object.
  if (/^\s*\[/.test(head) && /"(startTime|visit|activity|timelinePath)"/.test(head)) {
    return 'semantic-segments'
  }
  return 'unknown'
}

/* ------------------------------------------------------------------ */
/* Shared coordinate handling                                          */
/* ------------------------------------------------------------------ */

/**
 * Google writes coordinates four different ways depending on the export:
 * "40.7128°, -74.0060°", "geo:40.7128,-74.0060", plain "40.7,-74.0", or the
 * E7 integer pair used throughout the legacy formats.
 */
export function parseLatLng(value: unknown): LatLon | null {
  if (typeof value === 'string') {
    const cleaned = value.replace(/^geo:/i, '').replace(/°/g, '')
    const parts = cleaned.split(',').map((p) => Number(p.trim()))
    if (parts.length === 2 && parts.every(Number.isFinite)) {
      return validate([parts[0], parts[1]])
    }
    return null
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.latLng === 'string') return parseLatLng(o.latLng)
    const e7 = pickE7(o)
    if (e7) return e7
    const lat = numeric(o.latitude ?? o.lat)
    const lon = numeric(o.longitude ?? o.lng ?? o.lon)
    if (lat != null && lon != null) return validate([lat, lon])
  }
  return null
}

function pickE7(o: Record<string, unknown>): LatLon | null {
  const lat = numeric(o.latitudeE7 ?? o.latE7)
  const lon = numeric(o.longitudeE7 ?? o.lngE7 ?? o.lonE7)
  if (lat == null || lon == null) return null
  return validate([lat / 1e7, lon / 1e7])
}

function numeric(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function validate(p: LatLon): LatLon | null {
  const [lat, lon] = p
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  if (lat === 0 && lon === 0) return null // Null Island is a parse failure, not a place.
  return p
}

/** Minutes east of UTC from an ISO string that carries an offset. */
export function offsetFromIso(iso: string): number | undefined {
  const m = iso.match(/([+-])(\d{2}):?(\d{2})$/)
  if (!m) return undefined
  const sign = m[1] === '-' ? -1 : 1
  return sign * (Number(m[2]) * 60 + Number(m[3]))
}

/**
 * Longitude-derived offset, used only when the export omits one. It is wrong
 * near some borders, but it is far better than filing a dinner in Tokyo under
 * the previous day because the viewer happens to be in New York.
 */
export function approxOffsetFromLon(lon: number): number {
  return Math.round(lon / 15) * 60
}

function offsetFor(iso: string | undefined, point: LatLon | null): number | undefined {
  if (iso) {
    const exact = offsetFromIso(iso)
    if (exact != null) return exact
  }
  return point ? approxOffsetFromLon(point[1]) : undefined
}

function timeOf(value: unknown): number | null {
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === 'number') return value
  return null
}

const MODE_MAP: Record<string, TravelMode> = {
  walking: 'walking', on_foot: 'walking', running: 'walking', hiking: 'walking',
  cycling: 'cycling', on_bicycle: 'cycling',
  in_passenger_vehicle: 'driving', driving: 'driving', in_vehicle: 'driving',
  motorcycling: 'driving', in_taxi: 'driving', in_bus: 'transit',
  in_train: 'transit', in_subway: 'transit', in_tram: 'transit', in_ferry: 'transit',
  flying: 'flying', in_flight: 'flying',
}

function normalizeMode(raw: unknown, distanceKm: number, durationMs: number): TravelMode {
  if (typeof raw === 'string') {
    const hit = MODE_MAP[raw.toLowerCase()]
    if (hit) return hit
  }
  return inferMode(distanceKm, durationMs)
}

/* ------------------------------------------------------------------ */
/* Format 1: on-device Timeline export                                 */
/* ------------------------------------------------------------------ */

interface SemanticSegment {
  startTime?: string
  endTime?: string
  visit?: {
    probability?: number
    topCandidate?: {
      placeId?: string
      semanticType?: string
      probability?: number
      placeLocation?: unknown
    }
  }
  activity?: {
    start?: unknown
    end?: unknown
    distanceMeters?: string | number
    topCandidate?: { type?: string; probability?: number }
  }
  timelinePath?: Array<{ point?: unknown; durationMinutesOffsetFromStartTime?: string | number }>
}

export function parseSemanticSegments(root: unknown): TimelineEvent[] {
  const segments: SemanticSegment[] = Array.isArray(root)
    ? (root as SemanticSegment[])
    : ((root as { semanticSegments?: SemanticSegment[] })?.semanticSegments ?? [])

  const events: TimelineEvent[] = []
  for (const seg of segments) {
    const start = timeOf(seg.startTime)
    if (start == null) continue
    const end = timeOf(seg.endTime) ?? undefined

    if (seg.visit?.topCandidate) {
      const cand = seg.visit.topCandidate
      const point = parseLatLng(cand.placeLocation)
      if (!point) continue
      const tzOffsetMin = offsetFor(seg.startTime, point)
      // The on-device export gives a semantic type ("Home", "Work") but no
      // place name; it is still a better label than raw coordinates.
      const place = prettySemanticType(cand.semanticType) ?? 'Unnamed place'
      events.push({
        id: `timeline:visit:${start}`,
        source: 'timeline',
        kind: 'visit',
        start,
        end,
        tzOffsetMin,
        day: dayKey(start, tzOffsetMin),
        lat: point[0],
        lon: point[1],
        place,
        placeId: cand.placeId,
        nameIsCategory: true,
        confidence: cand.probability ?? seg.visit.probability,
      } satisfies VisitEvent)
      continue
    }

    if (seg.activity) {
      const from = parseLatLng(seg.activity.start)
      const to = parseLatLng(seg.activity.end)
      if (!from || !to) continue
      const meters = numeric(seg.activity.distanceMeters)
      const distanceKm = meters != null ? meters / 1000 : haversineKm(from, to)
      const duration = (end ?? start) - start
      const tzOffsetMin = offsetFor(seg.startTime, from)
      events.push({
        id: `timeline:move:${start}`,
        source: 'timeline',
        kind: 'move',
        start,
        end,
        tzOffsetMin,
        day: dayKey(start, tzOffsetMin),
        lat: from[0],
        lon: from[1],
        mode: normalizeMode(seg.activity.topCandidate?.type, distanceKm, duration),
        distanceKm,
        path: [from, to],
      } satisfies MoveEvent)
      continue
    }

    if (seg.timelinePath?.length) {
      const path: LatLon[] = []
      for (const node of seg.timelinePath) {
        const p = parseLatLng(node.point)
        if (p) path.push(p)
      }
      if (path.length < 2) continue
      const simplified = simplifyPath(path)
      const distanceKm = pathLengthKm(path)
      const duration = (end ?? start) - start
      const tzOffsetMin = offsetFor(seg.startTime, path[0])
      events.push({
        id: `timeline:path:${start}`,
        source: 'timeline',
        kind: 'move',
        start,
        end,
        tzOffsetMin,
        day: dayKey(start, tzOffsetMin),
        lat: path[0][0],
        lon: path[0][1],
        mode: inferMode(distanceKm, duration),
        distanceKm,
        path: simplified,
      } satisfies MoveEvent)
    }
  }
  return events
}

function prettySemanticType(type?: string): string | undefined {
  if (!type) return undefined
  const cleaned = type.replace(/^TYPE_/, '').replace(/_/g, ' ').toLowerCase()
  if (!cleaned || cleaned === 'unknown' || cleaned === 'unspecified') return undefined
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase())
}

/* ------------------------------------------------------------------ */
/* Format 2: legacy Semantic Location History                          */
/* ------------------------------------------------------------------ */

interface TimelineObject {
  placeVisit?: {
    location?: { name?: string; address?: string; placeId?: string; latitudeE7?: number; longitudeE7?: number }
    duration?: { startTimestamp?: string; endTimestamp?: string; startTimestampMs?: string; endTimestampMs?: string }
    visitConfidence?: number
  }
  activitySegment?: {
    startLocation?: unknown
    endLocation?: unknown
    duration?: { startTimestamp?: string; endTimestamp?: string; startTimestampMs?: string; endTimestampMs?: string }
    distance?: number
    activityType?: string
    waypointPath?: { waypoints?: Array<{ latE7?: number; lngE7?: number }> }
    simplifiedRawPath?: { points?: Array<{ latE7?: number; lngE7?: number }> }
  }
}

function legacyDuration(d?: {
  startTimestamp?: string
  endTimestamp?: string
  startTimestampMs?: string
  endTimestampMs?: string
}): { start: number; end?: number } | null {
  if (!d) return null
  const start = timeOf(d.startTimestamp) ?? numeric(d.startTimestampMs)
  if (start == null) return null
  const end = timeOf(d.endTimestamp) ?? numeric(d.endTimestampMs) ?? undefined
  return { start, end: end ?? undefined }
}

export function parseTimelineObjects(root: unknown): TimelineEvent[] {
  const objects: TimelineObject[] =
    (root as { timelineObjects?: TimelineObject[] })?.timelineObjects ?? []
  const events: TimelineEvent[] = []

  for (const obj of objects) {
    if (obj.placeVisit) {
      const v = obj.placeVisit
      const when = legacyDuration(v.duration)
      const point = parseLatLng(v.location)
      if (!when || !point) continue
      const tzOffsetMin = approxOffsetFromLon(point[1])
      events.push({
        id: `timeline:visit:${when.start}`,
        source: 'timeline',
        kind: 'visit',
        start: when.start,
        end: when.end,
        tzOffsetMin,
        day: dayKey(when.start, tzOffsetMin),
        lat: point[0],
        lon: point[1],
        place: v.location?.name ?? 'Unnamed place',
        nameIsCategory: !v.location?.name,
        address: v.location?.address,
        placeId: v.location?.placeId,
        confidence: v.visitConfidence != null ? v.visitConfidence / 100 : undefined,
      } satisfies VisitEvent)
      continue
    }

    if (obj.activitySegment) {
      const a = obj.activitySegment
      const when = legacyDuration(a.duration)
      const from = parseLatLng(a.startLocation)
      const to = parseLatLng(a.endLocation)
      if (!when || !from || !to) continue

      const raw = a.simplifiedRawPath?.points ?? a.waypointPath?.waypoints ?? []
      const path: LatLon[] = [from]
      for (const node of raw) {
        const p = parseLatLng(node)
        if (p) path.push(p)
      }
      path.push(to)

      const distanceKm = a.distance != null ? a.distance / 1000 : pathLengthKm(path)
      const duration = (when.end ?? when.start) - when.start
      const tzOffsetMin = approxOffsetFromLon(from[1])
      events.push({
        id: `timeline:move:${when.start}`,
        source: 'timeline',
        kind: 'move',
        start: when.start,
        end: when.end,
        tzOffsetMin,
        day: dayKey(when.start, tzOffsetMin),
        lat: from[0],
        lon: from[1],
        mode: normalizeMode(a.activityType, distanceKm, duration),
        distanceKm,
        path: simplifyPath(path),
      } satisfies MoveEvent)
    }
  }
  return events
}

/* ------------------------------------------------------------------ */
/* Format 3: raw Records.json                                          */
/* ------------------------------------------------------------------ */

export interface RawFix {
  ms: number
  point: LatLon
}

/**
 * Turn a stream of raw GPS fixes into visits and moves.
 *
 * A "stay" is a run of consecutive fixes that never wanders more than
 * `radiusKm` from the run's anchor and lasts at least `minStayMs`. Everything
 * between two stays is a move. This is the same shape Google's own semantic
 * pass produces, minus the place names it gets from Maps.
 */
export function segmentRawFixes(
  fixes: RawFix[],
  { radiusKm = 0.12, minStayMs = 10 * 60_000 } = {},
): TimelineEvent[] {
  const sorted = fixes.slice().sort((a, b) => a.ms - b.ms)
  const events: TimelineEvent[] = []
  if (sorted.length === 0) return events

  interface Stay { startIdx: number; endIdx: number; anchor: LatLon }
  const stays: Stay[] = []

  let i = 0
  while (i < sorted.length) {
    const anchor = sorted[i].point
    let j = i + 1
    while (j < sorted.length && haversineKm(anchor, sorted[j].point) <= radiusKm) j++
    const durationMs = sorted[j - 1].ms - sorted[i].ms
    if (durationMs >= minStayMs && j - i >= 2) {
      stays.push({ startIdx: i, endIdx: j - 1, anchor })
      i = j
    } else {
      i++
    }
  }

  for (const stay of stays) {
    const start = sorted[stay.startIdx].ms
    const end = sorted[stay.endIdx].ms
    const tzOffsetMin = approxOffsetFromLon(stay.anchor[1])
    events.push({
      id: `timeline:visit:${start}`,
      source: 'timeline',
      kind: 'visit',
      start,
      end,
      tzOffsetMin,
      day: dayKey(start, tzOffsetMin),
      lat: stay.anchor[0],
      lon: stay.anchor[1],
      // Records.json has no place names at all — only Maps could supply them,
      // and asking Maps would mean sending your coordinates off the device.
      place: 'Unnamed place',
      nameIsCategory: true,
      confidence: 0.5,
    } satisfies VisitEvent)
  }

  for (let k = 1; k < stays.length; k++) {
    const fromIdx = stays[k - 1].endIdx
    const toIdx = stays[k].startIdx
    if (toIdx <= fromIdx + 1) continue
    const leg = sorted.slice(fromIdx, toIdx + 1)
    const path = leg.map((f) => f.point)
    const distanceKm = pathLengthKm(path)
    // Sub-100m wobble between two readings of the same place is not a journey.
    if (distanceKm < 0.1) continue
    const start = leg[0].ms
    const end = leg[leg.length - 1].ms
    const tzOffsetMin = approxOffsetFromLon(path[0][1])
    events.push({
      id: `timeline:move:${start}`,
      source: 'timeline',
      kind: 'move',
      start,
      end,
      tzOffsetMin,
      day: dayKey(start, tzOffsetMin),
      lat: path[0][0],
      lon: path[0][1],
      mode: inferMode(distanceKm, end - start),
      distanceKm,
      path: simplifyPath(path),
    } satisfies MoveEvent)
  }

  return events
}
