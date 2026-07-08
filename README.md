# DK Player (versão desktop / Electron)

Player de música local — sem streaming pago, sem navegador no meio.

Essa é a versão "app de verdade" do DK Player, feita com Electron. A grande
diferença em relação à versão em HTML puro: **a pasta de músicas fica
gravada de vez**. Não existe mais permissão de navegador para expirar —
o app acessa os arquivos direto pelo Node.js, do jeito que qualquer
programa de desktop faz. Feche e abra o app quantas vezes quiser, a
biblioteca continua exatamente onde você deixou.

## Como rodar (modo desenvolvimento)

Pré-requisito: [Node.js](https://nodejs.org) instalado (versão 18 ou mais recente).

```bash
npm install
npm start
```

Isso baixa o Electron (a primeira vez demora um pouco, ele baixa o
Chromium) e abre o app numa janela normal.

## Como gerar um instalador (.exe / .dmg / .AppImage)

Esse passo é opcional — o `npm start` acima já é suficiente para usar o
app no dia a dia. Se quiser um instalador de verdade para distribuir ou
fixar na barra de tarefas, o caminho mais simples é o
[electron-builder](https://www.electron.build/):

```bash
npm install --save-dev electron-builder
```

E adicionar ao `package.json`:

```json
"scripts": {
  "dist": "electron-builder"
},
"build": {
  "appId": "com.dkplayer.app",
  "productName": "DK Player",
  "files": ["main.js", "preload.js", "renderer/**/*"]
}
```

Depois: `npm run dist`. Isso gera o instalador na pasta `dist/`, já
configurado pra plataforma em que você rodar o comando (Windows gera
`.exe`, macOS gera `.dmg`, Linux gera `.AppImage`/`.deb`).

## O que mudou em relação à versão web

- **Pasta lembrada de verdade**: o caminho da pasta escolhida é salvo num
  arquivinho de configuração (`config.json`, dentro da pasta de dados do
  app) e recuperado automaticamente ao abrir — sem nenhum clique de
  "conceder acesso".
- **Áudio tocado direto do disco**: os arquivos são servidos por um
  protocolo próprio (`dkmedia://`) que a janela usa no `<audio>`,
  com suporte a pular pra qualquer ponto da música (seek).
- **Leitura de tags ID3 (título/artista/álbum/capa)** feita pelo processo
  principal (Node `fs`), não mais pelo navegador.
- A busca por música/artista/álbum continua corrigida para encontrar
  títulos escritos com fontes estilizadas do Instagram/TikTok (normalização
  Unicode NFKD).
- Não existe mais o modo "fallback" de navegadores sem suporte a acesso a
  pastas (Firefox/Safari) — como é um app de desktop, sempre tem acesso
  completo.

## Estrutura do projeto

```
dk-player-electron/
├── main.js         # processo principal: janela, diálogos de arquivo,
│                   #   leitura de pasta/arquivos, protocolo dkmedia://
├── preload.js      # ponte seguraa entre main.js e a interface (window.dkAPI)
├── renderer/
│   ├── index.html  # interface
│   ├── styles.css  # visual (extraído do arquivo original)
│   └── app.js       # toda a lógica do player
└── package.json
```

## Segurança

A janela roda com `contextIsolation: true`, `nodeIntegration: false` e
`sandbox: true` — a interface (`app.js`) não tem acesso direto ao Node ou
ao sistema de arquivos; tudo passa pela ponte controlada em `preload.js`.
