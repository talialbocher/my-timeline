/**
 * Appearance. The stylesheet defines two complete token sets keyed on
 * `data-theme`, so rather than duplicate the light tokens inside a media
 * query, 'auto' is resolved here and an explicit theme is always stamped on
 * the root element.
 */
export type ThemePref = 'auto' | 'dark' | 'light'

const KEY = 'my-timeline.theme'

export function getThemePref(): ThemePref {
  const stored = localStorage.getItem(KEY)
  return stored === 'dark' || stored === 'light' ? stored : 'auto'
}

function resolve(pref: ThemePref): 'dark' | 'light' {
  if (pref !== 'auto') return pref
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function stamp(pref: ThemePref): void {
  const resolved = resolve(pref)
  document.documentElement.setAttribute('data-theme', resolved)
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'light' ? '#fcfcfb' : '#0d1117')
}

export function setThemePref(pref: ThemePref): void {
  if (pref === 'auto') localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, pref)
  stamp(pref)
}

/** Applies the stored preference and keeps 'auto' in step with the system. */
export function initTheme(): void {
  stamp(getThemePref())
  window
    .matchMedia('(prefers-color-scheme: light)')
    .addEventListener('change', () => {
      if (getThemePref() === 'auto') stamp('auto')
    })
}
