const { app, BrowserWindow, ipcMain, dialog, protocol } = require("electron");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { autoUpdater } = require("electron-updater");

// "Ouvir Junto" (WebRTC): por padrão o Chromium esconde o IP local por trás
// de um endereço mDNS (privacidade), mas isso às vezes falha silenciosamente
// pra resolver entre duas instâncias do MESMO PC — a conexão simplesmente
// nunca fecha, sem erro nenhum. Isso precisa ser setado antes do app ficar
// pronto. Não afeta nada além da parte de sincronização.
app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");

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

// Referência à janela principal, usada pra mandar eventos de update pro renderer
let mainWindow = null;

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
  mainWindow = win;
  win.on("closed", () => { if (mainWindow === win) mainWindow = null; });
}

/* ============================================================
   AUTO UPDATE
   Controle manual (autoDownload = false) em vez de checkForUpdatesAndNotify():
   assim a gente decide exatamente o que mostrar em cada etapa (tela de "nova
   versão disponível" com as novidades, e tela de "atualização concluída"),
   em vez de depender da notificação nativa silenciosa do Windows.
============================================================ */
autoUpdater.autoDownload = false;

autoUpdater.on("update-available", (info) => {
  mainWindow?.webContents.send("update-available", {
    version: info.version,
    notes: typeof info.releaseNotes === "string" ? info.releaseNotes : "",
  });
});

autoUpdater.on("update-downloaded", () => {
  mainWindow?.webContents.send("update-downloaded");
});

autoUpdater.on("error", (err) => {
  console.warn("erro no autoUpdater:", err);
});

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
            "Access-Control-Allow-Origin": "*",
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
          "Access-Control-Allow-Origin": "*",
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
    const results = [];
    // Anda recursivamente por todas as subpastas dentro da pasta escolhida
    // (ex: pastas de playlist criadas pelo próprio app) e junta tudo numa
    // lista só. Antes só lia o primeiro nível, por isso músicas dentro de
    // subpastas não apareciam na biblioteca.
    async function walk(dir) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (e) {
        console.warn("scan-folder: falha ao ler", dir, e);
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && AUDIO_EXT.includes(path.extname(entry.name).toLowerCase())) {
          results.push({ name: entry.name, path: full });
        }
      }
    }
    await walk(folderPath);
    return results;
  });

  // ============================================================
  // PASTAS DE PLAYLIST — cada playlist ganha uma subpasta física dentro
  // da biblioteca, e o arquivo da música é movido pra lá na PRIMEIRA vez
  // que ela entra em alguma playlist (fica só nessa pasta; se entrar em
  // outra playlist depois, só é referenciada lá, sem duplicar/mover de novo).
  // ============================================================
  function sanitizeFolderName(name) {
    // remove caracteres inválidos em nomes de pasta no Windows
    return String(name).replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 120) || "Playlist";
  }

  ipcMain.handle("ensure-playlist-folder", async (event, libraryPath, playlistName) => {
    // Todas as pastas de playlist ficam dentro de uma pasta-mãe "Playlist",
    // pra não espalhar pastas soltas na raiz da biblioteca.
    const folder = path.join(libraryPath, "Playlist", sanitizeFolderName(playlistName));
    await fsp.mkdir(folder, { recursive: true });
    return folder;
  });

  ipcMain.handle("move-file-to-folder", async (event, filePath, destFolder) => {
    try {
      const destPath0 = path.join(destFolder, path.basename(filePath));
      if (path.resolve(destPath0) === path.resolve(filePath)) return filePath; // já está lá

      // evita sobrescrever um arquivo diferente que já exista com o mesmo nome
      let destPath = destPath0;
      let n = 1;
      while (true) {
        try { await fsp.access(destPath); }
        catch (e) { break; } // não existe, pode usar esse caminho
        const ext = path.extname(destPath0);
        const base = path.basename(destPath0, ext);
        destPath = path.join(destFolder, `${base} (${n})${ext}`);
        n++;
      }

      try {
        await fsp.rename(filePath, destPath);
      } catch (e) {
        // rename falha se origem/destino estão em discos diferentes — copia e apaga o original
        await fsp.copyFile(filePath, destPath);
        await fsp.unlink(filePath);
      }
      return destPath;
    } catch (e) {
      console.warn("move-file-to-folder falhou", e);
      return null;
    }
  });

  // Ao excluir uma playlist: apaga a pasta dela SÓ SE ela estiver vazia
  // (as músicas já devem ter sido movidas de volta pra origem antes disso
  // — ver deletePlaylistAndRestoreFiles no app.js). Se sobrou algo lá
  // dentro (por segurança), não apaga nada e avisa o renderer.
  ipcMain.handle("delete-folder-if-empty", async (event, folderPath) => {
    try {
      const entries = await fsp.readdir(folderPath);
      if (entries.length === 0) {
        await fsp.rmdir(folderPath);
        return true;
      }
      return false;
    } catch (e) {
      console.warn("delete-folder-if-empty falhou", e);
      return false;
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

  // "Ouvir Junto": lê o arquivo de música inteiro de uma vez, pra mandar
  // pro amigo pela conexão (ver sync.js). Arquivos de música costumam ter
  // no máximo algumas dezenas de MB, então ler tudo de uma vez é tranquilo.
  ipcMain.handle("read-file-buffer", async (event, filePath) => {
    try {
      const data = await fsp.readFile(filePath);
      return new Uint8Array(data);
    } catch (e) {
      console.warn("read-file-buffer failed", e);
      return null;
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

  ipcMain.handle("get-app-version", () => app.getVersion());

  // O renderer chama isso quando o usuário clica em "Atualizar agora" na
  // telinha de nova versão disponível.
  ipcMain.handle("start-update-download", () => {
    autoUpdater.downloadUpdate().catch((e) => console.warn("download update failed", e));
  });

  // O renderer chama isso quando o usuário clica em "Reiniciar agora" na
  // telinha de atualização concluída.
  ipcMain.handle("install-update-now", () => {
    autoUpdater.quitAndInstall();
  });

  createWindow();

  // Só verifica se existe uma versão mais nova publicada — não baixa nada
  // sozinho. O download só começa quando o usuário aceita na telinha de
  // "nova versão disponível" (ver evento "update-available" acima).
  // Só funciona em builds instalados via .exe (NSIS), não em `npm start`.
  autoUpdater.checkForUpdates().catch((e) => {
    console.warn("check for updates failed", e);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
