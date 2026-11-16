'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_NAME = 'Keryx';
const APP_ID = 'app.keryx.browser';
const PARTITION = 'persist:keryx';
const MESSENGER_FILE_URL = pathToFileURL(path.join(__dirname, 'src', 'messenger.html')).href;

let mainWindow = null;
let browserSession = null;
let permissionDialogQueue = Promise.resolve();
const permissionDecisions = new Map();
const grantedPermissions = new Set();

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

app.setName(APP_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

app.userAgentFallback = buildUserAgent();
nativeTheme.themeSource = 'dark';
app.commandLine.appendSwitch('lang', 'ru');
Menu.setApplicationMenu(null);

function buildUserAgent() {
  const platform = process.platform === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'X11; Linux x86_64';

  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ----------------------------------------------------------------------- */
/* Browser session                                                         */
/* ----------------------------------------------------------------------- */

function setupBrowserSession() {
  browserSession = session.fromPartition(PARTITION);

  browserSession.on('will-download', handleDownload);
  browserSession.setPermissionRequestHandler(handlePermissionRequest);
  browserSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    if (permission === 'fullscreen') return true;
    const origin = normalizeOrigin(requestingOrigin);
    return grantedPermissions.has(`${origin}|${permission}`);
  });
}

function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === 'null' ? url.hostname : url.origin;
  } catch {
    return value || 'unknown';
  }
}

function handleDownload(_event, item) {
  const downloadsDirectory = app.getPath('downloads');
  fs.mkdirSync(downloadsDirectory, { recursive: true });

  const originalName = path.basename(item.getFilename() || 'download');
  const parsed = path.parse(originalName);
  let fileName = originalName;
  let index = 1;

  while (fs.existsSync(path.join(downloadsDirectory, fileName))) {
    fileName = `${parsed.name} (${index})${parsed.ext}`;
    index += 1;
  }

  const filePath = path.join(downloadsDirectory, fileName);
  item.setSavePath(filePath);

  sendToRenderer('browser:download', {
    phase: 'started',
    fileName,
    filePath
  });

  item.once('done', (_doneEvent, state) => {
    sendToRenderer('browser:download', {
      phase: 'finished',
      state,
      fileName,
      filePath
    });
  });
}

const PERMISSION_DESCRIPTIONS = {
  media: 'использовать камеру и микрофон',
  geolocation: 'определять ваше местоположение',
  notifications: 'показывать уведомления',
  'clipboard-read': 'читать содержимое буфера обмена',
  'clipboard-sanitized-write': 'записывать данные в буфер обмена',
  midi: 'получить доступ к MIDI-устройствам',
  midiSysex: 'получить доступ к MIDI-устройствам',
  pointerLock: 'захватить указатель мыши',
  'display-capture': 'записывать экран',
  'idle-detection': 'определять, активны ли вы',
  'speaker-selection': 'выбрать аудиоустройство'
};

function handlePermissionRequest(contents, permission, callback, details) {
  if (permission === 'fullscreen') {
    callback(true);
    return;
  }

  const origin = normalizeOrigin(details?.requestingUrl || contents.getURL());
  const key = `${origin}|${permission}`;

  if (permissionDecisions.has(key)) {
    callback(permissionDecisions.get(key));
    return;
  }

  if (!PERMISSION_DESCRIPTIONS[permission]) {
    callback(false);
    return;
  }

  permissionDialogQueue = permissionDialogQueue.then(async () => {
    if (permissionDecisions.has(key)) {
      callback(permissionDecisions.get(key));
      return;
    }

    if (!mainWindow || mainWindow.isDestroyed() || contents.isDestroyed()) {
      callback(false);
      return;
    }

    let host = origin;
    try {
      host = new URL(origin).hostname;
    } catch {
      /* Keep the origin as-is. */
    }

    let description = PERMISSION_DESCRIPTIONS[permission];
    if (permission === 'media' && details?.mediaTypes?.length) {
      const mediaTypes = details.mediaTypes;
      description = mediaTypes.includes('video')
        ? 'использовать камеру и микрофон'
        : 'использовать микрофон';
    }

    try {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: APP_NAME,
        message: `Разрешить сайту ${host} ${description}?`,
        detail: 'Вы можете изменить это решение, перезапустив браузер.',
        buttons: ['Запретить', 'Разрешить'],
        defaultId: 1,
        cancelId: 0,
        noLink: true
      });

      const allowed = response === 1;
      permissionDecisions.set(key, allowed);
      if (allowed) grantedPermissions.add(key);
      if (!contents.isDestroyed()) callback(allowed);
    } catch {
      if (!contents.isDestroyed()) callback(false);
    }
  }).catch(() => {
    if (!contents.isDestroyed()) callback(false);
  });
}

