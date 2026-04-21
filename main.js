const { app, BrowserWindow, Tray, ipcMain, dialog, Notification, Menu, shell, session } = require('electron')
const path = require('path')
const pkg = require('./package.json')

let win = null
let tray = null
let accountEmailLabel = null

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
      refreshAccountMenuLabel()
    })

    // Re-inject khi navigate trong page (SPA)
    win.webContents.on('did-navigate-in-page', () => {
      injectNotificationInterceptor()
      refreshAccountMenuLabel()
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

async function resolveAccountEmail() {
  if (!win || win.isDestroyed()) return null
  try {
    return await win.webContents.executeJavaScript(`
      (function () {
        try {
          const raw = localStorage.getItem('tmp.auth.v1.GLOBAL.User.User')
          if (raw) {
            const data = JSON.parse(raw)
            const item = data && data.item ? data.item : {}
            const profile = item.profile || {}
            return profile.preferred_username || profile.upn || item.userName || null
          }
        } catch (e) {}
        return null
      })();
    `)
  } catch (err) {
    return null
  }
}

async function refreshAccountMenuLabel() {
  accountEmailLabel = await resolveAccountEmail()
  createApplicationMenu()
}

async function showAccountInfoDialog() {
  if (!win || win.isDestroyed()) return

  try {
    const accountData = await win.webContents.executeJavaScript(`
      (function () {
        const ls = window.localStorage
        const keys = ls ? Object.keys(ls) : []
        const lower = (v) => String(v || '').toLowerCase()
        const pick = (matcher) => {
          const key = keys.find((k) => matcher(lower(k)))
          return key ? ls.getItem(key) : null
        }

        const title = document.title || ''
        const href = location.href || ''
        const authKey = 'tmp.auth.v1.GLOBAL.User.User'

        let parsedAuth = null
        try {
          const raw = ls ? ls.getItem(authKey) : null
          if (raw) parsedAuth = JSON.parse(raw)
        } catch (e) {}

        const profile = parsedAuth && parsedAuth.item ? parsedAuth.item.profile || {} : {}
        const authItem = parsedAuth && parsedAuth.item ? parsedAuth.item : {}

        const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/ig
        const sourceValues = [
          pick((k) => k.includes('account')),
          pick((k) => k.includes('profile')),
          pick((k) => k.includes('tenant')),
          pick((k) => k.includes('user')),
          pick((k) => k.includes('auth')),
          document.body ? document.body.innerText : ''
        ].filter(Boolean)

        let email = profile.preferred_username || profile.upn || authItem.userName || null
        let displayName = profile.name || null
        let workplace = authItem.homeTenantId || profile.tid || null

        for (const raw of sourceValues) {
          const txt = String(raw)
          if (!email) {
            const m = txt.match(emailRegex)
            if (m && m.length) email = m[0]
          }
          if (!displayName) {
            const nameMatch = txt.match(/"displayName"\\s*:\\s*"([^"]+)"/i) || txt.match(/"name"\\s*:\\s*"([^"]+)"/i)
            if (nameMatch) displayName = nameMatch[1]
          }
          if (!workplace) {
            const tenantMatch = txt.match(/"tenant(Name|DisplayName)?"\\s*:\\s*"([^"]+)"/i)
            if (tenantMatch) workplace = tenantMatch[2]
          }
        }

        return {
          title,
          href,
          email,
          displayName,
          workplace,
          authKeyFound: !!parsedAuth,
          userId: authItem.id || profile.oid || null,
          role: authItem.role || null,
          accountType: authItem.type || profile.idtyp || null
        }
      })();
    `)
    accountEmailLabel = accountData.email || null
    createApplicationMenu()

    const detailLines = [
      `Email: ${accountData.email || 'Not found'}`,
      `Display name: ${accountData.displayName || 'Not found'}`,
      `Role: ${accountData.role || 'Not found'}`,
      `Account type: ${accountData.accountType || 'Not found'}`,
      '',
      `Page title: ${accountData.title || 'Unknown'}`,
      `URL: ${accountData.href || 'Unknown'}`,
    ]

    await dialog.showMessageBox({
      type: 'info',
      title: 'Current account information',
      message: 'Microsoft Teams account',
      detail: detailLines.join('\n'),
      icon: path.join(__dirname, 'icon.png'),
      buttons: ['OK'],
      defaultId: 0,
      noLink: true,
    })
  } catch (err) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Unable to read account info',
      message: 'Failed to read account/workplace information from Teams page.',
      detail: String(err && err.message ? err.message : err),
      icon: path.join(__dirname, 'icon.png'),
      buttons: ['OK'],
      defaultId: 0,
      noLink: true,
    })
  }
}

