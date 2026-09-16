/**
 * Day-key handling. A timeline that spans ten years of travel has to decide
 * what "day" means: we use the local day where the event happened, falling
 * back to the viewing device's zone when a source gives us no offset.
 */

const MS_PER_DAY = 86_400_000

/** 'YYYY-MM-DD' for an instant, in the offset it happened at. */
export function dayKey(ms: number, tzOffsetMin?: number): string {
  const offset = tzOffsetMin ?? -new Date(ms).getTimezoneOffset()
  const shifted = new Date(ms + offset * 60_000)
  return shifted.toISOString().slice(0, 10)
}

/** Midnight UTC of a day key, used purely as a sortable/steppable anchor. */
export function dayKeyToAnchor(day: string): number {
  return Date.parse(day + 'T00:00:00Z')
}

export function anchorToDayKey(anchor: number): string {
  return new Date(anchor).toISOString().slice(0, 10)
}

export function addDays(day: string, delta: number): string {
  return anchorToDayKey(dayKeyToAnchor(day) + delta * MS_PER_DAY)
}

export function daysBetween(a: string, b: string): number {
  return Math.round((dayKeyToAnchor(b) - dayKeyToAnchor(a)) / MS_PER_DAY)
}

export function todayKey(): string {
  return dayKey(Date.now())
}

/** Clock time in the event's own zone, e.g. "9:41 PM". */
export function clockTime(ms: number, tzOffsetMin?: number): string {
  if (tzOffsetMin == null) {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    })
  }
  const shifted = new Date(ms + tzOffsetMin * 60_000)
  return shifted.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  })
}

/** Fractional hours past local midnight, for vertical placement in the feed. */
export function hourOfDay(ms: number, tzOffsetMin?: number): number {
  const offset = tzOffsetMin ?? -new Date(ms).getTimezoneOffset()
  const shifted = ms + offset * 60_000
  return ((shifted % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY / 3_600_000
}

export function formatDayLong(day: string): string {
  return new Date(dayKeyToAnchor(day)).toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function formatDayShort(day: string): string {
  return new Date(dayKeyToAnchor(day)).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/** "2h 15m", "45m", "—" for durations in the day story. */
export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000)
  if (totalMin < 1) return 'a moment'
  if (totalMin < 60) return `${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/** Compact zone label, e.g. "UTC+9" or "UTC−3:30". */
export function formatOffset(tzOffsetMin: number): string {
  const sign = tzOffsetMin < 0 ? '\u2212' : '+'
  const abs = Math.abs(tzOffsetMin)
  const hours = Math.floor(abs / 60)
  const minutes = abs % 60
  return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`
}

/** Relative phrase for the header, e.g. "11 years ago today". */
export function yearsAgoPhrase(day: string): string | null {
  const then = new Date(dayKeyToAnchor(day))
  const now = new Date(dayKeyToAnchor(todayKey()))
  let years = now.getUTCFullYear() - then.getUTCFullYear()
  const sameDate =
    now.getUTCMonth() === then.getUTCMonth() && now.getUTCDate() === then.getUTCDate()
  if (!sameDate) return null
  if (years <= 0) return null
  return years === 1 ? 'a year ago today' : `${years} years ago today`
}
