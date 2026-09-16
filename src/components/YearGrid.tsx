/**
 * Ten years as a sequential heatmap — one cell per day, one block per year.
 *
 * Magnitude, so: one hue, light steps near zero, no rainbow. Thresholds are
 * quantiles of the non-empty days rather than a linear split of the range,
 * because a handful of flights would otherwise flatten every ordinary day into
 * the same step.
 */
import { useMemo, useState } from 'react'
import type { DaySummary } from '../lib/model'
import { addDays, dayKeyToAnchor, formatDayLong } from '../lib/time'
import { formatKm } from '../lib/geo'

export type Metric = 'photos' | 'distance' | 'places'

const METRIC_LABEL: Record<Metric, string> = {
  photos: 'Photos',
  distance: 'Distance',
  places: 'Places',
}

interface Props {
  summaries: Map<string, DaySummary>
  selected: string
  onSelect: (day: string) => void
}

export function YearGrid({ summaries, selected, onSelect }: Props) {
  // Defaulting to photos would show an entirely empty grid for someone who has
  // only imported location, which reads as a broken app rather than an honest
  // one. Start on whichever metric the store can actually draw.
  const [metric, setMetric] = useState<Metric>(() => availableMetric(summaries))
  const [hover, setHover] = useState<{ x: number; y: number; day: string } | null>(null)

  const { years, thresholds, totals } = useMemo(
    () => buildModel(summaries, metric),
    [summaries, metric],
  )

  if (years.length === 0) {
    return (
      <div className="empty">
        <div className="empty__title">Nothing to show yet</div>
        <p className="empty__body">
          Connect Gmail or bring in a Timeline export from Sources, and ten
          years of days will fill in here.
        </p>
      </div>
    )
  }

  return (
    <div className="year">
      {/* Filters live in one row above the chart. */}
      <div className="btnrow" style={{ marginTop: 4, marginBottom: 14 }}>
        {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => (
          <button
            key={m}
            className={`btn ${m === metric ? 'btn--primary' : ''}`}
            onClick={() => setMetric(m)}
            aria-pressed={m === metric}
          >
            {METRIC_LABEL[m]}
          </button>
        ))}
      </div>

      <div className="scale" aria-hidden="true">
        <span>Less</span>
        {['var(--seq-0)', 'var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'].map(
          (c) => (
            <span key={c} className="scale__swatch" style={{ background: c }} />
          ),
        )}
        <span>More</span>
      </div>

      {years.map((year) => (
        <section className="year__block" key={year.label}>
          <div className="year__head">
            <span className="year__label">{year.label}</span>
            <span className="year__count">{formatTotal(metric, year.total)}</span>
          </div>
          <div className="year__scroll">
          <div
            className="year__grid"
            role="grid"
            aria-label={`${year.label}, daily ${METRIC_LABEL[metric].toLowerCase()}`}
          >
            {year.cells.map((cell, i) =>
              cell === null ? (
                <span key={`pad-${i}`} />
              ) : (
                <button
                  key={cell.day}
                  className={[
                    'cell',
                    `cell--l${level(cell.value, thresholds)}`,
                    cell.day === selected ? 'cell--selected' : '',
                    cell.value === 0 ? 'cell--empty' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  title={`${formatDayLong(cell.day)} — ${formatTotal(metric, cell.value)}`}
                  aria-label={`${formatDayLong(cell.day)}, ${formatTotal(metric, cell.value)}`}
                  onClick={() => onSelect(cell.day)}
                  onMouseEnter={(e) =>
                    setHover({ x: e.clientX, y: e.clientY, day: cell.day })
                  }
                  onMouseLeave={() => setHover(null)}
                />
              ),
            )}
          </div>
          </div>
        </section>
      ))}

      <details className="disclosure">
        <summary>Read the years as a table</summary>
        <table className="datatable">
          <thead>
            <tr>
              <th>Year</th>
              <th>Days with data</th>
              <th>{METRIC_LABEL[metric]}</th>
            </tr>
          </thead>
          <tbody>
            {years.map((y) => (
              <tr key={y.label}>
                <td>{y.label}</td>
                <td>{y.activeDays}</td>
                <td>{formatTotal(metric, y.total)}</td>
              </tr>
            ))}
            <tr>
              <td>All</td>
              <td>{totals.activeDays}</td>
              <td>{formatTotal(metric, totals.value)}</td>
            </tr>
          </tbody>
        </table>
      </details>

      {hover && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          day={hover.day}
          summary={summaries.get(hover.day)}
        />
      )}
    </div>
  )
}

