import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import * as LightweightCharts from 'lightweight-charts';
import './App.css';

const SERVER = import.meta.env.VITE_KOPIBAR_SERVER || 'http://77.239.105.144:3001';
const ACTIVE_EXCHANGE = 'binance';
const KLINES_CACHE_TTL_MS = 15_000;

const timeframes = ['1m', '5m', '15m', '1h', '4h', '1d'];
const TF_MIN = { '1m':1,'5m':5,'15m':15,'1h':60,'4h':240,'1d':1440 };
const CHART_HEADER_H = 71;
const OHLCV_BAR_H = 26;

const STAR_COLORS = [
  { key:'yellow', hex:'#f0c040', label:'Жёлтый'    },
  { key:'red',    hex:'#ff4444', label:'Красный'    },
  { key:'green',  hex:'#00e676', label:'Зелёный'    },
  { key:'blue',   hex:'#4499ff', label:'Синий'      },
  { key:'purple', hex:'#cc44ff', label:'Фиолетовый' },
  { key:'orange', hex:'#ff8844', label:'Оранжевый'  },
];
const starHex = (key) => STAR_COLORS.find(c => c.key === key)?.hex || '#f0c040';

function createExchangeWS(symbol, interval, onCandle) {
  let ws = null, pingInterval = null;
  try {
    ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@kline_${interval}`);
    ws.onmessage = (e) => { try { const msg=JSON.parse(e.data); if(msg.e==='kline'){const k=msg.k; onCandle({time:k.t/1000,open:+k.o,high:+k.h,low:+k.l,close:+k.c,volume:+k.v,openTime:k.t});} } catch {} };
    if (ws) { ws.onerror=()=>{}; ws.onclose=()=>{}; }
  } catch {}
  return {
    close: () => {
      if (pingInterval) clearInterval(pingInterval);
      if (!ws) return;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.onopen = () => ws.close();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
  };
}

function normalizeCandle(candle) {
  const time = Number(candle?.time);
  const open = Number(candle?.open);
  const high = Number(candle?.high);
  const low = Number(candle?.low);
  const close = Number(candle?.close);
  const volume = Number(candle?.volume ?? 0);
  const openTime = Number(candle?.openTime ?? time * 1000);

  if (![time, open, high, low, close, volume, openTime].every(Number.isFinite)) return null;

  return {
    time,
    open,
    high: Math.max(high, open, close),
    low: Math.min(low, open, close),
    close,
    volume,
    openTime,
  };
}

function prepareCandles(rows) {
  const byTime = new Map();
  for (const row of rows || []) {
    const candle = normalizeCandle(row);
    if (!candle) continue;
    byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

const requestQueue = (() => {
  let active=0; const MAX=12, queue=[];
  const run=()=>{ if(active>=MAX||!queue.length) return; active++; const{url,resolve,reject}=queue.shift(); fetch(url).then(r=>r.json()).then(resolve).catch(reject).finally(()=>{active--;run();}); };
  return (url)=>new Promise((resolve,reject)=>{ queue.push({url,resolve,reject}); run(); });
})();

const statsCache = new Map();
async function fetchServerStats(tf, filters) {
  const natrPeriod = filters?.natrPeriod || 2;
  const volatPeriod = filters?.volatPeriod || 6;
  const corrPeriod = filters?.corrPeriod || 1;
  const key = `${tf}|${natrPeriod}|${volatPeriod}|${corrPeriod}`;
  const cached = statsCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < KLINES_CACHE_TTL_MS) return cached.data;
  const url = `${SERVER}/stats?tf=${encodeURIComponent(tf)}&natrPeriod=${encodeURIComponent(natrPeriod)}&volatPeriod=${encodeURIComponent(volatPeriod)}&corrPeriod=${encodeURIComponent(corrPeriod)}`;
  const data = await requestQueue(url);
  const normalized = data && typeof data === 'object' ? data : {};
  statsCache.set(key, { data: normalized, fetchedAt: Date.now() });
  return normalized;
}

const klinesCache = new Map();
const klinesPending = new Map();
async function fetchKlines(symbol, tf) {
  const key=`${ACTIVE_EXCHANGE}:${symbol}:${tf}`;
  const cached = klinesCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < KLINES_CACHE_TTL_MS) return cached.data;
  if (klinesPending.has(key)) return klinesPending.get(key);
  const pending = requestQueue(`${SERVER}/klines?symbol=${symbol}&interval=${tf}`)
    .then((data) => {
      if (!Array.isArray(data)) return [];
      const prepared = prepareCandles(data);
      klinesCache.set(key, { data: prepared, fetchedAt: Date.now() });
      return prepared;
    })
    .finally(() => {
      klinesPending.delete(key);
    });
  klinesPending.set(key, pending);
  const data = await pending;
  if (!Array.isArray(data)) return [];
  return data;
}

const DRAWINGS_STORAGE_KEY = 'kopibar_drawings_v1';
const ALERT_HISTORY_STORAGE_KEY = 'kopibar_alert_history_v1';
const ALERT_SOUND_STORAGE_KEY = 'kopibar_alert_sound_v1';
const MAGNET_THRESHOLD_PX = 24;
const DRAWINGS_SYNC_EVENT = 'kopibar:drawings-sync';

const readStorageJson = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const writeStorageJson = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
};

const getDrawingScopeKey = (symbol, tf) => `${symbol}|${tf}`;

const loadChartDrawings = (symbol, tf) => {
  const store = readStorageJson(DRAWINGS_STORAGE_KEY, {});
  const key = getDrawingScopeKey(symbol, tf);
  return Array.isArray(store[key]) ? store[key] : [];
};

const saveChartDrawings = (symbol, tf, drawings, sourceId = null) => {
  const store = readStorageJson(DRAWINGS_STORAGE_KEY, {});
  const key = getDrawingScopeKey(symbol, tf);
  store[key] = drawings;
  writeStorageJson(DRAWINGS_STORAGE_KEY, store);
  try {
    window.dispatchEvent(new CustomEvent(DRAWINGS_SYNC_EVENT, { detail: { key, drawings, sourceId } }));
  } catch {}
};

const makeId = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const roundPriceValue = (value) => Number(Number(value || 0).toFixed(6));
const trimTrailingZeros = (value) => String(value).replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '').replace(/\.$/u, '');
const isLineTool = (type) => type === 'trend' || type === 'ray' || type === 'arrow';
const getMidPoint = (a, b) => ({ time: (a.time + b.time) / 2, price: (a.price + b.price) / 2 });

function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  if (!dx && !dy) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1);
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function extendSegmentToBounds(a, b, width, extendLeft, extendRight) {
  if (!extendLeft && !extendRight) return [a, b];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 0.0001) return [a, b];
  const points = [];
  const projectY = (x) => a.y + ((x - a.x) / dx) * dy;
  if (extendLeft) points.push({ x: 0, y: projectY(0) });
  else points.push(a);
  if (extendRight) points.push({ x: width, y: projectY(width) });
  else points.push(b);
  return points;
}

function getArrowHeadPoints(a, b, size = 10) {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  return [
    { x: b.x - size * Math.cos(angle - Math.PI / 6), y: b.y - size * Math.sin(angle - Math.PI / 6) },
    { x: b.x, y: b.y },
    { x: b.x - size * Math.cos(angle + Math.PI / 6), y: b.y - size * Math.sin(angle + Math.PI / 6) },
  ];
}

const calculateCorrelation = (data) => {
  if (data.length < 2) return null;
  const x=[], y=[];
  for (let i=1; i<data.length; i++) {
    if (!data[i].btcClose || !data[i-1].btcClose) continue;
    x.push((data[i].close - data[i-1].close) / data[i-1].close);
    y.push((data[i].btcClose - data[i-1].btcClose) / data[i-1].btcClose);
  }
  if (x.length < 2) return null;
  const n=x.length, mx=x.reduce((a,b)=>a+b,0)/n, my=y.reduce((a,b)=>a+b,0)/n;
  let num=0, dx2=0, dy2=0;
  for (let i=0;i<n;i++){const dx=x[i]-mx,dy=y[i]-my;num+=dx*dy;dx2+=dx*dx;dy2+=dy*dy;}
  if (!dx2||!dy2) return null;
  return (num/Math.sqrt(dx2*dy2))*100;
};

const calculateNATR = (data, periodHours, tfMin, lastPrice) => {
  const n=Math.max(2,Math.round((periodHours*60)/tfMin));
  const slice=data.slice(-n);
  if (slice.length<2||!lastPrice) return 0;
  let totalTR=0;
  for (let i=1;i<slice.length;i++) totalTR+=Math.max(slice[i].high-slice[i].low,Math.abs(slice[i].high-slice[i-1].close),Math.abs(slice[i].low-slice[i-1].close));
  return (totalTR/(slice.length-1)/lastPrice)*100;
};

const calculateVolatility = (data, periodHours, tfMin) => {
  const n=Math.max(2,Math.round((periodHours*60)/tfMin));
  const slice=data.slice(-n);
  if (slice.length<2) return 0;
  const ret=[];
  for (let i=1;i<slice.length;i++) {
    if(slice[i-1].close>0&&slice[i].close>0) ret.push((slice[i].close-slice[i-1].close)/slice[i-1].close);
  }
  if (ret.length===0) return 0;
  if (ret.length===1) return Math.abs(ret[0])*100;
  const mean=ret.reduce((a,b)=>a+b,0)/ret.length;
  return Math.sqrt(ret.reduce((s,r)=>s+(r-mean)**2,0)/(ret.length-1))*100;
};

async function loadStatsForSymbols(symbols, tf, filters, btcMap, onProgress, signal) {
  const tfMin = TF_MIN[tf] || 5;
  const partial = {};
  let cursor = 0;
  const workerCount = Math.min(6, symbols.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (!signal?.cancelled) {
      const index = cursor++;
      if (index >= symbols.length) return;
      const sym = symbols[index];
      try {
        const rawData = await fetchKlines(sym, tf);
        if (signal?.cancelled) return;
        partial[sym] = computeStats(rawData, btcMap, filters, tfMin, sym);
      } catch {
        partial[sym] = null;
      }
      if (!signal?.cancelled && onProgress) onProgress({ ...partial });
    }
  }));
  return partial;
}

function computeStats(rawData, btcMap, filters, tfMin, symbol) {
  if (!rawData||rawData.length<2) return null;
  const lastPrice=rawData[rawData.length-1].close;
  if (!lastPrice) return null;
  const natr=calculateNATR(rawData,filters.natrPeriod||2,tfMin,lastPrice);
  const volat=calculateVolatility(rawData,filters.volatPeriod||6,tfMin);
  let corr=null;
  if (symbol.replace(/[-_].*/,'').toUpperCase().startsWith('BTC')) { corr=100; }
  else if (btcMap) {
    const corrN=Math.max(3,Math.round(((filters.corrPeriod||1)*60)/tfMin));
    const slice=rawData
      .map(d=>({...d,btcClose:btcMap.get(d.openTime)}))
      .filter(d => d.btcClose != null)
      .slice(-corrN);
    corr=calculateCorrelation(slice);
    if (corr!==null) corr=Math.round(corr);
  }
  return {natr,volat,corr};
}

function passesStatsFilter(s, f) {
  if (s===null) return true;
  if (s===undefined) return false;
  const natrOk=s.natr>=(f.minNatr??0)&&s.natr<=(f.maxNatr??100);
  const volatOk=s.volat>=(f.minVolat??0)&&s.volat<=(f.maxVolat??100);
  const corrOk=s.corr===null||(s.corr>=(f.minCorr??-100)&&s.corr<=(f.maxCorr??100));
  return natrOk&&volatOk&&corrOk;
}

function hasStatsFilter(f) {
  return (f.minNatr??0)>0||(f.maxNatr??100)<100||(f.minVolat??0)>0||(f.maxVolat??100)<100||(f.minCorr??-100)>-100||(f.maxCorr??100)<100;
}

const timescaleFormatter = (time, tickMarkType) => {
  const date=new Date(time*1000), pad=n=>String(n).padStart(2,'0');
  const months=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
  switch(tickMarkType){
    case LightweightCharts.TickMarkType.Year:       return String(date.getFullYear());
    case LightweightCharts.TickMarkType.Month:      return months[date.getMonth()];
    case LightweightCharts.TickMarkType.DayOfMonth: return `${date.getDate()} ${months[date.getMonth()]}`;
    default: return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
};

const getPriceFormat = (price) => {
  if (price>=1000) return {precision:2,minMove:0.01};
  if (price>=100)  return {precision:3,minMove:0.001};
  if (price>=10)   return {precision:4,minMove:0.0001};
  if (price>=1)    return {precision:4,minMove:0.0001};
  if (price>=0.1)  return {precision:5,minMove:0.00001};
  if (price>=0.01) return {precision:6,minMove:0.000001};
  if (price>=0.001)return {precision:7,minMove:0.0000001};
  return               {precision:8,minMove:0.00000001};
};

function mergeCandles(older, newer) {
  const seen = new Set();
  return [...older, ...newer]
    .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a, b) => a.time - b.time);
}

// ─── Компонент графика ────────────────────────────────────────────────────────
const ChartComponent = ({ symbol, marketStats, globalTf, filters, btcMap, isFullscreenMode, onFullscreen, onClose, precomputedStats, fixedHeight, autoSize, watchlist, onToggleWatch, selectedStarColor, enableDrawingTools = false, onAlertTriggered }) => {
  const chartContainerRef = useRef();
  const overlayRef        = useRef(null);
  const chartRef          = useRef(null);
  const candleSeriesRef   = useRef(null);
  const volumeSeriesRef   = useRef(null);
  const futureScaleSeriesRef = useRef(null);
  const btcMapRef         = useRef(btcMap);
  const allCandlesRef     = useRef([]);
  const isLoadingMoreRef  = useRef(false);
  const hasMoreRef        = useRef(true);
  const localTfRef        = useRef(globalTf);
  const isHoveringRef     = useRef(false);
  const drawingsRef       = useRef([]);
  const drawingInstanceIdRef = useRef(makeId('drawing_scope'));

  const CHEIGHT = fixedHeight || 340;
  const useAutoSize = autoSize && !isFullscreenMode;
  const canDraw = enableDrawingTools;

  const [localTf, setLocalTf]     = useState(globalTf);
  const [stats, setStats]         = useState(precomputedStats || {});
  const [loading, setLoading]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [crosshair, setCrosshair] = useState(null);
  const [drawings, setDrawings] = useState([]);
  const [activeTool, setActiveTool] = useState('select');
  const [selectedDrawingIds, setSelectedDrawingIds] = useState([]);
  const [draftDrawing, setDraftDrawing] = useState(null);
  const [dragState, setDragState] = useState(null);
  const [magnetMode, setMagnetMode] = useState(true);
  const [cursorGuide, setCursorGuide] = useState(null);
  const [, setOverlayRefreshTick] = useState(0);
  const overlayRefreshRafRef = useRef(0);
  const overlayRefreshUntilRef = useRef(0);

  const requestOverlayRefresh = useCallback((durationMs = 0) => {
    if (durationMs > 0) {
      overlayRefreshUntilRef.current = Math.max(
        overlayRefreshUntilRef.current,
        performance.now() + durationMs
      );
    }
    if (overlayRefreshRafRef.current) return;
    overlayRefreshRafRef.current = requestAnimationFrame(() => {
      overlayRefreshRafRef.current = 0;
      setOverlayRefreshTick((tick) => tick + 1);
      if (performance.now() < overlayRefreshUntilRef.current) {
        requestOverlayRefresh();
      }
    });
  }, []);

  useEffect(() => { drawingsRef.current = drawings; }, [drawings]);
  const updateDrawingsState = useCallback((updater) => {
    commitDrawings((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      drawingsRef.current = next;
      return next;
    });
  }, []);
  const persistCurrentDrawings = useCallback((nextDrawings) => {
    saveChartDrawings(symbol, localTfRef.current || localTf, nextDrawings, drawingInstanceIdRef.current);
  }, [localTf, symbol]);
  const commitDrawings = useCallback((updater) => {
    setDrawings((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      drawingsRef.current = next;
      persistCurrentDrawings(next);
      return next;
    });
  }, [persistCurrentDrawings]);
  useEffect(() => {
    const next = loadChartDrawings(symbol, localTf);
    drawingsRef.current = next;
    setDrawings(next);
    setSelectedDrawingIds([]);
    setDraftDrawing(null);
    setActiveTool('select');
  }, [symbol, localTf]);
  useEffect(() => {
    const key = getDrawingScopeKey(symbol, localTf);
    const handleSync = (event) => {
      const detail = event.detail || {};
      if (detail.sourceId === drawingInstanceIdRef.current) return;
      if (detail.key !== key) return;
      const next = Array.isArray(detail.drawings) ? detail.drawings : [];
      drawingsRef.current = next;
      setDrawings(next);
    };
    window.addEventListener(DRAWINGS_SYNC_EVENT, handleSync);
    return () => window.removeEventListener(DRAWINGS_SYNC_EVENT, handleSync);
  }, [symbol, localTf]);
  useEffect(() => () => {
    if (overlayRefreshRafRef.current) cancelAnimationFrame(overlayRefreshRafRef.current);
    overlayRefreshRafRef.current = 0;
    overlayRefreshUntilRef.current = 0;
  }, []);

  const getNearestCandleByX = useCallback((x) => {
    if (!chartRef.current) return null;
    let best = null;
    let bestDist = Infinity;
    for (const candle of allCandlesRef.current) {
      const cx = chartRef.current.timeScale().timeToCoordinate(candle.time);
      if (!Number.isFinite(cx)) continue;
      const dist = Math.abs(cx - x);
      if (dist < bestDist) {
        best = candle;
        bestDist = dist;
      }
    }
    return best;
  }, []);

  const getTfStepSec = useCallback(() => {
    const tf = localTfRef.current || localTf;
    return (TF_MIN[tf] || 5) * 60;
  }, [localTf]);

  const buildFutureScaleData = useCallback((candles) => {
    if (!Array.isArray(candles) || !candles.length) return [];
    const last = candles[candles.length - 1];
    const stepSec = getTfStepSec();
    const futureBars = 120;
    return Array.from({ length: futureBars }, (_, index) => ({
      time: last.time + stepSec * (index + 1),
    }));
  }, [getTfStepSec]);

  const syncFutureScaleSeries = useCallback((candles) => {
    if (!futureScaleSeriesRef.current) return;
    futureScaleSeriesRef.current.setData(buildFutureScaleData(candles));
  }, [buildFutureScaleData]);

  const getApproxBarSpacing = useCallback(() => {
    if (!chartRef.current) return 8;
    const candles = allCandlesRef.current;
    for (let i = candles.length - 1; i > 0; i--) {
      const prevX = chartRef.current.timeScale().timeToCoordinate(candles[i - 1].time);
      const curX = chartRef.current.timeScale().timeToCoordinate(candles[i].time);
      if (Number.isFinite(prevX) && Number.isFinite(curX) && curX !== prevX) {
        return Math.abs(curX - prevX);
      }
    }
    return 8;
  }, []);

  const coordinateToChartTime = useCallback((x) => {
    if (!chartRef.current) return null;
    const candles = allCandlesRef.current;
    if (!candles.length) return null;
    const stepSec = getTfStepSec();
    const spacing = getApproxBarSpacing();
    const first = candles[0];
    const last = candles[candles.length - 1];
    const firstX = chartRef.current.timeScale().timeToCoordinate(first.time);
    const lastX = chartRef.current.timeScale().timeToCoordinate(last.time);

    if (Number.isFinite(lastX) && x > lastX) {
      const barsAhead = (x - lastX) / spacing;
      return last.time + barsAhead * stepSec;
    }
    if (Number.isFinite(firstX) && x < firstX) {
      const barsBack = (firstX - x) / spacing;
      return first.time - barsBack * stepSec;
    }
    const direct = chartRef.current.timeScale().coordinateToTime(x);
    const numeric = Number(direct);
    if (Number.isFinite(numeric)) return numeric;
    return last.time;
  }, [getApproxBarSpacing, getTfStepSec]);

  const timeToChartCoordinate = useCallback((time) => {
    if (!chartRef.current) return null;
    const candles = allCandlesRef.current;
    if (!candles.length) return null;
    const stepSec = getTfStepSec();
    const spacing = getApproxBarSpacing();
    const first = candles[0];
    const last = candles[candles.length - 1];
    const firstX = chartRef.current.timeScale().timeToCoordinate(first.time);
    const lastX = chartRef.current.timeScale().timeToCoordinate(last.time);

    if (Number.isFinite(lastX) && time > last.time) {
      return lastX + ((time - last.time) / stepSec) * spacing;
    }
    if (Number.isFinite(firstX) && time < first.time) {
      return firstX - ((first.time - time) / stepSec) * spacing;
    }
    const direct = chartRef.current.timeScale().timeToCoordinate(time);
    if (Number.isFinite(direct)) return direct;
    return null;
  }, [getApproxBarSpacing, getTfStepSec]);

  const eventToPoint = useCallback((evt, snap = magnetMode, toolType = activeTool) => {
    if (!overlayRef.current || !chartRef.current || !candleSeriesRef.current) return null;
    const rect = overlayRef.current.getBoundingClientRect();
    const rawX = evt.clientX - rect.left;
    const rawY = evt.clientY - rect.top;
    let x = rawX;
    let y = rawY;
    let time = coordinateToChartTime(rawX);
    let price = candleSeriesRef.current.coordinateToPrice(rawY);
    const nearest = getNearestCandleByX(rawX);
    let snapped = false;
    if (snap && nearest) {
      const isSinglePointHorizontalTool = toolType === 'hline' || toolType === 'alert' || toolType === 'ray';
      const xThreshold = isSinglePointHorizontalTool ? MAGNET_THRESHOLD_PX * 1.75 : MAGNET_THRESHOLD_PX;
      const yThreshold = isSinglePointHorizontalTool ? MAGNET_THRESHOLD_PX * 1.4 : MAGNET_THRESHOLD_PX;
      const candleX = chartRef.current.timeScale().timeToCoordinate(nearest.time);
      if (Number.isFinite(candleX)) {
        const levels = [nearest.open, nearest.high, nearest.low, nearest.close]
          .map((value) => {
            const py = candleSeriesRef.current.priceToCoordinate(value);
            if (!Number.isFinite(py)) return null;
            return {
              value,
              x: candleX,
              y: py,
              distX: Math.abs(candleX - rawX),
              distY: Math.abs(py - rawY),
            };
          })
          .filter(Boolean)
          .sort((a, b) => (a.distX + a.distY) - (b.distX + b.distY));
        const best = levels[0];
        if (best && best.distX <= xThreshold && best.distY <= yThreshold) {
          snapped = true;
          x = best.x;
          y = best.y;
          time = nearest.time;
          price = best.value;
        }
      }
    }
    const numericTime = Number(time);
    if (!Number.isFinite(numericTime) && nearest) time = nearest.time;
    else time = numericTime;
    if (!Number.isFinite(price)) price = nearest?.close;
    if (!Number.isFinite(time) || !Number.isFinite(price)) return null;
    return { time, price: roundPriceValue(price), x, y, snapped };
  }, [activeTool, coordinateToChartTime, getNearestCandleByX, magnetMode]);

  const projectPoint = useCallback((point) => {
    if (!chartRef.current || !candleSeriesRef.current || !point) return null;
    const x = timeToChartCoordinate(point.time);
    const y = candleSeriesRef.current.priceToCoordinate(point.price);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }, [timeToChartCoordinate]);

  const getDrawingRenderData = useCallback((drawing) => {
    const width = overlayRef.current?.clientWidth || chartContainerRef.current?.clientWidth || 0;
    const height = overlayRef.current?.clientHeight || chartContainerRef.current?.clientHeight || 0;
    if (!width || !height) return null;
    const lastCandle = allCandlesRef.current[allCandlesRef.current.length - 1];
    const nextBarX = lastCandle ? timeToChartCoordinate(lastCandle.time + getTfStepSec()) : null;
    if (drawing.type === 'ray') {
      const p = projectPoint(drawing.points?.[0]);
      if (!p) return null;
      const priceLabelX = clamp(p.x + 10, 10, width - 92);
      const isLowerZone = p.y > height * 0.6;
      const priceLabelY = clamp(isLowerZone ? p.y + 18 : p.y - 8, 14, height - 10);
      return {
        type: drawing.type,
        line: [{ x: p.x, y: p.y }, { x: width, y: p.y }],
        handles: [{ key: 'p0', x: p.x, y: p.y }],
        labelAt: { x: p.x + 8, y: p.y - 8 },
        priceLabelAt: { x: priceLabelX, y: priceLabelY },
      };
    }
    if (drawing.type === 'hline' || drawing.type === 'alert') {
      const y = candleSeriesRef.current?.priceToCoordinate?.(drawing.price);
      if (!Number.isFinite(y)) return null;
      const handleX = drawing.type === 'hline'
        ? clamp(Number.isFinite(nextBarX) ? nextBarX + 18 : width - 64, 22, width - 56)
        : width - 36;
      return { type: drawing.type, line: [{ x: 0, y }, { x: width, y }], handles: [{ key: 'price', x: handleX, y }], labelAt: { x: 12, y: y - 8 } };
    }
    if (drawing.type === 'text') {
      const p = projectPoint(drawing.points?.[0]);
      if (!p) return null;
      return { type: drawing.type, point: p, handles: [{ key: 'p0', x: p.x, y: p.y }], labelAt: { x: p.x + 8, y: p.y - 8 } };
    }
    if (!Array.isArray(drawing.points) || drawing.points.length < 2) return null;
    const p1 = projectPoint(drawing.points[0]);
    const p2 = projectPoint(drawing.points[1]);
    if (!p1 || !p2) return null;
    if (drawing.type === 'rect') {
      const x = Math.min(p1.x, p2.x);
      const y = Math.min(p1.y, p2.y);
      const w = Math.abs(p2.x - p1.x);
      const h = Math.abs(p2.y - p1.y);
      return { type: drawing.type, rect: { x, y, w, h }, handles: [{ key: 'p0', x: p1.x, y: p1.y }, { key: 'p1', x: p2.x, y: p2.y }], labelAt: { x: x + 6, y: y - 8 } };
    }
    const extendLeft = drawing.extendLeft || false;
    const extendRight = drawing.extendRight || false;
    const [a, b] = extendSegmentToBounds(p1, p2, width, extendLeft, extendRight);
    return {
      type: drawing.type,
      line: [a, b],
      handles: [{ key: 'p0', x: p1.x, y: p1.y }, { key: 'p1', x: p2.x, y: p2.y }],
      arrowHead: drawing.type === 'arrow' ? getArrowHeadPoints(a, b) : null,
      labelAt: { x: (p1.x + p2.x) / 2 + 8, y: (p1.y + p2.y) / 2 - 8 },
    };
  }, [getTfStepSec, projectPoint, timeToChartCoordinate]);

  const findHitTarget = useCallback((x, y) => {
    for (let i = drawings.length - 1; i >= 0; i--) {
      const drawing = drawings[i];
      const data = getDrawingRenderData(drawing);
      if (!data) continue;
      for (const handle of data.handles || []) {
        if (Math.hypot(handle.x - x, handle.y - y) <= 8) {
          return { drawing, mode: 'handle', handle: handle.key };
        }
      }
      if ((drawing.type === 'hline' || drawing.type === 'alert') && data.line) {
        if (Math.abs(data.line[0].y - y) <= 6) return { drawing, mode: 'move' };
      } else if (drawing.type === 'text' && data.point) {
        if (Math.hypot(data.point.x - x, data.point.y - y) <= 14) return { drawing, mode: 'move' };
      } else if (drawing.type === 'rect' && data.rect) {
        const inside = x >= data.rect.x - 4 && x <= data.rect.x + data.rect.w + 4 && y >= data.rect.y - 4 && y <= data.rect.y + data.rect.h + 4;
        if (inside) return { drawing, mode: 'move' };
      } else if (data.line) {
        const [a, b] = data.line;
        if (pointToSegmentDistance(x, y, a.x, a.y, b.x, b.y) <= 6) return { drawing, mode: 'move' };
      }
    }
    return null;
  }, [drawings, getDrawingRenderData]);

  const moveDrawingByDelta = useCallback((drawing, deltaTime, deltaPrice) => {
    if (drawing.type === 'hline' || drawing.type === 'alert') {
      return { ...drawing, price: roundPriceValue(drawing.price + deltaPrice), triggeredAt: null };
    }
    if (drawing.type === 'text') {
      return {
        ...drawing,
        points: drawing.points.map((point) => ({ time: point.time + deltaTime, price: roundPriceValue(point.price + deltaPrice) })),
      };
    }
    return {
      ...drawing,
      points: drawing.points.map((point) => ({ time: point.time + deltaTime, price: roundPriceValue(point.price + deltaPrice) })),
      triggeredAt: drawing.type === 'alert' ? null : drawing.triggeredAt,
    };
  }, []);

  const updateDrawingHandle = useCallback((drawing, handle, point) => {
    if (drawing.type === 'hline' || drawing.type === 'alert') return { ...drawing, price: roundPriceValue(point.price), triggeredAt: null };
    if (drawing.type === 'text') return { ...drawing, points: [{ time: point.time, price: roundPriceValue(point.price) }] };
    const nextPoints = drawing.points.map((item, index) => {
      if ((handle === 'p0' && index === 0) || (handle === 'p1' && index === 1)) {
        return { time: point.time, price: roundPriceValue(point.price) };
      }
      return item;
    });
    return { ...drawing, points: nextPoints, triggeredAt: drawing.type === 'alert' ? null : drawing.triggeredAt };
  }, []);

  const clearChartDrawings = useCallback(() => {
    if (!drawings.length) return;
    commitDrawings([]);
    setSelectedDrawingIds([]);
    setDraftDrawing(null);
  }, [commitDrawings, drawings.length]);

  const setSelectedLabel = useCallback(() => {
    const selectedDrawingId = selectedDrawingIds[selectedDrawingIds.length - 1];
    const drawing = drawings.find((item) => item.id === selectedDrawingId);
    if (!drawing) return;
    const current = drawing.type === 'text' ? drawing.text || '' : drawing.label || '';
    const next = window.prompt('Введите подпись', current);
    if (next === null) return;
    commitDrawings((prev) => prev.map((item) => {
      if (item.id !== selectedDrawingId) return item;
      return item.type === 'text' ? { ...item, text: next } : { ...item, label: next };
    }));
  }, [commitDrawings, drawings, selectedDrawingIds]);

  const toggleSelectedExtend = useCallback((side) => {
    const selectedDrawingId = selectedDrawingIds[selectedDrawingIds.length - 1];
    commitDrawings((prev) => prev.map((item) => {
      if (item.id !== selectedDrawingId || !isLineTool(item.type) || item.type === 'arrow') return item;
      const key = side === 'left' ? 'extendLeft' : 'extendRight';
      return { ...item, [key]: !item[key] };
    }));
  }, [commitDrawings, selectedDrawingIds]);

  const checkAlertTriggers = useCallback((candle) => {
    if (!canDraw || !onAlertTriggered || !candle) return;
    setDrawings((prev) => {
      let changed = false;
      const next = prev.map((drawing) => {
        if (drawing.type !== 'alert' || drawing.triggeredAt) return drawing;
        if (candle.low <= drawing.price && candle.high >= drawing.price) {
          changed = true;
          const triggeredAt = Date.now();
          onAlertTriggered({
            id: makeId('alert'),
            drawingId: drawing.id,
            symbol,
            tf: localTfRef.current,
            price: roundPriceValue(drawing.price),
            label: drawing.label || '',
            triggeredAt,
          });
          return { ...drawing, triggeredAt };
        }
        return drawing;
      });
      return changed ? next : prev;
    });
  }, [canDraw, commitDrawings, onAlertTriggered, symbol]);

  useEffect(() => { btcMapRef.current = btcMap; }, [btcMap]);
  useEffect(() => { setLocalTf(globalTf); }, [globalTf]);
  useEffect(() => { localTfRef.current = localTf; }, [localTf]);
  useEffect(() => { if (precomputedStats) setStats(precomputedStats); }, [precomputedStats]);

  useEffect(() => {
    const h = () => {
      if (!chartRef.current||!chartContainerRef.current) return;
      if (useAutoSize) return;
      chartRef.current.applyOptions({
        width:  isFullscreenMode ? window.innerWidth : chartContainerRef.current.clientWidth,
        height: isFullscreenMode ? window.innerHeight - CHART_HEADER_H - OHLCV_BAR_H : CHEIGHT - OHLCV_BAR_H,
      });
      requestOverlayRefresh(160);
    };
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, [isFullscreenMode, CHEIGHT, requestOverlayRefresh, useAutoSize]);

  useEffect(() => {
    if (!chartContainerRef.current) return;
    const container = chartContainerRef.current;
    const keepOverlayInSync = (durationMs) => requestOverlayRefresh(durationMs);
    const handleWheel = () => keepOverlayInSync(220);
    const handleMouseDown = () => keepOverlayInSync(900);
    const handleMouseMove = (event) => {
      if (event.buttons) keepOverlayInSync(90);
    };
    const handleMouseUp = () => keepOverlayInSync(120);

    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('mousedown', handleMouseDown);
    container.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => keepOverlayInSync(120));
      resizeObserver.observe(container);
    }

    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('mousedown', handleMouseDown);
      container.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      resizeObserver?.disconnect();
    };
  }, [requestOverlayRefresh]);

  useEffect(() => {
    if (!isFullscreenMode) return;
    const h = (e) => { if(e.key==='Escape'&&onClose) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [isFullscreenMode, onClose]);

  useEffect(() => {
    const h = (e) => {
      if (e.key !== 'Delete' || !selectedDrawingIds.length) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      const selectedSet = new Set(selectedDrawingIds);
      commitDrawings((prev) => prev.filter((item) => !selectedSet.has(item.id)));
      setSelectedDrawingIds([]);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [commitDrawings, selectedDrawingIds]);

  // ── Создаём chart ОДИН РАЗ ──────────────────────────────────────────────────
  useEffect(() => {
    if (!chartContainerRef.current) return;
    let cancelled = false;

    const w = isFullscreenMode ? window.innerWidth : (chartContainerRef.current.clientWidth||800);
    const h = isFullscreenMode ? window.innerHeight - CHART_HEADER_H - OHLCV_BAR_H : CHEIGHT - OHLCV_BAR_H;

    const chart = LightweightCharts.createChart(chartContainerRef.current, {
      layout: { background:{type:LightweightCharts.ColorType.Solid,color:'#0d0d0f'}, textColor:'#a1a1aa' },
      grid:   { vertLines:{visible:false}, horzLines:{visible:false} },
      crosshair: { mode:LightweightCharts.CrosshairMode.Normal },
      handleScroll: { pressedMouseMove: true, mouseWheel: true, horzTouchDrag: true, vertTouchDrag: true },
      rightPriceScale: { borderVisible:false, autoScale:true, minimumWidth:80 },
      timeScale: { borderVisible:false, rightOffset:60, barSpacing:3, minBarSpacing:0, timeVisible:true, secondsVisible:false, tickMarkFormatter:timescaleFormatter },
      ...(useAutoSize ? { autoSize:true } : { width:w, height:h }),
    });

    const candleSeries = chart.addCandlestickSeries({ upColor:'#00ff9d', downColor:'#ff3b3b', borderVisible:false, wickUpColor:'#00ff9d', wickDownColor:'#ff3b3b' });
    const volumeSeries = chart.addHistogramSeries({ color:'#26a69a', priceFormat:{type:'volume'}, priceScaleId:'' });
    const futureScaleSeries = chart.addLineSeries({
      color: 'rgba(0,0,0,0)',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    chart.priceScale('').applyOptions({ scaleMargins:{top:0.8,bottom:0} });

    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    futureScaleSeriesRef.current = futureScaleSeries;
    chartRef.current        = chart;

    chart.subscribeCrosshairMove((param) => {
      if (cancelled) return;
      requestOverlayRefresh(48);
      if (!param.time||!param.seriesData) {
        isHoveringRef.current = false;
        const last = allCandlesRef.current[allCandlesRef.current.length - 1];
        if (last) setCrosshair(last);
        return;
      }
      isHoveringRef.current = true;
      const c=param.seriesData.get(candleSeries), v=param.seriesData.get(volumeSeries);
      if (c) setCrosshair({open:c.open,high:c.high,low:c.low,close:c.close,volume:v?.value??0});
      else {
        const last = allCandlesRef.current[allCandlesRef.current.length - 1];
        if (last) setCrosshair(last);
      }
    });

    // Lazy loading при скролле влево
    chart.timeScale().subscribeVisibleLogicalRangeChange(async (range) => {
      requestOverlayRefresh(160);
      if (cancelled || !range || isLoadingMoreRef.current || !hasMoreRef.current) return;
      if (range.from > 100) return;
      const first = allCandlesRef.current[0];
      if (!first) return;
      isLoadingMoreRef.current = true;
      if (!cancelled) setLoadingMore(true);
      try {
        const url = `${SERVER}/klines?symbol=${symbol}&interval=${localTfRef.current}&before=${first.time - 1}`;
        const older = await requestQueue(url);
        if (cancelled) { isLoadingMoreRef.current = false; return; }
        if (!Array.isArray(older) || older.length === 0) {
          hasMoreRef.current = false;
        } else {
          const merged = mergeCandles(older, allCandlesRef.current);
          allCandlesRef.current = merged;
          if (candleSeriesRef.current && !cancelled) {
            candleSeriesRef.current.setData(merged);
            volumeSeriesRef.current.setData(merged.map(d => ({ time:d.time, value:d.volume, color:d.close>=d.open?'rgba(0,255,157,0.5)':'rgba(255,59,59,0.5)' })));
            syncFutureScaleSeries(merged);
            requestOverlayRefresh(180);
          }
          if (older.length < 100) hasMoreRef.current = false;
        }
      } catch {}
      isLoadingMoreRef.current = false;
      if (!cancelled) setLoadingMore(false);
    });

    return () => {
      cancelled = true;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      futureScaleSeriesRef.current = null;
      chartRef.current        = null;
      allCandlesRef.current   = [];
      isHoveringRef.current   = false;
      try { chart.remove(); } catch {}
    };
  }, [symbol, isFullscreenMode, CHEIGHT, requestOverlayRefresh, useAutoSize]); // eslint-disable-line

  // ── Загружаем данные при смене TF (без пересоздания графика) ───────────────
  useEffect(() => {
    if (!chartContainerRef.current) return;

    let cancelled = false;
    let wsHandle  = null;

    const doLoad = () => {
      if (!candleSeriesRef.current || !volumeSeriesRef.current || !chartRef.current) return;
      allCandlesRef.current    = [];
      hasMoreRef.current       = true;
      isLoadingMoreRef.current = false;
      futureScaleSeriesRef.current?.setData([]);
      setLoading(true);
      setLoadingMore(false);

      fetchKlines(symbol, localTf).then(rawData => {
        if (cancelled || !candleSeriesRef.current) return;
        if (rawData.length > 0) {
          const prepared = prepareCandles(rawData);
          allCandlesRef.current = prepared;
          candleSeriesRef.current.setData(prepared);
          const lastPrice = prepared[prepared.length-1].close;
          candleSeriesRef.current.applyOptions({ priceFormat:{type:'price',...getPriceFormat(lastPrice)} });
          volumeSeriesRef.current.setData(prepared.map(d => ({ time:d.time, value:d.volume, color:d.close>=d.open?'rgba(0,255,157,0.5)':'rgba(255,59,59,0.5)' })));
          syncFutureScaleSeries(prepared);
          chartRef.current.timeScale().scrollToRealTime();
          requestOverlayRefresh(180);
          if (!precomputedStats) {
            const tfMin = TF_MIN[localTf]||5;
            const s = computeStats(prepared, btcMapRef.current, filters, tfMin, symbol);
            if (!cancelled && s) setStats(s);
          }
          if (!cancelled) checkAlertTriggers(prepared[prepared.length - 1]);
          if (!cancelled) setCrosshair(prepared[prepared.length - 1]);
        }
        if (!cancelled) setLoading(false);
        if (!cancelled) wsHandle = createExchangeWS(symbol, localTf, (candle) => {
          if (cancelled||!candleSeriesRef.current||!volumeSeriesRef.current) return;
          const nextCandle = normalizeCandle(candle);
          if (!nextCandle) return;
          const arr = allCandlesRef.current;
          if (arr.length > 0 && arr[arr.length-1].time === nextCandle.time) arr[arr.length-1] = nextCandle;
          else if (!arr.length || nextCandle.time > arr[arr.length-1].time) arr.push(nextCandle);
          candleSeriesRef.current.update(nextCandle);
          volumeSeriesRef.current.update({ time:nextCandle.time, value:nextCandle.volume, color:nextCandle.close>=nextCandle.open?'rgba(0,255,157,0.5)':'rgba(255,59,59,0.5)' });
          syncFutureScaleSeries(arr);
          requestOverlayRefresh(80);
          checkAlertTriggers(nextCandle);
          if (!isHoveringRef.current) setCrosshair(nextCandle);
        });
      });
    };

    // setTimeout(0) — даём первому useEffect завершиться если компонент только смонтировался
    const timer = setTimeout(doLoad, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (wsHandle) wsHandle.close();
    };
  }, [localTf, requestOverlayRefresh, symbol, syncFutureScaleSeries]); // eslint-disable-line

  // Пересчёт stats при изменении периодов фильтров
  useEffect(() => {
    const cached = klinesCache.get(`${ACTIVE_EXCHANGE}:${symbol}:${localTf}`)?.data;
    if (!cached || !cached.length) return;
    if (precomputedStats) return;
    const tfMin = TF_MIN[localTf]||5;
    const s = computeStats(cached, btcMapRef.current, filters, tfMin, symbol);
    if (s) setStats(s);
  }, [filters.natrPeriod, filters.volatPeriod, filters.corrPeriod, filters.minNatr, filters.maxNatr, filters.minVolat, filters.maxVolat, filters.minCorr, filters.maxCorr]); // eslint-disable-line

  const selectedDrawing = useMemo(() => {
    const selectedDrawingId = selectedDrawingIds[selectedDrawingIds.length - 1];
    return drawings.find((item) => item.id === selectedDrawingId) || null;
  }, [drawings, selectedDrawingIds]);
  const selectedDrawingRender = useMemo(
    () => selectedDrawing ? getDrawingRenderData(selectedDrawing) : null,
    [selectedDrawing, getDrawingRenderData]
  );

  const buildLabeledDrawing = useCallback((type, point) => {
    const base = {
      id: makeId(type),
      type,
      label: '',
      color: type === 'alert' ? '#ff7a7a' : type === 'rect' ? '#ffb84d' : '#57c7ff',
    };
    if (type === 'text') {
      const text = window.prompt('Текстовая метка', '') || 'Текст';
      return { ...base, text, points: [{ time: point.time, price: point.price }] };
    }
    if (type === 'hline') {
      return { ...base, price: point.price };
    }
    if (type === 'alert') {
      return { ...base, price: point.price, label: '', triggeredAt: null };
    }
    if (type === 'ray') {
      return { ...base, points: [{ time: point.time, price: point.price }] };
    }
    return { ...base, points: [{ time: point.time, price: point.price }, { time: point.time, price: point.price }], extendLeft: false, extendRight: false };
  }, []);

  const handleOverlayMouseDown = useCallback((e) => {
    if (!canDraw || e.button !== 0) return;
    if (e.target?.closest?.('.drawing-toolbar') || e.target?.closest?.('.drawing-line-actions') || e.target?.closest?.('.drawing-label-actions')) return;
    const point = eventToPoint(e, magnetMode && activeTool !== 'select', activeTool);
    if (!point) return;

    if (activeTool === 'select') {
      const hit = findHitTarget(point.x, point.y);
      if (!hit) {
        setSelectedDrawingIds([]);
        setDragState(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setSelectedDrawingIds([hit.drawing.id]);
      setDragState({
        mode: hit.mode,
        drawingId: hit.drawing.id,
        handle: hit.handle || null,
        startPoint: point,
        origin: JSON.parse(JSON.stringify(hit.drawing)),
      });
      return;
    }

    if (activeTool === 'text' || activeTool === 'hline' || activeTool === 'alert' || activeTool === 'ray') {
      e.preventDefault();
      e.stopPropagation();
      const drawing = buildLabeledDrawing(activeTool, point);
      commitDrawings((prev) => [...prev, drawing]);
      setSelectedDrawingIds([drawing.id]);
      setActiveTool('select');
      return;
    }

    if (!draftDrawing) {
      e.preventDefault();
      e.stopPropagation();
      const drawing = buildLabeledDrawing(activeTool, point);
      setDraftDrawing(drawing);
      setSelectedDrawingIds([]);
      return;
    }

    const finalPoint = (e.shiftKey && (activeTool === 'trend' || activeTool === 'arrow'))
      ? { ...point, price: draftDrawing.points[0].price }
      : point;
    e.preventDefault();
    e.stopPropagation();
    const completed = {
      ...draftDrawing,
      points: [draftDrawing.points[0], { time: finalPoint.time, price: finalPoint.price }],
    };
    commitDrawings((prev) => [...prev, completed]);
    setSelectedDrawingIds([completed.id]);
    setDraftDrawing(null);
    setActiveTool('select');
  }, [activeTool, buildLabeledDrawing, canDraw, commitDrawings, draftDrawing, eventToPoint, findHitTarget]);

  const handleOverlayMouseMove = useCallback((e) => {
    if (e.target?.closest?.('.drawing-toolbar') || e.target?.closest?.('.drawing-line-actions') || e.target?.closest?.('.drawing-label-actions')) return;
    const dragToolType = dragState?.origin?.type || draftDrawing?.type || activeTool;
    const shouldSnap =
      canDraw &&
      magnetMode &&
      (
        (activeTool !== 'select' && !dragState) ||
        dragState?.mode === 'handle'
      );
    const point = eventToPoint(e, shouldSnap, dragToolType);
    if (!point) return;
    setCursorGuide(point);
    if (!canDraw) return;
    if (draftDrawing) {
      const nextPoint = (e.shiftKey && (draftDrawing.type === 'trend' || draftDrawing.type === 'arrow'))
        ? { ...point, price: draftDrawing.points[0].price }
        : point;
      setDraftDrawing((prev) => prev ? { ...prev, points: [prev.points[0], { time: nextPoint.time, price: nextPoint.price }] } : prev);
      return;
    }
    if (!dragState) return;
    updateDrawingsState((prev) => prev.map((item) => {
      if (item.id !== dragState.drawingId) return item;
      if (dragState.mode === 'handle') {
        let nextPoint = point;
        if (e.shiftKey && (dragState.origin.type === 'trend' || dragState.origin.type === 'arrow')) {
          const otherPoint = dragState.handle === 'p0' ? dragState.origin.points?.[1] : dragState.origin.points?.[0];
          if (otherPoint) nextPoint = { ...point, price: otherPoint.price };
        }
        return updateDrawingHandle(dragState.origin, dragState.handle, nextPoint);
      }
      const deltaTime = point.time - dragState.startPoint.time;
      const deltaPrice = point.price - dragState.startPoint.price;
      return moveDrawingByDelta(dragState.origin, deltaTime, deltaPrice);
    }));
  }, [activeTool, canDraw, dragState, draftDrawing, eventToPoint, moveDrawingByDelta, updateDrawingsState, updateDrawingHandle]);

  const handleOverlayMouseUp = useCallback(() => {
    if (dragState) {
      persistCurrentDrawings(drawingsRef.current);
      setDragState(null);
    }
  }, [dragState, persistCurrentDrawings]);

  const handleStageMouseLeave = useCallback(() => {
    setCursorGuide(null);
  }, []);

  useEffect(() => {
    if (!dragState) return;
    const onMove = (event) => handleOverlayMouseMove(event);
    const onUp = () => handleOverlayMouseUp();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragState, handleOverlayMouseMove, handleOverlayMouseUp]);

  const renderDrawingElement = useCallback((drawing, isDraft = false) => {
    const data = getDrawingRenderData(drawing);
    if (!data) return null;
    const color = drawing.color || (drawing.type === 'alert' ? '#ff7a7a' : drawing.type === 'rect' ? '#ffb84d' : '#57c7ff');
    const isSelected = selectedDrawingIds.includes(drawing.id) && !isDraft;
    const stroke = drawing.type === 'alert' && drawing.triggeredAt ? '#ffd166' : color;
    const labelText = drawing.type === 'text' ? drawing.text : drawing.label;
    const elements = [];

    if (drawing.type === 'rect' && data.rect) {
      elements.push(<rect key={`${drawing.id}_rect`} x={data.rect.x} y={data.rect.y} width={data.rect.w} height={data.rect.h} fill="rgba(255,184,77,0.10)" stroke={stroke} strokeWidth={isSelected ? 1.6 : 1} strokeDasharray={isDraft ? '6 4' : undefined} />);
    } else if ((drawing.type === 'hline' || drawing.type === 'alert') && data.line) {
      elements.push(<line key={`${drawing.id}_line`} x1={data.line[0].x} y1={data.line[0].y} x2={data.line[1].x} y2={data.line[1].y} stroke={stroke} strokeWidth={isSelected ? 1.5 : 0.9} strokeDasharray={drawing.type === 'alert' ? '6 4' : (isDraft ? '6 4' : undefined)} />);
    } else if (data.line) {
      elements.push(<line key={`${drawing.id}_line`} x1={data.line[0].x} y1={data.line[0].y} x2={data.line[1].x} y2={data.line[1].y} stroke={stroke} strokeWidth={isSelected ? 1.5 : 0.95} strokeDasharray={isDraft ? '6 4' : undefined} />);
      if (data.arrowHead) {
        const points = data.arrowHead.map((point) => `${point.x},${point.y}`).join(' ');
        elements.push(<polyline key={`${drawing.id}_arrow`} points={points} fill="none" stroke={stroke} strokeWidth={isSelected ? 1.5 : 0.95} />);
      }
    }

    if (drawing.type === 'text' && data.point) {
      elements.push(<text key={`${drawing.id}_text`} x={data.point.x + 8} y={data.point.y - 8} fill={stroke} fontSize="12">{drawing.text || 'Текст'}</text>);
    } else if (labelText && data.labelAt) {
      elements.push(<text key={`${drawing.id}_label`} x={data.labelAt.x} y={data.labelAt.y} fill={stroke} fontSize="11">{labelText}</text>);
    }
    if (drawing.type === 'ray' && data.priceLabelAt) {
      const priceValue = drawing.points?.[0]?.price;
      const priceText = Number.isFinite(priceValue)
        ? trimTrailingZeros(Number(priceValue).toFixed(Math.min(getPriceFormat(priceValue).precision + 2, 8)))
        : '';
      if (priceText) {
        elements.push(<text key={`${drawing.id}_price`} x={data.priceLabelAt.x} y={data.priceLabelAt.y} fill={stroke} fontSize="11">{priceText}</text>);
      }
    }

    if (isSelected && !isDraft) {
      for (const handle of data.handles || []) {
        elements.push(<circle key={`${drawing.id}_${handle.key}`} cx={handle.x} cy={handle.y} r="3.5" fill="#0d0d0f" stroke="#ffffff" strokeWidth="1" />);
      }
    }
    return <g key={drawing.id}>{elements}</g>;
  }, [getDrawingRenderData, selectedDrawingIds]);

  const fmtPrice = (v) => v.toFixed(Math.min(getPriceFormat(v).precision+2, 8));
  const fmtVol   = (v) => v>=1e6?(v/1e6).toFixed(2)+'M':v>=1e3?(v/1e3).toFixed(1)+'K':v.toFixed(0);

  const content = (
    <>
      <div className="chart-header">
        <span className="symbol-name">{symbol}</span>
        <div className="tf-selector-mini">
          {timeframes.map(tf => <button key={tf} className={`tf-btn-mini ${localTf===tf?'active':''}`} onClick={() => setLocalTf(tf)}>{tf}</button>)}
        </div>
        <div className="chart-header-btns">
          {onToggleWatch && (
            <button className="chart-star-btn"
              style={{color: watchlist?.[symbol] ? starHex(watchlist[symbol]) : '#333'}}
              onClick={(e)=>{e.stopPropagation(); onToggleWatch(symbol);}}
              title={watchlist?.[symbol] ? `Помечено (${STAR_COLORS.find(c=>c.key===watchlist[symbol])?.label})` : 'Пометить'}>★</button>
          )}
          {isFullscreenMode
            ? <button className="fullscreen-btn" onClick={onClose} title="Закрыть">✕</button>
            : onFullscreen ? <button className="fullscreen-btn" onClick={(e)=>{e.stopPropagation();onFullscreen();}} title="Развернуть">⛶</button> : null}
        </div>
      </div>
      <div className={`ohlcv-bar ${crosshair?'ohlcv-bar-visible':''}`}>
        {crosshair && <>
          <span className="ohlcv-label">Откр</span><span className="ohlcv-val">{fmtPrice(crosshair.open)}</span>
          <span className="ohlcv-label">Макс</span><span className="ohlcv-val ohlcv-high">{fmtPrice(crosshair.high)}</span>
          <span className="ohlcv-label">Мин</span><span className="ohlcv-val ohlcv-low">{fmtPrice(crosshair.low)}</span>
          <span className="ohlcv-label">Закр</span><span className={`ohlcv-val ${crosshair.close>=crosshair.open?'ohlcv-green':'ohlcv-red'}`}>{fmtPrice(crosshair.close)}</span>
          <span className="ohlcv-sep">│</span>
          <span className="ohlcv-label">Объём</span><span className="ohlcv-val ohlcv-vol">{fmtVol(crosshair.volume)}</span>
        </>}
      </div>
      <div
        className={`chart-relative-container ${canDraw ? 'chart-drawing-enabled' : ''}`}
        style={ useAutoSize ? {flex:1,minHeight:0} : { height: isFullscreenMode ? `calc(100vh - ${CHART_HEADER_H + OHLCV_BAR_H}px)` : `${CHEIGHT - OHLCV_BAR_H}px` } }
        onMouseDownCapture={canDraw ? handleOverlayMouseDown : undefined}
        onMouseMove={canDraw ? handleOverlayMouseMove : undefined}
        onMouseLeave={canDraw ? handleStageMouseLeave : undefined}
      >
        {canDraw && (
          <div className="drawing-toolbar">
            {[
              ['select', '⌖', 'Курсор'],
              ['trend', '╱', 'Линия тренда'],
              ['ray', '⟶', 'Горизонтальный луч'],
              ['hline', '—', 'Горизонтальный уровень'],
              ['rect', '▭', 'Прямоугольник / зона'],
              ['arrow', '➜', 'Стрелка'],
              ['text', 'T', 'Текст'],
              ['alert', '🔔', 'Алерт'],
            ].map(([key, icon, label]) => (
              <button key={key} className={`drawing-btn ${activeTool===key?'active':''}`} onClick={() => { setActiveTool(key); setDraftDrawing(null); }} title={label}>{icon}</button>
            ))}
            <button className={`drawing-btn ${magnetMode?'active':''}`} onClick={() => setMagnetMode(v => !v)} title="Магнит">∩</button>
            {selectedDrawing && (
              <>
                <button className="drawing-btn" onClick={setSelectedLabel} title="Подпись">✎</button>
                {selectedDrawing.type === 'trend' && (
                  <>
                    <button className={`drawing-btn ${selectedDrawing.extendLeft?'active':''}`} onClick={() => toggleSelectedExtend('left')} title="Продлить влево">←</button>
                    <button className={`drawing-btn ${selectedDrawing.extendRight?'active':''}`} onClick={() => toggleSelectedExtend('right')} title="Продлить вправо">→</button>
                  </>
                )}
                <button className="drawing-btn danger" onClick={() => setDrawings((prev) => prev.filter((item) => item.id !== selectedDrawing.id))} title="Удалить">⌫</button>
              </>
            )}
            <button className="drawing-btn danger" onClick={clearChartDrawings} title="Очистить график">🗑</button>
          </div>
        )}
        {canDraw && selectedDrawing?.type === 'trend' && selectedDrawingRender?.labelAt && (
          <div
            className="drawing-line-actions"
            style={{
              left: `${Math.max(72, selectedDrawingRender.labelAt.x - (selectedDrawing?.type === 'trend' ? 56 : 18))}px`,
              top: `${Math.max(12, selectedDrawingRender.labelAt.y - 42)}px`,
            }}
          >
            <button className={`drawing-btn ${selectedDrawing.extendLeft?'active':''}`} onClick={() => toggleSelectedExtend('left')} title="Продлить влево">←</button>
            <button className={`drawing-btn ${selectedDrawing.extendRight?'active':''}`} onClick={() => toggleSelectedExtend('right')} title="Продлить вправо">→</button>
          </div>
        )}
        {canDraw && selectedDrawingRender?.labelAt && (
          <div
            className="drawing-label-actions"
            style={{
              left: `${Math.max(72, selectedDrawingRender.labelAt.x - 18)}px`,
              top: `${Math.max(12, selectedDrawingRender.labelAt.y - (selectedDrawing?.type === 'trend' ? 82 : 42))}px`,
            }}
          >
            <button className="drawing-btn" onClick={setSelectedLabel} title="Подпись">✎</button>
          </div>
        )}
        {loading && <div className="chart-loader"><div className="scanner-line"></div><div className="loader-info"><div className="loader-ticker">{symbol.replace(/[-_]?USDT.*/i,'')}</div><div className="loader-status">DECODING DATA...</div></div></div>}
        {loadingMore && !loading && (
          <div style={{position:'absolute',top:8,left:'50%',transform:'translateX(-50%)',zIndex:20,background:'rgba(0,0,0,0.7)',color:'#00ff9d',fontSize:11,padding:'3px 10px',borderRadius:4,pointerEvents:'none'}}>
            ← загрузка истории...
          </div>
        )}
        <div className={`chart-anchor ${loading?'blurred':''}`} ref={chartContainerRef} />
        {(canDraw || drawings.length > 0) && (
          <svg
            ref={overlayRef}
            className={`drawing-overlay ${canDraw && activeTool!=='select'?'drawing-overlay-draw':''}`}
          >
            {canDraw && cursorGuide && (
              <g className="drawing-guide">
                <line x1={cursorGuide.x} y1={0} x2={cursorGuide.x} y2="100%" />
                <line x1={0} y1={cursorGuide.y} x2="100%" y2={cursorGuide.y} />
              </g>
            )}
            {drawings.map((drawing) => renderDrawingElement(drawing))}
            {draftDrawing && renderDrawingElement(draftDrawing, true)}
          </svg>
        )}
        <div className="info-overlay">
          <div>ОБЪЕМ <span className="stat-period">(24ч)</span>: <b>{(parseFloat(marketStats.quoteVolume)/1e6).toFixed(1)}M$</b></div>
          <div className={parseFloat(marketStats.priceChangePercent)>0?'green':'red'}>ИЗМ <span className="stat-period">(24ч)</span>: <b>{parseFloat(marketStats.priceChangePercent).toFixed(2)}%</b></div>
          {parseInt(marketStats.count)>0 && <div>СДЕЛКИ <span className="stat-period">(24ч)</span>: <b>{parseInt(marketStats.count).toLocaleString()}</b></div>}
          <div>NATR <span className="stat-period">({filters.natrPeriod||2}ч)</span>: <b>{stats.natr!=null?stats.natr.toFixed(2)+'%':'...'}</b></div>
          <div>ВОЛАТ <span className="stat-period">({filters.volatPeriod||6}ч)</span>: <b>{stats.volat!=null?stats.volat.toFixed(2)+'%':'...'}</b></div>
          <div>КОРР <span className="stat-period">({filters.corrPeriod||1}ч)</span>: <b>{stats.corr!=null?stats.corr+'%':stats.corr===null?'—':'...'}</b></div>
        </div>
      </div>
    </>
  );

  if (isFullscreenMode) return <div className="chart-card chart-card-fullscreen">{content}</div>;
  return <div className="chart-card">{content}</div>;
};

// ─── Виртуальная карточка ─────────────────────────────────────────────────────
const VirtualChartCard = (props) => {
  const containerRef = useRef();
  const [visible, setVisible]       = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if(e.isIntersecting) setVisible(true); }, {rootMargin:'800px 0px'});
    obs.observe(el); return () => obs.disconnect();
  }, []);

  useEffect(() => { document.body.style.overflow=fullscreen?'hidden':''; return ()=>{document.body.style.overflow='';}; }, [fullscreen]);

  const handleFullscreen = useCallback(() => setFullscreen(true), []);
  const handleClose      = useCallback(() => setFullscreen(false), []);

  const fullscreenPortal = fullscreen ? ReactDOM.createPortal(
    <div style={{position:'fixed',top:0,left:0,width:'100vw',height:'100vh',zIndex:99999,background:'#0d0d0f',display:'flex',flexDirection:'column',overflow:'hidden'}}
      onClick={(e)=>{if(e.target===e.currentTarget)setFullscreen(false);}}>
      <ChartComponent {...props} isFullscreenMode={true} onClose={handleClose} onFullscreen={null} enableDrawingTools={true}/>
    </div>, document.body
  ) : null;

  return (<>
    <div ref={containerRef} className="chart-card-virtual">
      {visible && <ChartComponent {...props} onFullscreen={handleFullscreen} isFullscreenMode={false} enableDrawingTools={false}/>}
    </div>
    {fullscreenPortal}
  </>);
};

// ─── Список монет ─────────────────────────────────────────────────────────────
const CoinList = ({ coins, watchlist, onToggleWatch, selectedStarColor, statsMap, globalTf, defaultSort, filters, btcMap, onAlertTriggered }) => {
  const containerRef = useRef(null);
  const [sortCol, setSortCol]         = useState(defaultSort || 'volume');
  const [sortDir, setSortDir]         = useState(-1);
  const [selectedSymbol, setSelectedSymbol] = useState(null);

  useEffect(() => { setSortCol(defaultSort || 'volume'); setSortDir(-1); }, [defaultSort]);

  const handleSort = (col) => { if(sortCol===col) setSortDir(d=>-d); else {setSortCol(col);setSortDir(-1);} };

  const sorted = useMemo(() => [...coins].sort((a, b) => {
    const aS=!!watchlist[a.symbol], bS=!!watchlist[b.symbol];
    if (aS&&!bS) return -1; if (!aS&&bS) return 1;
    let va, vb;
    switch (sortCol) {
      case 'symbol': va=a.symbol; vb=b.symbol; return sortDir*va.localeCompare(vb);
      case 'price':  va=parseFloat(a.price); vb=parseFloat(b.price); break;
      case 'change': va=parseFloat(a.priceChangePercent); vb=parseFloat(b.priceChangePercent); break;
      case 'volume': va=parseFloat(a.quoteVolume); vb=parseFloat(b.quoteVolume); break;
      case 'trades': va=parseInt(a.count)||0; vb=parseInt(b.count)||0; break;
      case 'natr':   va=statsMap[a.symbol]?.natr??-1; vb=statsMap[b.symbol]?.natr??-1; break;
      case 'volat':  va=statsMap[a.symbol]?.volat??-1; vb=statsMap[b.symbol]?.volat??-1; break;
      case 'corr':   va=statsMap[a.symbol]?.corr??-999; vb=statsMap[b.symbol]?.corr??-999; break;
      default: va=0; vb=0;
    }
    return sortDir*(va>vb?1:va<vb?-1:0);
  }), [coins, sortCol, sortDir, statsMap, watchlist]);

  const chartCoin = useMemo(() => {
    const sym = selectedSymbol || sorted[0]?.symbol;
    return sym ? (coins.find(c=>c.symbol===sym) || sorted[0]) : null;
  }, [selectedSymbol, sorted, coins]);

  useEffect(() => {
    if (!sorted.length) return;
    if (!selectedSymbol || !sorted.some((coin) => coin.symbol === selectedSymbol)) {
      setSelectedSymbol(sorted[0].symbol);
    }
  }, [sorted, selectedSymbol]);

  const handleListKeyDown = useCallback((e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    if (!sorted.length) return;
    e.preventDefault();
    const currentIndex = Math.max(0, sorted.findIndex((coin) => coin.symbol === chartCoin?.symbol));
    const nextIndex = e.key === 'ArrowDown'
      ? Math.min(sorted.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1);
    const nextSymbol = sorted[nextIndex]?.symbol;
    if (!nextSymbol) return;
    setSelectedSymbol(nextSymbol);
    requestAnimationFrame(() => {
      const row = containerRef.current?.querySelector(`[data-symbol="${nextSymbol}"]`);
      row?.scrollIntoView({ block: 'nearest' });
    });
  }, [sorted, chartCoin]);

  const Th = ({col, label}) => (
    <th className={`list-th ${sortCol===col?'active':''}`} onClick={()=>handleSort(col)}>
      {label}{sortCol===col?(sortDir===-1?' ↓':' ↑'):''}
    </th>
  );

  return (
    <div className="list-split-view" ref={containerRef} tabIndex={0} onKeyDown={handleListKeyDown}>
      <div className="list-chart-panel">
        {chartCoin && (
          <ChartComponent key={`${chartCoin.symbol}:${globalTf}`} symbol={chartCoin.symbol} marketStats={chartCoin}
            globalTf={globalTf} filters={filters} btcMap={btcMap}
            isFullscreenMode={false} onFullscreen={null}
            precomputedStats={statsMap[chartCoin.symbol]||null} autoSize={true} enableDrawingTools={true}
            watchlist={watchlist} onToggleWatch={onToggleWatch} selectedStarColor={selectedStarColor}
            onAlertTriggered={onAlertTriggered}/>
        )}
      </div>
      <div className="list-table-panel">
        <div className="coin-list-scroll">
          <table className="coin-list-table">
            <thead><tr>
              <th className="list-th" style={{width:38}}>★</th>
              <Th col="symbol" label="Монета"/>
              <Th col="price"  label="Цена"/>
              <Th col="change" label="Изм %"/>
              <Th col="volume" label="Объём"/>
              <Th col="trades" label="Сделки"/>
              <Th col="natr"   label="NATR"/>
              <Th col="volat"  label="Волат"/>
              <Th col="corr"   label="Корр"/>
            </tr></thead>
            <tbody>
              {sorted.map(coin => {
                const chg=parseFloat(coin.priceChangePercent);
                const s=statsMap[coin.symbol];
                const starKey=watchlist[coin.symbol];
                const isSelected=coin.symbol===chartCoin?.symbol;
                return (
                  <tr key={coin.symbol}
                    data-symbol={coin.symbol}
                    className={`list-row ${starKey?'starred':''} ${isSelected?'list-row-selected':''}`}
                    onClick={()=>setSelectedSymbol(coin.symbol)} style={{cursor:'pointer'}}>
                    <td onClick={e=>e.stopPropagation()}>
                      <button className="star-btn" style={{color:starKey?starHex(starKey):'#333'}}
                        onClick={()=>onToggleWatch(coin.symbol)}
                        title={starKey?`Помечено (${STAR_COLORS.find(c=>c.key===starKey)?.label})`:'Пометить'}>★</button>
                    </td>
                    <td className="list-symbol">{coin.symbol.replace(/[-_]?(USDT|BUSD|USDC).*$/i,'')+'USDT.P'}</td>
                    <td>{parseFloat(coin.price).toPrecision(5)}</td>
                    <td className={chg>=0?'green':'red'}>{chg>0?'+':''}{chg.toFixed(2)}%</td>
                    <td>{(parseFloat(coin.quoteVolume)/1e6).toFixed(1)}M$</td>
                    <td>{parseInt(coin.count)>0?parseInt(coin.count).toLocaleString():'—'}</td>
                    <td>{s?s.natr.toFixed(2)+'%':'...'}</td>
                    <td>{s?s.volat.toFixed(2)+'%':'...'}</td>
                    <td>{s?(s.corr!=null?s.corr+'%':'—'):'...'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// ─── Дефолтные фильтры ────────────────────────────────────────────────────────
const defaultFilters = {
  minVolume:10, maxVolume:99999,    volPeriod:24,
  minChange:10, maxChange:99999,    chgPeriod:24,
  minTrades:1000000, maxTrades:99999999, trdPeriod:24,
  minNatr:0,    maxNatr:100,        natrPeriod:2,
  minVolat:0,   maxVolat:100,       volatPeriod:6,
  minCorr:-100, maxCorr:100,        corrPeriod:1,
};
const defaultTab = { id:1, name:'Основная', globalTf:'5m', filters:defaultFilters };

// ─── App ──────────────────────────────────────────────────────────────────────
function App() {
  const [marketData, setMarketData]         = useState([]);
  const [activeSymbols, setActiveSymbols]   = useState([]);
  const [isFiltersOpen, setIsFiltersOpen]   = useState(false);
  const [sortBy, setSortBy]                 = useState('volume');
  const [btcMap, setBtcMap]                 = useState(null);
  const [loadingMarket, setLoadingMarket]   = useState(false);
  const [viewMode, setViewMode]             = useState('charts');
  const [listShowAll, setListShowAll]       = useState(false);
  const [statsMap, setStatsMap]             = useState({});
  const [statsLoading, setStatsLoading]     = useState(false);
  const [serverError, setServerError]       = useState(false);

  const [watchlist, setWatchlist] = useState(() => {
    try {
      const v2 = localStorage.getItem('kopibar_watchlist_v2');
      if (v2) return JSON.parse(v2);
      const old = localStorage.getItem('kopibar_watchlist');
      if (old) { const arr=JSON.parse(old); return Object.fromEntries(arr.map(s=>[s,'yellow'])); }
    } catch {}
    return {};
  });

  const [selectedStarColor, setSelectedStarColor] = useState('yellow');
  const [watchColorFilter, setWatchColorFilter]   = useState(null);
  const [watchDropOpen, setWatchDropOpen]          = useState(false);
  const [watchDropPos,  setWatchDropPos]           = useState({top:0,left:0});
  const [starColorOpen, setStarColorOpen]          = useState(false);
  const [starColorPos,  setStarColorPos]           = useState({top:0,left:0});
  const [alertPanelOpen, setAlertPanelOpen]        = useState(false);
  const [triggeredAlerts, setTriggeredAlerts]      = useState(() => readStorageJson(ALERT_HISTORY_STORAGE_KEY, []));
  const [alertToasts, setAlertToasts]              = useState([]);
  const [globalFullscreenChart, setGlobalFullscreenChart] = useState(null);
  const watchDropRef  = useRef(null);
  const starColorRef  = useRef(null);
  const alertBellRef  = useRef(null);
  const dropdownRef   = useRef(null);
  const statsAbortRef = useRef({cancelled:false});

  const [tabs, setTabs] = useState(() => {
    try {
      const saved = localStorage.getItem('kopibar_tabs');
      if (saved) {
        const parsed = JSON.parse(saved);
        return parsed.map(t => {
          const f = {...defaultFilters,...t.filters};
          if (t.id===1){f.minNatr=0;f.maxNatr=100;f.minVolat=0;f.maxVolat=100;f.minCorr=-100;f.maxCorr=100;f.maxChange=99999;f.minChange=Math.max(f.minChange,0);}
          return {...t, filters:f, appliedFilters: t.appliedFilters?{...defaultFilters,...t.appliedFilters}:f};
        });
      }
    } catch {}
    return [defaultTab];
  });

  const [activeTabId, setActiveTabId]       = useState(() => { try{return Number(localStorage.getItem('kopibar_active_tab'))||1;}catch{return 1;} });
  const [editingTabId, setEditingTabId]     = useState(null);
  const [editingTabName, setEditingTabName] = useState('');
  const [confirmClear, setConfirmClear]     = useState(false);

  useEffect(() => { try{localStorage.setItem('kopibar_tabs',JSON.stringify(tabs));}catch{} }, [tabs]);
  useEffect(() => { try{localStorage.setItem('kopibar_active_tab',String(activeTabId));}catch{} }, [activeTabId]);
  useEffect(() => { try{localStorage.setItem('kopibar_watchlist_v2',JSON.stringify(watchlist));}catch{} }, [watchlist]);
  useEffect(() => { writeStorageJson(ALERT_HISTORY_STORAGE_KEY, triggeredAlerts); }, [triggeredAlerts]);

  useEffect(() => {
    const h=(e)=>{
      if(watchDropRef.current&&!watchDropRef.current.contains(e.target)) setWatchDropOpen(false);
      if(starColorRef.current&&!starColorRef.current.contains(e.target)) setStarColorOpen(false);
      if(alertBellRef.current&&!alertBellRef.current.contains(e.target)) setAlertPanelOpen(false);
    };
    document.addEventListener('mousedown',h); return ()=>document.removeEventListener('mousedown',h);
  }, []);
  useEffect(() => {
    const h=(e)=>{ if(dropdownRef.current&&!dropdownRef.current.contains(e.target)) setIsFiltersOpen(false); };
    document.addEventListener('mousedown',h); return ()=>document.removeEventListener('mousedown',h);
  }, []);

  const activeTab     = tabs.find(t=>t.id===activeTabId)||tabs[0];
  const activeFilters = useMemo(()=>activeTab.appliedFilters||activeTab.filters,[activeTab]);
  const hasPendingChanges = JSON.stringify(activeTab.filters)!==JSON.stringify(activeTab.appliedFilters||activeTab.filters);
  const watchlistSize = Object.keys(watchlist).length;

  const toggleWatch = useCallback((symbol) => {
    setWatchlist(prev => {
      const next = {...prev};
      if (next[symbol]===selectedStarColor) delete next[symbol];
      else next[symbol] = selectedStarColor;
      return next;
    });
  }, [selectedStarColor]);

  const clearWatchlist = useCallback(() => { setConfirmClear(true); }, []);
  const pushAlertToast = useCallback((alert) => {
    const toast = { ...alert, toastId: makeId('toast') };
    setAlertToasts((prev) => [toast, ...prev].slice(0, 4));
    window.setTimeout(() => {
      setAlertToasts((prev) => prev.filter((item) => item.toastId !== toast.toastId));
    }, 8000);
  }, []);
  const handleAlertTriggered = useCallback((alert) => {
    setTriggeredAlerts((prev) => [alert, ...prev.filter((item) => !(item.symbol === alert.symbol && item.tf === alert.tf && item.price === alert.price && item.triggeredAt === alert.triggeredAt))].slice(0, 80));
    pushAlertToast(alert);
  }, [pushAlertToast]);
  const openAlertChart = useCallback((symbol, tf) => {
    setGlobalFullscreenChart({ symbol, tf });
    setAlertPanelOpen(false);
  }, []);

  const fetchMarket = useCallback(() => {
    setLoadingMarket(true); setServerError(false);
    Promise.all([
      requestQueue(`${SERVER}/symbols`),
      requestQueue(`${SERVER}/tickers`)
    ]).then(([symbols,tickers])=>{
      if(Array.isArray(symbols)) setActiveSymbols(symbols);
      if(Array.isArray(tickers)) setMarketData(tickers);
      if(!Array.isArray(symbols)||!Array.isArray(tickers)) setServerError(true);
    }).catch(()=>{ setServerError(true); }).finally(()=>setLoadingMarket(false));
  }, []);

  const fetchBtcMap = useCallback(async (tf) => {
    try {
      const data=await fetchKlines('BTCUSDT', tf);
      const map=new Map(); data.forEach(d=>map.set(d.openTime,d.close)); setBtcMap(map);
    } catch {}
  }, []);

  useEffect(() => { klinesCache.clear(); setMarketData([]); setActiveSymbols([]); setBtcMap(null); setStatsMap({}); fetchMarket(); }, [fetchMarket]);
  useEffect(() => { setBtcMap(null); fetchBtcMap(activeTab.globalTf); }, [activeTab.globalTf, fetchBtcMap]);

  const PERIOD_KEYS = new Set(['natrPeriod','volatPeriod','corrPeriod']);
  const updateF = (key, val) => setTabs(tabs.map(t => {
    if (t.id !== activeTabId) return t;
    const newFilters = {...t.filters, [key]: Number(val)};
    const newApplied = PERIOD_KEYS.has(key) ? {...(t.appliedFilters||t.filters), [key]: Number(val)} : t.appliedFilters;
    return {...t, filters: newFilters, ...(newApplied ? {appliedFilters: newApplied} : {})};
  }));
  const applyFilters = ()=>setTabs(tabs.map(t=>t.id===activeTabId?{...t,appliedFilters:{...t.filters}}:t));

  const preFilteredCoins = useMemo(() => {
    const f=activeFilters;
    return marketData.filter(item=>{
      if(!activeSymbols.includes(item.symbol)) return false;
      const v=parseFloat(item.quoteVolume)/1e6;
      const c=Math.abs(parseFloat(item.priceChangePercent));
      const t=parseInt(item.count)||0;
      const tradesOk=t===0||(t>=f.minTrades&&t<=f.maxTrades);
      return v>=f.minVolume&&v<=f.maxVolume&&c>=f.minChange&&c<=f.maxChange&&tradesOk;
    }).sort((a,b)=>{
      if(sortBy==='volume') return parseFloat(b.quoteVolume)-parseFloat(a.quoteVolume);
      if(sortBy==='change') return parseFloat(b.priceChangePercent)-parseFloat(a.priceChangePercent);
      if(sortBy==='trades') return (parseInt(b.count)||0)-(parseInt(a.count)||0);
      return 0;
    });
  }, [marketData, activeSymbols, activeFilters, sortBy]);

  const allCoins = useMemo(() => marketData
    .filter(item => activeSymbols.includes(item.symbol))
    .sort((a,b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent)),
  [marketData, activeSymbols]);

  const needStats = activeTab.id!==1 && hasStatsFilter(activeFilters);
  const shouldLoadStats = needStats || viewMode === 'list' || viewMode === 'watchlist';
  const statsSourceCoins = viewMode === 'list' && listShowAll ? allCoins : preFilteredCoins;
  const depsKey = useMemo(
    () => statsSourceCoins.map(c=>c.symbol).join(',') + `|${activeTab.globalTf}|${activeFilters.natrPeriod}|${activeFilters.volatPeriod}|${activeFilters.corrPeriod}|${viewMode}|${listShowAll}`,
    [statsSourceCoins, activeTab.globalTf, activeFilters.natrPeriod, activeFilters.volatPeriod, activeFilters.corrPeriod, viewMode, listShowAll]
  );

  useEffect(() => {
    if (!shouldLoadStats || !allCoins.length) { setStatsMap({}); setStatsLoading(false); return; }
    const abort={cancelled:false}; statsAbortRef.current=abort;
    setStatsLoading(true);
    (async()=>{
      try {
        const next = await fetchServerStats(activeTab.globalTf, activeFilters);
        if(!abort.cancelled) setStatsMap(next);
      } catch {
        if(!abort.cancelled) setStatsMap({});
      }
      if(!abort.cancelled) setStatsLoading(false);
    })();
    return()=>{abort.cancelled=true;};
  }, [depsKey, shouldLoadStats, allCoins.length, activeTab.globalTf, activeFilters]); // eslint-disable-line

  const filteredCoins = useMemo(() => {
    if (!needStats) return preFilteredCoins;
    return preFilteredCoins.filter(c=>{
      const s=statsMap[c.symbol];
      if(s===undefined) return false;
      return passesStatsFilter(s,activeFilters);
    });
  }, [preFilteredCoins, statsMap, activeFilters, needStats]);

  const watchlistCoins = useMemo(() => allCoins.filter(c=>{
    if(!watchlist[c.symbol]) return false;
    if(watchColorFilter&&watchlist[c.symbol]!==watchColorFilter) return false;
    return true;
  }), [allCoins, watchlist, watchColorFilter]);

  const displayCoins   = viewMode==='watchlist' ? watchlistCoins : filteredCoins;
  const analyzingCount = needStats&&statsLoading ? statsSourceCoins.filter(c=>statsMap[c.symbol]===undefined).length : 0;
  const globalFullscreenMarketStats = useMemo(() => {
    if (!globalFullscreenChart) return null;
    return marketData.find((item) => item.symbol === globalFullscreenChart.symbol) || {
      symbol: globalFullscreenChart.symbol,
      price: '0',
      priceChangePercent: '0',
      quoteVolume: '0',
      count: '0',
    };
  }, [globalFullscreenChart, marketData]);

  return (
    <div className="app-container">
      <header className="main-header">
        <div className="header-top">
          <div className="logo">Kopi<span className="green-accent">Bar</span></div>
          <div className="exchange-tabs">
            <div className="exchange-badge">Binance Futures</div>
          </div>
          <div className="tabs-container">
            {tabs.map(t=>(
              <div key={t.id} className={`tab-item ${activeTabId===t.id?'active':''}`} onClick={()=>{if(editingTabId!==t.id)setActiveTabId(t.id);}}>
                {editingTabId===t.id ? (
                  <input className="tab-name-input" value={editingTabName} autoFocus
                    onChange={e=>setEditingTabName(e.target.value)}
                    onKeyDown={e=>{
                      if(e.key==='Enter'){if(editingTabName.trim())setTabs(tabs.map(x=>x.id===t.id?{...x,name:editingTabName.trim()}:x));setEditingTabId(null);}
                      if(e.key==='Escape')setEditingTabId(null);
                    }}
                    onBlur={()=>{if(editingTabName.trim())setTabs(tabs.map(x=>x.id===t.id?{...x,name:editingTabName.trim()}:x));setEditingTabId(null);}}
                    onClick={e=>e.stopPropagation()}/>
                ) : <span className="tab-name">{t.name}</span>}
                {t.id!==1&&editingTabId!==t.id&&<span className="edit-icon" onClick={(e)=>{e.stopPropagation();setEditingTabId(t.id);setEditingTabName(t.name);}}>✎</span>}
                {t.id!==1&&<span className="close-x" onClick={(e)=>{e.stopPropagation();setTabs(tabs.filter(x=>x.id!==t.id));setActiveTabId(1);}}>×</span>}
              </div>
            ))}
            <button className="add-btn" onClick={()=>setTabs([...tabs,{...activeTab,id:Date.now(),name:'Новая',filters:{...activeTab.filters,minNatr:0,maxNatr:100,minVolat:0,maxVolat:100,minCorr:-100,maxCorr:100},appliedFilters:{...activeTab.filters,minNatr:0,maxNatr:100,minVolat:0,maxVolat:100,minCorr:-100,maxCorr:100}}])}>+</button>
          </div>
          <div className="header-right">
            <div className="view-toggle">
              <button className={`view-btn ${viewMode==='charts'?'active':''}`} onClick={()=>setViewMode('charts')}><span className="view-btn-icon">⊞</span><span className="view-btn-label">Графики</span></button>
              <button className={`view-btn ${viewMode==='list'?'active':''}`} onClick={()=>setViewMode('list')}><span className="view-btn-icon">☰</span><span className="view-btn-label">Список</span></button>
              {viewMode==='list' && (
                <>
                  <button className={`view-btn list-show-all-btn ${!listShowAll?'active':''}`} onClick={()=>setListShowAll(false)}>По фильтрам</button>
                  <button className={`view-btn list-show-all-btn ${listShowAll?'active':''}`} onClick={()=>setListShowAll(true)}>Все монеты</button>
                  <button style={{display:'none'}} className={`view-btn list-show-all-btn ${listShowAll?'active':''}`} onClick={()=>setListShowAll(v=>!v)}>
                  {listShowAll ? 'Все монеты' : 'По фильтрам'}
                  </button>
                </>
              )}
              <div className="watchlist-btn-wrap" ref={watchDropRef}>
                <button className={`view-btn ${viewMode==='watchlist'?'active':''}`} onClick={()=>setViewMode('watchlist')}>
                  <span className="view-btn-icon" style={{color:watchColorFilter?starHex(watchColorFilter):'#f0c040'}}>★</span>
                  <span className="view-btn-label">Избранное{watchlistSize>0?` (${watchlistSize})`:''}</span>
                </button>
                <button className="watch-drop-arrow-btn" onClick={(e)=>{const r=e.currentTarget.getBoundingClientRect();setWatchDropPos({top:r.bottom+4,left:r.left+r.width/2});setWatchDropOpen(o=>!o);}}>▾</button>
              </div>
            </div>
            <div className="star-color-select-wrap" ref={starColorRef}>
              <button className="star-color-btn" onClick={()=>{const r=starColorRef.current?.getBoundingClientRect();if(r)setStarColorPos({top:r.bottom+4,left:r.left});setStarColorOpen(o=>!o);}}>
                <span style={{color:starHex(selectedStarColor),fontSize:16}}>★</span>
                <span className="star-color-arrow">▾</span>
              </button>
            </div>
            <div className="alerts-wrap" ref={alertBellRef}>
              <button className={`alert-bell-btn ${alertPanelOpen?'active':''}`} onClick={()=>setAlertPanelOpen(o=>!o)} title="Сработавшие алерты">
                <span>🔔</span>
                {triggeredAlerts.length>0 && <span className="alert-badge">{Math.min(triggeredAlerts.length, 99)}</span>}
              </button>
              {alertPanelOpen && (
                <div className="alert-panel">
                  <div className="alert-panel-head">
                    <span>Алерты</span>
                    <button className="alert-panel-clear" onClick={()=>setTriggeredAlerts([])}>Очистить</button>
                  </div>
                  <div className="alert-panel-list">
                    {triggeredAlerts.length===0 && <div className="alert-empty">Пока нет сработавших алертов</div>}
                    {triggeredAlerts.map((alert)=>(
                      <div key={alert.id} className="alert-item">
                        <div className="alert-item-main">
                          <div className="alert-item-symbol">{alert.symbol} <span>{alert.tf}</span></div>
                          <div className="alert-item-price">{alert.price}</div>
                          <div className="alert-item-label">{alert.label || 'Без подписи'}</div>
                        </div>
                        <button className="alert-open-btn" onClick={()=>openAlertChart(alert.symbol, alert.tf)}>Открыть</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="results-count">
              {serverError ? <span style={{color:'#ff3b3b'}}>⚠ Сервер недоступен</span>
                : loadingMarket ? <span className="green-accent">Загрузка...</span>
                : analyzingCount>0 ? <><span className="green-accent">Анализ...</span> <span style={{color:'#666',fontSize:'11px'}}>({preFilteredCoins.length-analyzingCount}/{preFilteredCoins.length})</span></>
                : <>Найдено: <span className="green-accent">{filteredCoins.length}</span>{watchlistSize>0&&<span style={{color:'#f0c040'}}> ★{watchlistSize}</span>}</>}
            </div>
            <div className="sort-box">
              <span className="sort-label">Сортировка:</span>
              <select className="global-tf-select" value={sortBy} onChange={e=>setSortBy(e.target.value)}>
                <option value="volume">Объем</option>
                <option value="change">Изм %</option>
                <option value="trades">Сделки</option>
              </select>
            </div>
            <select className="global-tf-select" value={activeTab.globalTf} onChange={e=>{
              const newTf = e.target.value;
              setTabs(tabs.map(t=>t.id===activeTabId?{...t,globalTf:newTf}:t));
              // Prefetch данных ДО перерисовки карточек
              displayCoins.slice(0,30).forEach(c=>{
                const key=`${ACTIVE_EXCHANGE}:${c.symbol}:${newTf}`;
                const cached = klinesCache.get(key);
                if(!cached || Date.now() - cached.fetchedAt >= KLINES_CACHE_TTL_MS) fetchKlines(c.symbol,newTf).catch(()=>{});
              });
            }}>
              {timeframes.map(tf=><option key={tf} value={tf}>{tf}</option>)}
            </select>
            <button className="refresh-btn" onClick={fetchMarket}>Обновить</button>
          </div>
        </div>

        <div className="sub-header-line">
          {activeTab.id===1 ? (
            <div className="filters-area-static"><div className="f-row">
              <div className="f-group"><span className="f-label">Объем (M$) мин</span><div className="input-row"><input type="number" value={activeTab.filters.minVolume} onChange={e=>updateF('minVolume',e.target.value)}/></div></div>
              <div className="f-group"><span className="f-label">Изм % мин</span><div className="input-row"><input type="number" value={activeTab.filters.minChange} onChange={e=>updateF('minChange',e.target.value)}/></div></div>
              <div className="f-group"><span className="f-label">Сделки мин</span><div className="input-row"><input type="number" value={activeTab.filters.minTrades} onChange={e=>updateF('minTrades',e.target.value)}/></div></div>
              <button className={`apply-btn ${hasPendingChanges?'pending':''}`} onClick={applyFilters}>{hasPendingChanges?'● Применить':'Применить'}</button>
            </div></div>
          ) : (
            <div className="controls-row">
              <div className="dropdown-container" ref={dropdownRef}>
                <button className={`filter-toggle-btn-main ${isFiltersOpen?'active':''}`} onClick={()=>setIsFiltersOpen(!isFiltersOpen)}>ФИЛЬТРЫ {isFiltersOpen?'▲':'▼'}</button>
                {isFiltersOpen && (
                  <div className="vertical-dropdown">
                    <div className="f-vert-stack">
                      {[
                        {label:'Объем (M$)',keys:['minVolume','maxVolume','volPeriod']},
                        {label:'Изменение %',keys:['minChange','maxChange','chgPeriod']},
                        {label:'Сделки',keys:['minTrades','maxTrades','trdPeriod'],wide:true},
                        {label:'NATR %',keys:['minNatr','maxNatr','natrPeriod']},
                        {label:'Волатильность %',keys:['minVolat','maxVolat','volatPeriod']},
                        {label:'Корреляция %',keys:['minCorr','maxCorr','corrPeriod']},
                      ].map(({label,keys,wide})=>(
                        <div key={label} className="f-vert-item">
                          <span className="f-label">{label}</span>
                          <div className="input-row-vert">
                            <div className="input-with-hint"><span className="hint">Мин</span><input className={wide?'trades-input':''} type="number" value={activeTab.filters[keys[0]]} onChange={e=>updateF(keys[0],e.target.value)}/></div>
                            <div className="input-with-hint"><span className="hint">Макс</span><input className={wide?'trades-input':''} type="number" value={activeTab.filters[keys[1]]} onChange={e=>updateF(keys[1],e.target.value)}/></div>
                            <div className="input-with-hint"><span className="hint">Период (ч)</span><input className="p-in" type="number" value={activeTab.filters[keys[2]]} onChange={e=>updateF(keys[2],e.target.value)}/></div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="apply-btn-row">
                      <button className={`apply-btn ${hasPendingChanges?'pending':''}`} onClick={()=>{applyFilters();setIsFiltersOpen(false);}}>
                        {hasPendingChanges?'● Применить фильтры':'✓ Применить фильтры'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </header>

      {serverError && (
        <div style={{background:'#1a0a0a',border:'1px solid #ff3b3b',borderRadius:6,margin:'20px',padding:'16px 20px',color:'#ff6666',fontSize:13,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <span>⚠ Сервер недоступен — проверь что сервер запущен (<b>pm2 status</b>)</span>
          <button onClick={fetchMarket} style={{background:'#ff3b3b',border:'none',color:'#fff',padding:'6px 14px',borderRadius:4,cursor:'pointer',fontSize:12}}>Повторить</button>
        </div>
      )}

      {viewMode==='list' && (
        <CoinList coins={listShowAll?allCoins:filteredCoins} defaultSort={listShowAll?'change':'volume'}
          watchlist={watchlist} onToggleWatch={toggleWatch}
          selectedStarColor={selectedStarColor} statsMap={statsMap} globalTf={activeTab.globalTf}
          filters={activeFilters} btcMap={btcMap} onAlertTriggered={handleAlertTriggered}/>
      )}

      {viewMode==='watchlist' && watchlistCoins.length===0 && (
        <div className="empty-watchlist">
          <div style={{color:'#f0c040',fontSize:48}}>★</div>
          <div>Нет избранных монет</div>
          <div>{watchColorFilter?`Нет монет с цветом «${STAR_COLORS.find(c=>c.key===watchColorFilter)?.label}»`:'В режиме списка нажми ★ рядом с монетой'}</div>
        </div>
      )}

      {(viewMode==='charts'||viewMode==='watchlist') && (
        <div className="grid-scroll">
          <div className="grid-box">
            {displayCoins.map(c=>(
              <VirtualChartCard key={`${ACTIVE_EXCHANGE}-${c.symbol}`} symbol={c.symbol} marketStats={c}
                globalTf={activeTab.globalTf} filters={activeFilters} btcMap={btcMap}
                precomputedStats={statsMap[c.symbol]||null}
                watchlist={watchlist} onToggleWatch={toggleWatch} selectedStarColor={selectedStarColor}
                onAlertTriggered={handleAlertTriggered}/>
            ))}
          </div>
        </div>
      )}

      {alertToasts.length > 0 && (
        <div className="alert-toast-stack">
          {alertToasts.map((alert) => (
            <div key={alert.toastId} className="alert-toast">
              <div className="alert-toast-title">Алерт: {alert.symbol} <span>{alert.tf}</span></div>
              <div className="alert-toast-body">{alert.label || 'Уровень достигнут'} · {alert.price}</div>
              <button className="alert-open-btn" onClick={()=>openAlertChart(alert.symbol, alert.tf)}>Открыть</button>
            </div>
          ))}
        </div>
      )}

      {globalFullscreenChart && globalFullscreenMarketStats && ReactDOM.createPortal(
        <div style={{position:'fixed',top:0,left:0,width:'100vw',height:'100vh',zIndex:99999,background:'#0d0d0f',display:'flex',flexDirection:'column',overflow:'hidden'}}
          onClick={(e)=>{if(e.target===e.currentTarget)setGlobalFullscreenChart(null);}}>
          <ChartComponent
            symbol={globalFullscreenChart.symbol}
            marketStats={globalFullscreenMarketStats}
            globalTf={globalFullscreenChart.tf}
            filters={activeFilters}
            btcMap={btcMap}
            isFullscreenMode={true}
            onClose={()=>setGlobalFullscreenChart(null)}
            onFullscreen={null}
            precomputedStats={null}
            watchlist={watchlist}
            onToggleWatch={toggleWatch}
            selectedStarColor={selectedStarColor}
            enableDrawingTools={true}
            onAlertTriggered={handleAlertTriggered}
          />
        </div>, document.body
      )}

      {watchDropOpen && ReactDOM.createPortal(
        <div className="watch-color-dropdown portal-dropdown" style={{top:watchDropPos.top,left:watchDropPos.left,transform:'translateX(-50%)'}} onMouseDown={e=>e.stopPropagation()}>
          <button className={`watch-color-opt ${!watchColorFilter?'active':''}`} onClick={()=>{setWatchColorFilter(null);setWatchDropOpen(false);}}>Все</button>
          {STAR_COLORS.map(sc=>(
            <button key={sc.key} className={`watch-color-opt ${watchColorFilter===sc.key?'active':''}`} onClick={()=>{setWatchColorFilter(sc.key);setWatchDropOpen(false);}}>
              <span style={{color:sc.hex,fontSize:15}}>★</span>
            </button>
          ))}
          <div className="watch-drop-divider"/>
          <button className="watch-color-opt watch-clear-opt" onClick={()=>{clearWatchlist();setWatchDropOpen(false);}}>✕</button>
        </div>, document.body
      )}

      {starColorOpen && ReactDOM.createPortal(
        <div className="star-color-dropdown portal-dropdown" style={{top:starColorPos.top,left:starColorPos.left}} onMouseDown={e=>e.stopPropagation()}>
          {STAR_COLORS.map(sc=>(
            <button key={sc.key} className={`star-color-opt2 ${selectedStarColor===sc.key?'active':''}`}
              onClick={()=>{setSelectedStarColor(sc.key);setStarColorOpen(false);}} title={sc.label}>
              <span style={{color:sc.hex,fontSize:18}}>★</span>
            </button>
          ))}
        </div>, document.body
      )}

      {confirmClear && (
        <div style={{position:'fixed',inset:0,zIndex:999999,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.7)'}} onClick={()=>setConfirmClear(false)}>
          <div style={{background:'#111113',border:'1px solid #333',borderRadius:8,padding:'24px 28px',minWidth:300,boxShadow:'0 20px 60px rgba(0,0,0,0.9)'}} onClick={e=>e.stopPropagation()}>
            <div style={{color:'#fff',fontSize:15,fontWeight:600,marginBottom:8}}>Очистить избранное?</div>
            <div style={{color:'#666',fontSize:13,marginBottom:20}}>Все {Object.keys(watchlist).length} помеченных монет будут удалены</div>
            <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
              <button onClick={()=>setConfirmClear(false)} style={{background:'transparent',border:'1px solid #333',color:'#aaa',padding:'7px 18px',borderRadius:5,cursor:'pointer',fontSize:13}}>Отмена</button>
              <button onClick={()=>{setWatchlist({});setConfirmClear(false);setWatchDropOpen(false);}} style={{background:'#ff3b3b',border:'none',color:'#fff',padding:'7px 18px',borderRadius:5,cursor:'pointer',fontSize:13,fontWeight:600}}>Очистить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
