const { app, BrowserWindow, Tray, ipcMain, dialog, Notification, Menu, shell } = require('electron')
const path = require('path')
const pkg = require('./package.json')

let win = null
let tray = null

// User Agent giống Chrome Linux
const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Ngăn chặn mở nhiều instance
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // Nếu đã có instance khác đang chạy, thoát ngay
  app.quit()
} else {
  // Khi có instance thứ 2 cố mở, focus vào instance đầu tiên
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (win) {
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })

  app.disableHardwareAcceleration()

  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')

  function createWindow() {
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'persist:teams'
      }
    })

    win.webContents.setUserAgent(CHROME_UA)
    win.loadURL('https://teams.cloud.microsoft')

    // Click link trong chat → mở bằng trình duyệt mặc định
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    // Inject notification interceptor vào page context mỗi khi page load
    win.webContents.on('did-finish-load', () => {
      injectNotificationInterceptor()
    })

    // Re-inject khi navigate trong page (SPA)
    win.webContents.on('did-navigate-in-page', () => {
      injectNotificationInterceptor()
    })

    win.once('ready-to-show', () => {
      win.show()
    })

    // Hide khi bấm nút X (không thoát)
    win.on('close', (e) => {
      if (!app.isQuiting) {
        e.preventDefault()
        win.hide()
      }
    })
  }


function showAboutDialog() {
  const details = [
    pkg.description || 'Desktop wrapper for YouTube',
    '',
    `Version: ${pkg.version || app.getVersion()}`,
    `Author: ${pkg.author?.name || 'Unknown'}`,
    pkg.author?.email ? `Contact: ${pkg.author.email}` : null,
    pkg.homepage ? `Homepage: ${pkg.homepage}` : null,
  ].filter(Boolean).join('\n')

  dialog.showMessageBox({
    type: 'info',
    title: `About Microsoft Teams`,
    message: 'Microsoft Teams',
    detail: details,
    icon: path.join(__dirname, 'icon.png'),
    buttons: ['OK'],
    defaultId: 0,
    noLink: true,
  }).catch(() => { })
}

function forceExitApp() {
  app.isQuiting = true
  app.exit(0)
}

function createApplicationMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: isMac ? 'File' : '&File',
      submenu: [
        { role: 'close' },
        { type: 'separator' },
        { label: 'Exit', click: forceExitApp },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: `About`, click: showAboutDialog },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

  /**
   * Inject script để override Notification constructor
   * Dùng contextBridge expose từ preload để gọi notify
   */
  function injectNotificationInterceptor() {
    if (!win || win.isDestroyed()) return

    const script = `
      (function() {
        if (window.__teamsNotifInjected) return;
        window.__teamsNotifInjected = true;

        var OrigNotification = window.Notification;

        function TeamsNotification(title, options) {
          options = options || {};
          
          // Gửi notification qua contextBridge API
          if (window.teamsLinux) {
            window.teamsLinux.notify(title, options.body || '');
          }

          // Trả về fake notification object để Teams không crash
          var self = this;
          self.title = title;
          self.body = options.body || '';
          self.icon = options.icon || '';
          self.tag = options.tag || '';
          self.close = function(){};
          self.addEventListener = function(){};
          self.removeEventListener = function(){};
          self.onclick = null;
          self.onclose = null;
          self.onerror = null;
          self.onshow = null;
          
          // Fire onshow callback nếu Teams set
          setTimeout(function() {
            if (typeof self.onshow === 'function') self.onshow();
          }, 10);
        }

        TeamsNotification.permission = 'granted';
        TeamsNotification.requestPermission = function(cb) {
          var p = Promise.resolve('granted');
          if (cb) cb('granted');
          return p;
        };
        TeamsNotification.maxActions = 0;

        Object.defineProperty(window, 'Notification', {
          value: TeamsNotification,
          writable: true,
          configurable: true
        });

        // Intercept ServiceWorker showNotification (push notifications)
        if (navigator.serviceWorker) {
          var origGetReg = navigator.serviceWorker.getRegistration;
          if (origGetReg) {
            navigator.serviceWorker.getRegistration = function() {
              return origGetReg.apply(this, arguments).then(function(reg) {
                if (reg && reg.showNotification) {
                  var origShow = reg.showNotification.bind(reg);
                  reg.showNotification = function(title, opts) {
                    opts = opts || {};
                    if (window.teamsLinux) {
                      window.teamsLinux.notify(title, opts.body || '');
                    }
                    return origShow(title, opts);
                  };
                }
                return reg;
              });
            };
          }
        }
      })();
    `

    win.webContents.executeJavaScript(script).catch((err) => {
      console.error('[Teams] Failed to inject:', err)
    })
  }

  function createTray() {
    tray = new Tray(path.join(__dirname, 'icon.png'))
    tray.setToolTip('Microsoft Teams')

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open',
        click: () => {
          if (win) {
            win.show()
            win.focus()
          }
        }
      },
      {
        label: 'Refresh',
        click: () => {
          if (win) {
            win.loadURL('https://teams.microsoft.com')
            win.show()
            win.focus()
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Exit',
        click: () => {
          app.isQuiting = true
          app.quit()
        }
      }
    ])

    tray.setContextMenu(contextMenu)

    // Click trái → mở app
    tray.on('click', () => {
      if (win) {
        win.show()
        win.focus()
      }
    })
  }

  app.whenReady().then(() => {
    app.userAgentFallback = CHROME_UA
    createApplicationMenu()
    createWindow()
    createTray()
  })

  app.on('window-all-closed', (e) => {
    e.preventDefault()
  })
}

/* ---------------- IPC ---------------- */

ipcMain.on('notify', (event, data) => {
  const notif = new Notification({
    title: data.title,
    body: data.body,
    icon: path.join(__dirname, 'icon.png')
  })

  notif.on('click', () => {
    if (win) {
      win.show()
      win.focus()
    }
  })

  notif.show()
})

ipcMain.on('badge', (event, count) => {
  if (tray && !tray.isDestroyed()) {
    tray.setToolTip(
      count > 0 ? `Microsoft Teams (${count})` : 'Microsoft Teams'
    )
  }
})
