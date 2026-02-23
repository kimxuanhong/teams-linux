const { ipcRenderer, contextBridge } = require('electron')

// Expose API cho main world gọi được
contextBridge.exposeInMainWorld('teamsLinux', {
    notify: (title, body) => {
        ipcRenderer.send('notify', { title, body })
    },
    badge: (count) => ipcRenderer.send('badge', count)
})

window.addEventListener('DOMContentLoaded', () => {
    // Badge count
    setInterval(() => {
        const match = document.title.match(/\((\d+)\)/)
        const count = match ? parseInt(match[1]) : 0
        ipcRenderer.send('badge', count)
    }, 3000)
})
