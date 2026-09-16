/**
 * One normalized event shape for every source. Adapters (Gmail, Photos Picker,
 * Timeline export, EXIF) all reduce to this, so the UI never knows or cares
 * where a day's contents came from.
 */

export type SourceId = 'timeline' | 'photos' | 'gmail' | 'exif'

export const SOURCE_LABELS: Record<SourceId, string> = {
  timeline: 'Location Timeline',
  photos: 'Google Photos',
  gmail: 'Gmail',
  exif: 'Photo files',
}

export type TravelMode =
  | 'walking' | 'cycling' | 'driving' | 'transit' | 'flying' | 'unknown'

interface EventBase {
  id: string
  source: SourceId
  /** Epoch ms. */
  start: number
  /** Epoch ms. Absent for instantaneous events. */
  end?: number
  /**
   * Minutes east of UTC at the moment the event happened. Preserved from the
   * source when it knows, so a photo taken at 9pm in Tokyo files under the
   * Tokyo day rather than the day it was back home.
   */
  tzOffsetMin?: number
  /** 'YYYY-MM-DD' in the event's own local time. Denormalized for indexing. */
  day: string
  lat?: number
  lon?: number
}

export interface VisitEvent extends EventBase {
  kind: 'visit'
  /** Human name of the place, e.g. "Prospect Park". */
  place: string
  address?: string
  /** Google place identifier, when the source supplied one. */
  placeId?: string
  /**
   * True when `place` is a category ("Restaurant", "Park") rather than a
   * proper name. The on-device Timeline export carries only categories, so a
   * headline must not read "Flew to Restaurant".
   */
  nameIsCategory?: boolean
  /** 0-1 confidence the source assigned to this being a real stop. */
  confidence?: number
}

export interface MoveEvent extends EventBase {
  kind: 'move'
  mode: TravelMode
  distanceKm: number
  /** Decoded [lat, lon] path points, decimated for display. */
  path: Array<[number, number]>
  fromPlace?: string
  toPlace?: string
}

export interface PhotoEvent extends EventBase {
  kind: 'photo'
  filename: string
  isVideo: boolean
  width?: number
  height?: number
  /** Key into the blob store for the locally generated thumbnail. */
  thumbKey?: string
  /**
   * Google Photos media id. Photos Picker base URLs expire after ~60 minutes,
   * so we never persist them; we persist the id and a local thumbnail.
   */
  remoteId?: string
}

export interface MessageEvent extends EventBase {
  kind: 'message'
  subject: string
  /** Display name where available, otherwise the bare address. */
  counterparty: string
  direction: 'sent' | 'received'
  threadId?: string
  snippet?: string
}

export type TimelineEvent = VisitEvent | MoveEvent | PhotoEvent | MessageEvent

export type EventKind = TimelineEvent['kind']

/** Per-day rollup, maintained on ingest so the year grid never scans events. */
export interface DaySummary {
  day: string
  photoCount: number
  videoCount: number
  messageCount: number
  placeCount: number
  distanceKm: number
  /** Centroid of the day's known positions, for the year map. */
  lat?: number
  lon?: number
  /** Most significant place name of the day, used as the day's headline. */
  headline?: string
  sources: SourceId[]
}

export function isPhoto(e: TimelineEvent): e is PhotoEvent {
  return e.kind === 'photo'
}
export function isVisit(e: TimelineEvent): e is VisitEvent {
  return e.kind === 'visit'
}
export function isMove(e: TimelineEvent): e is MoveEvent {
  return e.kind === 'move'
}
export function isMessage(e: TimelineEvent): e is MessageEvent {
  return e.kind === 'message'
}
