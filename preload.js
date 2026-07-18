const { contextBridge, ipcRenderer } = require("electron");
const path = require("node:path");

/* Everything the renderer (app.js) is allowed to touch on the Node/OS side.
   contextIsolation is on and nodeIntegration is off in the BrowserWindow,
   so this is the *only* bridge — the UI never gets raw `fs`/`require`. */
contextBridge.exposeInMainWorld("dkAPI", {
  // Folder / file pickers (native OS dialogs)
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  pickAudioFiles: () => ipcRenderer.invoke("pick-audio-files"),

  // Library scanning + ID3 byte reads
  scanFolder: (folderPath) => ipcRenderer.invoke("scan-folder", folderPath),
  readFileRange: (filePath, start, length) => ipcRenderer.invoke("read-file-range", filePath, start, length),
  readFileBuffer: (filePath) => ipcRenderer.invoke("read-file-buffer", filePath),

  // Copying newly picked files into the library folder
  copyFilesIntoFolder: (filePaths, destFolder) => ipcRenderer.invoke("copy-files-into-folder", filePaths, destFolder),

  // Pastas de playlist: cria a subpasta física da playlist e move um
  // arquivo de música pra dentro dela (só na primeira playlist que a
  // música entrar — ver lógica em app.js).
  ensurePlaylistFolder: (libraryPath, playlistName) => ipcRenderer.invoke("ensure-playlist-folder", libraryPath, playlistName),
  moveFileToFolder: (filePath, destFolder) => ipcRenderer.invoke("move-file-to-folder", filePath, destFolder),
  deleteFolderIfEmpty: (folderPath) => ipcRenderer.invoke("delete-folder-if-empty", folderPath),

  // Remembering which folder is the library, across app restarts —
  // no permission prompts involved, this is a plain saved path.
  getLastFolder: () => ipcRenderer.invoke("get-last-folder"),
  setLastFolder: (folderPath) => ipcRenderer.invoke("set-last-folder", folderPath),

  // Small sync helpers
  basename: (p) => path.basename(p),
  mediaUrl: (filePath) => "dkmedia://local/" + encodeURIComponent(filePath),

  // Discord Rich Presence: manda pro main.js o que deve aparecer no perfil
  // do usuário no Discord (título, artista, capa, tempo). Falha em silêncio
  // do lado do main.js se o Discord não estiver aberto.
  setDiscordActivity: (activity) => ipcRenderer.invoke("discord-set-activity", activity),
  clearDiscordActivity: () => ipcRenderer.invoke("discord-clear-activity"),

  // Auto update: versão atual do app + fluxo manual de atualização
  // (o renderer decide o que mostrar em cada etapa em vez de depender
  // da notificação silenciosa padrão do electron-updater)
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  onUpdateAvailable: (callback) => ipcRenderer.on("update-available", (e, data) => callback(data)),
  onUpdateDownloaded: (callback) => ipcRenderer.on("update-downloaded", () => callback()),
  startUpdateDownload: () => ipcRenderer.invoke("start-update-download"),
  installUpdateNow: () => ipcRenderer.invoke("install-update-now"),
});
