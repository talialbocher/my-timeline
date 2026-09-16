/**
 * Browser-only Google OAuth via Google Identity Services.
 *
 * There is no server in this app and therefore no client secret: GIS issues
 * short-lived access tokens directly to the page for a "Web application" OAuth
 * client. Tokens are held in memory and mirrored to sessionStorage so a reload
 * mid-sync doesn't force a re-consent; they are never written to IndexedDB and
 * never leave the device except back to Google.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client'

export const SCOPES = {
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  photosPicker: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
} as const

export type ScopeName = keyof typeof SCOPES

interface TokenRecord {
  token: string
  expiresAt: number
  scope: string
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string
            scope: string
            prompt?: string
            callback: (resp: { access_token?: string; expires_in?: number; scope?: string; error?: string }) => void
            error_callback?: (err: { type?: string; message?: string }) => void
          }): { requestAccessToken(overrides?: { prompt?: string }): void }
          revoke(token: string, done?: () => void): void
        }
      }
    }
  }
}

const CLIENT_ID_KEY = 'my-timeline.google-client-id'
const TOKEN_KEY_PREFIX = 'my-timeline.token.'

export function getClientId(): string {
  return (
    localStorage.getItem(CLIENT_ID_KEY) ??
    (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ??
    ''
  )
}

export function setClientId(id: string): void {
  localStorage.setItem(CLIENT_ID_KEY, id.trim())
}

let gisReady: Promise<void> | null = null

function loadGis(): Promise<void> {
  if (gisReady) return gisReady
  gisReady = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve()
    const el = document.createElement('script')
    el.src = GIS_SRC
    el.async = true
    el.defer = true
    el.onload = () => resolve()
    el.onerror = () =>
      reject(new Error('Could not load Google Identity Services. Check your connection.'))
    document.head.appendChild(el)
  })
  return gisReady
}

function cached(scopeName: ScopeName): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY_PREFIX + scopeName)
    if (!raw) return null
    const rec = JSON.parse(raw) as TokenRecord
    // Refresh a minute early so a long page of results can't expire mid-flight.
    if (rec.expiresAt - 60_000 < Date.now()) return null
    return rec.token
  } catch {
    return null
  }
}

function remember(scopeName: ScopeName, rec: TokenRecord): void {
  try {
    sessionStorage.setItem(TOKEN_KEY_PREFIX + scopeName, JSON.stringify(rec))
  } catch {
    /* Private mode; the in-flight token still works for this session. */
  }
}

export function hasToken(scopeName: ScopeName): boolean {
  return cached(scopeName) !== null
}

export function signOut(scopeName: ScopeName): void {
  const token = cached(scopeName)
  sessionStorage.removeItem(TOKEN_KEY_PREFIX + scopeName)
  if (token) window.google?.accounts.oauth2.revoke(token)
}

/**
 * Returns a valid access token, prompting for consent only when there isn't a
 * live one. `interactive: false` refuses to open a popup, so background work
 * can degrade quietly instead of ambushing you with a consent window.
 */
export async function getAccessToken(
  scopeName: ScopeName,
  opts: { interactive?: boolean } = {},
): Promise<string> {
  const { interactive = true } = opts
  const existing = cached(scopeName)
  if (existing) return existing
  if (!interactive) throw new Error('Not signed in')

  const clientId = getClientId()
  if (!clientId) {
    throw new Error(
      'No Google OAuth client ID configured. Add one in Settings — see docs/GOOGLE_SETUP.md.',
    )
  }

  await loadGis()
  const scope = SCOPES[scopeName]

  return new Promise<string>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error ?? 'Authorization was dismissed.'))
          return
        }
        const rec: TokenRecord = {
          token: resp.access_token,
          expiresAt: Date.now() + (resp.expires_in ?? 3600) * 1000,
          scope: resp.scope ?? scope,
        }
        remember(scopeName, rec)
        resolve(rec.token)
      },
      error_callback: (err) => {
        reject(new Error(err.message ?? 'Authorization failed.'))
      },
    })
    client.requestAccessToken({ prompt: '' })
  })
}

/** Fetch against a Google API with the right bearer token and useful errors. */
export async function googleFetch(
  scopeName: ScopeName,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAccessToken(scopeName)
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  })
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY_PREFIX + scopeName)
    throw new Error('Google rejected the token. Sign in again.')
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      detail = body.error?.message ?? ''
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
  }
  return res
}
