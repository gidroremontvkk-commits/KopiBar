/**
 * KopiBar — прокси-сервер для 5 бирж
 * Binance, Bybit, OKX, Gate.io, Bitget
 * Запуск: node server.js
 */

const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ─── HTTP запрос ──────────────────────────────────────────────────────────────
function httpGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } },
      (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('JSON parse error: ' + body.slice(0, 100))); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// Пауза
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Кэш ─────────────────────────────────────────────────────────────────────
// cache[exchange][symbol][interval] = { data, updatedAt }
const cache = {};
const CACHE_TTL = 60 * 1000; // 1 минута

function getCache(exchange, symbol, interval) {
  return cache[exchange]?.[symbol]?.[interval] || null;
}

function setCache(exchange, symbol, interval, data) {
  if (!cache[exchange]) cache[exchange] = {};
  if (!cache[exchange][symbol]) cache[exchange][symbol] = {};
  cache[exchange][symbol][interval] = { data, updatedAt: Date.now() };
}

// ─── Адаптеры бирж ────────────────────────────────────────────────────────────
// Каждый адаптер возвращает массив свечей в едином формате:
// { time (сек), open, high, low, close, volume, openTime (мс) }

// --- BINANCE ---
const Binance = {
  name: 'binance',

  async getSymbols() {
    const d = await httpGet('fapi.binance.com', '/fapi/v1/exchangeInfo');
    return d.symbols
      .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT')
      .map(s => s.symbol);
  },

  async getTickers() {
    const d = await httpGet('fapi.binance.com', '/fapi/v1/ticker/24hr');
    return d.map(t => ({
      symbol: t.symbol,
      price: parseFloat(t.lastPrice),
      priceChangePercent: parseFloat(t.priceChangePercent),
      quoteVolume: parseFloat(t.quoteVolume),
      count: parseInt(t.count),
    }));
  },

  intervalMap: { '1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1d' },

  async getKlines(symbol, interval, limit = 1000, endTime = null) {
    const tf = this.intervalMap[interval] || interval;
    let qs = `symbol=${symbol}&interval=${tf}&limit=${limit}`;
    if (endTime) qs += `&endTime=${endTime}`;
    const d = await httpGet('fapi.binance.com', `/fapi/v1/klines?${qs}`);
    return d.map(c => ({
      time: c[0] / 1000, open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5], openTime: c[0]
    }));
  },
};

// --- BYBIT ---
const Bybit = {
  name: 'bybit',

  async getSymbols() {
    const d = await httpGet('api.bybit.com', '/v5/market/instruments-info?category=linear&limit=1000');
    return (d.result?.list || [])
      .filter(s => s.status === 'Trading' && s.quoteCoin === 'USDT')
      .map(s => s.symbol);
  },

  async getTickers() {
    const d = await httpGet('api.bybit.com', '/v5/market/tickers?category=linear');
    return (d.result?.list || [])
      .filter(t => t.symbol.endsWith('USDT'))
      .map(t => ({
        symbol: t.symbol,
        price: parseFloat(t.lastPrice),
        priceChangePercent: parseFloat(t.price24hPcnt) * 100,
        quoteVolume: parseFloat(t.turnover24h),
        count: 0,
      }));
  },

  intervalMap: { '1m':'1','5m':'5','15m':'15','1h':'60','4h':'240','1d':'D' },

  async getKlines(symbol, interval, limit = 1000, endTime = null) {
    const tf = this.intervalMap[interval] || interval;
    let qs = `category=linear&symbol=${symbol}&interval=${tf}&limit=${limit}`;
    if (endTime) qs += `&end=${endTime}`;
    const d = await httpGet('api.bybit.com', `/v5/market/kline?${qs}`);
    const list = (d.result?.list || []).reverse();
    return list.map(c => ({
      time: +c[0] / 1000, open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5], openTime: +c[0]
    }));
  },
};

