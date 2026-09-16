import { useEffect, useState } from 'react'
import { getBlob } from '../lib/db'
import type { PhotoEvent } from '../lib/model'
import { clockTime } from '../lib/time'

/**
 * Thumbnails live as blobs in IndexedDB. Object URLs are minted on mount and
 * revoked on unmount — a decade of photos would otherwise leak the whole
 * library into memory as you scroll.
 */
export function Thumb({ photo, onOpen }: { photo: PhotoEvent; onOpen?: () => void }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let revoked = false
    let objectUrl: string | null = null

    if (photo.thumbKey) {
      getBlob(photo.thumbKey).then((blob) => {
        if (!blob || revoked) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
    }

    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [photo.thumbKey])

  return (
    <button className="thumb" onClick={onOpen} title={photo.filename}>
      {url ? (
        <img src={url} alt={photo.filename} loading="lazy" decoding="async" />
      ) : (
        <span className="thumb__fallback">{photo.isVideo ? '▶' : '🖼'}</span>
      )}
      <span className="thumb__badge">{clockTime(photo.start, photo.tzOffsetMin)}</span>
    </button>
  )
}
