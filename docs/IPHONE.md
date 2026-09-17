# Getting this onto an iPhone

Four things stand between the repo and an icon on your Home Screen. Only the
first is a chore; the third is a genuine constraint you have to design around.

## 1. It needs an HTTPS origin

Safari will not install a web app, or run a service worker, over plain HTTP.
`localhost` is exempt, but your phone can't reach your laptop's localhost, and
your laptop's LAN address is HTTP — so the files have to be hosted.

Three configs are in the repo; pick one.

| Host | Config | URL shape |
|---|---|---|
| GitHub Pages | `.github/workflows/deploy.yml` | `https://<user>.github.io/<repo>/` |
| Vercel | `vercel.json` | `https://<project>.vercel.app` |
| Netlify | `netlify.toml` | `https://<site>.netlify.app` |

GitHub Pages is the least setup since the repo is already there: **Settings →
Pages → Source → GitHub Actions**, then push to `main`. The workflow runs the
tests, builds with the right base path, and publishes.

Hosting the files does not put your data anywhere. The host serves HTML, CSS
and JavaScript; every byte of your timeline is produced and stored on the phone.

Then on the phone: open the URL in **Safari → Share → Add to Home Screen**. It
must be Safari, and it must be the Share menu — there is no install prompt.

## 2. Storage needs to be claimed

An installed Home Screen app is treated far better than a Safari tab:

|  | Safari tab | Home Screen app |
|---|---|---|
| Quota | ~20% of disk | ~60% of disk |
| Eviction | ~7 days without interaction | idle counter only advances on days you open it |
| `storage.persist()` | usually refused | granted |

The app asks for persistent storage at the start of any import, which is when
WebKit is most willing to grant it. **Sources → Settings → Eviction** shows
whether it was. Install first, then import — doing it the other way round asks
from the weaker position.

One thing to know: **clearing Safari's history also clears the installed app's
storage.** Export a backup (below) before you do that.

## 3. Gmail and Photos can't sign in from the installed app

This is the real constraint, and it is not a bug in this app.

- An installed iOS app **cannot host the popup** Google's JavaScript library
  opens for consent. The window opens somewhere the app can't reach and the
  promise never settles — the app would just hang.
- The standard fix is a **redirect flow instead of a popup**. That is closed
  here too: Google's "Web application" client type requires a **client secret**
  at the token endpoint even with PKCE, and an app with no server has nowhere
  to keep one.
- The other obvious dodge — sign in using Safari instead — doesn't work either,
  because **an installed iOS app has completely separate storage from Safari**.
  Cookies, localStorage, IndexedDB and service workers are all isolated in both
  directions. Data you pull in via Safari simply isn't in the installed app.

So the app detects this and says so rather than hanging. What works instead:

**Ingest on a computer, carry the result over.** On a desktop browser, where
popups behave, connect Gmail and Photos and import whatever you want. Then
**Sources → Backup → Export**, which produces one `.timeline.zip` containing
every event and thumbnail. AirDrop it to the phone, and in the installed app
drop it onto **Sources → Backup**. Restoring merges rather than replaces, so
running it repeatedly is safe.

The two file-import sources — Location Timeline and photo files — work fine
directly on the phone, because they use the normal file picker rather than
OAuth. Those are also the only two that can put you on the map.

If you would rather sign in directly on the phone, that needs a small
token-exchange endpoint holding the client secret. It would only ever see the
OAuth handshake — your mail and photos would still go straight from Google to
the phone and be stored there — but it is a server, which is the thing this
build deliberately does without.

## 4. Register the deployed origin with Google

Only matters for the desktop half of the flow above. In the Cloud Console, add
your deployed origin to the OAuth client's **Authorized JavaScript origins** —
exactly, no trailing slash. See [GOOGLE_SETUP.md](GOOGLE_SETUP.md).

## Worth checking on the device

These were verified in Chromium at an iPhone viewport, not on real hardware, so
give them a look on the first run:

- The Timeline export `.json` is selectable from the Files app — if it appears
  greyed out, the `accept` attribute on that input is the thing to loosen.
- HEIC photos from the iPhone camera: EXIF reading and thumbnailing both lean
  on Safari's own HEIC decoding.
- A very large `Records.json` on the phone — the parser streams and stays under
  about 25 MB of heap, but mobile Safari is stricter than a desktop tab.
- Safe-area insets around the notch and the home indicator in standalone mode.