/* ----------------------------------------------------------------------- */
/* Window                                                                  */
/* ----------------------------------------------------------------------- */

function createWindow() {
  setupBrowserSession();

  const iconPath = path.join(__dirname, 'assets', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 920,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#08090d',
    autoHideMenuBar: true,
    title: APP_NAME,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: true
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('maximize', () => sendToRenderer('window:state', getWindowState()));
  mainWindow.on('unmaximize', () => sendToRenderer('window:state', getWindowState()));
  mainWindow.on('enter-full-screen', () => sendToRenderer('window:state', getWindowState()));
  mainWindow.on('leave-full-screen', () => sendToRenderer('window:state', getWindowState()));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;

    if (params.partition !== PARTITION) {
      event.preventDefault();
      return;
    }

    const target = String(params.src || '');
    if (
      target &&
      target !== 'about:blank' &&
      !/^https?:\/\//i.test(target) &&
      target !== MESSENGER_FILE_URL
    ) {
      event.preventDefault();
    }
  });

  registerShortcuts(mainWindow.webContents);
}

function getWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { maximized: false, fullscreen: false };
  }
  return {
    maximized: mainWindow.isMaximized(),
    fullscreen: mainWindow.isFullScreen()
  };
}

/* ----------------------------------------------------------------------- */
/* Guest pages                                                             */
/* ----------------------------------------------------------------------- */

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  registerShortcuts(contents);
  attachGuestContextMenu(contents);

  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (/^https?:\/\//i.test(url)) {
      sendToRenderer('browser:open-tab', {
        url,
        active: disposition !== 'background-tab'
      });
    } else if (/^(mailto:|tel:)/i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (/^(mailto:|tel:)/i.test(url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  contents.on('enter-html-full-screen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setFullScreen(true);
  });

  contents.on('leave-html-full-screen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
  });
});

function sendNewTab(url) {
  if (!url) return;
  sendToRenderer('browser:open-tab', { url, active: true });
}

function attachGuestContextMenu(contents) {
  contents.on('context-menu', (_event, params) => {
    const template = [];

    const addSeparator = () => {
      if (template.length && template[template.length - 1].type !== 'separator') {
        template.push({ type: 'separator' });
      }
    };

    if (params.linkURL && /^https?:\/\//i.test(params.linkURL)) {
      template.push({
        label: 'Открыть ссылку в новой вкладке',
        click: () => sendNewTab(params.linkURL)
      });
      template.push({
        label: 'Копировать адрес ссылки',
        click: () => clipboard.writeText(params.linkURL)
      });
      addSeparator();
    }

    if (params.mediaType === 'image' && params.srcURL) {
      template.push({
        label: 'Открыть изображение в новой вкладке',
        click: () => sendNewTab(params.srcURL)
      });
      template.push({
        label: 'Копировать изображение',
        click: () => contents.copyImageAt(params.x, params.y)
      });
      template.push({
        label: 'Скопировать адрес изображения',
        click: () => clipboard.writeText(params.srcURL)
      });
      template.push({
        label: 'Сохранить изображение',
        click: () => contents.downloadURL(params.srcURL)
      });
      addSeparator();
    }

    if (params.isEditable) {
      template.push({
        label: 'Отменить',
        enabled: Boolean(params.editFlags?.canUndo),
        click: () => contents.undo()
      });
      template.push({
        label: 'Повторить',
        enabled: Boolean(params.editFlags?.canRedo),
        click: () => contents.redo()
      });
      addSeparator();
      template.push({
        label: 'Вырезать',
        enabled: Boolean(params.editFlags?.canCut),
        click: () => contents.cut()
      });
      template.push({
        label: 'Копировать',
        enabled: Boolean(params.editFlags?.canCopy),
        click: () => contents.copy()
      });
      template.push({
        label: 'Вставить',
        enabled: Boolean(params.editFlags?.canPaste),
        click: () => contents.paste()
      });
      template.push({
        label: 'Выделить всё',
        enabled: Boolean(params.editFlags?.canSelectAll),
        click: () => contents.selectAll()
      });
      addSeparator();
    } else if (params.selectionText.trim()) {
      template.push({
        label: 'Копировать',
        click: () => contents.copy()
      });
      template.push({
        label: 'Искать выделенное',
        click: () => {
          sendToRenderer('browser:search', {
            query: params.selectionText.slice(0, 500),
            active: true
          });
        }
      });
      addSeparator();
    }

    template.push({
      label: 'Назад',
      enabled: contents.canGoBack(),
      click: () => contents.goBack()
    });
    template.push({
      label: 'Вперёд',
      enabled: contents.canGoForward(),
      click: () => contents.goForward()
    });
    template.push({
      label: 'Обновить',
      click: () => contents.reload()
    });
    addSeparator();
    template.push({
      label: 'Проверить элемент',
      click: () => contents.inspectElement(params.x, params.y)
    });

    while (template.length && template[template.length - 1].type === 'separator') {
      template.pop();
    }

    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window: mainWindow || undefined });
  });
}

