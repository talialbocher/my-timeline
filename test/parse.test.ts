import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  approxOffsetFromLon,
  detectFormat,
  offsetFromIso,
  parseLatLng,
  parseSemanticSegments,
  parseTimelineObjects,
  segmentRawFixes,
  type RawFix,
} from '../src/sources/timeline-parse.ts'
import { haversineKm, simplifyPath, centroid, fitProjection, padBounds, boundsOf } from '../src/lib/geo.ts'
import { dayKey, addDays, daysBetween, formatDuration } from '../src/lib/time.ts'

test('parseLatLng accepts every shape Google emits', () => {
  assert.deepEqual(parseLatLng('40.7128°, -74.0060°'), [40.7128, -74.006])
  assert.deepEqual(parseLatLng('geo:40.7128,-74.0060'), [40.7128, -74.006])
  assert.deepEqual(parseLatLng({ latLng: '40.7128°, -74.0060°' }), [40.7128, -74.006])
  assert.deepEqual(parseLatLng({ latitudeE7: 407128000, longitudeE7: -740060000 }), [
    40.7128, -74.006,
  ])
  assert.deepEqual(parseLatLng({ latE7: 407128000, lngE7: -740060000 }), [40.7128, -74.006])
  assert.equal(parseLatLng({ latitudeE7: 0, longitudeE7: 0 }), null, 'Null Island is a parse failure')
  assert.equal(parseLatLng('nonsense'), null)
  assert.equal(parseLatLng({ latitude: 200, longitude: 5 }), null, 'out of range rejected')
})

test('offsets are read from ISO strings and estimated from longitude', () => {
  assert.equal(offsetFromIso('2024-03-01T08:00:00.000-05:00'), -300)
  assert.equal(offsetFromIso('2024-03-01T08:00:00.000+09:00'), 540)
  assert.equal(offsetFromIso('2024-03-01T08:00:00.000Z'), undefined)
  assert.equal(approxOffsetFromLon(139.7), 540, 'Tokyo lands on UTC+9')
  assert.equal(approxOffsetFromLon(-74), -300, 'New York lands on UTC-5')
})

test('detectFormat tells the three exports apart', () => {
  assert.equal(detectFormat('{"semanticSegments": ['), 'semantic-segments')
  assert.equal(detectFormat('{"timelineObjects": ['), 'timeline-objects')
  assert.equal(detectFormat('{"locations": ['), 'records')
  assert.equal(detectFormat('[{"startTime":"2024-01-01T00:00:00Z","visit":{}}'), 'semantic-segments')
  assert.equal(detectFormat('{"something": 1}'), 'unknown')
})

test('on-device Timeline export yields visits, activities and paths', () => {
  const events = parseSemanticSegments({
    semanticSegments: [
      {
        startTime: '2024-06-01T09:00:00.000-04:00',
        endTime: '2024-06-01T11:30:00.000-04:00',
        visit: {
          probability: 0.9,
          topCandidate: {
            placeId: 'ChIJabc',
            semanticType: 'TYPE_HOME',
            probability: 0.85,
            placeLocation: { latLng: '40.6782°, -73.9442°' },
          },
        },
      },
      {
        startTime: '2024-06-01T11:30:00.000-04:00',
        endTime: '2024-06-01T12:00:00.000-04:00',
        activity: {
          start: { latLng: '40.6782°, -73.9442°' },
          end: { latLng: '40.7128°, -74.0060°' },
          distanceMeters: '7400',
          topCandidate: { type: 'in_passenger_vehicle' },
        },
      },
      {
        startTime: '2024-06-01T13:00:00.000-04:00',
        endTime: '2024-06-01T13:40:00.000-04:00',
        timelinePath: [
          { point: '40.7128°, -74.0060°' },
          { point: '40.7200°, -74.0100°' },
          { point: '40.7300°, -74.0150°' },
        ],
      },
    ],
  })

  assert.equal(events.length, 3)

  const [visit, drive, walk] = events
  assert.equal(visit.kind, 'visit')
  assert.equal(visit.kind === 'visit' && visit.place, 'Home')
  assert.equal(visit.tzOffsetMin, -240)
  assert.equal(visit.day, '2024-06-01')

  assert.equal(drive.kind, 'move')
  assert.equal(drive.kind === 'move' && drive.mode, 'driving')
  assert.equal(drive.kind === 'move' && Math.round(drive.distanceKm * 10) / 10, 7.4)

  assert.equal(walk.kind, 'move')
  assert.ok(walk.kind === 'move' && walk.path.length >= 2)
})

test('a Tokyo evening files under the Tokyo day, not the viewer\'s', () => {
  const [visit] = parseSemanticSegments({
    semanticSegments: [
      {
        startTime: '2024-06-01T21:00:00.000+09:00',
        endTime: '2024-06-01T23:00:00.000+09:00',
        visit: { topCandidate: { placeLocation: { latLng: '35.6762°, 139.6503°' } } },
      },
    ],
  })
  assert.equal(visit.day, '2024-06-01')
  assert.equal(visit.tzOffsetMin, 540)
})

