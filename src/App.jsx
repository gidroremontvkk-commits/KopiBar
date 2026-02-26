import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
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

// ─── Очередь запросов ────────────────────────────────────────────────────────
const requestQueue = (() => {
  let active = 0;
  const MAX_CONCURRENT = 3;
  const DELAY_MS = 200;
  const queue = [];

  const run = () => {
    if (active >= MAX_CONCURRENT || queue.length === 0) return;
    active++;
    const { url, resolve, reject } = queue.shift();
    setTimeout(() =>
      fetch(url)
        .then(r => r.json())
        .then(resolve)
        .catch(reject)
        .finally(() => { active--; run(); }),
      DELAY_MS
    );
  };

  return (url) => new Promise((resolve, reject) => {
    queue.push({ url, resolve, reject });
    run();
  });
})();

const throttledFetch = (url) => requestQueue(url);

// ─── Вспомогательные ─────────────────────────────────────────────────────────
const calculateCorrelation = (data) => {
  if (data.length < 2) return 0;
  let x = [], y = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i].btcClose || !data[i - 1].btcClose) continue;
    x.push((data[i].close - data[i - 1].close) / data[i - 1].close);
    y.push((data[i].btcClose - data[i - 1].btcClose) / data[i - 1].btcClose);
  }
  if (x.length === 0) return 0;
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX, dy = y[i] - meanY;
    num += dx * dy; denX += dx * dx; denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return 0;
  return (num / Math.sqrt(denX * denY)) * 100;
};

