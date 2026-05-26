// Electron entry point for Neon Crusade.
//
// Two modes:
//
//   1. Dev mode (`npm start`, app.isPackaged === false)
//      → Loads ./game.html directly from disk.
//      → File watcher auto-reloads the window on every save (no Cmd+R needed).
//      → No network calls.
//
//   2. Production mode (the packaged .app)
//      → On launch, fetches the latest game.html from GitHub raw and caches it
//        to ~/Library/Application Support/Neon Crusade/game.html.
//      → Falls back to the cached copy if offline.
//      → Falls back to the bundled copy (frozen at build time) if no cache exists.
//      → This means every `git push` to the configured repo's main/master branch
//        ships to the installed .app on the next launch — no rebuild required.
//
// main.js itself is frozen at build time. To change behavior in this file
// (window size, hotkeys, update source) you must rebuild + reinstall the .app.

const { app, BrowserWindow, Menu, globalShortcut, net, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Steam integration ───────────────────────────────────────────────────────
// Tries to initialize the Steam API on launch. App ID lives in steam_appid.txt
// at the project root (480 = Spacewar, Steam's public test app — swap to your
// real App ID after Steam Direct approval).
//
// Every IPC handler is wrapped so a failed/missing Steam init just no-ops
// quietly. The game runs identically whether Steam is connected or not.
const STEAM_APP_ID = (() => {
  try { return parseInt(fs.readFileSync(path.join(__dirname, 'steam_appid.txt'), 'utf8').trim(), 10) || 480; }
  catch (_) { return 480; }
})();

let steam = null;          // initialized steamworks client, or null if unavailable
let steamReady = false;
try {
  const steamworks = require('steamworks.js');
  steam = steamworks.init(STEAM_APP_ID);
  steamReady = true;
  console.log(`[steam] initialized for AppID ${STEAM_APP_ID}, user: ${steam.localplayer.getName()}`);
} catch (e) {
  console.log('[steam] not available —', e.message);
  steam = null;
}

// ── IPC handlers — all guarded by `steamReady` so they're safe no-ops ───────
ipcMain.handle('steam:available', () => steamReady);
ipcMain.handle('steam:user-name', () => steamReady ? steam.localplayer.getName() : '');

ipcMain.on('steam:achievement-unlock', (_, apiName) => {
  if (!steamReady || !apiName) return;
  try { steam.achievement.activate(apiName); }
  catch (e) { console.warn('[steam] achievement-unlock failed:', apiName, e.message); }
});

ipcMain.on('steam:achievement-clear-all', () => {
  if (!steamReady) return;
  // Iterates known achievements and clears each — steamworks.js doesn't have
  // a single "clear all" call. For testing only.
  try {
    const names = steam.achievement.getAchievementNames?.() || [];
    for (const n of names) steam.achievement.clear(n);
  } catch (e) { console.warn('[steam] clear-all failed:', e.message); }
});

ipcMain.on('steam:rich-presence-set', (_, { key, value }) => {
  if (!steamReady || !key) return;
  try { steam.localplayer.setRichPresence(key, value == null ? '' : String(value)); }
  catch (e) { console.warn('[steam] rich-presence failed:', key, e.message); }
});

ipcMain.on('steam:rich-presence-clear', () => {
  if (!steamReady) return;
  try { steam.localplayer.setRichPresence('status', ''); }
  catch (e) { console.warn('[steam] rich-presence-clear failed:', e.message); }
});

ipcMain.handle('steam:cloud-write', (_, { filename, data }) => {
  if (!steamReady || !filename) return false;
  try { return !!steam.cloud.writeFile(filename, data); }
  catch (e) { console.warn('[steam] cloud-write failed:', filename, e.message); return false; }
});

ipcMain.handle('steam:cloud-read', (_, filename) => {
  if (!steamReady || !filename) return null;
  try { return steam.cloud.readFile(filename); }
  catch (e) { console.warn('[steam] cloud-read failed:', filename, e.message); return null; }
});

ipcMain.handle('steam:cloud-exists', (_, filename) => {
  if (!steamReady || !filename) return false;
  try { return !!steam.cloud.fileExists?.(filename); }
  catch (_) { return false; }
});

// Disable Chromium's autoplay gesture requirement so the title-screen music
// can start the moment the window loads, without waiting for a click or keypress.
// Safe inside Electron because the user already chose to launch this app —
// the "user gesture" the browser is guarding against has effectively happened.
// Must be called before app.whenReady() resolves.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── Auto-update configuration ────────────────────────────────────────────────
// Flip STEAM_BUILD to true before running `npm run dist:steam` (or whatever
// build script targets the Steam depot). When true, the GitHub auto-fetch is
// completely disabled and the app always loads its bundled game.html — Steam
// handles version updates through its own depot/patch system, and this avoids
// version mismatch between the bundled main.js and a freshly-fetched
// game.html that may have been written against a newer main.js.
//
// Leave false for personal/local distributable builds where you want git-push
// to deliver gameplay updates without rebuilding the .app.
const STEAM_BUILD = false;

const UPDATE_REPO = 'nathan-ewing/Game';   // GitHub user/repo (must be public)
const UPDATE_FILE = 'game.html';            // file to fetch from the repo root
const FETCH_TIMEOUT_MS = 3500;              // give up if GitHub doesn't respond in time

// ── Single-instance lock ─────────────────────────────────────────────────────
// Re-launching brings the existing window forward instead of opening a duplicate.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

let mainWindow = null;

// ── Window-bounds persistence ───────────────────────────────────────────────
// Remembers size + position + maximized state across launches so the player
// doesn't lose their layout every time. Stored in userData/window-state.json.
function getWindowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}
function loadWindowState() {
  try {
    const raw = fs.readFileSync(getWindowStatePath(), 'utf8');
    const s = JSON.parse(raw);
    // Defensive validation — bail if any field looks corrupted
    if (typeof s.width !== 'number' || typeof s.height !== 'number') return null;
    if (s.width < 600 || s.height < 400) return null;
    return s;
  } catch (_) { return null; }
}
function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const state = win.isMaximized()
      ? { ...win.getNormalBounds(), maximized: true }
      : { ...win.getBounds(), maximized: false };
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state));
  } catch (_) { /* fail silently — not worth bothering the player */ }
}

