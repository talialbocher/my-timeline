import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamArrayItems } from '../src/lib/json-stream.ts'

/** Feed a string through a ReadableStream in fixed-size chunks. */
function chunked(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  return chunkedBytes(new TextEncoder().encode(text), chunkSize)
}

/**
 * Stream pre-encoded bytes as views rather than copies, so a memory
 * measurement sees the parser's allocation and not the harness's.
 */
function chunkedBytes(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize))
      offset += chunkSize
    },
  })
}

/** Heap in use, with a collection forced first where the runtime allows it. */
function heapUsed(): number {
  const gc = (globalThis as { gc?: () => void }).gc
  if (gc) {
    gc()
    gc()
  }
  return process.memoryUsage().heapUsed
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
  // ~40 MB of JSON, which a JS engine holds as ~80 MB of UTF-16 string if the
  // buffer is never trimmed. Asserting well under that proves the trimming is
  // real, with enough margin that GC timing can't decide the result.
  const big = JSON.stringify({
    locations: Array.from({ length: 400_000 }, (_, i) => ({
      latitudeE7: 400000000 + i,
      longitudeE7: -740000000,
      timestamp: '2020-01-01T00:00:00Z',
    })),
  })
  // Encode up front: the 40 MB byte array is the harness's cost, not the
  // parser's, and must not land inside the measurement window.
  const bytes = new TextEncoder().encode(big)
  const stream = chunkedBytes(bytes, 16_384)

  let count = 0
  let peak = 0
  const before = heapUsed()
  for await (const _ of streamArrayItems(stream, 'locations')) {
    count++
    if (count % 20_000 === 0) {
      peak = Math.max(peak, heapUsed() - before)
    }
  }
  assert.equal(count, 400_000)
  assert.ok(
    peak < 25_000_000,
    `heap growth ${(peak / 1e6).toFixed(1)} MB should stay far below the ~80 MB an untrimmed buffer would hold`,
  )
})
