/**
 * The day as a story: a headline, the shape of the day in numbers, where you
 * went, what you photographed, then the run of events in order.
 */
import { useMemo } from 'react'
import type { MoveEvent, TimelineEvent, VisitEvent } from '../lib/model'
import { isMessage, isMove, isPhoto, isVisit } from '../lib/model'
import { clockTime, formatDuration, formatOffset, yearsAgoPhrase } from '../lib/time'
import { formatKm } from '../lib/geo'
import { MiniMap } from './MiniMap'
import { Thumb } from './Thumb'

const MODE_GLYPH: Record<MoveEvent['mode'], string> = {
  walking: '🚶',
  cycling: '🚲',
  driving: '🚗',
  transit: '🚆',
  flying: '✈️',
  unknown: '→',
}

const MODE_VERB: Record<MoveEvent['mode'], string> = {
  walking: 'Walked',
  cycling: 'Cycled',
  driving: 'Drove',
  transit: 'Travelled',
  flying: 'Flew',
  unknown: 'Moved',
}

interface Props {
  day: string
  events: TimelineEvent[]
  showTiles: boolean
}

export function DayStory({ day, events, showTiles }: Props) {
  const derived = useMemo(() => {
    const photos = events.filter(isPhoto)
    const visits = events.filter(isVisit)
    const moves = events.filter(isMove)
    const messages = events.filter(isMessage)
    const distanceKm = moves.reduce((sum, m) => sum + m.distanceKm, 0)
    const dwell = visits.reduce((sum, v) => sum + ((v.end ?? v.start) - v.start), 0)
    // Events are ordered by the instant they happened, which is the only
    // correct order — but on a day that crosses zones, bare local times read
    // backwards (7pm in Tokyo precedes 10am in New York). Label the zone when
    // there is more than one in play.
    const zones = new Set(
      events.map((e) => e.tzOffsetMin ?? -new Date(e.start).getTimezoneOffset()),
    )
    return { photos, visits, moves, messages, distanceKm, dwell, mixedZones: zones.size > 1 }
  }, [events])

  if (events.length === 0) {
    return (
      <div className="day">
        <div className="empty">
          <div className="empty__title">Nothing recorded</div>
          <p className="empty__body">
            No photos, places or mail for this day. Swipe or use the arrows to
            move to another day, or open the year view to jump straight to a day
            that has something in it.
          </p>
        </div>
      </div>
    )
  }

  const headline = buildHeadline(derived.visits, derived.moves, derived.photos.length)
  const memory = yearsAgoPhrase(day)

  return (
    <div className="day">
      <header className="day__hero">
        <h1 className="day__headline">{headline}</h1>
        {memory && <div className="day__memory">{memory}</div>}
      </header>

      <div className="stats">
        {derived.distanceKm > 0 && (
          <div className="stat">
            <div className="stat__value">{formatKm(derived.distanceKm)}</div>
            <div className="stat__label">Travelled</div>
          </div>
        )}
        {derived.visits.length > 0 && (
          <div className="stat">
            <div className="stat__value">{derived.visits.length}</div>
            <div className="stat__label">
              {derived.visits.length === 1 ? 'Place' : 'Places'}
            </div>
          </div>
        )}
        {derived.photos.length > 0 && (
          <div className="stat">
            <div className="stat__value">{derived.photos.length}</div>
            <div className="stat__label">
              {derived.photos.length === 1 ? 'Photo' : 'Photos'}
            </div>
          </div>
        )}
        {derived.messages.length > 0 && (
          <div className="stat">
            <div className="stat__value">{derived.messages.length}</div>
            <div className="stat__label">Mail</div>
          </div>
        )}
      </div>

      <MiniMap events={events} showTiles={showTiles} />

      {derived.photos.length > 0 && (
        <>
          <div className="section__title">Photos</div>
          <div className="strip">
            {derived.photos.map((p) => (
              <Thumb key={p.id} photo={p} />
            ))}
          </div>
        </>
      )}

      <div className="section__title">The day in order</div>
      <div className="entries">
        {events.map((e) => (
          <Entry key={e.id} event={e} showZone={derived.mixedZones} />
        ))}
      </div>
    </div>
  )
}

function Entry({ event, showZone }: { event: TimelineEvent; showZone: boolean }) {
  const time = clockTime(event.start, event.tzOffsetMin)
  const offset = event.tzOffsetMin ?? -new Date(event.start).getTimezoneOffset()
  const when = (
    <span className="entry__time">
      {time}
      {showZone && <span className="entry__zone">{formatOffset(offset)}</span>}
    </span>
  )

  if (isVisit(event)) {
    const duration = event.end ? formatDuration(event.end - event.start) : null
    return (
      <div className="entry">
        <span className="entry__dot" style={{ background: 'var(--series-2)' }} />
        {when}
        <div className="entry__body">
          <div className="entry__title">{event.place}</div>
          <div className="entry__meta">
            {[duration && `Stayed ${duration}`, event.address]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      </div>
    )
  }

  if (isMove(event)) {
    const duration = event.end ? formatDuration(event.end - event.start) : null
    return (
      <div className="entry">
        <span className="entry__dot" style={{ background: 'var(--series-1)' }} />
        {when}
        <div className="entry__body">
          <div className="entry__title">
            {MODE_GLYPH[event.mode]} {MODE_VERB[event.mode]} {formatKm(event.distanceKm)}
          </div>
          <div className="entry__meta">
            {[duration, event.fromPlace && event.toPlace && `${event.fromPlace} → ${event.toPlace}`]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      </div>
    )
  }

  if (isPhoto(event)) {
    return (
      <div className="entry">
        <span className="entry__dot" style={{ background: 'var(--series-3)' }} />
        {when}
        <div className="entry__body">
          <div className="entry__title">
            {event.isVideo ? 'Took a video' : 'Took a photo'}
          </div>
          <div className="entry__meta">{event.filename}</div>
        </div>
      </div>
    )
  }

  if (isMessage(event)) {
    return (
      <div className="entry">
        <span className="entry__dot" style={{ background: 'var(--text-muted)' }} />
        {when}
        <div className="entry__body">
          <div className="entry__title">{event.subject}</div>
          <div className="entry__meta">
            {event.direction === 'sent' ? 'To' : 'From'} {event.counterparty}
          </div>
          {event.snippet && <div className="entry__snippet">{event.snippet}</div>}
        </div>
      </div>
    )
  }

  return null
}

/** One line that says what the day was, preferring place over statistics. */
function buildHeadline(
  visits: VisitEvent[],
  moves: MoveEvent[],
  photoCount: number,
): string {
  const longest = visits
    .slice()
    .sort((a, b) => ((b.end ?? b.start) - b.start) - ((a.end ?? a.start) - a.start))
  const homeish = /\b(home|house|apartment|apt)\b/i
  const named = longest.find((v) => !v.nameIsCategory && !homeish.test(v.place))
  const notable = named ?? longest.find((v) => !homeish.test(v.place) && v.place !== 'Unnamed place')

  const flight = moves.find((m) => m.mode === 'flying')
  if (flight) {
    // Only a real place name belongs after "Flew to" — a category would read
    // as "Flew to Restaurant".
    return named ? `Flew to ${named.place}` : `Flew ${formatKm(flight.distanceKm)}`
  }
  if (notable) return notable.place
  if (longest.length > 0) return longest[0].place

  const totalKm = moves.reduce((sum, m) => sum + m.distanceKm, 0)
  if (totalKm > 1) return `On the move · ${formatKm(totalKm)}`
  if (photoCount > 0) return `${photoCount} photo${photoCount === 1 ? '' : 's'}`
  return 'A quiet day'
}