async function createWindow() {
  const saved = loadWindowState();
  mainWindow = new BrowserWindow({
    width:    saved?.width  || 1280,
    height:   saved?.height || 800,
    x:        saved?.x,
    y:        saved?.y,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#000000',
    title: 'Neon Crusade',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  Menu.setApplicationMenu(null);

  const pageToLoad = await resolveGameHtmlPath();
  // Dev console is gated in game.html behind ?dev=1. When running unpackaged
  // (npm start) we auto-pass the flag so the developer always has access.
  // Packaged Steam builds never get the flag — dev console stays hidden.
  if (!app.isPackaged) {
    mainWindow.loadFile(pageToLoad, { query: { dev: '1' } });
  } else {
    mainWindow.loadFile(pageToLoad);
  }

  mainWindow.once('ready-to-show', () => {
    if (saved && saved.maximized) mainWindow.maximize();
    mainWindow.show();
  });

  // Save bounds whenever the user resizes/moves so we can restore them next launch.
  // Debounce a touch to avoid hammering the disk during a drag.
  let _saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => saveWindowState(mainWindow), 300);
  };
  mainWindow.on('resize',    scheduleSave);
  mainWindow.on('move',      scheduleSave);
  mainWindow.on('maximize',  scheduleSave);
  mainWindow.on('unmaximize', scheduleSave);

  // External links open in the system browser, never in the game window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', () => {
    // Last-chance save before the window dies
    saveWindowState(mainWindow);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Resolve which game.html to load ──────────────────────────────────────────
async function resolveGameHtmlPath() {
  const bundledPath = path.join(__dirname, 'game.html');

  // Dev mode: bypass the update flow entirely so local edits are visible
  // immediately via the file watcher + reload pattern.
  if (!app.isPackaged) return bundledPath;

  // Steam build: no outbound network. Steam manages updates via depot patches.
  if (STEAM_BUILD) {
    console.log('[update] STEAM_BUILD=true — using bundled game.html');
    return bundledPath;
  }

  // Production mode: try GitHub → cache → bundled fallback.
  const cacheDir  = app.getPath('userData');
  const cachedPath = path.join(cacheDir, 'game.html');

  try {
    const latest = await fetchLatestGameHtml();
    if (latest) {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cachedPath, latest);
      console.log(`[update] loaded latest from GitHub (${latest.length} bytes)`);
      return cachedPath;
    }
  } catch (e) {
    console.warn('[update] fetch error:', e.message);
  }

  if (fs.existsSync(cachedPath)) {
    console.log('[update] offline — using cached version');
    return cachedPath;
  }

  console.log('[update] no cache available — using bundled fallback');
  return bundledPath;
}

