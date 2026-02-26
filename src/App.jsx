import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import * as LightweightCharts from 'lightweight-charts';
import './App.css';

const SERVER = 'http://77.239.105.144:3001';

const EXCHANGES = [
  { id: 'binance', label: 'Binance' },
  { id: 'bybit',   label: 'Bybit'   },
  { id: 'okx',     label: 'OKX'     },
  { id: 'gateio',  label: 'Gate.io' },
  { id: 'bitget',  label: 'Bitget'  },
];

const timeframes = ['1m', '5m', '15m', '1h', '4h', '1d'];

// ─── WebSocket фабрика ────────────────────────────────────────────────────────
function createExchangeWS(exchange, symbol, interval, onCandle) {
  let ws = null;
  let pingInterval = null;

  try {
    if (exchange === 'binance') {
      ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@kline_${interval}`);
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.e === 'kline') {
            const k = msg.k;
            onCandle({ time: k.t/1000, open:+k.o, high:+k.h, low:+k.l, close:+k.c, volume:+k.v, openTime:k.t });
          }
        } catch {}
      };
    } else if (exchange === 'bybit') {
      const tfMap = { '1m':'1','5m':'5','15m':'15','1h':'60','4h':'240','1d':'D' };
      ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
      ws.onopen = () => ws.send(JSON.stringify({ op: 'subscribe', args: [`kline.${tfMap[interval]||interval}.${symbol}`] }));
      pingInterval = setInterval(() => { if (ws?.readyState === 1) ws.send(JSON.stringify({ op: 'ping' })); }, 20000);
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.topic?.startsWith('kline') && msg.data?.[0]) {
            const k = msg.data[0];
            onCandle({ time:+k.start/1000, open:+k.open, high:+k.high, low:+k.low, close:+k.close, volume:+k.volume, openTime:+k.start });
          }
        } catch {}
      };
    } else if (exchange === 'okx') {
      const tfMap = { '1m':'1m','5m':'5m','15m':'15m','1h':'1H','4h':'4H','1d':'1D' };
      ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
      ws.onopen = () => ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: `candle${tfMap[interval]||interval}`, instId: symbol }] }));
      pingInterval = setInterval(() => { if (ws?.readyState === 1) ws.send('ping'); }, 25000);
      ws.onmessage = (e) => {
        try {
          if (e.data === 'pong') return;
          const msg = JSON.parse(e.data);
          if (msg.data?.[0]) {
            const k = msg.data[0];
            onCandle({ time:+k[0]/1000, open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5], openTime:+k[0] });
          }
        } catch {}
      };
    } else if (exchange === 'gateio') {
      ws = new WebSocket('wss://fx-ws.gateio.ws/v4/ws/usdt');
      ws.onopen = () => ws.send(JSON.stringify({ time: Math.floor(Date.now()/1000), channel: 'futures.candlesticks', event: 'subscribe', payload: [interval, symbol] }));
      pingInterval = setInterval(() => { if (ws?.readyState === 1) ws.send(JSON.stringify({ time: Math.floor(Date.now()/1000), channel: 'futures.ping' })); }, 20000);
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.channel === 'futures.candlesticks' && msg.result) {
            const k = msg.result;
            onCandle({ time:+k.t, open:+k.o, high:+k.h, low:+k.l, close:+k.c, volume:+k.v, openTime:+k.t*1000 });
          }
        } catch {}
      };
    } else if (exchange === 'bitget') {
      const tfMap = { '1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1d' };
      ws = new WebSocket('wss://ws.bitget.com/v2/ws/public');
      ws.onopen = () => ws.send(JSON.stringify({ op: 'subscribe', args: [{ instType: 'USDT-FUTURES', channel: `candle${tfMap[interval]||interval}`, instId: symbol }] }));
      pingInterval = setInterval(() => { if (ws?.readyState === 1) ws.send('ping'); }, 25000);
      ws.onmessage = (e) => {
        try {
          if (e.data === 'pong') return;
          const msg = JSON.parse(e.data);
          if (msg.data?.[0]) {
            const k = msg.data[0];
            onCandle({ time:+k[0]/1000, open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5], openTime:+k[0] });
          }
        } catch {}
      };
    }
    if (ws) { ws.onerror = () => {}; ws.onclose = () => {}; }
  } catch (e) {}

  return {
    close: () => {
      if (pingInterval) clearInterval(pingInterval);
      if (ws) { ws.onmessage = null; ws.onerror = null; ws.onclose = null; if (ws.readyState <= 1) ws.close(); }
    }
  };
}

// ─── Очередь запросов ─────────────────────────────────────────────────────────
const requestQueue = (() => {
  let active = 0;
  const MAX = 6;
  const queue = [];
  const run = () => {
    if (active >= MAX || !queue.length) return;
    active++;
    const { url, resolve, reject } = queue.shift();
    fetch(url).then(r => r.json()).then(resolve).catch(reject).finally(() => { active--; run(); });
  };
  return (url) => new Promise((resolve, reject) => { queue.push({ url, resolve, reject }); run(); });
})();

// ─── Расчёты ──────────────────────────────────────────────────────────────────
const calculateCorrelation = (data) => {
  if (data.length < 2) return 0;
  let x = [], y = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i].btcClose || !data[i-1].btcClose) continue;
    x.push((data[i].close - data[i-1].close) / data[i-1].close);
    y.push((data[i].btcClose - data[i-1].btcClose) / data[i-1].btcClose);
  }
  if (!x.length) return 0;
  const n = x.length;
  const mx = x.reduce((a,b)=>a+b,0)/n, my = y.reduce((a,b)=>a+b,0)/n;
  let num=0, dx2=0, dy2=0;
  for (let i=0;i<n;i++) { const dx=x[i]-mx, dy=y[i]-my; num+=dx*dy; dx2+=dx*dx; dy2+=dy*dy; }
  if (!dx2||!dy2) return 0;
  return (num/Math.sqrt(dx2*dy2))*100;
};

// NATR = средний (high-low) за период / цена * 100
const calculateNATR = (data, periodHours, tfMin, lastPrice) => {
  const n = Math.max(1, Math.round((periodHours * 60) / tfMin));
  const slice = data.slice(-n);
  const avg = slice.reduce((s,b) => s + (b.high - b.low), 0) / (slice.length || 1);
  return (avg / lastPrice) * 100;
};

// Волатильность = стандартное отклонение доходностей за период
const calculateVolatility = (data, periodHours, tfMin) => {
  const n = Math.max(2, Math.round((periodHours * 60) / tfMin));
  const slice = data.slice(-n);
  if (slice.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < slice.length; i++) {
    returns.push((slice[i].close - slice[i-1].close) / slice[i-1].close);
  }
  const mean = returns.reduce((a,b)=>a+b,0) / returns.length;
  const variance = returns.reduce((s,r) => s + (r-mean)**2, 0) / returns.length;
  return Math.sqrt(variance) * 100;
};

const timescaleFormatter = (time, tickMarkType) => {
  const date = new Date(time*1000);
  const pad = n => String(n).padStart(2,'0');
  const months = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
  switch (tickMarkType) {
    case LightweightCharts.TickMarkType.Year:       return String(date.getFullYear());
    case LightweightCharts.TickMarkType.Month:      return months[date.getMonth()];
    case LightweightCharts.TickMarkType.DayOfMonth: return `${date.getDate()} ${months[date.getMonth()]}`;
    default: return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
};

const getPriceFormat = (price) => {
  if (price >= 1)      return { precision:2, minMove:0.01 };
  if (price >= 0.1)    return { precision:4, minMove:0.0001 };
  if (price >= 0.01)   return { precision:5, minMove:0.00001 };
  if (price >= 0.001)  return { precision:6, minMove:0.000001 };
  if (price >= 0.0001) return { precision:7, minMove:0.0000001 };
  return                     { precision:8, minMove:0.00000001 };
};

// ─── Компонент графика ────────────────────────────────────────────────────────
const ChartComponent = ({ symbol, marketStats, globalTf, filters, isFirstTab, btcMap, exchange, isFullscreenMode, onFullscreen, onClose, onHidden }) => {
  const chartContainerRef = useRef();
  const chartRef = useRef(null);
  const [localTf, setLocalTf] = useState(globalTf);
  const [stats, setStats] = useState({});
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const candleSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);

  const btcMapRef = useRef(btcMap);
  useEffect(() => { btcMapRef.current = btcMap; }, [btcMap]);
  useEffect(() => { setLocalTf(globalTf); }, [globalTf]);

  useEffect(() => {
    const h = () => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({
          width: isFullscreenMode ? window.innerWidth : chartContainerRef.current.clientWidth
        });
      }
    };
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  useEffect(() => {
    if (!isFullscreenMode) return;
    const h = (e) => { if (e.key === 'Escape' && onClose) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [isFullscreenMode, onClose]);

  const loadHistory = useCallback(async () => {
    try {
      const data = await requestQueue(`${SERVER}/klines?exchange=${exchange}&symbol=${symbol}&interval=${localTf}`);
      if (!Array.isArray(data)) return [];
      const currentBtcMap = btcMapRef.current;
      return data.map(d => ({
        ...d,
        btcClose: symbol.replace(/[-_].*/, '').startsWith('BTC') ? d.close : (currentBtcMap ? currentBtcMap.get(d.openTime) : undefined)
      }));
    } catch { return []; }
  }, [symbol, localTf, exchange]);

  useEffect(() => {
    if (!chartContainerRef.current) return;
    setLoading(true);
    let cancelled = false;
    let wsHandle = null;

    const chartWidth = isFullscreenMode ? window.innerWidth : (chartContainerRef.current?.clientWidth || 800);
    const chartHeight = isFullscreenMode ? window.innerHeight : 400;

    const chart = LightweightCharts.createChart(chartContainerRef.current, {
      layout: { background: { type: LightweightCharts.ColorType.Solid, color: '#0d0d0f' }, textColor: '#a1a1aa' },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false, autoScale: true, minimumWidth: 80 },
      timeScale: {
        borderVisible: false,
        rightOffset: 20,
        barSpacing: 3,
        minBarSpacing: 0,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: timescaleFormatter,
      },
      width: chartWidth,
      height: chartHeight,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#00ff9d', downColor: '#ff3b3b', borderVisible: false,
      wickUpColor: '#00ff9d', wickDownColor: '#ff3b3b',
    });
    const volumeSeries = chart.addHistogramSeries({ color: '#26a69a', priceFormat: { type: 'volume' }, priceScaleId: '' });
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    chartRef.current = chart;

    loadHistory().then(data => {
      if (cancelled) return;
      if (data.length > 0) {
        candleSeries.setData(data);
        const lastPrice = data[data.length-1].close;
        candleSeries.applyOptions({ priceFormat: { type: 'price', ...getPriceFormat(lastPrice) } });
        volumeSeries.setData(data.map(d => ({ time: d.time, value: d.volume, color: d.close >= d.open ? 'rgba(0,255,157,0.5)' : 'rgba(255,59,59,0.5)' })));
        const lastIdx = data.length - 1;
        chart.timeScale().setVisibleRange({ from: data[Math.max(0,lastIdx-600)].time, to: data[lastIdx].time + 100 });

        const tfMin = { '1m':1,'5m':5,'15m':15,'1h':60,'4h':240,'1d':1440 }[localTf] || 5;
        const corrN = Math.max(2, Math.round(((filters.corrPeriod||1)*60)/tfMin));
        const corrSlice = data.slice(-corrN);

        const computed = {
          natr: calculateNATR(data, filters.natrPeriod||2, tfMin, lastPrice),
          volat: calculateVolatility(data, filters.volatPeriod||6, tfMin),
          corr: symbol.replace(/[-_].*/, '').startsWith('BTC') ? 100 : Math.round(calculateCorrelation(corrSlice))
        };
        // Скрываем график если не проходит фильтры (только для не-первой вкладки)
        const isHidden = !isFirstTab && (
          computed.natr  < (filters.minNatr  || 0)   || computed.natr  > (filters.maxNatr  || 100) ||
          computed.volat < (filters.minVolat || 0)   || computed.volat > (filters.maxVolat || 100) ||
          computed.corr  < (filters.minCorr  || -100)|| computed.corr  > (filters.maxCorr  || 100)
        );
        if (!cancelled) { setStats(computed); setHidden(isHidden); onHidden && onHidden(isHidden); }
      }
      if (!cancelled) setLoading(false);

      if (!cancelled) {
        wsHandle = createExchangeWS(exchange, symbol, localTf, (candle) => {
          if (cancelled || !candleSeriesRef.current || !volumeSeriesRef.current) return;
          candleSeriesRef.current.update(candle);
          volumeSeriesRef.current.update({ time: candle.time, value: candle.volume, color: candle.close >= candle.open ? 'rgba(0,255,157,0.5)' : 'rgba(255,59,59,0.5)' });
        });
      }
    });

    return () => {
      cancelled = true;
      if (wsHandle) wsHandle.close();
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      chartRef.current = null;
      try { chart.remove(); } catch {}
    };
  }, [localTf, symbol, loadHistory, filters, isFirstTab, isFullscreenMode, exchange]);

  if (!isFullscreenMode && hidden) return null;

  const chartCardContent = (
    <>
      <div className="chart-header">
        <span className="symbol-name">{symbol}</span>
        <div className="tf-selector-mini">
          {timeframes.map(tf => (
            <button key={tf} className={`tf-btn-mini ${localTf === tf ? 'active' : ''}`} onClick={() => setLocalTf(tf)}>{tf}</button>
          ))}
        </div>
        {isFullscreenMode
          ? <button className="fullscreen-btn" onClick={onClose} title="Закрыть">✕</button>
          : <button className="fullscreen-btn" onClick={(e) => { e.stopPropagation(); onFullscreen && onFullscreen(); }} title="Развернуть">⛶</button>
        }
      </div>
      <div className="chart-relative-container" style={{ height: isFullscreenMode ? '100vh' : '400px' }}>
        {loading && (
          <div className="chart-loader">
            <div className="scanner-line"></div>
            <div className="loader-info">
              <div className="loader-ticker">{symbol.replace(/[-_]?USDT.*/i,'')}</div>
              <div className="loader-status">DECODING DATA...</div>
            </div>
          </div>
        )}
        <div className={`chart-anchor ${loading ? 'blurred' : ''}`} ref={chartContainerRef} />
        <div className="info-overlay">
          <div>ОБЪЕМ <span className="stat-period">(24ч)</span>: <b>{(parseFloat(marketStats.quoteVolume)/1e6).toFixed(1)}M$</b></div>
          <div className={parseFloat(marketStats.priceChangePercent) > 0 ? 'green' : 'red'}>ИЗМ <span className="stat-period">(24ч)</span>: <b>{parseFloat(marketStats.priceChangePercent).toFixed(2)}%</b></div>
          {parseInt(marketStats.count) > 0 && <div>СДЕЛКИ <span className="stat-period">(24ч)</span>: <b>{parseInt(marketStats.count).toLocaleString()}</b></div>}
          <div>NATR <span className="stat-period">({filters.natrPeriod||2}ч)</span>: <b>{stats.natr?.toFixed(2)}%</b></div>
          <div>ВОЛАТ <span className="stat-period">({filters.volatPeriod||6}ч)</span>: <b>{stats.volat?.toFixed(2)}%</b></div>
          <div>КОРР <span className="stat-period">({filters.corrPeriod||1}ч)</span>: <b>{stats.corr}%</b></div>
        </div>
      </div>
    </>
  );

  if (isFullscreenMode) return <div className="chart-card chart-card-fullscreen">{chartCardContent}</div>;
  return <div className="chart-card">{chartCardContent}</div>;
};

// ─── Виртуальная обёртка ──────────────────────────────────────────────────────
const VirtualChartCard = (props) => {
  const containerRef = useRef();
  const [visible, setVisible] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '600px 0px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    document.body.style.overflow = fullscreen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [fullscreen]);

  const handleFullscreen = useCallback(() => setFullscreen(true), []);
  const handleClose = useCallback(() => setFullscreen(false), []);
  const handleHidden = useCallback((val) => setHidden(val), []);

  // Полноэкранный через портал — рендерится прямо в body, поверх всего
  const fullscreenPortal = fullscreen ? ReactDOM.createPortal(
    <div
      style={{
        position: 'fixed', top: 0, left: 0,
        width: '100vw', height: '100vh',
        zIndex: 99999, background: '#0d0d0f',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) setFullscreen(false); }}
    >
      <ChartComponent
        {...props}
        isFullscreenMode={true}
        onClose={handleClose}
        onFullscreen={null}
        onHidden={null}
      />
    </div>,
    document.body
  ) : null;

  // Если график скрыт фильтром — не занимаем место в сетке
  if (hidden && !fullscreen) return null;

  return (
    <>
      <div ref={containerRef} className="chart-card-virtual">
        {visible && (
          <ChartComponent
            {...props}
            onFullscreen={handleFullscreen}
            isFullscreenMode={false}
            onHidden={handleHidden}
          />
        )}
      </div>
      {fullscreenPortal}
    </>
  );
};

// ─── Список монет ─────────────────────────────────────────────────────────────
const CoinList = ({ coins, exchange, watchlist, onToggleWatch, filters, btcMap, globalTf }) => {
  const [sortCol, setSortCol] = useState('volume');
  const [sortDir, setSortDir] = useState(-1); // -1 = desc
  const [statsMap, setStatsMap] = useState({});

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => -d);
    else { setSortCol(col); setSortDir(-1); }
  };

  // Загружаем статистику (NATR/волат/корр) для монет из кэша сервера
  useEffect(() => {
    const load = async () => {
      const btcSymbols = { binance:'BTCUSDT', bybit:'BTCUSDT', okx:'BTC-USDT-SWAP', gateio:'BTC_USDT', bitget:'BTCUSDT' };
      const map = {};
      // Берём только топ 100 чтобы не перегружать
      const top = [...coins].sort((a,b) => b.quoteVolume - a.quoteVolume).slice(0,100);
      await Promise.all(top.map(async (coin) => {
        try {
          const data = await requestQueue(`${SERVER}/klines?exchange=${exchange}&symbol=${coin.symbol}&interval=${globalTf}`);
          if (!Array.isArray(data) || data.length < 2) return;
          const tfMin = { '1m':1,'5m':5,'15m':15,'1h':60,'4h':240,'1d':1440 }[globalTf] || 5;
          const lastPrice = data[data.length-1].close;
          const isBtc = coin.symbol.replace(/[-_].*/, '').startsWith('BTC');
          const corrN = Math.max(2, Math.round(((filters.corrPeriod||1)*60)/tfMin));

          let corr = 100;
          if (!isBtc && btcMap) {
            const slice = data.slice(-corrN).map(d => ({ ...d, btcClose: btcMap.get(d.openTime) }));
            corr = Math.round(calculateCorrelation(slice));
          }

          map[coin.symbol] = {
            natr: calculateNATR(data, filters.natrPeriod||2, tfMin, lastPrice),
            volat: calculateVolatility(data, filters.volatPeriod||6, tfMin),
            corr,
          };
        } catch {}
      }));
      setStatsMap(map);
    };
    if (coins.length > 0) load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exchange, globalTf, coins.length]);

  const sorted = useMemo(() => {
    return [...coins].sort((a, b) => {
      let va, vb;
      switch (sortCol) {
        case 'symbol':      va = a.symbol; vb = b.symbol; return sortDir * va.localeCompare(vb);
        case 'price':       va = parseFloat(a.price); vb = parseFloat(b.price); break;
        case 'change':      va = parseFloat(a.priceChangePercent); vb = parseFloat(b.priceChangePercent); break;
        case 'volume':      va = parseFloat(a.quoteVolume); vb = parseFloat(b.quoteVolume); break;
        case 'trades':      va = parseInt(a.count)||0; vb = parseInt(b.count)||0; break;
        case 'natr':        va = statsMap[a.symbol]?.natr||0; vb = statsMap[b.symbol]?.natr||0; break;
        case 'volat':       va = statsMap[a.symbol]?.volat||0; vb = statsMap[b.symbol]?.volat||0; break;
        case 'corr':        va = statsMap[a.symbol]?.corr||0; vb = statsMap[b.symbol]?.corr||0; break;
        default:            va = 0; vb = 0;
      }
      return sortDir * ((va > vb ? 1 : va < vb ? -1 : 0));
    });
  }, [coins, sortCol, sortDir, statsMap]);

  const Th = ({ col, label }) => (
    <th className={`list-th ${sortCol === col ? 'active' : ''}`} onClick={() => handleSort(col)}>
      {label} {sortCol === col ? (sortDir === -1 ? '↓' : '↑') : ''}
    </th>
  );

  return (
    <div className="coin-list-wrapper">
      <div className="coin-list-scroll">
        <table className="coin-list-table">
          <thead>
            <tr>
              <th className="list-th" style={{width:36}}>★</th>
              <Th col="symbol" label="Монета" />
              <Th col="price" label="Цена" />
              <Th col="change" label="Изм %" />
              <Th col="volume" label="Объём 24ч" />
              <Th col="trades" label="Сделки" />
              <Th col="natr" label={`NATR(${filters.natrPeriod||2}ч)`} />
              <Th col="volat" label={`Волат(${filters.volatPeriod||6}ч)`} />
              <Th col="corr" label={`Корр(${filters.corrPeriod||1}ч)`} />
            </tr>
          </thead>
          <tbody>
            {sorted.map(coin => {
              const chg = parseFloat(coin.priceChangePercent);
              const s = statsMap[coin.symbol];
              const starred = watchlist.has(coin.symbol);
              return (
                <tr key={coin.symbol} className={`list-row ${starred ? 'starred' : ''}`}>
                  <td>
                    <button className={`star-btn ${starred ? 'on' : ''}`} onClick={() => onToggleWatch(coin.symbol)}>
                      {starred ? '★' : '☆'}
                    </button>
                  </td>
                  <td className="list-symbol">{coin.symbol.replace(/[-_]?USDT.*/i,'')}<span className="list-full">{coin.symbol}</span></td>
                  <td>{parseFloat(coin.price).toPrecision(5)}</td>
                  <td className={chg >= 0 ? 'green' : 'red'}>{chg > 0 ? '+' : ''}{chg.toFixed(2)}%</td>
                  <td>{(parseFloat(coin.quoteVolume)/1e6).toFixed(1)}M$</td>
                  <td>{parseInt(coin.count) > 0 ? parseInt(coin.count).toLocaleString() : '—'}</td>
                  <td>{s ? s.natr.toFixed(2)+'%' : '...'}</td>
                  <td>{s ? s.volat.toFixed(2)+'%' : '...'}</td>
                  <td>{s ? s.corr+'%' : '...'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ─── Дефолтные фильтры ────────────────────────────────────────────────────────
const defaultFilters = {
  minVolume: 10, maxVolume: 99999, volPeriod: 24,
  minChange: 0,  maxChange: 100,  chgPeriod: 24,
  minTrades: 0,  maxTrades: 99999999, trdPeriod: 24,
  minNatr: 0,    maxNatr: 100,    natrPeriod: 2,
  minVolat: 0,   maxVolat: 100,   volatPeriod: 6,
  minCorr: -100, maxCorr: 100,    corrPeriod: 1,
};

const defaultTab = { id: 1, name: 'Основная', globalTf: '5m', filters: defaultFilters };

// ─── App ──────────────────────────────────────────────────────────────────────
function App() {
  const [activeExchange, setActiveExchange] = useState('binance');
  const [marketData, setMarketData] = useState([]);
  const [activeSymbols, setActiveSymbols] = useState([]);
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const [sortBy, setSortBy] = useState('volume');
  const [btcMap, setBtcMap] = useState(null);
  const [loadingMarket, setLoadingMarket] = useState(false);
  const [viewMode, setViewMode] = useState('charts'); // 'charts' | 'list' | 'watchlist'
  const [watchlist, setWatchlist] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('kopibar_watchlist') || '[]')); } catch { return new Set(); }
  });
  const dropdownRef = useRef(null);

  const [tabs, setTabs] = useState(() => {
    try {
      const saved = localStorage.getItem('kopibar_tabs');
      if (saved) {
        const parsed = JSON.parse(saved);
        return parsed.map(t => {
          const f = { ...defaultFilters, ...t.filters, _migrated: true };
          return { ...t, filters: f, appliedFilters: t.appliedFilters || f };
        });
      }
    } catch {}
    return [defaultTab];
  });

  const [activeTabId, setActiveTabId] = useState(() => {
    try { return Number(localStorage.getItem('kopibar_active_tab')) || 1; } catch { return 1; }
  });

  useEffect(() => { try { localStorage.setItem('kopibar_tabs', JSON.stringify(tabs)); } catch {} }, [tabs]);
  useEffect(() => { try { localStorage.setItem('kopibar_active_tab', String(activeTabId)); } catch {} }, [activeTabId]);
  useEffect(() => { try { localStorage.setItem('kopibar_watchlist', JSON.stringify([...watchlist])); } catch {} }, [watchlist]);

  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];

  const toggleWatch = useCallback((symbol) => {
    setWatchlist(prev => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol); else next.add(symbol);
      return next;
    });
  }, []);

  const fetchMarket = useCallback(() => {
    setLoadingMarket(true);
    Promise.all([
      requestQueue(`${SERVER}/symbols?exchange=${activeExchange}`),
      requestQueue(`${SERVER}/tickers?exchange=${activeExchange}&interval=${activeTab.globalTf}`)
    ]).then(([symbols, tickers]) => {
      if (Array.isArray(symbols)) setActiveSymbols(symbols);
      if (Array.isArray(tickers)) setMarketData(tickers);
    }).finally(() => setLoadingMarket(false));
  }, [activeExchange, activeTab.globalTf]);

  const fetchBtcMap = useCallback(async (tf) => {
    try {
      const btcSymbols = { binance:'BTCUSDT', bybit:'BTCUSDT', okx:'BTC-USDT-SWAP', gateio:'BTC_USDT', bitget:'BTCUSDT' };
      const btcSym = btcSymbols[activeExchange] || 'BTCUSDT';
      const data = await requestQueue(`${SERVER}/klines?exchange=${activeExchange}&symbol=${btcSym}&interval=${tf}`);
      if (!Array.isArray(data)) return;
      const map = new Map();
      data.forEach(d => map.set(d.openTime, d.close));
      setBtcMap(map);
    } catch {}
  }, [activeExchange]);

  useEffect(() => {
    setMarketData([]); setActiveSymbols([]); setBtcMap(null);
    fetchMarket();
  }, [activeExchange, fetchMarket]);

  useEffect(() => { setBtcMap(null); fetchBtcMap(activeTab.globalTf); }, [activeTab.globalTf, fetchBtcMap]);

  useEffect(() => {
    const h = (e) => { if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setIsFiltersOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  // draft — то что пользователь вводит, applied — то что реально применяется
  const updateF = (key, val) => setTabs(tabs.map(t => t.id === activeTabId ? { ...t, filters: { ...t.filters, [key]: Number(val) } } : t));
  const applyFilters = () => setTabs(tabs.map(t => t.id === activeTabId ? { ...t, appliedFilters: { ...t.filters } } : t));

  const activeFilters = useMemo(() => activeTab.appliedFilters || activeTab.filters, [activeTab]);
  const hasPendingChanges = JSON.stringify(activeTab.filters) !== JSON.stringify(activeTab.appliedFilters || activeTab.filters);

  // ─── Фильтрация монет ─────────────────────────────────────────────────────
  const filteredCoins = useMemo(() => {
    const f = activeTab.appliedFilters || activeTab.filters;
    return marketData.filter(item => {
      if (!activeSymbols.includes(item.symbol)) return false;
      const v = parseFloat(item.quoteVolume) / 1e6;
      const c = Math.abs(parseFloat(item.priceChangePercent));
      // Фильтр сделок применяем только если count > 0 (т.е. биржа его предоставляет)
      const t = parseInt(item.count) || 0;
      const tradesOk = t === 0 || (t >= f.minTrades && t <= f.maxTrades);
      return v >= f.minVolume && v <= f.maxVolume && c >= f.minChange && c <= f.maxChange && tradesOk;
    }).sort((a, b) => {
      if (sortBy === 'volume') return parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume);
      // FIX: сортировка по реальному значению, не по модулю: +10, +5, 0, -5, -10
      if (sortBy === 'change') return parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent);
      if (sortBy === 'trades') return (parseInt(b.count)||0) - (parseInt(a.count)||0);
      return 0;
    });
  }, [marketData, activeSymbols, activeTab.appliedFilters, sortBy]);

  const watchlistCoins = useMemo(() => filteredCoins.filter(c => watchlist.has(c.symbol)), [filteredCoins, watchlist]);
  const displayCoins = viewMode === 'watchlist' ? watchlistCoins : filteredCoins;

  // ─── Рендер ───────────────────────────────────────────────────────────────
  return (
    <div className="app-container">
      <header className="main-header">
        <div className="header-top">
          <div className="logo">Kopi<span className="green-accent">Bar</span></div>

          {/* Биржи */}
          <div className="exchange-tabs">
            {EXCHANGES.map(ex => (
              <button key={ex.id} className={`exchange-tab ${activeExchange === ex.id ? 'active' : ''}`} onClick={() => setActiveExchange(ex.id)}>
                {ex.label}
              </button>
            ))}
          </div>

          {/* Вкладки фильтров */}
          <div className="tabs-container">
            {tabs.map(t => (
              <div key={t.id} className={`tab-item ${activeTabId === t.id ? 'active' : ''}`} onClick={() => setActiveTabId(t.id)}>
                <span className="tab-name">{t.name}</span>
                {t.id !== 1 && <span className="edit-icon" onClick={(e) => { e.stopPropagation(); const n = prompt('Имя вкладки:', t.name); if (n) setTabs(tabs.map(x => x.id === t.id ? {...x,name:n} : x)); }}>✎</span>}
                {t.id !== 1 && <span className="close-x" onClick={(e) => { e.stopPropagation(); setTabs(tabs.filter(x => x.id !== t.id)); setActiveTabId(1); }}>×</span>}
              </div>
            ))}
            <button className="add-btn" onClick={() => setTabs([...tabs, { ...activeTab, id: Date.now(), name: 'Новая', filters: {...activeTab.filters} }])}>+</button>
          </div>

          <div className="header-right">
            {/* Переключение вида */}
            <div className="view-toggle">
              <button className={`view-btn ${viewMode === 'charts' ? 'active' : ''}`} onClick={() => setViewMode('charts')}>
                <span className="view-btn-icon">⊞</span>
                <span className="view-btn-label">Графики</span>
              </button>
              <button className={`view-btn ${viewMode === 'list' ? 'active' : ''}`} onClick={() => setViewMode('list')}>
                <span className="view-btn-icon">☰</span>
                <span className="view-btn-label">Список</span>
              </button>
              <button className={`view-btn ${viewMode === 'watchlist' ? 'active' : ''}`} onClick={() => setViewMode('watchlist')}>
                <span className="view-btn-icon">★</span>
                <span className="view-btn-label">Избранное{watchlist.size > 0 ? ` (${watchlist.size})` : ''}</span>
              </button>
            </div>

            <div className="results-count">
              {loadingMarket ? <span className="green-accent">Загрузка...</span> : <>Найдено: <span className="green-accent">{filteredCoins.length}</span>{watchlist.size > 0 && <span style={{color:'#f0c040'}}> ★{watchlist.size}</span>}</>}
            </div>
            <div className="sort-box">
              <span className="sort-label">Сортировка:</span>
              <select className="global-tf-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
                <option value="volume">Объем</option>
                <option value="change">Изм %</option>
                <option value="trades">Сделки</option>
              </select>
            </div>
            <select className="global-tf-select" value={activeTab.globalTf} onChange={e => setTabs(tabs.map(t => t.id === activeTabId ? {...t, globalTf: e.target.value} : t))}>
              {timeframes.map(tf => <option key={tf} value={tf}>{tf}</option>)}
            </select>
            <button className="refresh-btn" onClick={fetchMarket}>Обновить</button>
          </div>
        </div>

        {/* Фильтры */}
        <div className="sub-header-line">
          {activeTab.id === 1 ? (
            <div className="filters-area-static">
              <div className="f-row">
                <div className="f-group"><span className="f-label">Объем (M$) мин</span><div className="input-row"><input type="number" value={activeTab.filters.minVolume} onChange={e => updateF('minVolume', e.target.value)} /></div></div>
                <div className="f-group"><span className="f-label">Изм % мин</span><div className="input-row"><input type="number" value={activeTab.filters.minChange} onChange={e => updateF('minChange', e.target.value)} /></div></div>
                <div className="f-group"><span className="f-label">Сделки мин</span><div className="input-row"><input className="trades-input" type="number" value={activeTab.filters.minTrades} onChange={e => updateF('minTrades', e.target.value)} /></div></div>
                <button className={`apply-btn ${hasPendingChanges ? 'pending' : ''}`} onClick={applyFilters}>
                  {hasPendingChanges ? '● Применить' : 'Применить'}
                </button>
              </div>
            </div>
          ) : (
            <div className="controls-row">
              <div className="dropdown-container" ref={dropdownRef}>
                <button className={`filter-toggle-btn-main ${isFiltersOpen ? 'active' : ''}`} onClick={() => setIsFiltersOpen(!isFiltersOpen)}>
                  ФИЛЬТРЫ {isFiltersOpen ? '▲' : '▼'}
                </button>
                {isFiltersOpen && (
                  <div className="vertical-dropdown">
                    <div className="f-vert-stack">
                      {[
                        { label:'Объем (M$)',     keys:['minVolume','maxVolume','volPeriod'] },
                        { label:'Изменение %',    keys:['minChange','maxChange','chgPeriod'] },
                        { label:'Сделки',         keys:['minTrades','maxTrades','trdPeriod'], wide: true },
                        { label:'NATR %',         keys:['minNatr','maxNatr','natrPeriod'] },
                        { label:'Волатильность %',keys:['minVolat','maxVolat','volatPeriod'] },
                        { label:'Корреляция %',   keys:['minCorr','maxCorr','corrPeriod'] },
                      ].map(({ label, keys, wide }) => (
                        <div key={label} className="f-vert-item">
                          <span className="f-label">{label}</span>
                          <div className="input-row-vert">
                            <div className="input-with-hint"><span className="hint">Мин</span><input className={wide ? 'trades-input' : ''} type="number" value={activeTab.filters[keys[0]]} onChange={e => updateF(keys[0], e.target.value)} /></div>
                            <div className="input-with-hint"><span className="hint">Макс</span><input className={wide ? 'trades-input' : ''} type="number" value={activeTab.filters[keys[1]]} onChange={e => updateF(keys[1], e.target.value)} /></div>
                            <div className="input-with-hint"><span className="hint">Период (ч)</span><input className="p-in" type="number" value={activeTab.filters[keys[2]]} onChange={e => updateF(keys[2], e.target.value)} /></div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="apply-btn-row">
                      <button className={`apply-btn ${hasPendingChanges ? 'pending' : ''}`} onClick={() => { applyFilters(); setIsFiltersOpen(false); }}>
                        {hasPendingChanges ? '● Применить фильтры' : '✓ Применить фильтры'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Список монет */}
      {viewMode === 'list' && (
        <CoinList
          coins={filteredCoins}
          exchange={activeExchange}
          watchlist={watchlist}
          onToggleWatch={toggleWatch}
          filters={activeFilters}
          btcMap={btcMap}
          globalTf={activeTab.globalTf}
        />
      )}

      {/* Избранное — список */}
      {viewMode === 'watchlist' && watchlistCoins.length === 0 && (
        <div className="empty-watchlist">
          <div>★</div>
          <div>Нет избранных монет</div>
          <div>В режиме списка нажми ☆ рядом с монетой чтобы добавить</div>
        </div>
      )}

      {/* Графики */}
      {(viewMode === 'charts' || viewMode === 'watchlist') && (
        <div className="grid-box">
          {displayCoins.map(c => (
            <VirtualChartCard
              key={`${activeExchange}-${c.symbol}`}
              symbol={c.symbol}
              marketStats={c}
              globalTf={activeTab.globalTf}
              filters={activeFilters}
              isFirstTab={activeTab.id === 1}
              btcMap={btcMap}
              exchange={activeExchange}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default App;