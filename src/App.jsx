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
const TF_MIN = { '1m':1,'5m':5,'15m':15,'1h':60,'4h':240,'1d':1440 };
const CHART_HEADER_H = 71;

// ─── Цвета звёздочек ──────────────────────────────────────────────────────────
const STAR_COLORS = [
  { key:'yellow', hex:'#f0c040', label:'Жёлтый'    },
  { key:'red',    hex:'#ff4444', label:'Красный'    },
  { key:'green',  hex:'#00e676', label:'Зелёный'    },
  { key:'blue',   hex:'#4499ff', label:'Синий'      },
  { key:'purple', hex:'#cc44ff', label:'Фиолетовый' },
  { key:'orange', hex:'#ff8844', label:'Оранжевый'  },
];
const starHex = (key) => STAR_COLORS.find(c => c.key === key)?.hex || '#f0c040';

// ─── WebSocket фабрика ────────────────────────────────────────────────────────
function createExchangeWS(exchange, symbol, interval, onCandle) {
  let ws = null, pingInterval = null;
  try {
    if (exchange === 'binance') {
      ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@kline_${interval}`);
      ws.onmessage = (e) => { try { const msg=JSON.parse(e.data); if(msg.e==='kline'){const k=msg.k; onCandle({time:k.t/1000,open:+k.o,high:+k.h,low:+k.l,close:+k.c,volume:+k.v,openTime:k.t});} } catch {} };
    } else if (exchange === 'bybit') {
      const tfMap={'1m':'1','5m':'5','15m':'15','1h':'60','4h':'240','1d':'D'};
      ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
      ws.onopen = () => ws.send(JSON.stringify({op:'subscribe',args:[`kline.${tfMap[interval]||interval}.${symbol}`]}));
      pingInterval = setInterval(() => { if(ws?.readyState===1) ws.send(JSON.stringify({op:'ping'})); }, 20000);
      ws.onmessage = (e) => { try { const msg=JSON.parse(e.data); if(msg.topic?.startsWith('kline')&&msg.data?.[0]){const k=msg.data[0]; onCandle({time:+k.start/1000,open:+k.open,high:+k.high,low:+k.low,close:+k.close,volume:+k.volume,openTime:+k.start});} } catch {} };
    } else if (exchange === 'okx') {
      const tfMap={'1m':'1m','5m':'5m','15m':'15m','1h':'1H','4h':'4H','1d':'1D'};
      ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
      ws.onopen = () => ws.send(JSON.stringify({op:'subscribe',args:[{channel:`candle${tfMap[interval]||interval}`,instId:symbol}]}));
      pingInterval = setInterval(() => { if(ws?.readyState===1) ws.send('ping'); }, 25000);
      ws.onmessage = (e) => { try { if(e.data==='pong') return; const msg=JSON.parse(e.data); if(msg.data?.[0]){const k=msg.data[0]; onCandle({time:+k[0]/1000,open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5],openTime:+k[0]});} } catch {} };
    } else if (exchange === 'gateio') {
      ws = new WebSocket('wss://fx-ws.gateio.ws/v4/ws/usdt');
      ws.onopen = () => ws.send(JSON.stringify({time:Math.floor(Date.now()/1000),channel:'futures.candlesticks',event:'subscribe',payload:[interval,symbol]}));
      pingInterval = setInterval(() => { if(ws?.readyState===1) ws.send(JSON.stringify({time:Math.floor(Date.now()/1000),channel:'futures.ping'})); }, 20000);
      ws.onmessage = (e) => { try { const msg=JSON.parse(e.data); if(msg.channel==='futures.candlesticks'&&msg.result){const k=msg.result; onCandle({time:+k.t,open:+k.o,high:+k.h,low:+k.l,close:+k.c,volume:+k.v,openTime:+k.t*1000});} } catch {} };
    } else if (exchange === 'bitget') {
      const tfMap={'1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1d'};
      ws = new WebSocket('wss://ws.bitget.com/v2/ws/public');
      ws.onopen = () => ws.send(JSON.stringify({op:'subscribe',args:[{instType:'USDT-FUTURES',channel:`candle${tfMap[interval]||interval}`,instId:symbol}]}));
      pingInterval = setInterval(() => { if(ws?.readyState===1) ws.send('ping'); }, 25000);
      ws.onmessage = (e) => { try { if(e.data==='pong') return; const msg=JSON.parse(e.data); if(msg.data?.[0]){const k=msg.data[0]; onCandle({time:+k[0]/1000,open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5],openTime:+k[0]});} } catch {} };
    }
    if (ws) { ws.onerror=()=>{}; ws.onclose=()=>{}; }
  } catch {}
  return { close: () => { if(pingInterval) clearInterval(pingInterval); if(ws){ws.onmessage=null;ws.onerror=null;ws.onclose=null;if(ws.readyState<=1)ws.close();} } };
}

// ─── Очередь запросов ─────────────────────────────────────────────────────────
const requestQueue = (() => {
  let active=0; const MAX=6,queue=[];
  const run=()=>{ if(active>=MAX||!queue.length) return; active++; const{url,resolve,reject}=queue.shift(); fetch(url).then(r=>r.json()).then(resolve).catch(reject).finally(()=>{active--;run();}); };
  return (url)=>new Promise((resolve,reject)=>{ queue.push({url,resolve,reject}); run(); });
})();

// ─── Кэш свечей ──────────────────────────────────────────────────────────────
const klinesCache = new Map();
async function fetchKlines(exchange, symbol, tf) {
  const key=`${exchange}:${symbol}:${tf}`;
  if (klinesCache.has(key)) return klinesCache.get(key);
  const data = await requestQueue(`${SERVER}/klines?exchange=${exchange}&symbol=${symbol}&interval=${tf}`);
  if (!Array.isArray(data)) return [];
  klinesCache.set(key, data);
  return data;
}

// ─── Расчёты ──────────────────────────────────────────────────────────────────
const calculateCorrelation = (data) => {
  if (data.length < 2) return null;
  const x=[], y=[];
  for (let i=1; i<data.length; i++) {
    if (!data[i].btcClose || !data[i-1].btcClose) continue;
    x.push((data[i].close - data[i-1].close) / data[i-1].close);
    y.push((data[i].btcClose - data[i-1].btcClose) / data[i-1].btcClose);
  }
  if (x.length < 5) return null;
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
  for (let i=1;i<slice.length;i++) if(slice[i-1].close>0&&slice[i].close>0) ret.push(Math.log(slice[i].close/slice[i-1].close));
  if (ret.length<2) return 0;
  const mean=ret.reduce((a,b)=>a+b,0)/ret.length;
  return Math.sqrt(ret.reduce((s,r)=>s+(r-mean)**2,0)/(ret.length-1))*100;
};

function computeStats(rawData, btcMap, filters, tfMin, symbol) {
  if (!rawData||rawData.length<2) return null;
  const lastPrice=rawData[rawData.length-1].close;
  if (!lastPrice) return null;
  const natr=calculateNATR(rawData,filters.natrPeriod||2,tfMin,lastPrice);
  const volat=calculateVolatility(rawData,filters.volatPeriod||6,tfMin);
  let corr=null;
  if (symbol.replace(/[-_].*/,'').toUpperCase().startsWith('BTC')) { corr=100; }
  else if (btcMap) {
    const corrN=Math.max(10,Math.round(((filters.corrPeriod||1)*60)/tfMin));
    const slice=rawData.slice(-corrN).map(d=>({...d,btcClose:btcMap.get(d.openTime)}));
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

// ─── Форматтеры ───────────────────────────────────────────────────────────────
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

// ─── Компонент графика ────────────────────────────────────────────────────────
const ChartComponent = ({ symbol, marketStats, globalTf, filters, btcMap, exchange, isFullscreenMode, onFullscreen, onClose, precomputedStats, fixedHeight, autoSize, watchlist, onToggleWatch, selectedStarColor }) => {
  const chartContainerRef = useRef();
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const btcMapRef = useRef(btcMap);

  const CHEIGHT = fixedHeight || 340;
  const useAutoSize = autoSize && !isFullscreenMode;

  const [localTf, setLocalTf] = useState(globalTf);
  const [stats, setStats] = useState(precomputedStats || {});
  const [loading, setLoading] = useState(true);
  const [crosshair, setCrosshair] = useState(null);

  useEffect(() => { btcMapRef.current = btcMap; }, [btcMap]);
  useEffect(() => { setLocalTf(globalTf); }, [globalTf]);
  useEffect(() => { if (precomputedStats) setStats(precomputedStats); }, [precomputedStats]);

  // Пересчитываем stats при изменении периодов фильтров — берём данные из кеша
  useEffect(() => {
    const cached = klinesCache.get(`${exchange}:${symbol}:${localTf}`);
    if (!cached || !cached.length) return;
    const tfMin = TF_MIN[localTf] || 5;
    const s = computeStats(cached, btcMapRef.current, filters, tfMin, symbol);
    if (s) setStats(s);
  }, [filters.natrPeriod, filters.volatPeriod, filters.corrPeriod, symbol, exchange, localTf]); // eslint-disable-line

  useEffect(() => {
    const h = () => {
      if (!chartRef.current||!chartContainerRef.current) return;
      if (useAutoSize) return; // autoSize handles it
      chartRef.current.applyOptions({
        width: isFullscreenMode ? window.innerWidth : chartContainerRef.current.clientWidth,
        height: isFullscreenMode ? window.innerHeight - CHART_HEADER_H : CHEIGHT,
      });
    };
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, [isFullscreenMode, CHEIGHT, useAutoSize]);

  useEffect(() => {
    if (!isFullscreenMode) return;
    const h = (e) => { if(e.key==='Escape'&&onClose) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [isFullscreenMode, onClose]);

  useEffect(() => {
    if (!chartContainerRef.current) return;
    setLoading(true);
    let cancelled=false, wsHandle=null;
    const w = isFullscreenMode ? window.innerWidth : (chartContainerRef.current.clientWidth||800);
    const h = isFullscreenMode ? window.innerHeight - CHART_HEADER_H : CHEIGHT;

    const chart = LightweightCharts.createChart(chartContainerRef.current, {
      layout: { background:{type:LightweightCharts.ColorType.Solid,color:'#0d0d0f'}, textColor:'#a1a1aa' },
      grid: { vertLines:{visible:false}, horzLines:{visible:false} },
      crosshair: { mode:LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderVisible:false, autoScale:true, minimumWidth:80 },
      timeScale: { borderVisible:false, rightOffset:60, barSpacing:3, minBarSpacing:0, timeVisible:true, secondsVisible:false, tickMarkFormatter:timescaleFormatter },
      ...(useAutoSize ? { autoSize:true } : { width:w, height:h }),
    });

    const candleSeries = chart.addCandlestickSeries({ upColor:'#00ff9d', downColor:'#ff3b3b', borderVisible:false, wickUpColor:'#00ff9d', wickDownColor:'#ff3b3b' });
    const volumeSeries = chart.addHistogramSeries({ color:'#26a69a', priceFormat:{type:'volume'}, priceScaleId:'' });
    chart.priceScale('').applyOptions({ scaleMargins:{top:0.8,bottom:0} });
    candleSeriesRef.current=candleSeries; volumeSeriesRef.current=volumeSeries; chartRef.current=chart;

    chart.subscribeCrosshairMove((param) => {
      if (!param.time||!param.seriesData) { setCrosshair(null); return; }
      const c=param.seriesData.get(candleSeries), v=param.seriesData.get(volumeSeries);
      if (c) setCrosshair({open:c.open,high:c.high,low:c.low,close:c.close,volume:v?.value??0});
      else setCrosshair(null);
    });

    fetchKlines(exchange, symbol, localTf).then(rawData => {
      if (cancelled) return;
      if (rawData.length > 0) {
        candleSeries.setData(rawData);
        const lastPrice = rawData[rawData.length-1].close;
        candleSeries.applyOptions({ priceFormat:{type:'price',...getPriceFormat(lastPrice)} });
        volumeSeries.setData(rawData.map(d => ({ time:d.time, value:d.volume, color:d.close>=d.open?'rgba(0,255,157,0.5)':'rgba(255,59,59,0.5)' })));
        chart.timeScale().scrollToRealTime();
        const tfMin = TF_MIN[localTf]||5;
        const s = computeStats(rawData, btcMapRef.current, filters, tfMin, symbol);
        if (!cancelled && s) setStats(s);
      }
      if (!cancelled) setLoading(false);
      if (!cancelled) wsHandle = createExchangeWS(exchange, symbol, localTf, (candle) => {
        if (cancelled||!candleSeriesRef.current||!volumeSeriesRef.current) return;
        candleSeriesRef.current.update(candle);
        volumeSeriesRef.current.update({ time:candle.time, value:candle.volume, color:candle.close>=candle.open?'rgba(0,255,157,0.5)':'rgba(255,59,59,0.5)' });
      });
    });

    return () => { cancelled=true; if(wsHandle) wsHandle.close(); candleSeriesRef.current=null; volumeSeriesRef.current=null; chartRef.current=null; try{chart.remove();}catch{} };
  }, [localTf, symbol, exchange, isFullscreenMode, CHEIGHT]); // eslint-disable-line

  // Пересчёт stats при изменении периодов фильтров (без перезагрузки графика)
  useEffect(() => {
    const cached = klinesCache.get(`${exchange}:${symbol}:${localTf}`);
    if (!cached || !cached.length) return;
    const tfMin = TF_MIN[localTf]||5;
    const s = computeStats(cached, btcMapRef.current, filters, tfMin, symbol);
    if (s) setStats(s);
  }, [filters.natrPeriod, filters.volatPeriod, filters.corrPeriod, filters.minNatr, filters.maxNatr, filters.minVolat, filters.maxVolat, filters.minCorr, filters.maxCorr]); // eslint-disable-line

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
            <button
              className="chart-star-btn"
              style={{color: watchlist?.[symbol] ? starHex(watchlist[symbol]) : '#333'}}
              onClick={(e)=>{e.stopPropagation(); onToggleWatch(symbol);}}
              title={watchlist?.[symbol] ? `Помечено (${STAR_COLORS.find(c=>c.key===watchlist[symbol])?.label})` : 'Пометить'}
            >★</button>
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
      <div className="chart-relative-container" style={ useAutoSize ? {flex:1,minHeight:0} : { height: isFullscreenMode ? `calc(100vh - ${CHART_HEADER_H}px)` : `${CHEIGHT}px` } }>
        {loading && <div className="chart-loader"><div className="scanner-line"></div><div className="loader-info"><div className="loader-ticker">{symbol.replace(/[-_]?USDT.*/i,'')}</div><div className="loader-status">DECODING DATA...</div></div></div>}
        <div className={`chart-anchor ${loading?'blurred':''}`} ref={chartContainerRef} />
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
  const [visible, setVisible] = useState(false);
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
      <ChartComponent {...props} isFullscreenMode={true} onClose={handleClose} onFullscreen={null}/>
    </div>, document.body
  ) : null;

  return (<>
    <div ref={containerRef} className="chart-card-virtual">
      {visible && <ChartComponent {...props} onFullscreen={handleFullscreen} isFullscreenMode={false}/>}
    </div>
    {fullscreenPortal}
  </>);
};

// ─── Список монет + боковой график ───────────────────────────────────────────
const CoinList = ({ coins, exchange, watchlist, onToggleWatch, selectedStarColor, filters, btcMap, globalTf, defaultSort }) => {
  const [sortCol, setSortCol] = useState(defaultSort || 'volume');
  const [sortDir, setSortDir] = useState(-1);
  const [statsMap, setStatsMap] = useState({});
  const [selectedSymbol, setSelectedSymbol] = useState(null);

  // Сброс сортировки при переключении режима "все / по фильтрам"
  useEffect(() => { setSortCol(defaultSort || 'volume'); setSortDir(-1); }, [defaultSort]);

  const handleSort = (col) => { if(sortCol===col) setSortDir(d=>-d); else {setSortCol(col);setSortDir(-1);} };

  useEffect(() => {
    if (!coins.length) return;
    let cancelled = false;
    const tfMin = TF_MIN[globalTf]||5;
    const top = coins;
    const map = {};
    (async () => {
      await Promise.all(top.map(async (coin) => {
        try {
          const rawData = await fetchKlines(exchange, coin.symbol, globalTf);
          if (cancelled||!rawData.length) return;
          const s = computeStats(rawData, btcMap, filters, tfMin, coin.symbol);
          if (s) map[coin.symbol] = s;
        } catch {}
      }));
      if (!cancelled) setStatsMap({...map});
    })();
    return () => { cancelled=true; };
  }, [exchange, globalTf, coins.length, btcMap, filters.natrPeriod, filters.volatPeriod, filters.corrPeriod]); // eslint-disable-line

  // Помеченные — наверх, потом сортировка по столбцу
  const sorted = useMemo(() => [...coins].sort((a, b) => {
    const aS=!!watchlist[a.symbol], bS=!!watchlist[b.symbol];
    if (aS&&!bS) return -1;
    if (!aS&&bS) return 1;
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

  const Th = ({col, label}) => (
    <th className={`list-th ${sortCol===col?'active':''}`} onClick={()=>handleSort(col)}>
      {label}{sortCol===col?(sortDir===-1?' ↓':' ↑'):''}
    </th>
  );

  return (
    <div className="list-split-view">
      {/* Левая панель — график выбранной монеты */}
      <div className="list-chart-panel">
        {chartCoin && (
          <ChartComponent
            symbol={chartCoin.symbol}
            marketStats={chartCoin}
            globalTf={globalTf}
            filters={filters}
            btcMap={btcMap}
            exchange={exchange}
            isFullscreenMode={false}
            onFullscreen={null}
            precomputedStats={statsMap[chartCoin.symbol]||null}
            autoSize={true}
            watchlist={watchlist}
            onToggleWatch={onToggleWatch}
            selectedStarColor={selectedStarColor}
          />
        )}
      </div>

      {/* Правая панель — таблица */}
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
                const chg      = parseFloat(coin.priceChangePercent);
                const s        = statsMap[coin.symbol];
                const starKey  = watchlist[coin.symbol];
                const isSelected = coin.symbol === chartCoin?.symbol;
                return (
                  <tr
                    key={coin.symbol}
                    className={`list-row ${starKey?'starred':''} ${isSelected?'list-row-selected':''}`}
                    onClick={() => setSelectedSymbol(coin.symbol)}
                    style={{cursor:'pointer'}}
                  >
                    <td onClick={e=>e.stopPropagation()}>
                      <button
                        className="star-btn"
                        style={{ color: starKey ? starHex(starKey) : '#333' }}
                        onClick={() => onToggleWatch(coin.symbol)}
                        title={starKey ? `Помечено (${STAR_COLORS.find(c=>c.key===starKey)?.label}) — нажми чтобы изменить или снять` : 'Пометить'}
                      >★</button>
                    </td>
                    <td className="list-symbol">
                      {coin.symbol.replace(/[-_]?(USDT|BUSD|USDC).*$/i, '') + 'USDT.P'}
                    </td>
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
  minChange:0,  maxChange:100,      chgPeriod:24,
  minTrades:0,  maxTrades:99999999, trdPeriod:24,
  minNatr:0,    maxNatr:100,        natrPeriod:2,
  minVolat:0,   maxVolat:100,       volatPeriod:6,
  minCorr:-100, maxCorr:100,        corrPeriod:1,
};
const defaultTab = { id:1, name:'Основная', globalTf:'5m', filters:defaultFilters };

// ─── App ──────────────────────────────────────────────────────────────────────
function App() {
  const [activeExchange, setActiveExchange] = useState('binance');
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

  // watchlist: { [symbol]: colorKey }
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
  const watchDropRef  = useRef(null);
  const starColorRef  = useRef(null);
  const dropdownRef   = useRef(null);
  const statsAbortRef = useRef({cancelled:false});

  const [tabs, setTabs] = useState(() => {
    try {
      const saved = localStorage.getItem('kopibar_tabs');
      if (saved) {
        const parsed = JSON.parse(saved);
        return parsed.map(t => {
          const f = {...defaultFilters,...t.filters};
          if (t.id===1) {f.minNatr=0;f.maxNatr=100;f.minVolat=0;f.maxVolat=100;f.minCorr=-100;f.maxCorr=100;}
          return {...t, filters:f, appliedFilters: t.appliedFilters?{...defaultFilters,...t.appliedFilters}:f};
        });
      }
    } catch {}
    return [defaultTab];
  });

  const [activeTabId, setActiveTabId] = useState(() => { try{return Number(localStorage.getItem('kopibar_active_tab'))||1;}catch{return 1;} });

  useEffect(() => { try{localStorage.setItem('kopibar_tabs',JSON.stringify(tabs));}catch{} }, [tabs]);
  useEffect(() => { try{localStorage.setItem('kopibar_active_tab',String(activeTabId));}catch{} }, [activeTabId]);
  useEffect(() => { try{localStorage.setItem('kopibar_watchlist_v2',JSON.stringify(watchlist));}catch{} }, [watchlist]);

  // Закрыть watch dropdown при клике снаружи
  useEffect(() => {
    const h=(e)=>{ if(watchDropRef.current&&!watchDropRef.current.contains(e.target)) setWatchDropOpen(false); if(starColorRef.current&&!starColorRef.current.contains(e.target)) setStarColorOpen(false); };
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
      if (next[symbol]===selectedStarColor) delete next[symbol]; // тот же цвет → снять
      else next[symbol] = selectedStarColor;                      // новый / другой цвет
      return next;
    });
  }, [selectedStarColor]);

  const clearWatchlist = useCallback(() => {
    if (window.confirm('Очистить все помеченные монеты?')) setWatchlist({});
  }, []);

  const fetchMarket = useCallback(() => {
    setLoadingMarket(true);
    Promise.all([
      requestQueue(`${SERVER}/symbols?exchange=${activeExchange}`),
      requestQueue(`${SERVER}/tickers?exchange=${activeExchange}&interval=${activeTab.globalTf}`)
    ]).then(([symbols,tickers])=>{
      if(Array.isArray(symbols)) setActiveSymbols(symbols);
      if(Array.isArray(tickers)) setMarketData(tickers);
    }).finally(()=>setLoadingMarket(false));
  }, [activeExchange, activeTab.globalTf]);

  const fetchBtcMap = useCallback(async (tf) => {
    try {
      const btcSymbols={binance:'BTCUSDT',bybit:'BTCUSDT',okx:'BTC-USDT-SWAP',gateio:'BTC_USDT',bitget:'BTCUSDT'};
      const data=await fetchKlines(activeExchange,btcSymbols[activeExchange]||'BTCUSDT',tf);
      const map=new Map(); data.forEach(d=>map.set(d.openTime,d.close)); setBtcMap(map);
    } catch {}
  }, [activeExchange]);

  useEffect(() => { klinesCache.clear(); setMarketData([]); setActiveSymbols([]); setBtcMap(null); setStatsMap({}); fetchMarket(); }, [activeExchange]); // eslint-disable-line
  useEffect(() => { setBtcMap(null); fetchBtcMap(activeTab.globalTf); }, [activeTab.globalTf, fetchBtcMap]);

  const PERIOD_KEYS = new Set(['natrPeriod','volatPeriod','corrPeriod']);
  const updateF = (key, val) => setTabs(tabs.map(t => {
    if (t.id !== activeTabId) return t;
    const newFilters = {...t.filters, [key]: Number(val)};
    // периоды применяются сразу без кнопки "Применить"
    const newApplied = PERIOD_KEYS.has(key)
      ? {...(t.appliedFilters||t.filters), [key]: Number(val)}
      : t.appliedFilters;
    return {...t, filters: newFilters, ...(newApplied ? {appliedFilters: newApplied} : {})};
  }));
  const applyFilters = ()=>setTabs(tabs.map(t=>t.id===activeTabId?{...t,appliedFilters:{...t.filters}}:t));

  // Шаг 1
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

  // Все монеты без фильтров, отсортированные по |изм%| убыванию (для "Все монеты" в списке)
  const allCoins = useMemo(() => {
    return marketData
      .filter(item => activeSymbols.includes(item.symbol))
      .sort((a,b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent));
  }, [marketData, activeSymbols]);

  // Шаг 2
  const needStats = activeTab.id!==1 && hasStatsFilter(activeFilters);
  const depsKey   = preFilteredCoins.map(c=>c.symbol).join(',')+`|${activeExchange}|${activeTab.globalTf}|${activeFilters.natrPeriod}|${activeFilters.volatPeriod}|${activeFilters.corrPeriod}`;

  useEffect(() => {
    if (!needStats||!preFilteredCoins.length) { setStatsMap({}); setStatsLoading(false); return; }
    const abort={cancelled:false}; statsAbortRef.current=abort;
    setStatsMap({}); setStatsLoading(true);
    const tf=activeTab.globalTf, tfMin=TF_MIN[tf]||5, partial={};
    (async()=>{
      const symbols=preFilteredCoins.map(c=>c.symbol);
      for(let i=0;i<symbols.length;i+=6){
        if(abort.cancelled) return;
        await Promise.all(symbols.slice(i,i+6).map(async(sym)=>{
          if(abort.cancelled) return;
          try{const rawData=await fetchKlines(activeExchange,sym,tf);if(abort.cancelled)return;partial[sym]=computeStats(rawData,btcMap,activeFilters,tfMin,sym);}
          catch{partial[sym]=null;}
        }));
        if(!abort.cancelled) setStatsMap({...partial});
      }
      if(!abort.cancelled) setStatsLoading(false);
    })();
    return()=>{abort.cancelled=true;};
  }, [depsKey, btcMap, needStats]); // eslint-disable-line

  // Шаг 3
  const filteredCoins = useMemo(() => {
    if (!needStats) return preFilteredCoins;
    return preFilteredCoins.filter(c=>{
      const s=statsMap[c.symbol];
      if(s===undefined) return false;
      return passesStatsFilter(s,activeFilters);
    });
  }, [preFilteredCoins, statsMap, activeFilters, needStats]);

  // Избранное с фильтром по цвету
  const watchlistCoins = useMemo(() => filteredCoins.filter(c=>{
    if(!watchlist[c.symbol]) return false;
    if(watchColorFilter&&watchlist[c.symbol]!==watchColorFilter) return false;
    return true;
  }), [filteredCoins, watchlist, watchColorFilter]);

  const displayCoins    = viewMode==='watchlist' ? watchlistCoins : filteredCoins;
  const analyzingCount  = needStats&&statsLoading ? preFilteredCoins.filter(c=>statsMap[c.symbol]===undefined).length : 0;

  return (
    <div className="app-container">
      <header className="main-header">
        <div className="header-top">
          <div className="logo">Kopi<span className="green-accent">Bar</span></div>

          <div className="exchange-tabs">
            {EXCHANGES.map(ex=><button key={ex.id} className={`exchange-tab ${activeExchange===ex.id?'active':''}`} onClick={()=>setActiveExchange(ex.id)}>{ex.label}</button>)}
          </div>

          <div className="tabs-container">
            {tabs.map(t=>(
              <div key={t.id} className={`tab-item ${activeTabId===t.id?'active':''}`} onClick={()=>setActiveTabId(t.id)}>
                <span className="tab-name">{t.name}</span>
                {t.id!==1&&<span className="edit-icon" onClick={(e)=>{e.stopPropagation();const n=prompt('Имя:',t.name);if(n)setTabs(tabs.map(x=>x.id===t.id?{...x,name:n}:x));}}>✎</span>}
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
                <button className={`view-btn list-show-all-btn ${listShowAll?'active':''}`} onClick={()=>setListShowAll(v=>!v)} title="Показать все монеты / только по фильтрам">
                  {listShowAll ? 'Все монеты' : 'По фильтрам'}
                </button>
              )}

              {/* Кнопка Избранное + выпадашка цветов */}
              <div className="watchlist-btn-wrap" ref={watchDropRef}>
                <button className={`view-btn ${viewMode==='watchlist'?'active':''}`} onClick={()=>setViewMode('watchlist')}>
                  <span className="view-btn-icon" style={{color:watchColorFilter?starHex(watchColorFilter):'#f0c040'}}>★</span>
                  <span className="view-btn-label">Избранное{watchlistSize>0?` (${watchlistSize})`:''}</span>
                </button>
                <button className="watch-drop-arrow-btn" onClick={(e)=>{
                  const r=e.currentTarget.getBoundingClientRect();
                  setWatchDropPos({top:r.bottom+4, left:r.left + r.width/2});
                  setWatchDropOpen(o=>!o);
                }} title="Фильтр по цвету">▾</button>
              </div>
            </div>

            {/* Выбор цвета для пометки */}
            <div className="star-color-select-wrap" ref={starColorRef}>
              <button className="star-color-btn" onClick={()=>{
                const r=starColorRef.current?.getBoundingClientRect();
                if(r) setStarColorPos({top:r.bottom+4, left:r.left});
                setStarColorOpen(o=>!o);
              }} title="Цвет пометки">
                <span style={{color:starHex(selectedStarColor),fontSize:16}}>★</span>
                <span className="star-color-arrow">▾</span>
              </button>
            </div>

            <div className="results-count">
              {loadingMarket
                ? <span className="green-accent">Загрузка...</span>
                : analyzingCount>0
                  ? <><span className="green-accent">Анализ...</span> <span style={{color:'#666',fontSize:'11px'}}>({preFilteredCoins.length-analyzingCount}/{preFilteredCoins.length})</span></>
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
            <select className="global-tf-select" value={activeTab.globalTf} onChange={e=>setTabs(tabs.map(t=>t.id===activeTabId?{...t,globalTf:e.target.value}:t))}>
              {timeframes.map(tf=><option key={tf} value={tf}>{tf}</option>)}
            </select>
            <button className="refresh-btn" onClick={fetchMarket}>Обновить</button>
          </div>
        </div>

        {/* Фильтры */}
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

      {viewMode==='list' && (
        <CoinList
          coins={listShowAll ? allCoins : filteredCoins}
          defaultSort={listShowAll ? 'change' : 'volume'}
          exchange={activeExchange}
          watchlist={watchlist}
          onToggleWatch={toggleWatch}
          selectedStarColor={selectedStarColor}
          filters={activeFilters}
          btcMap={btcMap}
          globalTf={activeTab.globalTf}
        />
      )}

      {viewMode==='watchlist' && watchlistCoins.length===0 && (
        <div className="empty-watchlist">
          <div style={{color:'#f0c040',fontSize:48}}>★</div>
          <div>Нет избранных монет</div>
          <div>{watchColorFilter ? `Нет монет с цветом «${STAR_COLORS.find(c=>c.key===watchColorFilter)?.label}»` : 'В режиме списка нажми ★ рядом с монетой'}</div>
        </div>
      )}

      {(viewMode==='charts'||viewMode==='watchlist') && (
        <div className="grid-scroll">
          <div className="grid-box">
          {displayCoins.map(c=>(
            <VirtualChartCard
              key={`${activeExchange}-${c.symbol}`}
              symbol={c.symbol}
              marketStats={c}
              globalTf={activeTab.globalTf}
              filters={activeFilters}
              btcMap={btcMap}
              exchange={activeExchange}
              precomputedStats={statsMap[c.symbol]||null}
              watchlist={watchlist}
              onToggleWatch={toggleWatch}
              selectedStarColor={selectedStarColor}
            />
          ))}
        </div>
        </div>
      )}

      {/* Порталы — рендерятся поверх всего в document.body */}
      {watchDropOpen && ReactDOM.createPortal(
        <div className="watch-color-dropdown portal-dropdown" style={{top:watchDropPos.top, left:watchDropPos.left, transform:'translateX(-50%)'}}
          onMouseDown={e=>e.stopPropagation()}>
          <button className={`watch-color-opt ${!watchColorFilter?'active':''}`} onClick={()=>{setWatchColorFilter(null);setWatchDropOpen(false);}}>
            Все
          </button>
          {STAR_COLORS.map(sc=>(
            <button key={sc.key} className={`watch-color-opt ${watchColorFilter===sc.key?'active':''}`}
              onClick={()=>{setWatchColorFilter(sc.key);setWatchDropOpen(false);}}>
              <span style={{color:sc.hex,fontSize:15}}>★</span>
            </button>
          ))}
          <div className="watch-drop-divider"/>
          <button className="watch-color-opt watch-clear-opt" onClick={()=>{clearWatchlist();setWatchDropOpen(false);}}>✕</button>
        </div>,
        document.body
      )}

      {starColorOpen && ReactDOM.createPortal(
        <div className="star-color-dropdown portal-dropdown" style={{top:starColorPos.top, left:starColorPos.left}}
          onMouseDown={e=>e.stopPropagation()}>
          {STAR_COLORS.map(sc=>(
            <button key={sc.key}
              className={`star-color-opt2 ${selectedStarColor===sc.key?'active':''}`}
              onClick={()=>{setSelectedStarColor(sc.key);setStarColorOpen(false);}}
              title={sc.label}
            ><span style={{color:sc.hex,fontSize:18}}>★</span></button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

export default App;