/**
 * Adapter interfaces with no implementation yet (V2 §2). They exist so the
 * shapes are settled NOW, and a backend developer implements against a frozen
 * contract instead of refactoring the app.
 */

/** Authentication — the local app is single-user and needs none. */
export interface AuthAdapter {
  currentUser(): Promise<{ id: string; label: string } | null>
  signIn(): Promise<void>
  signOut(): Promise<void>
}

/** The local implementation: one anonymous user, always signed in. */
export const localAuth: AuthAdapter = {
  currentUser: () => Promise.resolve({ id: 'local', label: 'Local user' }),
  signIn: () => Promise.resolve(),
  signOut: () => Promise.resolve(),
}

/**
 * Order execution — INTERFACE ONLY, deliberately unimplemented.
 * The product is SIMULATION ONLY; no code in this repository places orders.
 * The interface exists so the boundary is drawn where it will one day matter.
 */
export interface ExecutionAdapter {
  placeOrder(order: unknown): Promise<never>
  modifyOrder(id: string, patch: unknown): Promise<never>
  cancelOrder(id: string): Promise<never>
  positions(): Promise<never>
}

/** Notifications: browser today; webhook / email / Telegram behind a relay later. */
export interface NotifierAdapter {
  notify(title: string, body: string): Promise<boolean>
  capabilities(): { channels: string[] }
}

export const browserNotifier: NotifierAdapter = {
  async notify(title, body) {
    if (typeof Notification === 'undefined') return false
    if (Notification.permission === 'default') await Notification.requestPermission()
    if (Notification.permission !== 'granted') return false
    new Notification(title, { body })
    return true
  },
  capabilities: () => ({ channels: ['browser'] }),
}
