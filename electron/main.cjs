const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, autoUpdater } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const archiver = require('archiver');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const isDev = !app.isPackaged;
const isWindows = process.platform === 'win32';

let mainWindow = null;
let tray = null;
let isQuitting = false;
let hasShownTrayHint = false;
let lastRendererRecoveryAt = 0;

function getWindowIconPath() {
    if (process.platform === 'darwin') {
        return undefined; // macOS uses the app bundle icon
    }
    return path.join(__dirname, '..', 'public', 'favicon.ico');
}

function appendMainLog(tag, message) {
    try {
        const logPath = path.join(app.getPath('userData'), 'main-process.log');
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] [${tag}] ${message}\n`;
        fs.appendFileSync(logPath, line, 'utf8');
    } catch (_) {}
}

function initServer() {
    const serverApp = express();
    serverApp.use(cors());
    serverApp.use(express.json());

    const upload = multer({ dest: path.join(app.getPath('userData'), 'uploads') });

    serverApp.get('/api/health', (req, res) => {
        res.json({ status: 'ok', platform: process.platform });
    });

    serverApp.post('/api/upload', upload.single('file'), (req, res) => {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        res.json({
            success: true,
            filename: req.file.originalname,
            path: req.file.path,
            size: req.file.size,
        });
    });

    serverApp.get('/api/download/:filename', (req, res) => {
        const filePath = path.join(app.getPath('userData'), 'uploads', req.params.filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        res.download(filePath);
    });

    return serverApp;
}

function enableNodeModeForChildProcesses() {
    // No-op: this build uses direct API calls instead of SDK subprocess
}

function firstExistingPath(paths) {
    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function findPyCharmExe() {
    const candidates = [
        path.join(process.env['ProgramFiles'] || '', 'JetBrains', 'PyCharm Community Edition', 'bin', 'pycharm64.exe'),
        path.join(process.env['ProgramFiles'] || '', 'JetBrains', 'PyCharm Professional', 'bin', 'pycharm64.exe'),
        path.join(process.env['LocalAppData'] || '', 'JetBrains', 'Toolbox', 'apps', 'PyCharm-C', 'ch-0', '*', 'bin', 'pycharm64.exe'),
        path.join(process.env['LocalAppData'] || '', 'JetBrains', 'Toolbox', 'apps', 'PyCharm-P', 'ch-0', '*', 'bin', 'pycharm64.exe'),
    ];
    for (const p of candidates) {
        if (p.includes('*')) {
            const dir = path.dirname(p);
            if (fs.existsSync(dir)) {
                const versions = fs.readdirSync(dir).filter(d => /^\d+/.test(d)).sort();
                if (versions.length > 0) {
                    const resolved = path.join(dir, versions[versions.length - 1], 'bin', 'pycharm64.exe');
                    if (fs.existsSync(resolved)) return resolved;
                }
            }
        } else if (fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}

function spawnDetached(command, args, options) {
    try {
        const child = spawn(command, args, {
            ...options,
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        return true;
    } catch (error) {
        console.error('spawnDetached failed:', error);
        return false;
    }
}

function sanitizePreviewName(name) {
    if (!name) return 'preview.html';
    const safe = String(name).replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_').substring(0, 100);
    return safe.endsWith('.html') ? safe : `${safe}.html`;
}

function showMainWindow() {
    if (!mainWindow) {
        createWindow();
        return;
    }
    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
        mainWindow.show();
    }
    mainWindow.focus();
}

function createTray() {
    const iconPath = process.platform === 'darwin'
        ? path.join(__dirname, '..', 'public', 'favicon.png')
        : path.join(__dirname, '..', 'public', 'favicon.ico');

    tray = new Tray(iconPath);
    tray.setToolTip('Claude Desktop CN');

    function refreshTrayMenu() {
        const visible = mainWindow && mainWindow.isVisible();
        const template = [
            {
                label: visible ? '\u9690\u85cf\u7a97\u53e3' : '\u663e\u793a\u7a97\u53e3',
                click: () => {
                    if (!mainWindow || !mainWindow.isVisible()) {
                        showMainWindow();
                    } else {
                        mainWindow.hide();
                    }
                },
            },
            { type: 'separator' },
            {
                label: '\u9000\u51fa',
                click: () => {
                    isQuitting = true;
                    app.quit();
                },
            },
        ];
        tray.setContextMenu(Menu.buildFromTemplate(template));
    }

    tray.on('click', () => {
        if (!mainWindow || !mainWindow.isVisible()) {
            showMainWindow();
        } else {
            mainWindow.focus();
        }
        refreshTrayMenu();
    });

    tray.on('double-click', () => {
        showMainWindow();
        refreshTrayMenu();
    });

    refreshTrayMenu();
}

function createWindow() {
    let startupWatchdog = null;
    let attemptedStartupReload = false;

    mainWindow = new BrowserWindow({
        width: 1150,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        ...(process.platform === 'darwin'
            ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 12 } }
            : {
                titleBarStyle: 'hidden',
                titleBarOverlay: {
                    color: '#00000000',
                    symbolColor: '#808080',
                    height: 44
                }
            }),
        icon: getWindowIconPath(),
        backgroundColor: '#1f1f1d',
        show: false,
    });

    mainWindow.once('ready-to-show', () => {
        if (startupWatchdog) {
            clearTimeout(startupWatchdog);
            startupWatchdog = null;
        }
        mainWindow.webContents.setZoomFactor(1.0);
        mainWindow.show();
        appendMainLog('window', 'ready-to-show');
    });

    const TITLE_BAR_BASE_HEIGHT = 44;
    const applyZoom = (factor) => {
        const wc = mainWindow.webContents;
        wc.setZoomFactor(factor);
        if (process.platform !== 'darwin') {
            try {
                mainWindow.setTitleBarOverlay({
                    color: '#00000000',
                    symbolColor: '#808080',
                    height: Math.round(TITLE_BAR_BASE_HEIGHT * factor),
                });
            } catch (_) {}
        }
        wc.send('zoom-changed', factor);
    };

    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (!input.control && !input.meta) return;
        const wc = mainWindow.webContents;
        const current = wc.getZoomFactor();
        if (input.key === '=' || input.key === '+') {
            event.preventDefault();
            applyZoom(Math.min(+(current + 0.1).toFixed(1), 2.0));
        } else if (input.key === '-') {
            event.preventDefault();
            applyZoom(Math.max(+(current - 0.1).toFixed(1), 0.5));
        } else if (input.key === '0') {
            event.preventDefault();
            applyZoom(1.0);
        }
    });

    if (isDev) {
        mainWindow.loadURL('http://localhost:3000');
    } else {
        mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    }

    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        appendMainLog('did-fail-load', `${errorCode} ${errorDescription} ${validatedURL || ''}`.trim());
    });

    mainWindow.webContents.on('did-finish-load', () => {
        if (startupWatchdog) {
            clearTimeout(startupWatchdog);
            startupWatchdog = null;
        }
        appendMainLog('did-finish-load', 'renderer finished loading');
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
            mainWindow.show();
        }
    });

    mainWindow.webContents.on('render-process-gone', (event, details) => {
        appendMainLog('render-process-gone', JSON.stringify(details || {}));
        const now = Date.now();
        if (now - lastRendererRecoveryAt < 10000) return;
        lastRendererRecoveryAt = now;
        setTimeout(() => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            try {
                if (isDev) {
                    mainWindow.loadURL('http://localhost:3000');
                } else {
                    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
                }
            } catch (error) {
                appendMainLog('render-process-reload-failed', error?.message || String(error));
            }
        }, 1200);
    });

    mainWindow.on('unresponsive', () => {
        appendMainLog('window-unresponsive', 'BrowserWindow became unresponsive');
    });

    startupWatchdog = setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (attemptedStartupReload) return;
        attemptedStartupReload = true;
        appendMainLog('startup-watchdog', 'window did not become ready in time, forcing reload');
        try {
            mainWindow.webContents.reloadIgnoringCache();
        } catch (error) {
            appendMainLog('startup-watchdog-failed', error?.message || String(error));
        }
    }, 12000);

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith('file://') || url.startsWith('http://localhost')) return;
        event.preventDefault();
        shell.openExternal(url);
    });

    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        if (level >= 2) {
            try { require('fs').appendFileSync(require('path').join(require('electron').app.getPath('userData'), 'frontend-error.log'), `[Frontend Error] ${message} at ${sourceId}:${line}\n`); } catch (_) {}
        }
    });

    if (process.platform === 'win32' || process.platform === 'linux') {
        mainWindow.on('close', (event) => {
            if (isQuitting) return;
            event.preventDefault();
            mainWindow.hide();
            if (tray) {
                const visible = mainWindow.isVisible();
                const template = [
                    {
                        label: visible ? '\u9690\u85cf\u7a97\u53e3' : '\u663e\u793a\u7a97\u53e3',
                        click: () => {
                            if (!mainWindow || !mainWindow.isVisible()) {
                                showMainWindow();
                            } else {
                                mainWindow.hide();
                            }
                        },
                    },
                    { type: 'separator' },
                    {
                        label: '\u9000\u51fa',
                        click: () => {
                            isQuitting = true;
                            app.quit();
                        },
                    },
                ];
                tray.setContextMenu(Menu.buildFromTemplate(template));
                if (!hasShownTrayHint && process.platform === 'win32' && typeof tray.displayBalloon === 'function') {
                    tray.displayBalloon({
                        title: 'Claude Desktop CN',
                        content: '\u5df2\u6700\u5c0f\u5316\u5230\u7cfb\u7edf\u6258\u76d8\uff0c\u53f3\u952e\u6258\u76d8\u56fe\u6807\u53ef\u4ee5\u9000\u51fa\u5e94\u7528\u3002',
                        iconType: 'info',
                    });
                    hasShownTrayHint = true;
                }
            }
        });
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

if (isWindows) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
}

app.whenReady().then(() => {
    app.setAppUserModelId('com.claude.desktop.cn');

    if (process.platform === 'darwin') {
        try {
            const engineBin = path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'), 'engine', 'bin');
            require('child_process').execSync(`xattr -cr "${engineBin}" 2>/dev/null || true`, { stdio: 'ignore' });
        } catch (_) {}
    }

    const server = initServer();
    server.listen(30080, '127.0.0.1', () => {
        console.log('Bridge Server running on http://127.0.0.1:30080');
    });

    createTray();
    createWindow();

    enableNodeModeForChildProcesses();

    if (!isDev && process.env.CLAUDE_DESKTOP_ENABLE_AUTO_UPDATE === '1') {
        autoUpdater.setFeedURL({
            provider: 'generic',
            url: 'https://clawparrot.com/updates',
        });
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.logger = console;

        autoUpdater.on('update-available', (info) => {
            console.log('[Update] New version available:', info.version);
            if (mainWindow) {
                mainWindow.webContents.send('update-status', { type: 'available', version: info.version });
            }
        });

        autoUpdater.on('download-progress', (progress) => {
            if (mainWindow) {
                mainWindow.webContents.send('update-status', { type: 'progress', percent: Math.round(progress.percent) });
            }
        });

        autoUpdater.on('update-downloaded', (info) => {
            console.log('[Update] Downloaded:', info.version);
            if (mainWindow) {
                mainWindow.webContents.send('update-status', { type: 'downloaded', version: info.version });
            }
        });

        autoUpdater.on('error', (err) => {
            console.error('[Update] Error:', err.message);
            if (mainWindow) {
                mainWindow.webContents.send('update-status', { type: 'error', message: err.message });
            }
        });

        autoUpdater.on('update-not-available', (info) => {
            console.log('[Update] Already up-to-date:', info.version);
        });

        const doCheck = () => {
            console.log('[Update] Checking for updates...');
            autoUpdater.checkForUpdates().catch(err => {
                console.error('[Update] Check failed:', err.message);
            });
        };
        setTimeout(doCheck, 15000);
        setInterval(doCheck, 10 * 60 * 1000);
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
            return;
        }
        showMainWindow();
    });
});

app.on('before-quit', () => {
    isQuitting = true;
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        if (!tray) app.quit();
    }
});

ipcMain.handle('get-app-path', () => app.getPath('userData'));
ipcMain.handle('get-platform', () => process.platform);
ipcMain.handle('install-update', () => {
    if (process.platform === 'darwin') {
        app.relaunch();
        app.exit(0);
    } else {
        autoUpdater.quitAndInstall(true, true);
    }
});
ipcMain.handle('open-external', (_, url) => { const { shell } = require('electron'); shell.openExternal(url); });
ipcMain.handle('resize-window', (_, width, height) => {
    if (mainWindow) {
        mainWindow.setSize(width, height);
        mainWindow.center();
    }
});

const recentlyOpenedFolders = new Map();
ipcMain.handle('show-item-in-folder', (event, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const folder = path.dirname(filePath);
    const now = Date.now();
    const lastOpened = recentlyOpenedFolders.get(folder);
    if (lastOpened && now - lastOpened < 2000) return true;
    recentlyOpenedFolders.set(folder, now);
    for (const [k, v] of recentlyOpenedFolders) {
        if (now - v > 5000) recentlyOpenedFolders.delete(k);
    }
    shell.showItemInFolder(filePath);
    return true;
});

const recentlyOpenedDirs = new Map();
ipcMain.handle('open-folder', (event, folderPath) => {
    if (!folderPath || !fs.existsSync(folderPath)) return false;
    const now = Date.now();
    const lastOpened = recentlyOpenedDirs.get(folderPath);
    if (lastOpened && now - lastOpened < 2000) return true;
    recentlyOpenedDirs.set(folderPath, now);
    for (const [k, v] of recentlyOpenedDirs) {
        if (now - v > 5000) recentlyOpenedDirs.delete(k);
    }
    shell.openPath(folderPath);
    return true;
});

ipcMain.handle('open-path-with-target', async (event, targetPath, target) => {
    if (!targetPath || !fs.existsSync(targetPath)) {
        return { ok: false, error: 'Path not found' };
    }

    const normalizedTarget = String(target || 'default').toLowerCase();
    const resolvedPath = path.resolve(targetPath);

    if (normalizedTarget === 'explorer' || normalizedTarget === 'default') {
        await shell.openPath(resolvedPath);
        return { ok: true };
    }

    if (normalizedTarget === 'vscode') {
        const codeExe = firstExistingPath([
            path.join(process.env['LocalAppData'] || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
            path.join(process.env['ProgramFiles'] || '', 'Microsoft VS Code', 'Code.exe'),
            path.join(process.env['LocalAppData'] || '', 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
        ]);
        const opened = codeExe
            ? spawnDetached(codeExe, ['-n', resolvedPath], { cwd: path.dirname(resolvedPath) })
            : spawnDetached('code', ['-n', resolvedPath], { cwd: path.dirname(resolvedPath) });
        if (opened) return { ok: true };
        await shell.openPath(resolvedPath);
        return { ok: false, fallback: 'explorer' };
    }

    if (normalizedTarget === 'git-bash') {
        const gitBash = firstExistingPath([
            path.join(process.env['ProgramFiles'] || '', 'Git', 'git-bash.exe'),
            path.join(process.env['ProgramW6432'] || '', 'Git', 'git-bash.exe'),
            path.join(process.env['LocalAppData'] || '', 'Programs', 'Git', 'git-bash.exe'),
        ]);
        if (gitBash && spawnDetached(gitBash, [`--cd=${resolvedPath}`], { cwd: resolvedPath })) {
            return { ok: true };
        }
        await shell.openPath(resolvedPath);
        return { ok: false, fallback: 'explorer' };
    }

    if (normalizedTarget === 'pycharm') {
        const pycharmExe = findPyCharmExe();
        if (pycharmExe && spawnDetached(pycharmExe, [resolvedPath], { cwd: path.dirname(resolvedPath) })) {
            return { ok: true };
        }
        await shell.openPath(resolvedPath);
        return { ok: false, fallback: 'explorer' };
    }

    await shell.openPath(resolvedPath);
    return { ok: true, fallback: 'explorer' };
});

ipcMain.handle('open-preview-html', async (event, html, suggestedName) => {
    try {
        if (typeof html !== 'string' || !html.trim()) {
            return { ok: false, error: 'Missing preview html' };
        }
        const os = require('os');
        const previewDir = path.join(os.tmpdir(), 'claude-desktop-cn-previews');
        fs.mkdirSync(previewDir, { recursive: true });
        const previewName = `${Date.now()}-${sanitizePreviewName(suggestedName)}`;
        const previewPath = path.join(previewDir, previewName);
        fs.writeFileSync(previewPath, html, 'utf8');
        await shell.openPath(previewPath);
        return { ok: true, path: previewPath };
    } catch (error) {
        return { ok: false, error: error?.message || 'Failed to open preview html' };
    }
});

ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    return result.filePaths[0];
});

ipcMain.handle('export-workspace', async (event, workspaceId, contextMarkdown, defaultFilename) => {
    try {
        const result = await dialog.showSaveDialog(mainWindow, {
            title: '\u5bfc\u51fa\u5de5\u4f5c\u7a7a\u95f4',
            defaultPath: defaultFilename,
            filters: [
                { name: 'Zip Archives', extensions: ['zip'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (result.canceled || !result.filePath) {
            return { success: false, reason: 'canceled' };
        }

        const zipDest = result.filePath;
        const workspacePath = path.join(app.getPath('userData'), 'workspaces', workspaceId);

        if (!fs.existsSync(workspacePath)) {
            fs.mkdirSync(workspacePath, { recursive: true });
        }

        fs.writeFileSync(path.join(workspacePath, 'chat_context.md'), contextMarkdown || '', 'utf-8');

        return await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipDest);
            const archive = archiver('zip', {
                zlib: { level: 9 }
            });

            output.on('close', () => {
                resolve({ success: true, path: zipDest, size: archive.pointer() });
            });

            archive.on('error', (err) => {
                reject(err);
            });

            archive.pipe(output);
            archive.directory(workspacePath, false);
            archive.finalize();
        });
    } catch (err) {
        console.error("Export Workspace Failed:", err);
        throw err;
    }
});
