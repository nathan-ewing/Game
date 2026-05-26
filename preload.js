// Electron preload — exposes a small Steam API to the renderer (game.html)
// via contextBridge. All actual Steam calls happen in the main process; this
// file is just the safe IPC surface the renderer can reach.
//
// Every method is fire-and-forget (ipcRenderer.send) or returns a Promise
// (ipcRenderer.invoke). If Steam isn't initialized in the main process,
// the handlers there are no-ops, so the renderer never has to care whether
// Steam is actually connected — it just calls and the game keeps working.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('steam', {
  // ─── Availability ─────────────────────────────────────────────────────────
  // Returns true if Steam initialized successfully (user has Steam running,
  // owns the game on their account, etc.). False everywhere else — Web,
  // standalone-launched .app, dev with Steam off, etc.
  isAvailable: () => ipcRenderer.invoke('steam:available'),

  // Steam account name of the local user (for UI flair, e.g. "Welcome back, X").
  getUserName: () => ipcRenderer.invoke('steam:user-name'),

  // ─── Achievements ─────────────────────────────────────────────────────────
  // Unlock by Steam API name. Idempotent — Steam silently no-ops a re-unlock.
  unlockAchievement: (steamApiName) =>
    ipcRenderer.send('steam:achievement-unlock', steamApiName),

  // Clear all achievements (for testing).
  clearAchievements: () => ipcRenderer.send('steam:achievement-clear-all'),

  // ─── Rich Presence ────────────────────────────────────────────────────────
  // Sets a key/value displayed in the user's Steam friends list.
  // Special key 'steam_display' selects a localization token from the
  // game's RichPresenceLocalization file (configured on Steamworks side).
  setRichPresence: (key, value) =>
    ipcRenderer.send('steam:rich-presence-set', { key, value }),

  // Clears all rich-presence keys for the current session.
  clearRichPresence: () => ipcRenderer.send('steam:rich-presence-clear'),

  // ─── Cloud Saves ──────────────────────────────────────────────────────────
  // Write/read a file to/from Steam Cloud. File appears in the player's
  // Steam Cloud directory and is synced across their devices.
  cloudWrite: (filename, data) =>
    ipcRenderer.invoke('steam:cloud-write', { filename, data }),
  cloudRead:  (filename) =>
    ipcRenderer.invoke('steam:cloud-read', filename),
  cloudExists: (filename) =>
    ipcRenderer.invoke('steam:cloud-exists', filename),
});
