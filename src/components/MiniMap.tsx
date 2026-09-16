/**
 * The day's movement, drawn as SVG.
 *
 * Three mark types, so three categorical slots in fixed order: the travelled
 * path (slot 1), places you stopped (slot 2), photos (slot 3). A legend is
 * always present — identity is never carried by color alone — and the same
 * information is available as a table below.
 *
 * No basemap is loaded by default. Raster tiles would mean asking a tile
 * server for the exact squares of earth you are looking at, which is a request
 * this app has no business making on your behalf; it is opt-in in Settings.
 */
import { useMemo, useRef, useState } from 'react'
import type { TimelineEvent } from '../lib/model'
import { isMove, isPhoto, isVisit } from '../lib/model'
import {
  boundsOf,
  fitProjection,
  formatKm,
  padBounds,
  type LatLon,
} from '../lib/geo'
import { clockTime, formatDuration } from '../lib/time'

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

interface Props {
  events: TimelineEvent[]
  showTiles: boolean
  height?: number
}

interface Marker {
  point: LatLon
  kind: 'visit' | 'photo'
  title: string
  detail: string
}

export function MiniMap({ events, showTiles, height = 220 }: Props) {
  const width = 360
  const ref = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<{ x: number; y: number; marker: Marker } | null>(null)

  const { paths, markers, bounds, distanceKm } = useMemo(() => {
    const paths: LatLon[][] = []
    const markers: Marker[] = []
    const all: LatLon[] = []
    let distanceKm = 0

    for (const e of events) {
      if (isMove(e)) {
        distanceKm += e.distanceKm
        if (e.path.length >= 2) {
          paths.push(e.path)
          all.push(...e.path)
        }
      } else if (isVisit(e) && e.lat != null && e.lon != null) {
        const point: LatLon = [e.lat, e.lon]
        all.push(point)
        markers.push({
          point,
          kind: 'visit',
          title: e.place,
          detail: e.end
            ? `${clockTime(e.start, e.tzOffsetMin)} · ${formatDuration(e.end - e.start)}`
            : clockTime(e.start, e.tzOffsetMin),
        })
      } else if (isPhoto(e) && e.lat != null && e.lon != null) {
        const point: LatLon = [e.lat, e.lon]
        all.push(point)
        markers.push({
          point,
          kind: 'photo',
          title: e.filename,
          detail: clockTime(e.start, e.tzOffsetMin),
        })
      }
    }

    const raw = boundsOf(all)
    return {
      paths,
      markers,
      bounds: raw ? padBounds(raw) : null,
      distanceKm,
    }
  }, [events])

  if (!bounds) {
    return (
      <div className="map">
        <div className="map__empty">
          Nothing placed this day on the map. Location comes from a Timeline
          export or from GPS in your photo files — both in Sources.
        </div>
      </div>
    )
  }

  const proj = fitProjection(bounds, width, height)
  const tiles = showTiles ? tileGrid(proj, width, height) : []

  const toScreen = (p: LatLon) => proj.project(p)

  function showTip(marker: Marker, clientX: number, clientY: number) {
    setHover({ x: clientX, y: clientY, marker })
  }

  return (
    <>
      <div className="map">
        <svg
          ref={ref}
          className="map__canvas"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Map of the day's movement, ${formatKm(distanceKm)} travelled across ${markers.length} marked points`}
          onMouseLeave={() => setHover(null)}
        >
          {tiles.map((t) => (
            <image
              key={`${t.z}/${t.x}/${t.y}`}
              href={TILE_URL.replace('{z}', String(t.z))
                .replace('{x}', String(t.x))
                .replace('{y}', String(t.y))}
              x={t.px}
              y={t.py}
              width={t.size}
              height={t.size}
              opacity={0.55}
              preserveAspectRatio="none"
            />
          ))}

          {/* Casing under the route keeps it readable over tiles or bare surface. */}
          {paths.map((path, i) => (
            <polyline
              key={`casing-${i}`}
              points={path.map(toScreen).map(([x, y]) => `${x},${y}`).join(' ')}
              fill="none"
              stroke="var(--surface-0)"
              strokeWidth={5}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={0.85}
            />
          ))}
          {paths.map((path, i) => (
            <polyline
              key={`path-${i}`}
              points={path.map(toScreen).map(([x, y]) => `${x},${y}`).join(' ')}
              fill="none"
              stroke="var(--series-1)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {markers.map((m, i) => {
            const [x, y] = toScreen(m.point)
            const color = m.kind === 'visit' ? 'var(--series-2)' : 'var(--series-3)'
            return (
              <g key={i}>
                {/* Hit target is deliberately larger than the mark. */}
                <circle
                  cx={x}
                  cy={y}
                  r={14}
                  fill="transparent"
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={(e) => showTip(m, e.clientX, e.clientY)}
                  onTouchStart={(e) =>
                    showTip(m, e.touches[0].clientX, e.touches[0].clientY)
                  }
                />
                <circle
                  cx={x}
                  cy={y}
                  r={m.kind === 'visit' ? 5 : 4}
                  fill={color}
                  stroke="var(--surface-0)"
                  strokeWidth={2}
                  pointerEvents="none"
                />
              </g>
            )
          })}
        </svg>
      </div>

      <div className="legend">
        {paths.length > 0 && (
          <span className="legend__item">
            <span
              className="legend__swatch legend__swatch--line"
              style={{ background: 'var(--series-1)' }}
            />
            Route · {formatKm(distanceKm)}
          </span>
        )}
        {markers.some((m) => m.kind === 'visit') && (
          <span className="legend__item">
            <span className="legend__swatch" style={{ background: 'var(--series-2)' }} />
            Places
          </span>
        )}
        {markers.some((m) => m.kind === 'photo') && (
          <span className="legend__item">
            <span className="legend__swatch" style={{ background: 'var(--series-3)' }} />
            Photos
          </span>
        )}
      </div>

      {showTiles && (
        <div className="disclosure">Basemap © OpenStreetMap contributors</div>
      )}

      {markers.length > 0 && (
        <details className="disclosure">
          <summary>Read the map as a table</summary>
          <table className="datatable">
            <thead>
              <tr>
                <th>Point</th>
                <th>When</th>
                <th>Coordinates</th>
              </tr>
            </thead>
            <tbody>
              {markers.map((m, i) => (
                <tr key={i}>
                  <td>{m.title}</td>
                  <td>{m.detail}</td>
                  <td>
                    {m.point[0].toFixed(4)}, {m.point[1].toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {hover && (
        <div
          className="tooltip"
          style={{
            left: Math.min(hover.x + 12, window.innerWidth - 232),
            top: Math.max(hover.y - 56, 8),
          }}
        >
          <div className="tooltip__title">{hover.marker.title}</div>
          <div>{hover.marker.detail}</div>
        </div>
      )}
    </>
  )
}

interface Tile {
  z: number
  x: number
  y: number
  px: number
  py: number
  size: number
}

/** The tiles covering the viewport at the projection's own zoom. */
function tileGrid(
  proj: ReturnType<typeof fitProjection>,
  width: number,
  height: number,
): Tile[] {
  const z = proj.tileZoom
  const n = 2 ** z
  // One tile spans 1/n of normalized world space.
  const size = proj.scale / n
  if (!Number.isFinite(size) || size <= 0) return []

  const firstX = Math.floor((-proj.originX) / size)
  const lastX = Math.floor((width - proj.originX) / size)
  const firstY = Math.floor((-proj.originY) / size)
  const lastY = Math.floor((height - proj.originY) / size)

  const tiles: Tile[] = []
  // A runaway grid would mean hundreds of requests; cap it and skip the basemap.
  if ((lastX - firstX + 1) * (lastY - firstY + 1) > 48) return []

  for (let x = firstX; x <= lastX; x++) {
    for (let y = firstY; y <= lastY; y++) {
      if (y < 0 || y >= n) continue
      tiles.push({
        z,
        x: ((x % n) + n) % n,
        y,
        px: proj.originX + x * size,
        py: proj.originY + y * size,
        size,
      })
    }
  }
  return tiles
}