test('legacy Semantic Location History parses place visits and activity segments', () => {
  const events = parseTimelineObjects({
    timelineObjects: [
      {
        placeVisit: {
          location: {
            name: 'Prospect Park',
            address: '95 Prospect Park W, Brooklyn',
            placeId: 'ChIJxyz',
            latitudeE7: 406600000,
            longitudeE7: -739700000,
          },
          duration: {
            startTimestamp: '2019-04-14T14:00:00Z',
            endTimestamp: '2019-04-14T16:00:00Z',
          },
          visitConfidence: 88,
        },
      },
      {
        activitySegment: {
          startLocation: { latitudeE7: 406600000, longitudeE7: -739700000 },
          endLocation: { latitudeE7: 407128000, longitudeE7: -740060000 },
          duration: {
            startTimestamp: '2019-04-14T16:00:00Z',
            endTimestamp: '2019-04-14T16:40:00Z',
          },
          distance: 6200,
          activityType: 'CYCLING',
          simplifiedRawPath: {
            points: [{ latE7: 406900000, lngE7: -739800000 }],
          },
        },
      },
    ],
  })

  assert.equal(events.length, 2)
  const [visit, ride] = events
  assert.equal(visit.kind === 'visit' && visit.place, 'Prospect Park')
  assert.equal(visit.kind === 'visit' && visit.confidence, 0.88)
  assert.equal(ride.kind === 'move' && ride.mode, 'cycling')
  assert.equal(ride.kind === 'move' && ride.distanceKm, 6.2)
  assert.equal(ride.kind === 'move' && ride.path.length >= 2, true)
})

test('raw fixes segment into stays and the moves between them', () => {
  const base = Date.parse('2020-08-09T12:00:00Z')
  const fixes: RawFix[] = []

  // 40 minutes sitting still at a cafe.
  for (let i = 0; i < 20; i++) {
    fixes.push({ ms: base + i * 2 * 60_000, point: [40.7000 + i * 0.00002, -74.0000] })
  }
  // A walk east.
  for (let i = 1; i <= 10; i++) {
    fixes.push({ ms: base + (40 + i) * 60_000, point: [40.7000, -74.0000 + i * 0.002] })
  }
  // 40 minutes still again at the destination.
  for (let i = 0; i < 20; i++) {
    fixes.push({
      ms: base + (55 + i * 2) * 60_000,
      point: [40.7000, -73.9800 + i * 0.00002],
    })
  }

  const events = segmentRawFixes(fixes)
  const visits = events.filter((e) => e.kind === 'visit')
  const moves = events.filter((e) => e.kind === 'move')

  assert.equal(visits.length, 2, 'two stays detected')
  assert.equal(moves.length, 1, 'one journey between them')
  const move = moves[0]
  assert.ok(move.kind === 'move' && move.distanceKm > 1.5 && move.distanceKm < 2.5)
})

test('a day spent entirely in one place produces no phantom journeys', () => {
  const base = Date.parse('2020-08-09T12:00:00Z')
  const fixes: RawFix[] = Array.from({ length: 60 }, (_, i) => ({
    ms: base + i * 60_000,
    point: [40.7 + (i % 3) * 0.00001, -74.0] as [number, number],
  }))
  const events = segmentRawFixes(fixes)
  assert.equal(events.filter((e) => e.kind === 'move').length, 0)
})

test('distances are kilometres and match known values', () => {
  // Manhattan to Brooklyn, roughly 6 km.
  const km = haversineKm([40.7128, -74.006], [40.6782, -73.9442])
  assert.ok(km > 6 && km < 7, `expected ~6.4 km, got ${km}`)
  // New York to London, roughly 5570 km.
  const far = haversineKm([40.7128, -74.006], [51.5074, -0.1278])
  assert.ok(far > 5500 && far < 5600, `expected ~5570 km, got ${far}`)
})

test('path simplification keeps the ends and drops the filler', () => {
  const straight: Array<[number, number]> = Array.from(
    { length: 50 },
    (_, i) => [40.7 + i * 0.001, -74.0],
  )
  const simplified = simplifyPath(straight)
  assert.equal(simplified.length, 2, 'a straight line needs two points')
  assert.deepEqual(simplified[0], straight[0])
  assert.deepEqual(simplified[1], straight[straight.length - 1])
})

test('centroid survives the antimeridian', () => {
  const c = centroid([
    [0, 179],
    [0, -179],
  ])!
  assert.ok(Math.abs(Math.abs(c[1]) - 180) < 0.001, `expected ~±180, got ${c[1]}`)
})

test('projection fits bounds and keeps north above south', () => {
  const b = padBounds(boundsOf([[40.70, -74.02], [40.75, -73.96]])!)
  const proj = fitProjection(b, 360, 220)
  const north = proj.project([40.75, -73.99])
  const south = proj.project([40.70, -73.99])
  assert.ok(north[1] < south[1], 'north renders above south')
  for (const [x, y] of [north, south]) {
    assert.ok(x >= -1 && x <= 361 && y >= -1 && y <= 221, 'stays inside the box')
  }
})

test('day keys and stepping', () => {
  assert.equal(dayKey(Date.parse('2024-06-01T02:00:00Z'), -300), '2024-05-31')
  assert.equal(dayKey(Date.parse('2024-06-01T22:00:00Z'), 540), '2024-06-02')
  assert.equal(addDays('2024-02-28', 1), '2024-02-29')
  assert.equal(addDays('2024-12-31', 1), '2025-01-01')
  assert.equal(daysBetween('2015-01-01', '2025-01-01'), 3653)
  assert.equal(formatDuration(45 * 60_000), '45m')
  assert.equal(formatDuration(135 * 60_000), '2h 15m')
  assert.equal(formatDuration(120 * 60_000), '2h')
})
