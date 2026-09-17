/**
 * Where data comes in. Each adapter gets a card that says plainly what it can
 * and cannot deliver — the honest version matters here, because two of the
 * four cannot give you location no matter what you authorize.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { syncGmail } from '../sources/gmail'
import {
  clearPendingPickerSession,
  getPendingPickerSession,
  importFromPhotosPicker,
  resumePhotosPickerImport,
} from '../sources/photos-picker'
import { importLocationFiles } from '../sources/timeline-import'
import { importPhotoFiles } from '../sources/exif-import'
import { getClientId, hasToken, setClientId, signOut } from '../sources/google-auth'
import { clearAll, clearSource, stats, type StoreStats } from '../lib/db'
import { backupFilename, downloadBlob, exportBackup, importBackup } from '../lib/backup'
import { SOURCE_LABELS, type SourceId } from '../lib/model'
import { todayKey } from '../lib/time'
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme'
import {
  canHostOAuthPopup,
  isStandalone,
  isStoragePersisted,
  requestPersistentStorage,
} from '../lib/platform'

interface Job {
  card: string
  label: string
  fraction?: number
}

interface Props {
  onChanged: () => void
  showTiles: boolean
  onShowTilesChange: (value: boolean) => void
}

export function Sources({ onChanged, showTiles, onShowTilesChange }: Props) {
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [store, setStore] = useState<StoreStats | null>(null)
  const [clientId, setClientIdState] = useState(getClientId())
  const [pickerUri, setPickerUri] = useState<string | null>(null)
  const [theme, setTheme] = useState<ThemePref>(getThemePref)
  const [persisted, setPersisted] = useState(false)
  const [resumable, setResumable] = useState(false)
  // Computed once: neither can change without a reload.
  const [oauthUsable] = useState(canHostOAuthPopup)
  const [standalone] = useState(isStandalone)
  const abortRef = useRef<AbortController | null>(null)

  const refreshStats = useCallback(() => {
    stats().then(setStore)
  }, [])

  useEffect(refreshStats, [refreshStats])

  useEffect(() => {
    isStoragePersisted().then(setPersisted)
    getPendingPickerSession().then((session) => setResumable(Boolean(session)))
  }, [job])

  const run = useCallback(
    async (card: string, fn: (signal: AbortSignal) => Promise<void>) => {
      const controller = new AbortController()
      abortRef.current = controller
      setError(null)
      setDone(null)
      setJob({ card, label: 'Starting…' })
      try {
        // Asked during a deliberate action, which is when WebKit is most
        // likely to grant it. Failure is not fatal, just less durable.
        await requestPersistentStorage()
        await fn(controller.signal)
        onChanged()
        refreshStats()
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message)
        }
      } finally {
        abortRef.current = null
        setJob(null)
      }
    },
    [onChanged, refreshStats],
  )

  const busy = job !== null

  return (
    <div className="panel">
      {error && <div className="status status--error">{error}</div>}
      {done && <div className="status status--ok">{done}</div>}

      {/* ---------- Gmail ---------- */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">Gmail</span>
          <button
            className="btn btn--primary"
            disabled={busy || !oauthUsable}
            onClick={() =>
              run('gmail', async (signal) => {
                const added = await syncGmail({
                  after: '2015-01-01',
                  before: todayKey(),
                  maxMessages: 5000,
                  signal,
                  onProgress: (p) =>
                    setJob({
                      card: 'gmail',
                      label: p.label,
                      fraction: p.total ? p.fetched / p.total : undefined,
                    }),
                })
                setDone(`Added ${added.toLocaleString()} messages.`)
              })
            }
          >
            {hasToken('gmail') ? 'Sync' : 'Connect'}
          </button>
        </div>
        <p className="card__desc">
          Reads message headers only — sender, subject, date. Never message
          bodies. Promotions, social, updates and forums are skipped so the
          timeline shows correspondence rather than newsletters.
        </p>
        <p className="card__note">
          Capped at 5,000 messages per sync, newest first, from 2015 onward.
        </p>
        {!oauthUsable && <OAuthUnavailable />}
        {job?.card === 'gmail' && <Progress job={job} onCancel={() => abortRef.current?.abort()} />}
      </div>

      {/* ---------- Google Photos ---------- */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">Google Photos</span>
          <button
            className="btn btn--primary"
            disabled={busy || !oauthUsable}
            onClick={() =>
              run('photos', async (signal) => {
                const added = await importFromPhotosPicker({
                  signal,
                  onPickerUri: setPickerUri,
                  onProgress: (p) =>
                    setJob({
                      card: 'photos',
                      label: p.label,
                      fraction: p.total ? p.fetched / p.total : undefined,
                    }),
                })
                setPickerUri(null)
                setDone(`Added ${added.toLocaleString()} photos.`)
              })
            }
          >
            Pick photos
          </button>
        </div>
        <p className="card__desc">
          Opens Google's own picker and imports whatever you select, with a
          thumbnail stored locally.
        </p>
        <p className="card__note">
          Google retired whole-library API access in March 2025 — the picker is
          the only route left, and it strips GPS from everything it returns. So
          photos here contribute <em>when</em>, not <em>where</em>.
        </p>
        {!oauthUsable && <OAuthUnavailable />}
        {resumable && oauthUsable && (
          <div className="btnrow">
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                run('photos', async (signal) => {
                  const added = await resumePhotosPickerImport({
                    signal,
                    onPickerUri: setPickerUri,
                    onProgress: (p) =>
                      setJob({
                        card: 'photos',
                        label: p.label,
                        fraction: p.total ? p.fetched / p.total : undefined,
                      }),
                  })
                  setDone(`Added ${added.toLocaleString()} photos.`)
                })
              }
            >
              Resume interrupted import
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={async () => {
                await clearPendingPickerSession()
                setResumable(false)
              }}
            >
              Discard it
            </button>
          </div>
        )}
        {pickerUri && (
          <p className="card__note">
            <a href={pickerUri} target="_blank" rel="noreferrer">
              Open the picker
            </a>{' '}
            if it didn't open on its own.
          </p>
        )}
        {job?.card === 'photos' && <Progress job={job} onCancel={() => abortRef.current?.abort()} />}
      </div>

      {/* ---------- Location ---------- */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">Location Timeline</span>
        </div>
        <p className="card__desc">
          The backbone of the map. Google removed the Location History API and
          moved Timeline on-device, so this has to come from an export you hold.
        </p>
        <p className="card__note">
          On your iPhone: Google Maps → your picture → Your Timeline → ⋯ →
          Location &amp; privacy settings → Export Timeline data. Drop the
          resulting <code>.json</code> here. Old Takeout archives work too —
          drop the whole <code>.zip</code>.
        </p>
        <DropZone
          disabled={busy}
          accept=".json,.zip,application/json,application/zip"
          hint="Drop a Timeline export or Takeout .zip"
          onFiles={(files) =>
            run('timeline', async (signal) => {
              const results = await importLocationFiles(files, {
                signal,
                onProgress: (p) =>
                  setJob({ card: 'timeline', label: p.label, fraction: p.fraction }),
              })
              const total = results.reduce((sum, r) => sum + r.events, 0)
              setDone(
                total === 0
                  ? 'No location data recognized in those files.'
                  : `Imported ${total.toLocaleString()} location events.`,
              )
            })
          }
        />
        {job?.card === 'timeline' && <Progress job={job} onCancel={() => abortRef.current?.abort()} />}
      </div>

      {/* ---------- Photo files ---------- */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">Photo files</span>
        </div>
        <p className="card__desc">
          Reads capture time and GPS straight out of EXIF, in the browser. This
          is the one source that gives photos <em>and</em> places at once.
        </p>
        <p className="card__note">
          Originals are never copied — only a thumbnail and the metadata are
          kept. On iPhone, pick from the Photos sheet; on a computer you can
          drop a whole folder.
        </p>
        <DropZone
          disabled={busy}
          accept="image/*,video/*"
          multiple
          hint="Drop photos, or tap to choose"
          onFiles={(files) =>
            run('exif', async (signal) => {
              const added = await importPhotoFiles(files, {
                signal,
                onProgress: (p) =>
                  setJob({
                    card: 'exif',
                    label: p.label,
                    fraction: p.total ? p.processed / p.total : undefined,
                  }),
              })
              setDone(`Added ${added.toLocaleString()} photos.`)
            })
          }
        />
        {job?.card === 'exif' && <Progress job={job} onCancel={() => abortRef.current?.abort()} />}
      </div>

      {/* ---------- Backup ---------- */}
      <div className="card">
        <div className="card__head">
          <span className="card__title">Backup</span>
          <button
            className="btn"
            disabled={busy || (store?.events ?? 0) === 0}
            onClick={() =>
              run('backup', async () => {
                const blob = await exportBackup({
                  onProgress: (p) =>
                    setJob({ card: 'backup', label: p.label, fraction: p.fraction }),
                })
                downloadBlob(blob, backupFilename())
                setDone('Backup saved.')
              })
            }
          >
            Export
          </button>
        </div>
        <p className="card__desc">
          Everything in one file — events and thumbnails. With no server to sync
          through, this is how the timeline moves between your computer and your
          phone.
        </p>
        <p className="card__note">
          Restoring merges rather than replaces, so importing the same backup
          twice is harmless. The file is not encrypted; treat it like the photos
          it came from.
        </p>
        <DropZone
          disabled={busy}
          accept=".zip,application/zip"
          multiple={false}
          hint="Drop a backup to restore"
          onFiles={(files) =>
            run('backup', async () => {
              const result = await importBackup(files[0], {
                onProgress: (p) =>
                  setJob({ card: 'backup', label: p.label, fraction: p.fraction }),
              })
              setDone(
                `Restored ${result.events.toLocaleString()} events and ${result.thumbnails.toLocaleString()} thumbnails.`,
              )
            })
          }
        />
        {job?.card === 'backup' && (
          <Progress job={job} onCancel={() => abortRef.current?.abort()} />
        )}
      </div>

      {/* ---------- Settings ---------- */}
      <div className="card">
        <div className="card__title">Settings</div>

        <div className="field">
          <label htmlFor="client-id">Google OAuth client ID</label>
          <input
            id="client-id"
            value={clientId}
            placeholder="…apps.googleusercontent.com"
            onChange={(e) => {
              setClientIdState(e.target.value)
              setClientId(e.target.value)
            }}
          />
        </div>
        <p className="card__note">
          Needed only for Gmail and Photos. It is your own client ID, stored on
          this device; there is no server and no client secret. Setup steps are
          in <code>docs/GOOGLE_SETUP.md</code>.
        </p>

        <div className="field">
          <label htmlFor="theme">Appearance</label>
          <select
            id="theme"
            value={theme}
            onChange={(e) => {
              const next = e.target.value as ThemePref
              setTheme(next)
              setThemePref(next)
            }}
          >
            <option value="auto">Match system</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="tiles">Map basemap</label>
          <select
            id="tiles"
            value={showTiles ? 'osm' : 'none'}
            onChange={(e) => onShowTilesChange(e.target.value === 'osm')}
          >
            <option value="none">None — nothing leaves the device</option>
            <option value="osm">OpenStreetMap tiles</option>
          </select>
        </div>
        <p className="card__note">
          Tiles are fetched from openstreetmap.org as you look at a day, which
          tells that server roughly where you are looking. Off by default.
        </p>

        {store && (
          <>
            <table className="datatable">
              <tbody>
                <tr>
                  <th>Events</th>
                  <td>{store.events.toLocaleString()}</td>
                </tr>
                <tr>
                  <th>Days</th>
                  <td>{store.days.toLocaleString()}</td>
                </tr>
                <tr>
                  <th>Photos</th>
                  <td>{store.photos.toLocaleString()}</td>
                </tr>
                {store.estimatedBytes != null && (
                  <tr>
                    <th>On device</th>
                    <td>
                      {formatBytes(store.estimatedBytes)}
                      {store.quotaBytes ? ` of ${formatBytes(store.quotaBytes)}` : ''}
                    </td>
                  </tr>
                )}
                <tr>
                  <th>Eviction</th>
                  <td>
                    {persisted
                      ? 'Protected'
                      : standalone
                        ? 'Not protected yet — import something'
                        : 'Install to the Home Screen to protect'}
                  </td>
                </tr>
              </tbody>
            </table>

            <div className="btnrow">
              {(Object.keys(SOURCE_LABELS) as SourceId[])
                .filter((s) => (store.bySource[s] ?? 0) > 0)
                .map((s) => (
                  <button
                    key={s}
                    className="btn"
                    disabled={busy}
                    onClick={async () => {
                      await clearSource(s)
                      if (s === 'gmail' || s === 'photos') {
                        signOut(s === 'gmail' ? 'gmail' : 'photosPicker')
                      }
                      onChanged()
                      refreshStats()
                    }}
                  >
                    Remove {SOURCE_LABELS[s]}
                  </button>
                ))}
              <button
                className="btn btn--danger"
                disabled={busy}
                onClick={async () => {
                  if (!confirm('Delete everything stored on this device?')) return
                  await clearAll()
                  onChanged()
                  refreshStats()
                }}
              >
                Erase all data
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Installed iOS apps cannot host the consent popup Google's library opens, and
 * Google requires a client secret for the redirect alternative — which an app
 * with no server has nowhere to keep. So this says what to do instead.
 */
function OAuthUnavailable() {
  return (
    <p className="card__note">
      <strong>Not available in the installed app.</strong> iOS home-screen apps
      can't host the Google consent window, and their storage is separate from
      Safari's, so signing in there wouldn't reach this app either. Import this
      source on a computer, export a backup from there, and restore it here —
      the Backup card below does both halves.
    </p>
  )
}

function Progress({ job, onCancel }: { job: Job; onCancel: () => void }) {
  return (
    <>
      <div className="progress">
        <div
          className="progress__bar"
          style={{ width: job.fraction != null ? `${job.fraction * 100}%` : '35%' }}
        />
      </div>
      <div className="progress__label">
        {job.label}{' '}
        <button className="btn" style={{ padding: '2px 8px' }} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  )
}

function DropZone({
  onFiles,
  hint,
  accept,
  multiple = true,
  disabled,
}: {
  onFiles: (files: File[]) => void
  hint: string
  accept: string
  multiple?: boolean
  disabled?: boolean
}) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <>
      <div
        className={`drop ${over ? 'drop--over' : ''}`}
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          if (disabled) return
          const files = [...e.dataTransfer.files]
          if (files.length) onFiles(files)
        }}
      >
        {hint}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          if (files.length) onFiles(files)
          e.target.value = ''
        }}
      />
    </>
  )
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
