# KopiBar

KopiBar is a React interface for monitoring Binance Futures markets.

## What is in this repo

- `src/App.jsx` contains the main application logic: filters, tabs, watchlist, charts, and data loading.
- `src/App.css` contains the main UI styles.
- `Документация/` stores project notes and server operation instructions.

## Current architecture

The interface connects to a separate Node.js server running on a VPS at `http://77.239.105.144:3001`.

The server is stored locally in a separate folder:

- frontend: `D:\KopiBar`
- server copy: `D:\kopibar-server`

Only Binance is supported in the current version. The project was intentionally reduced from multiple exchanges to one exchange to fit VPS limits on disk, RAM, and CPU.

## Frontend start

```bash
npm install
npm run dev
```

## Optional environment variable

You can override the server address without editing code:

```bash
VITE_KOPIBAR_SERVER=http://77.239.105.144:3001
```

If the variable is not set, the app uses the same address by default.

## Deploy workflow

1. Edit files locally.
2. Copy changed frontend or server files to the VPS manually.
3. Restart the server process on the VPS if `server.js` or `package.json` changed.
