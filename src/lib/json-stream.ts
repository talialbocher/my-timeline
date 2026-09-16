/**
 * Minimal streaming extractor for one named array inside a very large JSON file.
 *
 * `Records.json` from a ten-year Takeout routinely exceeds a gigabyte, which
 * `JSON.parse` cannot survive in a browser tab. Rather than pull in a full
 * streaming parser, this walks the byte stream once, finds the array under the
 * requested key, and yields each top-level element as its own parsed object —
 * so peak memory is one element, not the whole file.
 */

/** How much of a key-less preamble to keep while hunting for the target key. */
const KEY_SEARCH_TAIL = 1024

export async function* streamArrayItems<T>(
  stream: ReadableStream<Uint8Array>,
  key: string,
  onBytes?: (bytes: number) => void,
): AsyncGenerator<T> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const keyPattern = new RegExp(`"${key}"\\s*:\\s*\\[`)

  let buffer = ''
  /** Next index in `buffer` to examine. Never rewinds over scanned input. */
  let pos = 0
  let bytesRead = 0
  let insideArray = false
  let depth = 0
  let elementStart = -1
  let inString = false
  let escaped = false

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) {
        bytesRead += value.byteLength
        buffer += decoder.decode(value, { stream: true })
        onBytes?.(bytesRead)
      } else if (done) {
        buffer += decoder.decode()
      }

      if (!insideArray) {
        const hit = keyPattern.exec(buffer)
        if (hit) {
          insideArray = true
          // Drop the preamble entirely; scanning resumes at the array's first
          // element with the cursor rebased onto the trimmed buffer.
          buffer = buffer.slice(hit.index + hit[0].length)
          pos = 0
        } else {
          // Keep a tail long enough that the key can't be split across chunks.
          if (buffer.length > KEY_SEARCH_TAIL) buffer = buffer.slice(-KEY_SEARCH_TAIL)
          pos = 0
          if (done) return
          continue
        }
      }

      while (pos < buffer.length) {
        const ch = buffer[pos]

        if (inString) {
          if (escaped) escaped = false
          else if (ch === '\\') escaped = true
          else if (ch === '"') inString = false
          pos++
          continue
        }

        if (ch === '"') {
          inString = true
          pos++
          continue
        }

        if (ch === '{' || ch === '[') {
          if (depth === 0) elementStart = pos
          depth++
          pos++
          continue
        }

        if (ch === '}' || ch === ']') {
          if (depth === 0) return // The closing bracket of the array itself.
          depth--
          pos++
          if (depth === 0 && elementStart >= 0) {
            const text = buffer.slice(elementStart, pos)
            elementStart = -1
            try {
              yield JSON.parse(text) as T
            } catch {
              /* A malformed element is skipped rather than killing the import. */
            }
            // Everything up to here is consumed; keep the buffer bounded.
            buffer = buffer.slice(pos)
            pos = 0
          }
          continue
        }

        pos++
      }

      // Between elements nothing is pending, so the whole buffer is spent.
      // Mid-element, only the bytes before the element's first brace are.
      if (depth === 0 && !inString) {
        buffer = ''
        pos = 0
      } else if (elementStart > 0) {
        buffer = buffer.slice(elementStart)
        pos -= elementStart
        elementStart = 0
      }

      if (done) return
    }
  } finally {
    reader.releaseLock()
  }
}

/** First `n` characters of a file, for format sniffing. */
export async function peek(file: File, n = 4096): Promise<string> {
  return await file.slice(0, n).text()
}
