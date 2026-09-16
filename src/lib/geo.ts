/** Geometry helpers. All distances are kilometres. */

export type LatLon = [number, number]

const EARTH_RADIUS_KM = 6371.0088

export function haversineKm(a: LatLon, b: LatLon): number {
  const toRad = Math.PI / 180
  const dLat = (b[0] - a[0]) * toRad
  const dLon = (b[1] - a[1]) * toRad
  const lat1 = a[0] * toRad
  const lat2 = b[0] * toRad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function pathLengthKm(path: LatLon[]): number {
  let total = 0
  for (let i = 1; i < path.length; i++) total += haversineKm(path[i - 1], path[i])
  return total
}

export interface Bounds {
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
}

export function boundsOf(points: LatLon[]): Bounds | null {
  if (points.length === 0) return null
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
  for (const [lat, lon] of points) {
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
  }
  return { minLat, maxLat, minLon, maxLon }
}

/** Grow bounds so a single point still yields a sane viewport. */
export function padBounds(b: Bounds, minSpanDeg = 0.004): Bounds {
  const latSpan = b.maxLat - b.minLat
  const lonSpan = b.maxLon - b.minLon
  const padLat = Math.max((minSpanDeg - latSpan) / 2, latSpan * 0.15, 0)
  const padLon = Math.max((minSpanDeg - lonSpan) / 2, lonSpan * 0.15, 0)
  return {
    minLat: b.minLat - padLat,
    maxLat: b.maxLat + padLat,
    minLon: b.minLon - padLon,
    maxLon: b.maxLon + padLon,
  }
}

/** Normalized Web-Mercator coordinates, both in [0, 1]. */
export function mercatorNorm([lat, lon]: LatLon): [number, number] {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat))
  const rad = (clamped * Math.PI) / 180
  const y = Math.log(Math.tan(Math.PI / 4 + rad / 2))
  return [(lon + 180) / 360, (1 - y / Math.PI) / 2]
}

export interface Projection {
  project(p: LatLon): [number, number]
  /** Pixels per unit of normalized world space. */
  scale: number
  originX: number
  originY: number
  /** Integer tile zoom whose 256px tiles best match `scale`. */
  tileZoom: number
}

/**
 * Fit bounds into a box, preserving aspect ratio so a day spent on one street
 * doesn't render as a stretched smear. Everything — the path, the markers and
 * the optional raster tiles — is drawn through this one projection.
 */
export function fitProjection(b: Bounds, width: number, height: number): Projection {
  const [nx0, ny1] = mercatorNorm([b.minLat, b.minLon])
  const [nx1, ny0] = mercatorNorm([b.maxLat, b.maxLon])
  const spanX = Math.max(nx1 - nx0, 1e-12)
  const spanY = Math.max(ny1 - ny0, 1e-12)
  const scale = Math.min(width / spanX, height / spanY)
  const originX = (width - spanX * scale) / 2 - nx0 * scale
  const originY = (height - spanY * scale) / 2 - ny0 * scale
  const tileZoom = Math.max(0, Math.min(19, Math.floor(Math.log2(scale / 256))))
  return {
    scale,
    originX,
    originY,
    tileZoom,
    project(p: LatLon) {
      const [nx, ny] = mercatorNorm(p)
      return [originX + nx * scale, originY + ny * scale]
    },
  }
}

/**
 * Ramer-Douglas-Peucker simplification. Raw location paths run to thousands of
 * points per day; the mini-map needs tens.
 */
export function simplifyPath(path: LatLon[], toleranceKm = 0.02): LatLon[] {
  if (path.length <= 2) return path.slice()
  const keep = new Uint8Array(path.length)
  keep[0] = 1
  keep[path.length - 1] = 1

  const stack: Array<[number, number]> = [[0, path.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()!
    let maxDist = 0
    let index = -1
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularKm(path[i], path[first], path[last])
      if (d > maxDist) {
        maxDist = d
        index = i
      }
    }
    if (index !== -1 && maxDist > toleranceKm) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }
  return path.filter((_, i) => keep[i] === 1)
}

function perpendicularKm(p: LatLon, a: LatLon, b: LatLon): number {
  // Local flat-earth approximation is fine at the scale of a single day's path.
  const kmPerDegLat = 110.574
  const kmPerDegLon = 111.32 * Math.cos((p[0] * Math.PI) / 180)
  const px = p[1] * kmPerDegLon, py = p[0] * kmPerDegLat
  const ax = a[1] * kmPerDegLon, ay = a[0] * kmPerDegLat
  const bx = b[1] * kmPerDegLon, by = b[0] * kmPerDegLat
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

export function centroid(points: LatLon[]): LatLon | null {
  if (points.length === 0) return null
  // Average on the unit sphere so a trip straddling the antimeridian doesn't
  // land the centroid in the wrong hemisphere.
  let x = 0, y = 0, z = 0
  for (const [lat, lon] of points) {
    const latR = (lat * Math.PI) / 180
    const lonR = (lon * Math.PI) / 180
    x += Math.cos(latR) * Math.cos(lonR)
    y += Math.cos(latR) * Math.sin(lonR)
    z += Math.sin(latR)
  }
  const n = points.length
  x /= n; y /= n; z /= n
  const hyp = Math.hypot(x, y)
  if (hyp < 1e-12 && Math.abs(z) < 1e-12) return points[0]
  return [
    (Math.atan2(z, hyp) * 180) / Math.PI,
    (Math.atan2(y, x) * 180) / Math.PI,
  ]
}

export function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`
  if (km < 10) return `${km.toFixed(1)} km`
  return `${Math.round(km).toLocaleString()} km`
}

/** Infer how you travelled when the source doesn't say. */
export function inferMode(distanceKm: number, durationMs: number): import('./model').TravelMode {
  const hours = durationMs / 3_600_000
  if (hours <= 0) return 'unknown'
  const kmh = distanceKm / hours
  if (kmh > 200) return 'flying'
  if (kmh > 35) return 'driving'
  if (kmh > 18) return 'transit'
  if (kmh > 8) return 'cycling'
  return 'walking'
}