// --- OKX ---
const OKX = {
  name: 'okx',

  async getSymbols() {
    const d = await httpGet('www.okx.com', '/api/v5/public/instruments?instType=SWAP');
    return (d.data || [])
      .filter(s => s.state === 'live' && s.ctType === 'linear' && s.settleCcy === 'USDT')
      .map(s => s.instId);
  },

  async getTickers() {
    const d = await httpGet('www.okx.com', '/api/v5/market/tickers?instType=SWAP');
    return (d.data || [])
      .filter(t => t.instId.endsWith('-USDT-SWAP'))
      .map(t => ({
        symbol: t.instId,
        price: parseFloat(t.last),
        priceChangePercent: ((parseFloat(t.last) - parseFloat(t.open24h)) / parseFloat(t.open24h)) * 100,
        quoteVolume: parseFloat(t.volCcy24h),
        count: 0,
      }));
  },

  intervalMap: { '1m':'1m','5m':'5m','15m':'15m','1h':'1H','4h':'4H','1d':'1D' },

  async getKlines(symbol, interval, limit = 300, endTime = null) {
    const tf = this.intervalMap[interval] || interval;
    let qs = `instId=${symbol}&bar=${tf}&limit=${limit}`;
    if (endTime) qs += `&after=${endTime}`;
    const d = await httpGet('www.okx.com', `/api/v5/market/candles?${qs}`);
    return (d.data || []).reverse().map(c => ({
      time: +c[0] / 1000, open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5], openTime: +c[0]
    }));
  },
};

// --- GATE.IO ---
const GateIO = {
  name: 'gateio',

  async getSymbols() {
    const d = await httpGet('api.gateio.ws', '/api/v4/futures/usdt/contracts');
    return (Array.isArray(d) ? d : [])
      .filter(s => !s.in_delisting)
      .map(s => s.name);
  },

  async getTickers() {
    const d = await httpGet('api.gateio.ws', '/api/v4/futures/usdt/tickers');
    return (Array.isArray(d) ? d : []).map(t => ({
      symbol: t.contract,
      price: parseFloat(t.last),
      priceChangePercent: parseFloat(t.change_percentage),
      quoteVolume: parseFloat(t.volume_24h_quote || t.volume_24h_settle || 0),
      count: 0,
    }));
  },

  intervalMap: { '1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1d' },

  async getKlines(symbol, interval, limit = 1000, endTime = null) {
    const tf = this.intervalMap[interval] || interval;
    let qs = `contract=${symbol}&interval=${tf}&limit=${limit}`;
    if (endTime) qs += `&to=${Math.floor(endTime / 1000)}`;
    const d = await httpGet('api.gateio.ws', `/api/v4/futures/usdt/candlesticks?${qs}`);
    return (Array.isArray(d) ? d : []).map(c => ({
      time: +c.t, open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +c.v, openTime: +c.t * 1000
    }));
  },
};

// --- BITGET ---
const Bitget = {
  name: 'bitget',

  async getSymbols() {
    const d = await httpGet('api.bitget.com', '/api/v2/mix/market/tickers?productType=USDT-FUTURES');
    return (d.data || []).map(s => s.symbol);
  },

  async getTickers() {
    const d = await httpGet('api.bitget.com', '/api/v2/mix/market/tickers?productType=USDT-FUTURES');
    return (d.data || []).map(t => ({
      symbol: t.symbol,
      price: parseFloat(t.lastPr),
      priceChangePercent: parseFloat(t.change24h) * 100,
      quoteVolume: parseFloat(t.quoteVolume || t.usdtVolume || 0),
      count: 0,
    }));
  },

  intervalMap: { '1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1d' },

  async getKlines(symbol, interval, limit = 1000, endTime = null) {
    const tf = this.intervalMap[interval] || interval;
    let qs = `symbol=${symbol}&granularity=${tf}&limit=${limit}&productType=usdt-futures`;
    if (endTime) qs += `&endTime=${endTime}`;
    const d = await httpGet('api.bitget.com', `/api/v2/mix/market/candles?${qs}`);
    return (d.data || []).reverse().map(c => ({
      time: +c[0] / 1000, open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5], openTime: +c[0]
    }));
  },
};

