// electron/main.js — Electron main process for DevLab desktop app
// Uses CommonJS (Electron's native module system)
const { app, BrowserWindow, Menu, shell, ipcMain, dialog, Tray, nativeImage, session } = require('electron');
const path = require('path');
const { createServer } = require('http');
const { spawn } = require('child_process');
const net = require('net');

// ── Config ─────────────────────────────────────────────────────────────────────
const UI_PORT = 4321;
const APP_ROOT = path.join(__dirname, '..');
const isDev = process.env.NODE_ENV === 'development';

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverReady = false;

function allowVoicePermissions() {
  const ses = session.defaultSession;
  if (!ses) return;

  ses.setPermissionCheckHandler((_webContents, permission) => (
    permission === 'media' || permission === 'audioCapture' || permission === 'microphone'
  ));

  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = permission === 'media' || permission === 'audioCapture' || permission === 'microphone';
    callback(allowed);
  });
}

// ── Check if port is in use ───────────────────────────────────────────────────
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(port);
  });
}

// ── Wait for server to be ready ───────────────────────────────────────────────
function waitForServer(url, maxMs = 15000) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const start = Date.now();
    const check = () => {
      http.get(url, (res) => {
        if (res.statusCode < 500) resolve();
        else retry();
      }).on('error', retry);
    };
    const retry = () => {
      if (Date.now() - start > maxMs) return reject(new Error('Server start timeout'));
      setTimeout(check, 300);
    };
    check();
  });
}

// ── Start Express/WS server ───────────────────────────────────────────────────
async function startServer() {
  const free = await isPortFree(UI_PORT);
  if (!free) {
    console.log(`Port ${UI_PORT} already in use — assuming server already running`);
    return;
  }

  return new Promise((resolve, reject) => {
    // Spawn the Node server as a child process (keeps it isolated from Electron's V8)
    serverProcess = spawn(process.execPath, [
      path.join(APP_ROOT, 'electron', 'server-entry.js'),
    ], {
      cwd: APP_ROOT,
      env: { ...process.env, UI_PORT: String(UI_PORT), ELECTRON_APP: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProcess.stdout.on('data', (d) => {
      const line = d.toString();
      if (line.includes('running at') || line.includes('localhost:')) {
        serverReady = true;
        resolve();
      }
    });

    serverProcess.stderr.on('data', (d) => console.error('[server]', d.toString()));
    serverProcess.on('error', reject);
    serverProcess.on('exit', (code) => {
      if (!serverReady) reject(new Error(`Server exited with code ${code}`));
    });

    // Fallback: wait up to 12s
    setTimeout(() => { serverReady = true; resolve(); }, 12000);
  });
}

// ── Create main window ────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f0f0f',
    show: false,
    icon: getAppIcon(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: !isDev,
    },
  });

  // Show loading screen first
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('closed', () => { mainWindow = null; });

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

// ── App icon helper ───────────────────────────────────────────────────────────
function getAppIcon() {
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, 'assets', 'icon.ico')
    : process.platform === 'darwin'
    ? path.join(__dirname, 'assets', 'icon.icns')
    : path.join(__dirname, 'assets', 'icon.png');
  try {
    return nativeImage.createFromPath(iconPath);
  } catch {
    return undefined;
  }
}

// ── App menu ──────────────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Project Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openDirectory'],
              title: 'Open Project',
            });
            if (!result.canceled && result.filePaths.length > 0) {
              const projectPath = result.filePaths[0];
              mainWindow.loadURL(`http://localhost:${UI_PORT}?project=${encodeURIComponent(projectPath)}`);
            }
          },
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(isDev ? [{ role: 'toggleDevTools' }] : []),
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin' ? [
          { type: 'separator' },
          { role: 'front' },
        ] : [{ role: 'close' }]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'DevLab on GitHub',
          click: () => shell.openExternal('https://github.com'),
        },
        {
          label: 'Toggle Developer Tools',
          accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('get-app-path', () => APP_ROOT);
ipcMain.handle('open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Open Project Folder',
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('get-platform', () => process.platform);

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  allowVoicePermissions();
  buildMenu();
  createWindow();

  try {
    await startServer();
    // Load the actual app
    if (mainWindow) {
      await mainWindow.loadURL(`http://localhost:${UI_PORT}`);
    }
  } catch (err) {
    console.error('Failed to start server:', err);
    if (mainWindow) {
      mainWindow.loadFile(path.join(__dirname, 'error.html'));
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    cleanup();
    app.quit();
  }
});

app.on('before-quit', cleanup);

function cleanup() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}
