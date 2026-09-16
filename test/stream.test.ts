import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamArrayItems } from '../src/lib/json-stream.ts'

/** Feed a string through a ReadableStream in fixed-size chunks. */
function chunked(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize))
      offset += chunkSize
    },
  })
}

async function collect<T>(stream: ReadableStream<Uint8Array>, key: string): Promise<T[]> {
  const out: T[] = []
  for await (const item of streamArrayItems<T>(stream, key)) out.push(item)
  return out
}

const RECORDS = JSON.stringify({
  locations: Array.from({ length: 500 }, (_, i) => ({
    latitudeE7: 407128000 + i * 100,
    longitudeE7: -740060000 - i * 100,
    timestamp: new Date(Date.parse('2020-01-01T00:00:00Z') + i * 60_000).toISOString(),
    accuracy: 10 + (i % 40),
  })),
})

test('streams every element regardless of where chunks land', async () => {
  // Chunk sizes chosen to split mid-key, mid-string and mid-number.
  for (const size of [1, 7, 64, 997, 65_536]) {
    const items = await collect<{ latitudeE7: number }>(chunked(RECORDS, size), 'locations')
    assert.equal(items.length, 500, `chunk size ${size}`)
    assert.equal(items[0].latitudeE7, 407128000, `chunk size ${size}`)
    assert.equal(items[499].latitudeE7, 407128000 + 499 * 100, `chunk size ${size}`)
  }
})

test('handles strings containing braces and escaped quotes', async () => {
  const tricky = JSON.stringify({
    locations: [
      { note: 'a } brace and a { brace', timestamp: 'x' },
      { note: 'an \\"escaped\\" quote', timestamp: 'y' },
      { note: '[]{}""', timestamp: 'z' },
    ],
  })
  for (const size of [1, 13, 1024]) {
    const items = await collect<{ timestamp: string }>(chunked(tricky, size), 'locations')
    assert.equal(items.length, 3, `chunk size ${size}`)
    assert.deepEqual(
      items.map((i) => i.timestamp),
      ['x', 'y', 'z'],
      `chunk size ${size}`,
    )
  }
})

test('handles nested objects and arrays inside elements', async () => {
  const nested = JSON.stringify({
    locations: [
      { a: { b: { c: [1, 2, { d: 3 }] } }, id: 1 },
      { a: [[[]]], id: 2 },
    ],
  })
  const items = await collect<{ id: number }>(chunked(nested, 5), 'locations')
  assert.deepEqual(items.map((i) => i.id), [1, 2])
})

test('skips preamble keys and stops at the end of the target array', async () => {
  const withExtras = JSON.stringify({
    metadata: { version: 2, notes: 'locations are below' },
    locations: [{ id: 1 }, { id: 2 }],
    trailing: [{ id: 99 }],
  })
  const items = await collect<{ id: number }>(chunked(withExtras, 11), 'locations')
  assert.deepEqual(items.map((i) => i.id), [1, 2], 'trailing array is not consumed')
})

test('an empty array yields nothing and terminates', async () => {
  const items = await collect(chunked('{"locations":[]}', 3), 'locations')
  assert.equal(items.length, 0)
})

test('a missing key terminates instead of hanging', async () => {
  const items = await collect(chunked('{"other":[{"id":1}]}', 4), 'locations')
  assert.equal(items.length, 0)
})

test('memory stays bounded across a large stream', async () => {
  // 40k elements is ~4 MB of JSON; peak RSS growth should be far below that
  // if the buffer is really being trimmed as elements are yielded.
  const big = JSON.stringify({
    locations: Array.from({ length: 40_000 }, (_, i) => ({
      latitudeE7: 400000000 + i,
      longitudeE7: -740000000,
      timestamp: '2020-01-01T00:00:00Z',
    })),
  })
  let count = 0
  let peak = 0
  const before = process.memoryUsage().heapUsed
  for await (const _ of streamArrayItems(chunked(big, 16_384), 'locations')) {
    count++
    if (count % 5000 === 0) {
      peak = Math.max(peak, process.memoryUsage().heapUsed - before)
    }
  }
  assert.equal(count, 40_000)
  assert.ok(peak < 12_000_000, `heap growth ${peak} bytes should stay bounded`)
})