function openSwitchWorkplacePage() {
  shell.openExternal('https://teams.microsoft.com/_#/modern-calling/').catch(() => { })
}

async function logoutAccount() {
  if (!win || win.isDestroyed()) return

  const answer = await dialog.showMessageBox({
    type: 'warning',
    title: 'Logout from Teams',
    message: 'Logout khỏi phiên Teams hiện tại?',
    detail: 'Session đăng nhập sẽ bị xóa và app sẽ tải lại trang đăng nhập Teams.',
    icon: path.join(__dirname, 'icon.png'),
    buttons: ['Cancel', 'Logout'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  })

  if (answer.response !== 1) return

  try {
    const ses = session.fromPartition('persist:teams')
    await ses.clearStorageData({
      storages: ['cookies', 'localstorage']
    })
    await ses.clearCache()
    accountEmailLabel = null
    createApplicationMenu()
    await win.loadURL('https://teams.cloud.microsoft')
  } catch (err) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Logout failed',
      message: 'Could not logout from Teams.',
      detail: String(err && err.message ? err.message : err),
      icon: path.join(__dirname, 'icon.png'),
      buttons: ['OK'],
      defaultId: 0,
      noLink: true,
    })
  }
}

async function reloadSession() {
  if (!win || win.isDestroyed()) return
  win.webContents.reload()
}

async function hardReloadSession() {
  if (!win || win.isDestroyed()) return
  try {
    const ses = session.fromPartition('persist:teams')
    await ses.clearCache()
    win.webContents.reloadIgnoringCache()
  } catch (err) {
    console.error('[Teams] Hard reload failed:', err)
  }
}

async function clearLocalData() {
  if (!win || win.isDestroyed()) return

  const answer = await dialog.showMessageBox({
    type: 'warning',
    title: 'Clear Teams local data',
    message: 'Remove local Teams session data?',
    detail: 'This clears cookies, localStorage, and sessionStorage for partition persist:teams.',
    icon: path.join(__dirname, 'icon.png'),
    buttons: ['Cancel', 'Clear and reload'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  })

  if (answer.response !== 1) return

  try {
    const ses = session.fromPartition('persist:teams')
    await ses.clearStorageData({
      storages: ['cookies', 'localstorage', 'serviceworkers', 'indexdb', 'cachestorage']
    })

    await win.webContents.executeJavaScript(`
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (e) {}
    `).catch(() => { })

    await ses.clearCache()
    win.webContents.reloadIgnoringCache()
  } catch (err) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Failed to clear local data',
      message: 'Could not clear local Teams data.',
      detail: String(err && err.message ? err.message : err),
      icon: path.join(__dirname, 'icon.png'),
      buttons: ['OK'],
      defaultId: 0,
      noLink: true,
    })
  }
}

function createApplicationMenu() {
  const isMac = process.platform === 'darwin'
  const signedInLabel = accountEmailLabel ? `Signed in as: ${accountEmailLabel}` : 'Signed in as: Unknown'
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
      label: 'Profile',
      submenu: [
        { label: signedInLabel, enabled: false },
        { type: 'separator' },
        { label: 'Show info', click: () => { showAccountInfoDialog() } },
        { label: 'Logout', click: () => { logoutAccount() } },
      ],
    },
    {
      label: 'Session',
      submenu: [
        { label: 'Clear data', click: () => { clearLocalData() } },
      ],
    },
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