function Tooltip({
  x,
  y,
  day,
  summary,
}: {
  x: number
  y: number
  day: string
  summary?: DaySummary
}) {
  return (
    <div
      className="tooltip"
      style={{
        left: Math.min(x + 12, window.innerWidth - 232),
        top: Math.max(y - 64, 8),
      }}
    >
      <div className="tooltip__title">{formatDayLong(day)}</div>
      {summary ? (
        <div>
          {summary.headline && <div>{summary.headline}</div>}
          {[
            summary.photoCount > 0 && `${summary.photoCount} photos`,
            summary.distanceKm > 0.1 && formatKm(summary.distanceKm),
            summary.messageCount > 0 && `${summary.messageCount} mail`,
          ]
            .filter(Boolean)
            .join(' · ') || 'No detail'}
        </div>
      ) : (
        <div>Nothing recorded</div>
      )}
    </div>
  )
}

interface Cell {
  day: string
  value: number
}

interface YearBlock {
  label: string
  cells: Array<Cell | null>
  total: number
  activeDays: number
}

/** The first metric with any data behind it, so the grid never opens blank. */
function availableMetric(summaries: Map<string, DaySummary>): Metric {
  let photos = 0
  let places = 0
  let distance = 0
  for (const s of summaries.values()) {
    photos += s.photoCount + s.videoCount
    places += s.placeCount
    distance += s.distanceKm
  }
  if (photos > 0) return 'photos'
  if (places > 0) return 'places'
  if (distance > 0) return 'distance'
  return 'photos'
}

function valueOf(summary: DaySummary | undefined, metric: Metric): number {
  if (!summary) return 0
  if (metric === 'photos') return summary.photoCount + summary.videoCount
  if (metric === 'distance') return summary.distanceKm
  return summary.placeCount
}

function buildModel(summaries: Map<string, DaySummary>, metric: Metric) {
  const days = [...summaries.keys()].sort()
  if (days.length === 0) {
    return {
      years: [] as YearBlock[],
      thresholds: [] as number[],
      totals: { activeDays: 0, value: 0 },
    }
  }

  const firstYear = Number(days[0].slice(0, 4))
  const lastYear = Number(days[days.length - 1].slice(0, 4))

  const values: number[] = []
  let grandTotal = 0
  let grandActive = 0
  for (const day of days) {
    const v = valueOf(summaries.get(day), metric)
    if (v > 0) {
      values.push(v)
      grandTotal += v
      grandActive++
    }
  }

  const years: YearBlock[] = []
  for (let y = lastYear; y >= firstYear; y--) {
    const cells: Array<Cell | null> = []
    const start = `${y}-01-01`
    const end = `${y}-12-31`

    // Columns are weeks, rows are weekdays; pad so the first column starts on
    // the right weekday instead of sliding the whole year by a day.
    const leading = new Date(dayKeyToAnchor(start)).getUTCDay()
    for (let i = 0; i < leading; i++) cells.push(null)

    let total = 0
    let activeDays = 0
    for (let day = start; day <= end; day = addDays(day, 1)) {
      const value = valueOf(summaries.get(day), metric)
      if (value > 0) {
        total += value
        activeDays++
      }
      cells.push({ day, value })
    }
    years.push({ label: String(y), cells, total, activeDays })
  }

  return {
    years,
    thresholds: quantiles(values),
    totals: { activeDays: grandActive, value: grandTotal },
  }
}

/** Four cut points splitting the non-empty days into five steps. */
function quantiles(values: number[]): number[] {
  if (values.length === 0) return [1, 2, 3, 4]
  const sorted = values.slice().sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return [at(0.2), at(0.4), at(0.6), at(0.8)]
}

function level(value: number, thresholds: number[]): 0 | 1 | 2 | 3 | 4 | 5 {
  if (value <= 0) return 0
  if (thresholds.length < 4) return 3
  // No spread in the data — every day the same. Quantiles would push all of
  // them onto the faintest step, reading as "barely anything" when the truth
  // is "the same every day"; a mid step says that instead.
  if (thresholds[0] === thresholds[3]) return 3
  if (value <= thresholds[0]) return 1
  if (value <= thresholds[1]) return 2
  if (value <= thresholds[2]) return 3
  if (value <= thresholds[3]) return 4
  return 5
}

function formatTotal(metric: Metric, value: number): string {
  if (metric === 'distance') return formatKm(value)
  const rounded = Math.round(value)
  if (metric === 'photos') return `${rounded.toLocaleString()} photo${rounded === 1 ? '' : 's'}`
  return `${rounded.toLocaleString()} place${rounded === 1 ? '' : 's'}`
}