/* ----------------------------------------------------------------------- */
/* Keyboard shortcuts                                                      */
/* ----------------------------------------------------------------------- */

function registerShortcuts(contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.isAutoRepeat && !/^[1-8]$/.test(input.key)) return;

    const key = String(input.key || '').toLowerCase();
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    const shift = input.shift;
    const alt = input.alt;
    let action = null;

    if (mod && !alt && !shift && key === 't') {
      action = 'new-tab';
    } else if (mod && !alt && shift && key === 't') {
      action = 'reopen-tab';
    } else if (mod && !alt && !shift && key === 'w') {
      action = 'close-tab';
    } else if (mod && !alt && (key === 'l' || key === 'k')) {
      action = 'focus-address';
    } else if (mod && !alt && shift && key === 'r') {
      action = 'hard-reload';
    } else if (((mod && !alt && !shift && key === 'r') || (!mod && !alt && key === 'f5'))) {
      action = 'reload';
    } else if (mod && !alt && (key === '=' || key === '+' || key === 'add')) {
      action = 'zoom-in';
    } else if (mod && !alt && (key === '-' || key === '_' || key === 'subtract')) {
      action = 'zoom-out';
    } else if (mod && !alt && key === '0') {
      action = 'zoom-reset';
    } else if (mod && !alt && key === 'tab') {
      action = shift ? 'previous-tab' : 'next-tab';
    } else if (mod && !alt && key === '9') {
      action = 'select-last-tab';
    } else if (mod && !alt && /^[1-8]$/.test(key)) {
      action = 'select-tab';
    } else if (alt && !mod && !shift && key === 'arrowleft') {
      action = 'back';
    } else if (alt && !mod && !shift && key === 'arrowright') {
      action = 'forward';
    } else if (alt && !mod && key === 'home') {
      action = 'home';
    } else if (key === 'f12' || (mod && !alt && shift && key === 'i')) {
      action = 'devtools';
    }

    if (!action) return;

    event.preventDefault();
    sendToRenderer('browser:shortcut', {
      action,
      index: action === 'select-tab' ? Number(key) - 1 : undefined
    });
  });
}

/* ----------------------------------------------------------------------- */
/* IPC                                                                     */
/* ----------------------------------------------------------------------- */

ipcMain.on('window:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.on('window:toggle-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});

ipcMain.on('window:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.on('window:leave-fullscreen', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && win.isFullScreen()) win.setFullScreen(false);
});

ipcMain.handle('window:is-maximized', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return Boolean(win?.isMaximized());
});

ipcMain.handle('app:about', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  await dialog.showMessageBox(win || mainWindow, {
    type: 'info',
    title: `О ${APP_NAME}`,
    message: `${APP_NAME} Browser`,
    detail: `Версия 1.0.0\nElectron ${process.versions.electron}\nChromium ${process.versions.chrome}\nNode.js ${process.versions.node}\n\nБыстрый, тихий браузер с тёмным интерфейсом.`,
    buttons: ['Закрыть'],
    noLink: true
  });
});

/* ----------------------------------------------------------------------- */
/* App lifecycle                                                           */
/* ----------------------------------------------------------------------- */

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusMainWindow();
  });
});

app.on('second-instance', focusMainWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
