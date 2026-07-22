'use strict';

// הגדלת מאגר ה-I/O threads של libuv (משותף לכל התהליך כולל workers) — לפני כל שימוש ב-fs.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '24';

const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;
let activeWorker = null;
let tray = null;

const ICON_PATH = path.join(__dirname, 'build', 'icon.ico');

// ---------- אחסון סריקות שמורות ----------
const SCANS_DIR = path.join(app.getPath('userData'), 'scans');
const INDEX_FILE = path.join(SCANS_DIR, 'index.json');

function ensureScansDir() {
  try { fs.mkdirSync(SCANS_DIR, { recursive: true }); } catch (_) {}
}
function sanitizeId(id) {
  return String(id).replace(/[^A-Za-z0-9]/g, '') || 'x';
}
function scanFilePath(driveId, prev) {
  return path.join(SCANS_DIR, sanitizeId(driveId) + (prev ? '.prev' : '') + '.json');
}
function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch (_) { return {}; }
}
function writeIndex(idx) {
  try { fs.writeFileSync(INDEX_FILE, JSON.stringify(idx), 'utf8'); } catch (_) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0f1419',
    title: 'ניהול אחסון',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // סגירת החלון מסתירה ל-tray (האפליקציה ממשיכה לרוץ); יציאה אמיתית דרך התפריט.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    terminateWorker();
  });
}

function showWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  try {
    let image = nativeImage.createFromPath(ICON_PATH);
    if (image.isEmpty()) return;
    tray = new Tray(image);
    tray.setToolTip('ניהול אחסון');
    const menu = Menu.buildFromTemplate([
      { label: 'הצג את ניהול אחסון', click: showWindow },
      { label: 'בדוק עדכונים', click: () => { if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); showWindow(); } },
      { type: 'separator' },
      { label: 'יציאה', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(menu);
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
  } catch (_) {}
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  setupAutoUpdater();
  if (app.isPackaged) {
    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 3000);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { app.isQuitting = true; });

// לא יוצאים אוטומטית כשהחלון נסגר — נשארים ב-tray עד יציאה מפורשת.
app.on('window-all-closed', () => {
  if (process.platform === 'darwin' && app.isQuitting) app.quit();
});

// ---------- עדכונים אוטומטיים (electron-updater) ----------
function sendUpdateStatus(status, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', Object.assign({ status }, data || {}));
  }
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
  autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info && info.version }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus('none'));
  autoUpdater.on('error', (err) => sendUpdateStatus('error', { message: String(err && err.message ? err.message : err) }));
  autoUpdater.on('download-progress', (p) => sendUpdateStatus('progress', { percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('downloaded', { version: info && info.version }));
}

ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) return { ok: false, dev: true };
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});
ipcMain.handle('download-update', async () => {
  try { await autoUpdater.downloadUpdate(); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});
ipcMain.handle('install-update', () => { app.isQuitting = true; autoUpdater.quitAndInstall(); });

// ---------- מניית כוננים דרך PowerShell ----------
function listDrives() {
  return new Promise((resolve) => {
    // Get-CimInstance Win32_LogicalDisk → DeviceID, Size, FreeSpace, VolumeName, DriveType
    const psScript =
      'Get-CimInstance Win32_LogicalDisk | ' +
      'Select-Object DeviceID, Size, FreeSpace, VolumeName, DriveType | ' +
      'ConvertTo-Json -Compress';

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) {
          resolve([]);
          return;
        }
        try {
          let parsed = JSON.parse(stdout);
          if (!Array.isArray(parsed)) parsed = [parsed];
          const driveTypeName = (t) => {
            switch (Number(t)) {
              case 2: return 'נשלף';       // Removable
              case 3: return 'קבוע';        // Local disk
              case 4: return 'רשת';         // Network
              case 5: return 'תקליטור';     // CD-ROM
              default: return 'אחר';
            }
          };
          const drives = parsed
            .filter((d) => d && d.DeviceID)
            .map((d) => {
              const size = Number(d.Size) || 0;
              const free = Number(d.FreeSpace) || 0;
              return {
                id: d.DeviceID,               // "C:"
                path: d.DeviceID + '\\',      // "C:\"
                label: d.VolumeName || '',
                total: size,
                free: free,
                used: Math.max(0, size - free),
                typeName: driveTypeName(d.DriveType),
                driveType: Number(d.DriveType)
              };
            })
            // רק כוננים עם קיבולת אמיתית (מסנן כונני רשת/תקליטור ריקים)
            .filter((d) => d.total > 0);
          resolve(drives);
        } catch (e) {
          resolve([]);
        }
      }
    );
  });
}

