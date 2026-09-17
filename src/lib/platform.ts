/**
 * Platform facts the UI has to adapt to, all of them iOS-specific.
 *
 * An iOS home-screen web app is not a Safari tab. It gets its own storage
 * (nothing is shared with Safari, in either direction), a much larger quota,
 * and an eviction clock that only ticks on days you open it — but it also
 * cannot host a popup window, which is how Google's JavaScript OAuth library
 * asks for consent.
 */

/** True when running as an installed home-screen app rather than in a tab. */
export function isStandalone(): boolean {
  // iOS sets the non-standard navigator.standalone; everyone else reports the
  // display mode the manifest asked for.
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true
  const displayMode = ['standalone', 'fullscreen', 'minimal-ui'].some(
    (mode) => window.matchMedia(`(display-mode: ${mode})`).matches,
  )
  return iosStandalone || displayMode
}

export function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS reports as a Mac; the touch point count gives it away.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

/**
 * A popup can only carry an OAuth result back if the opener survives. In an
 * installed iOS app it does not: the consent page opens somewhere the app
 * cannot reach, and the promise never settles. Better to say so than to hang.
 */
export function canHostOAuthPopup(): boolean {
  return !(isIOS() && isStandalone())
}

/**
 * Ask the browser to exempt this origin from storage eviction. WebKit grants
 * this mainly to home-screen apps, so it is worth asking once the app is
 * installed and the user has done something deliberate.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

export async function isStoragePersisted(): Promise<boolean> {
  if (!navigator.storage?.persisted) return false
  try {
    return await navigator.storage.persisted()
  } catch {
    return false
  }
}
