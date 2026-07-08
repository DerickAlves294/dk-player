const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require("electron");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { autoUpdater } = require("electron-updater");

const AUDIO_EXT = [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".oga", ".weba"];

/* Custom protocol used to stream local audio files straight into the
   <audio> element without exposing raw filesystem access to the renderer.
   Must be registered before app is ready. `stream:true` + forwarding the
   request's headers to net.fetch keeps Range requests working, which is
   what lets the user seek/scrub through a track. */
protocol.registerSchemesAsPrivileged([
  {
    scheme: "dkmedia",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true },
  },
]);

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}
async function readConfig() {
  try {
    return JSON.parse(await fsp.readFile(configPath(), "utf-8"));
  } catch (e) {
    return {};
  }
}
async function writeConfig(cfg) {
  await fsp.writeFile(configPath(), JSON.stringify(cfg), "utf-8");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0B0D10",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:true bloqueia o preload.js de usar require("node:path"),
      // então window.dkAPI nunca era criado — era isso que fazia o botão
      // de adicionar música (e a pasta) parecer que não fazia nada.
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  protocol.handle("dkmedia", (request) => {
    try {
      const url = new URL(request.url);
      const filePath = decodeURIComponent(url.pathname.slice(1));
      return net.fetch(pathToFileURL(filePath).toString(), { headers: request.headers });
    } catch (e) {
      console.warn("dkmedia protocol failed", e);
      return new Response("Not found", { status: 404 });
    }
  });

  ipcMain.handle("pick-folder", async () => {
    const res = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle("pick-audio-files", async () => {
    const res = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Áudio", extensions: AUDIO_EXT.map((e) => e.slice(1)) }],
    });
    if (res.canceled) return [];
    return res.filePaths;
  });

  ipcMain.handle("scan-folder", async (event, folderPath) => {
    try {
      const entries = await fsp.readdir(folderPath, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && AUDIO_EXT.includes(path.extname(e.name).toLowerCase()))
        .map((e) => ({ name: e.name, path: path.join(folderPath, e.name) }));
    } catch (e) {
      console.warn("scan-folder failed", e);
      return [];
    }
  });

  ipcMain.handle("read-file-range", async (event, filePath, start, length) => {
    let fh;
    try {
      fh = await fsp.open(filePath, "r");
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, start);
      // copy into a plain Uint8Array — cleaner to send over IPC than a Node Buffer
      return new Uint8Array(buf.subarray(0, bytesRead));
    } catch (e) {
      console.warn("read-file-range failed", e);
      return new Uint8Array(0);
    } finally {
      if (fh) await fh.close();
    }
  });

  ipcMain.handle("copy-files-into-folder", async (event, filePaths, destFolder) => {
    const copied = [];
    for (const src of filePaths) {
      try {
        const name = path.basename(src);
        await fsp.copyFile(src, path.join(destFolder, name));
        copied.push(name);
      } catch (e) {
        console.warn("copy failed for", src, e);
      }
    }
    return copied;
  });

  ipcMain.handle("get-last-folder", async () => {
    const cfg = await readConfig();
    if (cfg.libraryPath) {
      try {
        await fsp.access(cfg.libraryPath);
        return cfg.libraryPath;
      } catch (e) {
        return null; // folder was moved/deleted since last time
      }
    }
    return null;
  });

  ipcMain.handle("set-last-folder", async (event, folderPath) => {
    const cfg = await readConfig();
    cfg.libraryPath = folderPath;
    await writeConfig(cfg);
    return true;
  });

  createWindow();

  // Verifica se existe uma versão mais nova publicada e, se sim, baixa em
  // segundo plano e instala automaticamente na próxima vez que o app abrir.
  // Só funciona em builds instalados via .exe (NSIS), não em `npm start`.
  autoUpdater.checkForUpdatesAndNotify().catch((e) => {
    console.warn("check for updates failed", e);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