const timescaleFormatter = (time, tickMarkType) => {
  const date = new Date(time * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const months = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
  switch (tickMarkType) {
    case LightweightCharts.TickMarkType.Year:       return String(date.getFullYear());
    case LightweightCharts.TickMarkType.Month:      return months[date.getMonth()];
    case LightweightCharts.TickMarkType.DayOfMonth: return `${date.getDate()} ${months[date.getMonth()]}`;
    case LightweightCharts.TickMarkType.Time:       return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    default:                                        return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
};

const getPriceFormat = (price) => {
  if (price >= 1)      return { precision: 2, minMove: 0.01 };
  if (price >= 0.1)    return { precision: 4, minMove: 0.0001 };
  if (price >= 0.01)   return { precision: 5, minMove: 0.00001 };
  if (price >= 0.001)  return { precision: 6, minMove: 0.000001 };
  if (price >= 0.0001) return { precision: 7, minMove: 0.0000001 };
  return                     { precision: 8, minMove: 0.00000001 };
};

// ─── Компонент графика ────────────────────────────────────────────────────────
const ChartComponent = ({ symbol, marketStats, globalTf, filters, isFirstTab, btcMap, exchange, isFullscreenMode, onFullscreen, onClose }) => {
  const chartContainerRef = useRef();
  const chartRef = useRef(null);
  const [localTf, setLocalTf] = useState(globalTf);
  const [dataReady, setDataReady] = useState({ isHidden: false, stats: {} });
  const [loading, setLoading] = useState(true);
  const candleSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);

  const btcMapRef = useRef(btcMap);
  useEffect(() => { btcMapRef.current = btcMap; }, [btcMap]);

  useEffect(() => { setLocalTf(globalTf); }, [globalTf]);

  useEffect(() => {
    const handleResize = () => {
      if (chartRef.current && chartContainerRef.current)
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!isFullscreenMode) return;
    const onKey = (e) => { if (e.key === 'Escape' && onClose) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreenMode, onClose]);

  const loadHistory = useCallback(async () => {
    try {
      const url = `${SERVER}/klines?exchange=${exchange}&symbol=${symbol}&interval=${localTf}`;
      const data = await throttledFetch(url);
      if (!Array.isArray(data)) return [];
      const currentBtcMap = btcMapRef.current;
      return data.map(d => ({
        ...d,
        btcClose: symbol.startsWith('BTC') ? d.close : (currentBtcMap ? currentBtcMap.get(d.openTime) : undefined)
      }));
    } catch (e) { return []; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, localTf, exchange]);

  useEffect(() => {
    if (!chartContainerRef.current) return;
    setLoading(true);
    let cancelled = false;

    const chartHeight = isFullscreenMode ? window.innerHeight - 48 : 400;

    const chart = LightweightCharts.createChart(chartContainerRef.current, {
      layout: {
        background: { type: LightweightCharts.ColorType.Solid, color: '#0d0d0f' },
        textColor: '#a1a1aa',
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false, autoScale: true, minimumWidth: 80 },
      timeScale: {
        borderVisible: false, rightOffset: 20, barSpacing: 3,
        minBarSpacing: 0, fixLeftEdge: false, fixRightEdge: false,
        tickMarkFormatter: timescaleFormatter,
      },
      width: chartContainerRef.current.clientWidth,
      height: chartHeight,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#00ff9d', downColor: '#ff3b3b', borderVisible: false,
      wickUpColor: '#00ff9d', wickDownColor: '#ff3b3b',
    });

    const volumeSeries = chart.addHistogramSeries({
      color: '#26a69a', priceFormat: { type: 'volume' }, priceScaleId: '',
    });
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    chartRef.current = chart;

    loadHistory().then(data => {
      if (cancelled) return;
      if (data.length > 0) {
        candleSeries.setData(data);
        const lastPrice = data[data.length - 1].close;
        candleSeries.applyOptions({ priceFormat: { type: 'price', ...getPriceFormat(lastPrice) } });

        volumeSeries.setData(data.map(d => ({
          time: d.time, value: d.volume,
          color: d.close >= d.open ? 'rgba(0, 255, 157, 0.5)' : 'rgba(255, 59, 59, 0.5)'
        })));

        const lastIdx = data.length - 1;
        chart.timeScale().setVisibleRange({
          from: data[Math.max(0, lastIdx - 600)].time,
          to: data[lastIdx].time + 100
        });

        const tfMin = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 }[localTf] || 5;
        const getSlice = (h, extra = 0) => data.slice(-Math.max(1, Math.round((h * 60) / tfMin)) - extra);

        const stats = {
          natr: (getSlice(filters.natrPeriod || 2).reduce((s, b) => s + (b.high - b.low), 0) / (getSlice(filters.natrPeriod || 2).length || 1) / lastPrice) * 100,
          volat: (getSlice(filters.volatPeriod || 6).reduce((s, b) => s + (b.high - b.low), 0) / (getSlice(filters.volatPeriod || 6).length || 1) / lastPrice) * 100,
          corr: symbol.startsWith('BTC') ? 100 : Math.round(calculateCorrelation(getSlice(filters.corrPeriod || 1, 1)))
        };

        const hide = !isFirstTab && (
          stats.natr < (filters.minNatr || 0) || stats.natr > (filters.maxNatr || 100) ||
          stats.volat < (filters.minVolat || 0) || stats.volat > (filters.maxVolat || 100) ||
          stats.corr < (filters.minCorr || -100) || stats.corr > (filters.maxCorr || 100)
        );
        if (!cancelled) setDataReady({ isHidden: hide, stats });
      }
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      chartRef.current = null;
      try { chart.remove(); } catch (e) {}
    };
  }, [localTf, symbol, loadHistory, filters, isFirstTab, isFullscreenMode]);

  if (!isFullscreenMode && dataReady.isHidden) return null;

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
          : <button className="fullscreen-btn" onClick={onFullscreen} title="Развернуть">⛶</button>
        }
      </div>
      <div className="chart-relative-container" style={{ height: isFullscreenMode ? 'calc(100vh - 48px)' : '400px' }}>
        {loading && (
          <div className="chart-loader">
            <div className="scanner-line"></div>
            <div className="loader-info">
              <div className="loader-ticker">{symbol.replace(/USDT.*/, '')}</div>
              <div className="loader-status">DECODING DATA...</div>
            </div>
          </div>
        )}
        <div className={`chart-anchor ${loading ? 'blurred' : ''}`} ref={chartContainerRef} />
        <div className="info-overlay">
          <div>ОБЪЕМ: <b>{(parseFloat(marketStats.quoteVolume) / 1e6).toFixed(1)}M$</b></div>
          <div className={marketStats.priceChangePercent > 0 ? 'green' : 'red'}>ИЗМ: <b>{parseFloat(marketStats.priceChangePercent).toFixed(2)}%</b></div>
          {marketStats.count > 0 && <div>СДЕЛКИ: <b>{parseInt(marketStats.count).toLocaleString()}</b></div>}
          <div>NATR: <b>{dataReady.stats.natr?.toFixed(2)}%</b></div>
          <div>ВОЛАТ: <b>{dataReady.stats.volat?.toFixed(2)}%</b></div>
          <div>КОРР: <b>{dataReady.stats.corr}%</b></div>
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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: '500px 0px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    document.body.style.overflow = fullscreen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [fullscreen]);

  return (
    <>
      <div ref={containerRef} className="chart-card-virtual">
        {visible && <ChartComponent {...props} onFullscreen={() => setFullscreen(true)} />}
      </div>
      {fullscreen && (
        <div className="fullscreen-overlay" onClick={(e) => { if (e.target === e.currentTarget) setFullscreen(false); }}>
          <ChartComponent {...props} isFullscreenMode onClose={() => setFullscreen(false)} />
        </div>
      )}
    </>
  );
};

// ─── Дефолтная вкладка ────────────────────────────────────────────────────────
const defaultTab = {
  id: 1, name: 'Основная', globalTf: '5m',
  filters: {
    minVolume: 10, maxVolume: 99999, volPeriod: 24,
    minChange: 10, maxChange: 100, chgPeriod: 24,
    minTrades: 0, maxTrades: 99999999, trdPeriod: 24,
    minNatr: 0, maxNatr: 100, natrPeriod: 2,
    minVolat: 0, maxVolat: 100, volatPeriod: 6,
    minCorr: -100, maxCorr: 100, corrPeriod: 1
  }
};

// ─── App ──────────────────────────────────────────────────────────────────────
function App() {
  const [activeExchange, setActiveExchange] = useState('binance');
  const [marketData, setMarketData] = useState([]);
  const [activeSymbols, setActiveSymbols] = useState([]);
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const [sortBy, setSortBy] = useState('volume');
  const [btcMap, setBtcMap] = useState(null);
  const [loadingMarket, setLoadingMarket] = useState(false);
  const dropdownRef = useRef(null);

  const [tabs, setTabs] = useState(() => {
    try {
      const saved = localStorage.getItem('kopibar_tabs');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return [defaultTab];
  });

  const [activeTabId, setActiveTabId] = useState(() => {
    try { return Number(localStorage.getItem('kopibar_active_tab')) || 1; } catch { return 1; }
  });

  useEffect(() => {
    try { localStorage.setItem('kopibar_tabs', JSON.stringify(tabs)); } catch (e) {}
  }, [tabs]);

  useEffect(() => {
    try { localStorage.setItem('kopibar_active_tab', String(activeTabId)); } catch (e) {}
  }, [activeTabId]);

  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];

  const fetchMarket = useCallback(() => {
    setLoadingMarket(true);
    Promise.all([
      throttledFetch(`${SERVER}/symbols?exchange=${activeExchange}`),
      throttledFetch(`${SERVER}/tickers?exchange=${activeExchange}`)
    ]).then(([symbols, tickers]) => {
      if (Array.isArray(symbols)) setActiveSymbols(symbols);
      if (Array.isArray(tickers)) setMarketData(tickers);
    }).finally(() => setLoadingMarket(false));
  }, [activeExchange]);

  const fetchBtcMap = useCallback(async (tf) => {
    try {
      // Определяем символ BTC для текущей биржи
      const btcSymbols = {
        binance: 'BTCUSDT', bybit: 'BTCUSDT', okx: 'BTC-USDT-SWAP',
        gateio: 'BTC_USDT', bitget: 'BTCUSDT'
      };
      const btcSym = btcSymbols[activeExchange] || 'BTCUSDT';
      const data = await throttledFetch(`${SERVER}/klines?exchange=${activeExchange}&symbol=${btcSym}&interval=${tf}`);
      if (!Array.isArray(data)) return;
      const map = new Map();
      data.forEach(d => map.set(d.openTime, d.close));
      setBtcMap(map);
    } catch (e) { console.error('Ошибка загрузки BTC:', e); }
  }, [activeExchange]);

  // Сбрасываем данные при смене биржи
  useEffect(() => {
    setMarketData([]);
    setActiveSymbols([]);
    setBtcMap(null);
    fetchMarket();
  }, [activeExchange, fetchMarket]);

  useEffect(() => {
    setBtcMap(null);
    fetchBtcMap(activeTab.globalTf);
  }, [activeTab.globalTf, fetchBtcMap]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setIsFiltersOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const updateF = (key, val) => setTabs(tabs.map(t => t.id === activeTabId ? { ...t, filters: { ...t.filters, [key]: Number(val) } } : t));
  const activeFilters = useMemo(() => activeTab.filters, [activeTab.filters]);

  const filteredCoins = marketData.filter(item => {
    if (!activeSymbols.includes(item.symbol)) return false;
    const v = parseFloat(item.quoteVolume) / 1e6;
    const c = Math.abs(parseFloat(item.priceChangePercent));
    const t = parseInt(item.count) || 0;
    return v >= activeTab.filters.minVolume && v <= activeTab.filters.maxVolume &&
      c >= activeTab.filters.minChange && c <= activeTab.filters.maxChange &&
      t >= activeTab.filters.minTrades;
  }).sort((a, b) => {
    if (sortBy === 'volume') return parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume);
    if (sortBy === 'change') return Math.abs(parseFloat(b.priceChangePercent)) - Math.abs(parseFloat(a.priceChangePercent));
    if (sortBy === 'trades') return parseInt(b.count || 0) - parseInt(a.count || 0);
    return 0;
  });

  return (
    <div className="app-container">
      <header className="main-header">
        <div className="header-top">
          <div className="logo">Kopi<span className="green-accent">Bar</span></div>

          {/* Выбор биржи */}
          <div className="exchange-tabs">
            {EXCHANGES.map(ex => (
              <button
                key={ex.id}
                className={`exchange-tab ${activeExchange === ex.id ? 'active' : ''}`}
                onClick={() => setActiveExchange(ex.id)}
              >
                {ex.label}
              </button>
            ))}
          </div>

          <div className="tabs-container">
            {tabs.map(t => (
              <div key={t.id} className={`tab-item ${activeTabId === t.id ? 'active' : ''}`} onClick={() => setActiveTabId(t.id)}>
                <span className="tab-name">{t.name}</span>
                {t.id !== 1 && (
                  <span className="edit-icon" onClick={(e) => {
                    e.stopPropagation();
                    const n = prompt('Имя вкладки:', t.name);
                    if (n) setTabs(tabs.map(x => x.id === t.id ? { ...x, name: n } : x));
                  }}>✎</span>
                )}
                {t.id !== 1 && <span className="close-x" onClick={(e) => { e.stopPropagation(); setTabs(tabs.filter(x => x.id !== t.id)); setActiveTabId(1); }}>×</span>}
              </div>
            ))}
            <button className="add-btn" onClick={() => setTabs([...tabs, { ...activeTab, id: Date.now(), name: 'Новая' }])}>+</button>
          </div>

          <div className="header-right">
            <div className="results-count">
              {loadingMarket ? <span className="green-accent">Загрузка...</span> : <>Найдено: <span className="green-accent">{filteredCoins.length}</span></>}
            </div>
            <div className="sort-box">
              <span className="sort-label">Сортировка:</span>
              <select className="global-tf-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                <option value="volume">Объем</option>
                <option value="change">Изм %</option>
                <option value="trades">Сделки</option>
              </select>
            </div>
            <select className="global-tf-select" value={activeTab.globalTf} onChange={(e) => setTabs(tabs.map(t => t.id === activeTabId ? { ...t, globalTf: e.target.value } : t))}>
              {timeframes.map(tf => <option key={tf} value={tf}>{tf}</option>)}
            </select>
            <button className="refresh-btn" onClick={fetchMarket}>Обновить</button>
          </div>
        </div>

        <div className="sub-header-line">
          {activeTab.id === 1 ? (
            <div className="filters-area-static">
              <div className="f-row">
                <div className="f-group"><span className="f-label">Объем за 24ч (M$)</span><div className="input-row"><input type="number" value={activeTab.filters.minVolume} onChange={e => updateF('minVolume', e.target.value)} /></div></div>
                <div className="f-group"><span className="f-label">Изм % за 24ч</span><div className="input-row"><input type="number" value={activeTab.filters.minChange} onChange={e => updateF('minChange', e.target.value)} /></div></div>
                <div className="f-group"><span className="f-label">Сделки за 24ч</span><div className="input-row"><input className="trades-input" type="number" value={activeTab.filters.minTrades} onChange={e => updateF('minTrades', e.target.value)} /></div></div>
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
                      <div className="f-vert-item">
                        <span className="f-label">Объем (M$)</span>
                        <div className="input-row-vert">
                          <div className="input-with-hint"><span className="hint">Минимум</span><input type="number" value={activeTab.filters.minVolume} onChange={e => updateF('minVolume', e.target.value)} /></div>
                          <div className="input-with-hint"><span className="hint">Максимум</span><input type="number" value={activeTab.filters.maxVolume} onChange={e => updateF('maxVolume', e.target.value)} /></div>
                          <div className="input-with-hint"><span className="hint">Период (ч)</span><input className="p-in" type="number" value={activeTab.filters.volPeriod} onChange={e => updateF('volPeriod', e.target.value)} /></div>
                        </div>
                      </div>
                      <div className="f-vert-item">
                        <span className="f-label">Изменение %</span>
                        <div className="input-row-vert">
                          <div className="input-with-hint"><span className="hint">Минимум</span><input type="number" value={activeTab.filters.minChange} onChange={e => updateF('minChange', e.target.value)} /></div>
                          <div className="input-with-hint"><span className="hint">Максимум</span><input type="number" value={activeTab.filters.maxChange} onChange={e => updateF('maxChange', e.target.value)} /></div>
                          <div className="input-with-hint"><span className="hint">Период (ч)</span><input className="p-in" type="number" value={activeTab.filters.chgPeriod} onChange={e => updateF('chgPeriod', e.target.value)} /></div>
                        </div>
                      </div>
                      <div className="f-vert-item">
                        <span className="f-label">NATR %</span>
                        <div className="input-row-vert">
                          <div className="input-with-hint"><span className="hint">Мин</span><input type="number" value={activeTab.filters.minNatr} onChange={e => updateF('minNatr', e.target.value)} /></div>
                          <div className="input-with-hint"><span className="hint">Макс</span><input type="number" value={activeTab.filters.maxNatr} onChange={e => updateF('maxNatr', e.target.value)} /></div>
                          <div className="input-with-hint"><span className="hint">Период (ч)</span><input className="p-in" type="number" value={activeTab.filters.natrPeriod} onChange={e => updateF('natrPeriod', e.target.value)} /></div>
                        </div>
                      </div>
                      <div className="f-vert-item">
                        <span className="f-label">Волатильность %</span>
                        <div className="input-row-vert">
                          <div className="input-with-hint"><span className="hint">Мин</span><input type="number" value={activeTab.filters.minVolat} onChange={e => updateF('minVolat', e.target.value)} /></div>
                          <div className="input-with-hint"><span className="hint">Макс</span><input type="number" value={activeTab.filters.maxVolat} onChange={e => updateF('maxVolat', e.target.value)} /></div>
                          <div className="input-with-hint"><span className="hint">Период (ч)</span><input className="p-in" type="number" value={activeTab.filters.volatPeriod} onChange={e => updateF('volatPeriod', e.target.value)} /></div>
                        </div>
                      </div>
                      <div className="f-vert-item">
                        <span className="f-label">Корреляция %</span>
                        <div className="input-row-vert">
                          <div className="input-with-hint"><span className="hint">Мин</span><input type="number" value={activeTab.filters.minCorr} onChange={e => updateF('minCorr', e.target.value)} /></div>
                          <div className="input-with-hint"><span className="hint">Макс</span><input type="number" value={activeTab.filters.maxCorr} onChange={e => updateF('maxCorr', e.target.value)} /></div>
                          <div className="input-with-hint"><span className="hint">Период (ч)</span><input className="p-in" type="number" value={activeTab.filters.corrPeriod} onChange={e => updateF('corrPeriod', e.target.value)} /></div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </header>

      <div className="grid-box">
        {filteredCoins.map(c => (
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
    </div>
  );
}

export default App;