/**
 * Generates the PWA icon set. The mark is the app itself in miniature: a
 * travelled route with a stop on it, in the palette's slot-1 blue and slot-2
 * orange on the app's dark surface.
 *
 * Rendered by hand rather than pulled from a toolchain so `npm run icons`
 * needs nothing but Node.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
const SS = 4 // supersampling factor, for edges that aren't staircases

const SURFACE = [13, 17, 23, 255]
const BLUE = [57, 135, 229, 255]
const ORANGE = [217, 89, 38, 255]
const AQUA = [25, 158, 112, 255]

/** Route in unit coordinates, traced through the icon. */
const ROUTE = [
  [0.20, 0.74], [0.32, 0.60], [0.30, 0.44],
  [0.46, 0.34], [0.62, 0.40], [0.72, 0.28],
]
const STOP = [0.72, 0.28]
const PHOTO = [0.20, 0.74]

function render(size, { inset = 0 } = {}) {
  const dim = size * SS
  const px = new Uint8ClampedArray(dim * dim * 4)

  // Background fills edge to edge; maskable icons get cropped by the OS.
  for (let i = 0; i < dim * dim; i++) px.set(SURFACE, i * 4)

  const scale = 1 - inset * 2
  const at = ([x, y]) => [(inset + x * scale) * dim, (inset + y * scale) * dim]

  const strokeW = dim * 0.075
  for (let i = 1; i < ROUTE.length; i++) {
    line(px, dim, at(ROUTE[i - 1]), at(ROUTE[i]), strokeW, BLUE)
  }
  for (const point of ROUTE) disc(px, dim, at(point), strokeW / 2, BLUE)

  disc(px, dim, at(STOP), dim * 0.085, SURFACE)
  disc(px, dim, at(STOP), dim * 0.062, ORANGE)
  disc(px, dim, at(PHOTO), dim * 0.075, SURFACE)
  disc(px, dim, at(PHOTO), dim * 0.052, AQUA)

  return downsample(px, dim, size)
}

function blend(px, dim, x, y, color) {
  if (x < 0 || y < 0 || x >= dim || y >= dim) return
  const i = (y * dim + x) * 4
  px[i] = color[0]
  px[i + 1] = color[1]
  px[i + 2] = color[2]
  px[i + 3] = 255
}

function disc(px, dim, [cx, cy], r, color) {
  const r2 = r * r
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= r2) blend(px, dim, x, y, color)
    }
  }
}

function line(px, dim, a, b, width, color) {
  const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]))
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    disc(px, dim, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], width / 2, color)
  }
}

function downsample(px, dim, size) {
  const out = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * dim + (x * SS + sx)) * 4
          r += px[i]; g += px[i + 1]; b += px[i + 2]
        }
      }
      const n = SS * SS
      const o = (y * size + x) * 4
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255
    }
  }
  return out
}

function png(pixels, size) {
  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(
      raw,
      y * (size * 4 + 1) + 1,
    )
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'icon-192.png'), png(render(192), 192))
writeFileSync(join(OUT, 'icon-512.png'), png(render(512), 512))
// Maskable icons lose up to 20% on each edge to the platform's mask.
writeFileSync(join(OUT, 'icon-maskable.png'), png(render(512, { inset: 0.14 }), 512))

const svgRoute = ROUTE.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * 512).toFixed(0)} ${(y * 512).toFixed(0)}`).join(' ')
writeFileSync(
  join(OUT, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0d1117"/>
  <path d="${svgRoute}" fill="none" stroke="#3987e5" stroke-width="38" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="${(PHOTO[0] * 512).toFixed(0)}" cy="${(PHOTO[1] * 512).toFixed(0)}" r="38" fill="#0d1117"/>
  <circle cx="${(PHOTO[0] * 512).toFixed(0)}" cy="${(PHOTO[1] * 512).toFixed(0)}" r="27" fill="#199e70"/>
  <circle cx="${(STOP[0] * 512).toFixed(0)}" cy="${(STOP[1] * 512).toFixed(0)}" r="44" fill="#0d1117"/>
  <circle cx="${(STOP[0] * 512).toFixed(0)}" cy="${(STOP[1] * 512).toFixed(0)}" r="32" fill="#d95926"/>
</svg>
`,
)

console.log('icons written to public/icons')
