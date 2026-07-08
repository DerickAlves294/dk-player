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

  // Copying newly picked files into the library folder
  copyFilesIntoFolder: (filePaths, destFolder) => ipcRenderer.invoke("copy-files-into-folder", filePaths, destFolder),

  // Remembering which folder is the library, across app restarts —
  // no permission prompts involved, this is a plain saved path.
  getLastFolder: () => ipcRenderer.invoke("get-last-folder"),
  setLastFolder: (folderPath) => ipcRenderer.invoke("set-last-folder", folderPath),

  // Small sync helpers
  basename: (p) => path.basename(p),
  mediaUrl: (filePath) => "dkmedia://local/" + encodeURIComponent(filePath),
});
