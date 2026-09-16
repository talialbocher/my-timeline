# My Timeline

Ten years of where you were and what you did, on your phone, assembled on your
own device.

Open it to a single day: a map of that day's route, the places you stopped, the
photos you took, the mail you actually wrote. Swipe for the day before. Pull up
the year view to see a decade at a glance and jump anywhere in it.

It installs to the iPhone home screen as a PWA and runs full-screen. There is no
server, no account, and no telemetry. Your data is written to IndexedDB on the
device and goes nowhere else.

## What each source can actually give you

This matters more than it should, because Google changed the rules in 2024–2025
and most write-ups of "build your own timeline" are now out of date.

| Source | How it connects | Gives you *when* | Gives you *where* |
|---|---|---|---|
| **Location Timeline** | File import | ✅ | ✅ |
| **Photo files** | File import, EXIF read in-browser | ✅ | ✅ (when the photo has GPS) |
| **Gmail** | Live OAuth | ✅ | ❌ |
| **Google Photos** | Live OAuth (Picker API) | ✅ | ❌ (Google strips GPS) |

The two hard constraints:

- **There is no location API.** Google retired the Location History API and
  moved Timeline to on-device storage. The only way to get your location
  history is to export it yourself — which is why that source is a file import
  and not a button that says "Connect".
- **There is no whole-library photo API.** Since March 2025 the Photos Library
  API only returns media the calling app created. The Picker API is the
  replacement: you choose the items, and it hands back metadata with the GPS
  removed.

So: **import the Location Timeline export first.** Everything else decorates a
map that only it can draw.

## Getting your data in

### Location Timeline (do this one first)

On your iPhone: **Google Maps → your profile picture → Your Timeline → ⋯ →
Location & privacy settings → Export Timeline data**. You get a `.json` file.
Open the app, go to **Sources → Location Timeline**, and drop it in.

Old **Takeout** archives work too — drop the whole `.zip`, or individual
`Records.json` / `Semantic Location History` files. All three historical formats
are parsed. `Records.json` is read as a stream, so a multi-gigabyte file will
not take the tab down with it; raw GPS fixes are segmented into stays and
journeys on the way in.

### Photos

Two routes, and they do different things:

- **Photo files** — pick or drop the image files. EXIF is read in the browser,
  so you get capture time *and* GPS. Originals are never copied; a 320px
  thumbnail and the metadata are kept.
- **Google Photos** — opens Google's picker. Convenient, but timestamps only.

### Gmail

Needs a one-time OAuth setup — see **[docs/GOOGLE_SETUP.md](docs/GOOGLE_SETUP.md)**.
Only headers are requested (`format=metadata`): sender, subject, date. Bodies
are never fetched. Promotions, social, updates and forums are filtered out, so
the timeline shows correspondence rather than newsletters.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run build      # static files in dist/
npm run preview
npm test           # parser, geometry and streaming tests
npm run test:e2e   # drives the built app in Chromium at iPhone viewport
```

### Getting it onto the iPhone

Safari will only install a PWA served over HTTPS, so `dist/` needs a host —
any static host will do (Vercel, Netlify, GitHub Pages, Cloudflare Pages).
Then on the phone: open the URL in **Safari → Share → Add to Home Screen**.

Hosting the static files does not put your data anywhere: the host serves HTML,
CSS and JavaScript, and every byte of your timeline is produced and stored on
the phone. Add the deployed origin to your OAuth client's authorized JavaScript
origins (see the setup doc) if you want Gmail and Photos to work there too.

## Privacy, concretely

- Everything is in IndexedDB on the device. **Sources → Settings** shows how
  much space it uses and erases it — by source or entirely.
- Access tokens live in `sessionStorage`, never in the database, and are
  revoked when you remove a source.
- Gmail is read with `format=metadata`. There is no code path that fetches a
  message body.
- The map draws **no basemap by default**. Raster tiles would tell a tile server
  which squares of earth you are looking at; turn them on in Settings if you
  want them, and the attribution appears when you do.
- The service worker caches the app shell only. Photo bytes are never precached.

## How it's put together

```
src/
  lib/
    model.ts         One normalized event shape for every source
    db.ts            IndexedDB store + per-day rollups
    geo.ts           Haversine (km), Mercator projection, path simplification
    time.ts          Day keys in the event's own timezone
    json-stream.ts   Streaming array extractor for gigabyte JSON
  sources/
    google-auth.ts   Browser-only OAuth (GIS token client, no secret)
    gmail.ts         Live OAuth, header metadata only
    photos-picker.ts Live OAuth, Picker API sessions
    timeline-parse.ts  All three Google location export formats
    timeline-import.ts File/zip orchestration, streaming for Records.json
    exif-import.ts   EXIF time + GPS, thumbnails, in-browser
  components/
    DayStory.tsx     The day view
    MiniMap.tsx      SVG route map
    YearGrid.tsx     Sequential heatmap, a decade per screen
    Sources.tsx      Import, connect, settings
```

Adapters are the only source-aware code. Each one reduces to `TimelineEvent`,
and the UI never knows where a day's contents came from — adding a source means
writing one adapter and nothing else.

### Two details worth knowing

**Days are local to where you were.** Each event carries the UTC offset it
happened at, so a 9pm dinner in Tokyo files under the Tokyo day rather than the
day it was back home. Where an export omits the offset, it is estimated from
longitude — wrong near some borders, much better than the alternative.

**The year heatmap steps by quantile, not by range.** A handful of flights would
otherwise flatten every ordinary day onto the same step.

## Colour

Charts follow a validated palette: sequential blue for the heatmap, and
categorical slots 1–3 (blue / orange / aqua) for the map's three mark types,
which is the largest set that clears the all-pairs colour-vision-deficiency
floors. Every chart carries a legend and a table view, so nothing is readable
by colour alone. Tokens are defined once in `src/styles.css`.