const EXCHANGES = { binance: Binance, bybit: Bybit, okx: OKX, gateio: GateIO, bitget: Bitget };

// ─── Загрузка истории (несколько запросов назад) ──────────────────────────────
async function loadHistory(exchange, symbol, interval) {
  const ex = EXCHANGES[exchange];
  if (!ex) throw new Error('Неизвестная биржа: ' + exchange);

  let allKlines = [];
  let lastEndTime = null;
  const passes = exchange === 'okx' ? 13 : 4; // OKX лимит 300 свечей за раз

  for (let i = 0; i < passes; i++) {
    try {
      const batch = await ex.getKlines(symbol, interval, 1000, lastEndTime);
      if (!batch || batch.length === 0) break;
      allKlines = [...batch, ...allKlines];
      lastEndTime = batch[0].openTime - 1;
      await sleep(150);
    } catch (e) {
      console.error(`[${exchange}] ошибка батча ${i}:`, e.message);
      break;
    }
  }

  // Убрать дубли и отсортировать
  const seen = new Set();
  return allKlines
    .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a, b) => a.time - b.time);
}

// ─── Кэш символов и тикеров ───────────────────────────────────────────────────
const metaCache = {};

async function getMeta(exchange) {
  const now = Date.now();
  if (metaCache[exchange] && now - metaCache[exchange].updatedAt < 5 * 60 * 1000) {
    return metaCache[exchange];
  }
  const ex = EXCHANGES[exchange];
  const [symbols, tickers] = await Promise.all([ex.getSymbols(), ex.getTickers()]);
  metaCache[exchange] = { symbols, tickers, updatedAt: now };
  return metaCache[exchange];
}

// ─── Роуты ────────────────────────────────────────────────────────────────────

app.get('/ping', (req, res) => res.json({ ok: true, exchanges: Object.keys(EXCHANGES) }));

// GET /exchanges — список доступных бирж
app.get('/exchanges', (req, res) => {
  res.json(Object.keys(EXCHANGES));
});

// GET /symbols?exchange=binance
app.get('/symbols', async (req, res) => {
  const { exchange = 'binance' } = req.query;
  try {
    const meta = await getMeta(exchange);
    res.json(meta.symbols);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /tickers?exchange=binance
app.get('/tickers', async (req, res) => {
  const { exchange = 'binance' } = req.query;
  try {
    const meta = await getMeta(exchange);
    res.json(meta.tickers);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /klines?exchange=binance&symbol=BTCUSDT&interval=5m
app.get('/klines', async (req, res) => {
  const { exchange = 'binance', symbol, interval = '5m' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Нужен параметр symbol' });

  const cached = getCache(exchange, symbol, interval);
  if (cached && Date.now() - cached.updatedAt < CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const data = await loadHistory(exchange, symbol, interval);
    setCache(exchange, symbol, interval, data);
    res.json(data);
  } catch (e) {
    if (cached) return res.json(cached.data);
    res.status(500).json({ error: e.message });
  }
});

// GET /cache-status
app.get('/cache-status', (req, res) => {
  const result = {};
  for (const ex of Object.keys(cache)) {
    result[ex] = { symbols: 0, candles: 0 };
    for (const sym of Object.keys(cache[ex])) {
      result[ex].symbols++;
      for (const tf of Object.keys(cache[ex][sym])) {
        result[ex].candles += cache[ex][sym][tf].data.length;
      }
    }
  }
  res.json(result);
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ KopiBar сервер запущен: http://0.0.0.0:${PORT}`);
  console.log(`   Биржи: ${Object.keys(EXCHANGES).join(', ')}`);
  console.log(`   Проверка: http://77.239.105.144:${PORT}/ping`);
});
/**
 * HISTORICAL REFERENCE ONLY.
 * This file describes the older multi-exchange proxy version.
 * The current production server is the Binance-only server in D:\kopibar-server\server.js.
 */
