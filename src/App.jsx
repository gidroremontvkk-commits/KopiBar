import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as LightweightCharts from 'lightweight-charts';
import './App.css';

const timeframes = ['1m', '5m', '15m', '1h', '4h', '1d'];

// НОВАЯ ФУНКЦИЯ: Математический расчет корреляции Пирсона с Биткойном
const calculateCorrelation = (data) => {
  if (data.length < 2) return 0;
  
  let x = [];
  let y = [];
  
  // Считаем % изменения цены (доходность) между свечами для монеты и для BTC
  for (let i = 1; i < data.length; i++) {
    if (!data[i].btcClose || !data[i - 1].btcClose) continue; 
    
    const symRet = (data[i].close - data[i - 1].close) / data[i - 1].close;
    const btcRet = (data[i].btcClose - data[i - 1].btcClose) / data[i - 1].btcClose;
    
    x.push(symRet);
    y.push(btcRet);
  }

  if (x.length === 0) return 0;

  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  if (denX === 0 || denY === 0) return 0;
  return (num / Math.sqrt(denX * denY)) * 100; // Возвращает от -100 до 100
};

const ChartComponent = ({ symbol, marketStats, globalTf, filters, isFirstTab }) => {
  const chartContainerRef = useRef();
  const chartRef = useRef();
  const [localTf, setLocalTf] = useState(globalTf);
  const [dataReady, setDataReady] = useState({ isHidden: false, stats: {} });
  const [loading, setLoading] = useState(true);
  const candleSeriesRef = useRef(); 
  const volumeSeriesRef = useRef();

  useEffect(() => { setLocalTf(globalTf); }, [globalTf]);

  useEffect(() => {
    const handleResize = () => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // ИЗМЕНЕНО: Теперь качаем данные монеты и BTCUSDT параллельно
  const loadHistory = useCallback(async () => {
    try {
      let allKlines = [];
      let btcKlines = [];
      let lastEndTime = null;
      
      for (let i = 0; i < 4; i++) {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${localTf}&limit=1000${lastEndTime ? `&endTime=${lastEndTime}` : ''}`;
        const btcUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=${localTf}&limit=1000${lastEndTime ? `&endTime=${lastEndTime}` : ''}`;
        
        const [res, btcRes] = await Promise.all([
          fetch(url).then(r => r.json()),
          symbol !== 'BTCUSDT' ? fetch(btcUrl).then(r => r.json()) : Promise.resolve([])
        ]);

        if (!res || res.length === 0) break;
        allKlines = [...res, ...allKlines];
        if (symbol !== 'BTCUSDT') btcKlines = [...btcRes, ...btcKlines];
        
        lastEndTime = res[0][0] - 1;
      }

      // Синхронизируем цены Биткойна по времени
      const btcMap = new Map();
      btcKlines.forEach(d => btcMap.set(d[0], parseFloat(d[4])));

      return allKlines.map(d => ({
        time: d[0] / 1000, 
        open: parseFloat(d[1]), 
        high: parseFloat(d[2]), 
        low: parseFloat(d[3]), 
        close: parseFloat(d[4]),
        volume: parseFloat(d[5]),
        btcClose: symbol === 'BTCUSDT' ? parseFloat(d[4]) : btcMap.get(d[0]) // Добавляем цену BTC
      }));
    } catch (e) { return []; }
  }, [symbol, localTf]);

  useEffect(() => {
    if (!chartContainerRef.current) return;
    setLoading(true);

    const chart = LightweightCharts.createChart(chartContainerRef.current, {
      layout: { background: { type: LightweightCharts.ColorType.Solid, color: '#0d0d0f' }, textColor: '#a1a1aa' },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false, autoScale: true },
      timeScale: { 
        borderVisible: false, rightOffset: 20, barSpacing: 3,
        minBarSpacing: 0, fixLeftEdge: false, fixRightEdge: false
      },
      width: chartContainerRef.current.clientWidth, height: 400,
    });
    
    const candleSeries = chart.addCandlestickSeries({ 
      upColor: '#00ff9d', downColor: '#ff3b3b', borderVisible: false,
      wickUpColor: '#00ff9d', wickDownColor: '#ff3b3b',
      priceFormat: {
        type: 'price',
        precision: 8,      // Максимальное кол-во знаков для дешевых монет
        minMove: 0.00000001, // Минимальный шаг цены
      },
    });

    const volumeSeries = chart.addHistogramSeries({
      color: '#26a69a', priceFormat: { type: 'volume' }, priceScaleId: '', 
    });

    // Привязываем созданные серии к "рефам", чтобы сокет мог их видеть
    candleSeriesRef.current = candleSeries;
    // Автоматическая настройка точности в зависимости от цены монеты
    candleSeries.applyOptions({
      priceFormat: {
        type: 'custom',
        formatter: price => {
          if (price === undefined) return '';
          if (price > 1) return price.toFixed(2);
          if (price > 0.01) return price.toFixed(4);
          return price.toFixed(8); // Для очень дешевых активов
        },
      },
    });
    volumeSeriesRef.current = volumeSeries;

    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chartRef.current = chart;

    loadHistory().then(data => {
      if (data.length > 0) {
        candleSeries.setData(data);
        const volumeData = data.map(d => ({
          time: d.time,
          value: d.volume,
          color: d.close >= d.open ? 'rgba(0, 255, 157, 0.5)' : 'rgba(255, 59, 59, 0.5)'
        }));
        volumeSeries.setData(volumeData);

        const lastIdx = data.length - 1;
        chart.timeScale().setVisibleRange({ from: data[Math.max(0, lastIdx - 600)].time, to: data[lastIdx].time + 100 });

        const tfMin = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 }[localTf] || 5;
        const lastPrice = data[lastIdx].close;
        const getSlice = (h, extra = 0) => data.slice(-Math.round((h * 60) / (tfMin || 5)) - extra);

        const stats = {
          natr: (getSlice(filters.natrPeriod || 2).reduce((s, b) => s + (b.high - b.low), 0) / (getSlice(filters.natrPeriod || 2).length || 1) / lastPrice) * 100,
          volat: (getSlice(filters.volatPeriod || 6).reduce((s, b) => s + (b.high - b.low), 0) / (getSlice(filters.volatPeriod || 6).length || 1) / lastPrice) * 100,
          corr: symbol === 'BTCUSDT' ? 100 : Math.round(calculateCorrelation(getSlice(filters.corrPeriod || 1, 1)))
        };

        const hide = !isFirstTab && (
          stats.natr < (filters.minNatr || 0) || stats.natr > (filters.maxNatr || 100) || 
          stats.volat < (filters.minVolat || 0) || stats.volat > (filters.maxVolat || 100) ||
          stats.corr < (filters.minCorr || -100) || stats.corr > (filters.maxCorr || 100)
        );
        setDataReady({ isHidden: hide, stats });
      }
      setLoading(false);
    });

    // СОЗДАЕМ СОКЕТ ДЛЯ ОБНОВЛЕНИЯ В РЕАЛЬНОМ ВРЕМЕНИ
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@kline_${localTf}`);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.e === 'kline') {
        const k = msg.k;
        const candleUpdate = {
          time: k.t / 1000,
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c)
        };
        
        // Магия обновления без перезагрузки
        if (candleSeriesRef.current) candleSeriesRef.current.update(candleUpdate);
        if (volumeSeriesRef.current) {
          volumeSeriesRef.current.update({
            time: k.t / 1000,
            value: parseFloat(k.v),
            color: parseFloat(k.c) >= parseFloat(k.o) ? 'rgba(0, 255, 157, 0.5)' : 'rgba(255, 59, 59, 0.5)'
          });
        }
      }
    };

    return () => {
      chart.remove();
      ws.close(); // Теперь ws существует и закроется корректно
    };
  }, [localTf, symbol, loadHistory, filters, isFirstTab]);

  if (dataReady.isHidden) return null;

  return (
    <div className="chart-card">
      <div className="chart-header">
        <span className="symbol-name">{symbol}</span>
        <div className="tf-selector-mini">
          {timeframes.map(tf => (
            <button key={tf} className={`tf-btn-mini ${localTf === tf ? 'active' : ''}`} onClick={() => setLocalTf(tf)}>{tf}</button>
          ))}
        </div>
      </div>
      <div className="chart-relative-container">
        {loading && (
          <div className="chart-loader">
            <div className="scanner-line"></div>
            <div className="loader-info">
              <div className="loader-ticker">{symbol.replace('USDT', '')}</div>
              <div className="loader-status">DECODING DATA...</div>
            </div>
          </div>
        )}
        <div className={`chart-anchor ${loading ? 'blurred' : ''}`} ref={chartContainerRef} />
        <div className="info-overlay">
          <div>ОБЪЕМ: <b>{(parseFloat(marketStats.quoteVolume)/1e6).toFixed(1)}M$</b></div>
          <div className={marketStats.priceChangePercent > 0 ? 'green' : 'red'}>ИЗМ: <b>{marketStats.priceChangePercent}%</b></div>
          <div>СДЕЛКИ: <b>{parseInt(marketStats.count).toLocaleString()}</b></div>
          <div>NATR: <b>{dataReady.stats.natr?.toFixed(2)}%</b></div>
          <div>ВОЛАТ: <b>{dataReady.stats.volat?.toFixed(2)}%</b></div>
          <div>КОРР: <b>{dataReady.stats.corr}%</b></div>
        </div>
      </div>
    </div>
  );
};

function App() {
  const [marketData, setMarketData] = useState([]);
  const [activeSymbols, setActiveSymbols] = useState([]);
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const [sortBy, setSortBy] = useState('volume'); // Тут мы создали "переключатель" сортировки
  const dropdownRef = useRef(null);

  const [tabs, setTabs] = useState([{ 
    id: 1, name: 'Основная', globalTf: '5m', 
    filters: { 
      minVolume: 10, maxVolume: 99999, volPeriod: 24,
      minChange: 10, maxChange: 100, chgPeriod: 24, 
      minTrades: 1000000, maxTrades: 99999999, trdPeriod: 24, 
      minNatr: 0, maxNatr: 100, natrPeriod: 2,
      minVolat: 0, maxVolat: 100, volatPeriod: 6,
      minCorr: -100, maxCorr: 100, corrPeriod: 1 
    } 
  }]);
  const [activeTabId, setActiveTabId] = useState(1);

  const fetchMarket = useCallback(() => {
    Promise.all([
      fetch('https://fapi.binance.com/fapi/v1/exchangeInfo').then(r => r.json()),
      fetch('https://fapi.binance.com/fapi/v1/ticker/24hr').then(r => r.json())
    ]).then(([info, tickers]) => {
      setActiveSymbols(info.symbols.filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT').map(s => s.symbol));
      setMarketData(tickers);
    });
  }, []);

  useEffect(() => { fetchMarket(); }, [fetchMarket]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) setIsFiltersOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];
  const updateF = (key, val) => setTabs(tabs.map(t => t.id === activeTabId ? { ...t, filters: { ...t.filters, [key]: Number(val) } } : t));

  // ВОТ ТУТ ПРОИСХОДИТ МАГИЯ СОРТИРОВКИ
  const filteredCoins = marketData.filter(item => {
    if (!activeSymbols.includes(item.symbol)) return false;
    const v = parseFloat(item.quoteVolume)/1e6, c = Math.abs(parseFloat(item.priceChangePercent)), t = parseInt(item.count);
    return v >= activeTab.filters.minVolume && v <= activeTab.filters.maxVolume && 
           c >= activeTab.filters.minChange && c <= activeTab.filters.maxChange && 
           t >= activeTab.filters.minTrades;
  }).sort((a, b) => {
    if (sortBy === 'volume') return parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume);
    if (sortBy === 'change') return Math.abs(parseFloat(b.priceChangePercent)) - Math.abs(parseFloat(a.priceChangePercent));
    if (sortBy === 'trades') return parseInt(b.count) - parseInt(a.count);
    return 0;
  });

  const displayedCoins = filteredCoins.slice(0, 12);

  return (
    <div className="app-container">
      <header className="main-header">
        <div className="header-top">
          <div className="logo">Kopi<span className="green-accent">Bar</span></div>
          <div className="tabs-container">
            {tabs.map(t => (
              <div key={t.id} className={`tab-item ${activeTabId === t.id ? 'active' : ''}`} onClick={() => setActiveTabId(t.id)}>
                <span className="tab-name">{t.name}</span>
                {t.id !== 1 && (
                  <span className="edit-icon" onClick={(e) => {
                    e.stopPropagation();
                    const n = prompt("Имя вкладки:", t.name);
                    if(n) setTabs(tabs.map(x => x.id === t.id ? {...x, name: n} : x));
                  }}>✎</span>
                )}
                {t.id !== 1 && <span className="close-x" onClick={(e) => { e.stopPropagation(); setTabs(tabs.filter(x => x.id !== t.id)); setActiveTabId(1); }}>×</span>}
              </div>
            ))}
            <button className="add-btn" onClick={() => setTabs([...tabs, { ...activeTab, id: Date.now(), name: 'Новая' }])}>+</button>
          </div>
          <div className="header-right">
            <div className="results-count">Найдено: <span className="green-accent">{filteredCoins.length}</span></div>
            
            {/* НОВЫЙ ВЫПАДАЮЩИЙ СПИСОК ДЛЯ СОРТИРОВКИ */}
            <div className="sort-box">
              <span className="sort-label">Сортировка:</span>
              <select className="global-tf-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                <option value="volume">Объем</option>
                <option value="change">Изм %</option>
                <option value="trades">Сделки</option>
              </select>
            </div>

            <select className="global-tf-select" value={activeTab.globalTf} onChange={(e) => setTabs(tabs.map(t => t.id === activeTabId ? {...t, globalTf: e.target.value} : t))}>
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
                        <span className="f-label">Сделки</span>
                        <div className="input-row-vert">
                          <div className="input-with-hint"><span className="hint">Минимум</span><input className="trades-input" type="number" value={activeTab.filters.minTrades} onChange={e => updateF('minTrades', e.target.value)} /></div>
                          <div className="input-with-hint"><span className="hint">Максимум</span><input className="trades-input" type="number" value={activeTab.filters.maxTrades} onChange={e => updateF('maxTrades', e.target.value)} /></div>
                          <div className="input-with-hint"><span className="hint">Период (ч)</span><input className="p-in" type="number" value={activeTab.filters.trdPeriod} onChange={e => updateF('trdPeriod', e.target.value)} /></div>
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
        {displayedCoins.map(c => (
          <ChartComponent 
            key={c.symbol} 
            symbol={c.symbol} 
            marketStats={c} 
            globalTf={activeTab.globalTf} 
            filters={activeTab.filters} 
            isFirstTab={activeTab.id === 1} 
          />
        ))}
      </div>
    </div>
  );
}

export default App;