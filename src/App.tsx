import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DaySummary, TimelineEvent } from './lib/model'
import { getDay, getDaySummaries, getRange } from './lib/db'
import { addDays, formatDayLong, formatDayShort, todayKey } from './lib/time'
import { DayStory } from './components/DayStory'
import { YearGrid } from './components/YearGrid'
import { Sources } from './components/Sources'

type Tab = 'day' | 'year' | 'sources'

const TILES_KEY = 'my-timeline.map-tiles'

export default function App() {
  const [tab, setTab] = useState<Tab>('day')
  const [day, setDay] = useState<string>(() => dayFromHash() ?? todayKey())
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [summaries, setSummaries] = useState<Map<string, DaySummary>>(new Map())
  const [range, setRange] = useState<{ first: string; last: string } | null>(null)
  const [showTiles, setShowTiles] = useState(
    () => localStorage.getItem(TILES_KEY) === 'osm',
  )
  const [loaded, setLoaded] = useState(false)
  /** Whether we've already parked the view on a day that has content. */
  const positioned = useRef(false)
  /**
   * The day the app was opened with, captured before we start writing the hash
   * ourselves — otherwise our own `replaceState` would look like a deep link
   * and suppress the jump to the newest day with data.
   */
  const openedWith = useRef(dayFromHash())

  const reloadIndex = useCallback(async () => {
    const [nextSummaries, nextRange] = await Promise.all([getDaySummaries(), getRange()])
    setSummaries(nextSummaries)
    setRange(nextRange)
    setLoaded(true)
    // Land on the most recent day that actually has something in it — on first
    // load and again the first time data arrives, since an empty "today" makes
    // a freshly imported archive look like it failed. After that, wherever the
    // viewer has navigated to is left alone.
    if (!positioned.current && nextRange) {
      positioned.current = true
      // A day in the URL wins: it is how a bookmarked or shared day reopens.
      if (!openedWith.current) setDay(nextRange.last)
    }
    return nextRange
  }, [])

  useEffect(() => {
    void reloadIndex()
  }, [reloadIndex])

  useEffect(() => {
    let stale = false
    getDay(day).then((result) => {
      if (!stale) setEvents(result)
    })
    return () => {
      stale = true
    }
  }, [day, summaries])

  // Keep the day in the URL so a particular day can be bookmarked, and so the
  // back gesture in a standalone PWA steps through days rather than leaving.
  useEffect(() => {
    if (dayFromHash() !== day) history.replaceState(null, '', `#${day}`)
  }, [day])

  useEffect(() => {
    const onHash = () => {
      const fromHash = dayFromHash()
      if (fromHash) setDay(fromHash)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const setTiles = useCallback((value: boolean) => {
    setShowTiles(value)
    localStorage.setItem(TILES_KEY, value ? 'osm' : 'none')
  }, [])

  /** Step to the next/previous day, skipping runs with nothing in them. */
  const step = useCallback(
    (delta: 1 | -1) => {
      setDay((current) => {
        if (!range) return addDays(current, delta)
        let candidate = addDays(current, delta)
        // Bounded scan: past the ends of the archive, just move one day.
        for (let i = 0; i < 4000; i++) {
          if (candidate < range.first || candidate > range.last) break
          if (summaries.has(candidate)) return candidate
          candidate = addDays(candidate, delta)
        }
        return addDays(current, delta)
      })
    },
    [range, summaries],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tab !== 'day') return
      if (e.key === 'ArrowLeft') step(-1)
      if (e.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, tab])

  const swipe = useSwipe(
    () => step(1),
    () => step(-1),
  )

  const summary = summaries.get(day)
  const subtitle = useMemo(() => {
    if (tab === 'sources') return 'Everything stays on this device'
    if (tab === 'year') return range ? `${range.first.slice(0, 4)} – ${range.last.slice(0, 4)}` : ''
    if (!summary) return 'Nothing recorded'
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
    const bits = [
      summary.photoCount > 0 && plural(summary.photoCount, 'photo'),
      summary.placeCount > 0 && plural(summary.placeCount, 'place'),
      summary.messageCount > 0 && `${summary.messageCount} mail`,
    ].filter(Boolean)
    return bits.join(' · ') || 'Nothing recorded'
  }, [tab, summary, range])

  const empty = loaded && summaries.size === 0

  return (
    <div className="app">
      <header className="topbar">
        {tab === 'day' && (
          <button
            className="iconbtn"
            onClick={() => step(-1)}
            aria-label="Previous day"
            disabled={Boolean(range) && day <= range!.first}
          >
            ‹
          </button>
        )}
        <div className="topbar__titles">
          <div className="topbar__day">
            {tab === 'day' ? formatDayLong(day) : tab === 'year' ? 'Ten years' : 'Sources'}
          </div>
          <div className="topbar__sub">{subtitle}</div>
        </div>
        {tab === 'day' && (
          <button
            className="iconbtn"
            onClick={() => step(1)}
            aria-label="Next day"
            disabled={Boolean(range) && day >= range!.last}
          >
            ›
          </button>
        )}
      </header>

      <main className="app__body" {...(tab === 'day' ? swipe : {})}>
        {tab === 'day' &&
          (empty ? (
            <FirstRun onGoToSources={() => setTab('sources')} />
          ) : (
            <DayStory day={day} events={events} showTiles={showTiles} />
          ))}

        {tab === 'year' && (
          <YearGrid
            summaries={summaries}
            selected={day}
            onSelect={(next) => {
              setDay(next)
              setTab('day')
            }}
          />
        )}

        {tab === 'sources' && (
          <Sources
            onChanged={reloadIndex}
            showTiles={showTiles}
            onShowTilesChange={setTiles}
          />
        )}
      </main>

      <nav className="tabs">
        <TabButton
          active={tab === 'day'}
          glyph="☀"
          label={tab === 'day' ? formatDayShort(day) : 'Day'}
          onClick={() => setTab('day')}
        />
        <TabButton
          active={tab === 'year'}
          glyph="▦"
          label="Years"
          onClick={() => setTab('year')}
        />
        <TabButton
          active={tab === 'sources'}
          glyph="⊕"
          label="Sources"
          onClick={() => setTab('sources')}
        />
      </nav>
    </div>
  )
}

function TabButton({
  active,
  glyph,
  label,
  onClick,
}: {
  active: boolean
  glyph: string
  label: string
  onClick: () => void
}) {
  return (
    <button
      className={`tab ${active ? 'tab--active' : ''}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
    >
      <span className="tab__glyph" aria-hidden="true">
        {glyph}
      </span>
      {label}
    </button>
  )
}

function FirstRun({ onGoToSources }: { onGoToSources: () => void }) {
  return (
    <div className="empty">
      <div className="empty__title">Nothing here yet</div>
      <p className="empty__body">
        This app holds your timeline on this device and nowhere else. Bring in a
        Location Timeline export to put yourself on the map, then connect Gmail
        and Photos to fill in the days.
      </p>
      <div className="btnrow" style={{ justifyContent: 'center' }}>
        <button className="btn btn--primary" onClick={onGoToSources}>
          Open Sources
        </button>
      </div>
    </div>
  )
}

function dayFromHash(): string | null {
  const raw = window.location.hash.slice(1)
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

/** Horizontal swipe between days, ignoring vertical scrolling. */
function useSwipe(onLeft: () => void, onRight: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null)

  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0]
      start.current = { x: t.clientX, y: t.clientY }
    },
    onTouchEnd: (e: React.TouchEvent) => {
      if (!start.current) return
      const t = e.changedTouches[0]
      const dx = t.clientX - start.current.x
      const dy = t.clientY - start.current.y
      start.current = null
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6) return
      if (dx < 0) onLeft()
      else onRight()
    },
  }
}