ipcMain.handle('list-drives', async () => {
  return await listDrives();
});

// ---------- פתיחה בסייר Windows ----------
ipcMain.handle('open-in-explorer', async (_evt, targetPath) => {
  if (!targetPath || typeof targetPath !== 'string') return { ok: false };
  try {
    // showItemInFolder מסמן את הפריט בתוך התיקייה המכילה אותו
    shell.showItemInFolder(targetPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// ---------- שמירה/טעינה של סריקות ----------
// שומר עץ סריקה לכונן, ומגלגל את הסריקה הקודמת (עבור השוואה).
ipcMain.handle('save-scan', async (_evt, payload) => {
  try {
    ensureScansDir();
    const { driveId, displayName, rootPath, totalSize, scannedAt, tree } = payload;
    const curFile = scanFilePath(driveId, false);
    const prevFile = scanFilePath(driveId, true);

    // גלגול: הסריקה הנוכחית הופכת ל"קודמת"
    let hadPrev = false;
    if (fs.existsSync(curFile)) {
      try { fs.copyFileSync(curFile, prevFile); hadPrev = true; } catch (_) {}
    }

    fs.writeFileSync(curFile, JSON.stringify({ meta: { driveId, displayName, rootPath, totalSize, scannedAt }, tree }), 'utf8');

    const idx = readIndex();
    idx[sanitizeId(driveId)] = { driveId, displayName, rootPath, totalSize, scannedAt, hasPrev: hadPrev || (idx[sanitizeId(driveId)] && idx[sanitizeId(driveId)].hasPrev) || false };
    writeIndex(idx);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('list-scans', async () => {
  return readIndex();
});

ipcMain.handle('load-scan', async (_evt, driveId) => {
  try {
    const data = JSON.parse(fs.readFileSync(scanFilePath(driveId, false), 'utf8'));
    return { ok: true, meta: data.meta, tree: data.tree };
  } catch (e) {
    return { ok: false, error: 'לא נמצאה סריקה שמורה' };
  }
});

ipcMain.handle('load-prev-scan', async (_evt, driveId) => {
  try {
    const data = JSON.parse(fs.readFileSync(scanFilePath(driveId, true), 'utf8'));
    return { ok: true, meta: data.meta, tree: data.tree };
  } catch (e) {
    return { ok: false };
  }
});

// ---------- סריקה דרך worker_thread ----------
function terminateWorker() {
  if (activeWorker) {
    const w = activeWorker;
    activeWorker = null;
    // בקשה מסודרת לעצור (הורגת את robocopy ומנקה קבצים זמניים), ואז terminate כגיבוי
    try { w.postMessage({ cancel: true }); } catch (_) {}
    setTimeout(() => { try { w.terminate(); } catch (_) {} }, 800);
  }
}

ipcMain.handle('scan-cancel', async () => {
  terminateWorker();
  return { ok: true };
});

ipcMain.handle('scan-start', async (_evt, rootPath) => {
  terminateWorker();

  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'scanner-worker.js'), {
      workerData: { rootPath },
      env: { ...process.env, UV_THREADPOOL_SIZE: '24' }
    });
    activeWorker = worker;

    worker.on('message', (msg) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (msg.type === 'progress') {
        mainWindow.webContents.send('scan-progress', msg);
      } else if (msg.type === 'done') {
        mainWindow.webContents.send('scan-progress', { type: 'progress', done: true });
        resolve({ ok: true, tree: msg.tree });
        if (activeWorker === worker) activeWorker = null;
      } else if (msg.type === 'error') {
        resolve({ ok: false, error: msg.error });
        if (activeWorker === worker) activeWorker = null;
      }
    });

    worker.on('error', (err) => {
      resolve({ ok: false, error: String(err && err.message ? err.message : err) });
      if (activeWorker === worker) activeWorker = null;
    });

    worker.on('exit', (code) => {
      if (activeWorker === worker) activeWorker = null;
      if (code !== 0) {
        resolve({ ok: false, error: 'הסריקה הופסקה או נכשלה (קוד ' + code + ')' });
      }
    });
  });
});
