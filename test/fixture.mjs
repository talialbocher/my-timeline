/**
 * Generates a realistic on-device Timeline export spanning several years so the
 * app can be exercised the way it will actually be used.
 */
import { writeFileSync } from 'node:fs'

const PLACES = [
  { name: 'TYPE_HOME', lat: 40.6782, lon: -73.9442 },
  { name: 'TYPE_WORK', lat: 40.7484, lon: -73.9857 },
  { name: 'TYPE_GYM', lat: 40.6892, lon: -73.9903 },
  { name: 'TYPE_RESTAURANT', lat: 40.7223, lon: -73.9874 },
  { name: 'TYPE_PARK', lat: 40.6602, lon: -73.969 },
]

const segments = []
const start = new Date('2016-03-01T00:00:00Z')
const end = new Date('2026-09-01T00:00:00Z')
let rng = 12345
const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
  // Most days have something; some are blank, like real life.
  if (rand() < 0.28) continue
  const iso = (h, m = 0) =>
    `${d.toISOString().slice(0, 10)}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000-05:00`

  const home = PLACES[0]
  segments.push({
    startTime: iso(0),
    endTime: iso(8, 30),
    visit: {
      probability: 0.95,
      topCandidate: {
        placeId: 'home',
        semanticType: home.name,
        probability: 0.9,
        placeLocation: { latLng: `${home.lat}°, ${home.lon}°` },
      },
    },
  })

  const dest = PLACES[1 + Math.floor(rand() * (PLACES.length - 1))]
  segments.push({
    startTime: iso(8, 30),
    endTime: iso(9, 10),
    activity: {
      start: { latLng: `${home.lat}°, ${home.lon}°` },
      end: { latLng: `${dest.lat}°, ${dest.lon}°` },
      distanceMeters: String(Math.round(6000 + rand() * 4000)),
      topCandidate: { type: rand() > 0.5 ? 'in_subway' : 'walking' },
    },
  })

  segments.push({
    startTime: iso(9, 10),
    endTime: iso(17, 45),
    visit: {
      probability: 0.88,
      topCandidate: {
        placeId: `p${dest.name}`,
        semanticType: dest.name,
        probability: 0.8,
        placeLocation: { latLng: `${dest.lat}°, ${dest.lon}°` },
      },
    },
  })

  // A wandering path in the evening, the kind that draws a real route.
  const path = []
  for (let i = 0; i < 14; i++) {
    path.push({
      point: `${(dest.lat + Math.sin(i / 2) * 0.004 + i * 0.0006).toFixed(6)}°, ${(dest.lon + Math.cos(i / 3) * 0.005 - i * 0.0004).toFixed(6)}°`,
    })
  }
  segments.push({ startTime: iso(18), endTime: iso(19, 20), timelinePath: path })
}

// A trip abroad, to prove the timezone handling and the flight headline.
for (let i = 0; i < 6; i++) {
  const day = `2023-05-${String(12 + i).padStart(2, '0')}`
  if (i === 0) {
    segments.push({
      startTime: `${day}T10:00:00.000-04:00`,
      endTime: `${day}T23:30:00.000+09:00`,
      activity: {
        start: { latLng: '40.6413°, -73.7781°' },
        end: { latLng: '35.5494°, 139.7798°' },
        distanceMeters: '10850000',
        topCandidate: { type: 'flying' },
      },
    })
  }
  segments.push({
    startTime: `${day}T19:00:00.000+09:00`,
    endTime: `${day}T22:00:00.000+09:00`,
    visit: {
      probability: 0.9,
      topCandidate: {
        placeId: `tokyo${i}`,
        semanticType: 'TYPE_RESTAURANT',
        probability: 0.85,
        placeLocation: { latLng: '35.6762°, 139.6503°' },
      },
    },
  })
}

writeFileSync(process.argv[2], JSON.stringify({ semanticSegments: segments }))
console.log(`${segments.length} segments`)
