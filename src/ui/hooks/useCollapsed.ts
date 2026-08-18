import { useEffect, useState } from 'react'

/**
 * Persist the open/closed state of a collapsible section.
 *
 * Kept UI-only: it never touches the app store or IndexedDB, only
 * localStorage — remembering panel state is a browser concern.
 */
const KEY_PREFIX = 'lab:section:'

export function useCollapsed(id: string, defaultOpen = true): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return defaultOpen
    const raw = localStorage.getItem(KEY_PREFIX + id)
    return raw === null ? defaultOpen : raw === '1'
  })

  useEffect(() => {
    try {
      localStorage.setItem(KEY_PREFIX + id, open ? '1' : '0')
    } catch {
      // localStorage full or blocked — the state still works for the session.
    }
  }, [id, open])

  return [open, setOpen]
}
