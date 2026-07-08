const { app, BrowserWindow, ipcMain, dialog, protocol } = require("electron");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { autoUpdater } = require("electron-updater");

const AUDIO_EXT = [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".oga", ".weba"];
const AUDIO_MIME = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".oga": "audio/ogg",
  ".weba": "audio/webm",
};

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
  protocol.handle("dkmedia", async (request) => {
    try {
      const url = new URL(request.url);
      const filePath = decodeURIComponent(url.pathname.slice(1));
      const stat = await fsp.stat(filePath);
      const fileSize = stat.size;
      const mime = AUDIO_MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
      const range = request.headers.get("range");

      // This is the part that fixes seeking: when the <audio> element asks
      // to jump to a specific point in the track, it sends a "Range" header
      // (e.g. "bytes=500000-"). We used to hand this off to net.fetch on a
      // file:// URL and hope it replied with a proper 206 partial response —
      // it didn't always, so the player would think the stream had ended
      // and restart the track. Reading and returning the exact byte slice
      // ourselves guarantees a correct 206 response every time.
      if (range) {
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        const start = match ? parseInt(match[1], 10) : 0;
        const end = match && match[2] ? parseInt(match[2], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        const fh = await fsp.open(filePath, "r");
        const buf = Buffer.alloc(chunkSize);
        await fh.read(buf, 0, chunkSize, start);
        await fh.close();

        return new Response(buf, {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": String(chunkSize),
            "Content-Type": mime,
          },
        });
      }

      const data = await fsp.readFile(filePath);
      return new Response(data, {
        status: 200,
        headers: {
          "Content-Length": String(fileSize),
          "Content-Type": mime,
          "Accept-Ranges": "bytes",
        },
      });
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
