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

const { app, BrowserWindow, Menu, globalShortcut, net } = require('electron');
const path = require('path');
const fs = require('fs');

// Disable Chromium's autoplay gesture requirement so the title-screen music
// can start the moment the window loads, without waiting for a click or keypress.
// Safe inside Electron because the user already chose to launch this app —
// the "user gesture" the browser is guarding against has effectively happened.
// Must be called before app.whenReady() resolves.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── Auto-update configuration ────────────────────────────────────────────────
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

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#000000',
    title: 'Neon Crusade',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  Menu.setApplicationMenu(null);

  const pageToLoad = await resolveGameHtmlPath();
  mainWindow.loadFile(pageToLoad);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // External links open in the system browser, never in the game window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
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