// ── Fetch latest game.html from GitHub ───────────────────────────────────────
// Uses the GitHub Contents API rather than raw.githubusercontent.com because the
// raw CDN can cache a stale copy for several minutes after a push. The API
// queries git directly and reflects changes immediately. Anonymous calls are
// rate-limited to 60/hour, which is far more than this app will ever need.
// Falls back to the raw URL only if the API call itself fails (offline, rate
// limited) so we have two layers of redundancy.
async function fetchLatestGameHtml() {
  // Primary: GitHub Contents API (instant, no CDN cache, ~1MB limit)
  const apiUrl = `https://api.github.com/repos/${UPDATE_REPO}/contents/${UPDATE_FILE}`;
  try {
    const json = await fetchUrl(apiUrl, FETCH_TIMEOUT_MS);
    const data = JSON.parse(json);
    if (data && data.encoding === 'base64' && data.content) {
      const text = Buffer.from(data.content, 'base64').toString('utf8');
      if (text && text.length > 10000 && text.includes('NEON CRUSADE')) {
        return text;
      }
    }
  } catch (_) { /* fall through to raw URL fallback */ }

  // Fallback: raw URL (slower to reflect new pushes but works during API outages)
  for (const branch of ['main', 'master']) {
    const url = `https://raw.githubusercontent.com/${UPDATE_REPO}/${branch}/${UPDATE_FILE}`;
    try {
      const text = await fetchUrl(url, FETCH_TIMEOUT_MS);
      if (text && text.length > 10000 && text.includes('NEON CRUSADE')) {
        return text;
      }
    } catch (_) { /* try next */ }
  }
  return null;
}

function fetchUrl(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = net.request(url);
    const chunks = [];
    const timer = setTimeout(() => {
      try { req.abort(); } catch (_) {}
      reject(new Error('timeout'));
    }, timeoutMs);
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  await createWindow();

  // F11 → toggle fullscreen.   F12 → toggle DevTools.
  globalShortcut.register('F11', () => {
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });
  globalShortcut.register('F12', () => {
    if (mainWindow) mainWindow.webContents.toggleDevTools();
  });

  // Dev-only: auto-reload the window whenever game.html changes on disk.
  // Skipped in packaged builds (the update flow handles that side).
  if (!app.isPackaged) {
    const watchPaths = ['game.html'];
    let reloadTimer = null;
    const scheduleReload = () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload();
        }
      }, 150);
    };
    for (const rel of watchPaths) {
      try {
        fs.watch(path.join(__dirname, rel), scheduleReload);
      } catch (_) { /* file missing is fine */ }
    }
    console.log('[dev] auto-reload watching:', watchPaths.join(', '));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
