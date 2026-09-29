/* ══════════════════════════════════════════════════════════
   OS Monitor Dashboard  —  dashboard.js  v2.0
   Real Mac system data via /api/stats  +  interactive UI
   ══════════════════════════════════════════════════════════ */
'use strict';

/* ─────────────────────────────────────────────────────────
   1. BACKGROUND PARTICLES
───────────────────────────────────────────────────────── */
(function spawnParticles() {
  const container = document.getElementById('bgParticles');
  if (!container) return;
  for (let i = 0; i < 40; i++) {
    const p = document.createElement('div');
    p.className = 'bg-particle';
    p.style.cssText = `
      left:${Math.random()*100}%;top:${Math.random()*100}%;
      width:${Math.random()<0.3?3:2}px;height:${Math.random()<0.3?3:2}px;
      opacity:${0.15+Math.random()*0.4};
      background:${Math.random()<0.5?'#6366f1':'#06b6d4'};
      animation-duration:${10+Math.random()*22}s;
      animation-delay:-${Math.random()*22}s;
    `;
    container.appendChild(p);
  }
})();

/* ─────────────────────────────────────────────────────────
   2. STATE
───────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

// History buffers for sparklines/charts
const HIST_LEN = 50;
let cpuHistory  = new Array(HIST_LEN).fill(0);
let netUpHist   = new Array(HIST_LEN).fill(0);
let netDnHist   = new Array(HIST_LEN).fill(0);
let cpuPerCore  = [];          // per-core bars

let sortKey   = 'cpu';
let isPaused  = false;
let darkMode  = true;
let apiOnline = false;         // true once first API response arrives

// Sim fallback (used if API unreachable)
const sim = {
  cpuPct:35, memTotal:16, memUsed:8.2, memCache:1.8,
  diskPct:55, diskTotal:512, diskRead:8, diskWrite:3,
  netUp:350, netDn:1100, netSentMB:120, netRecvMB:840,
  load1:1.1, load5:0.9, load15:0.7, uptime:43200, procs:312
};

const SIM_PROCS = [
  {name:'chrome',        pid:1234, state:'running',  threads:42, cpu:22.4, mem:4.1},
  {name:'node',          pid:5678, state:'running',  threads:12, cpu:14.8, mem:2.3},
  {name:'python3',       pid:8910, state:'sleeping', threads:4,  cpu:6.2,  mem:1.1},
  {name:'code',          pid:2233, state:'running',  threads:28, cpu:5.1,  mem:3.8},
  {name:'system_server', pid:1001, state:'sleeping', threads:65, cpu:2.9,  mem:0.9},
  {name:'dockerd',       pid:3344, state:'waiting',  threads:18, cpu:1.7,  mem:0.5},
  {name:'ffmpeg',        pid:7788, state:'running',  threads:8,  cpu:1.2,  mem:0.3},
  {name:'postgres',      pid:4455, state:'sleeping', threads:10, cpu:0.8,  mem:0.7},
];

function smoothRandom(v, min, max, step=6) {
  return Math.max(min, Math.min(max, v + (Math.random()-0.5)*step*2));
}

/* ─────────────────────────────────────────────────────────
   3. API FETCH
───────────────────────────────────────────────────────── */
async function fetchStats() {
  try {
    const res = await fetch('/api/stats', { cache: 'no-store' });
    if (!res.ok) throw new Error('non-200');
    apiOnline = true;
    setApiStatus(true);
    return await res.json();
  } catch {
    setApiStatus(false);
    return null;
  }
}

function setApiStatus(online) {
  const badge  = $('liveBadge');
  const apiLbl = $('apiLabel');
  if (!badge || !apiLbl) return;
  if (online) {
    badge.classList.remove('offline');
    apiLbl.textContent = 'LIVE · REAL DATA';
  } else {
    badge.classList.add('offline');
    apiLbl.textContent = 'SIMULATED DATA';
  }
}

/* ─────────────────────────────────────────────────────────
   4. CLOCK  (fixes the "not showing" bug — guaranteed DOM-ready)
───────────────────────────────────────────────────────── */
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2,'0');
  const mm = String(now.getMinutes()).padStart(2,'0');
  const ss = String(now.getSeconds()).padStart(2,'0');
  const timeStr = `${hh}:${mm}:${ss}`;
  const dateStr = `${DAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;

  // Safe set — always works even if some elements missing
  const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  set('headerClock', timeStr);
  set('clockTime',   timeStr);
  set('clockDate',   dateStr);
  set('locDay',      DAYS[now.getDay()]);

  const tz     = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  const offset = -now.getTimezoneOffset();
  const sign   = offset >= 0 ? '+' : '-';
  const tzH    = String(Math.floor(Math.abs(offset)/60)).padStart(2,'0');
  const tzM    = String(Math.abs(offset)%60).padStart(2,'0');
  set('clockTZ',  tz);
  set('locTZ',    tz);
  set('locUTC',   `UTC${sign}${tzH}:${tzM}`);
  set('locLocale',navigator.language || 'en-IN');

  drawAnalogClock(now);
}

/* ─────────────────────────────────────────────────────────
   5. ANALOG CLOCK CANVAS
───────────────────────────────────────────────────────── */
function drawAnalogClock(now) {
  const canvas = $('analogClock');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W/2, cy = H/2, r = W/2 - 8;
  ctx.clearRect(0,0,W,H);

  // Face
  const fg = ctx.createRadialGradient(cx,cy,2,cx,cy,r);
  fg.addColorStop(0,'rgba(30,25,60,0.9)');
  fg.addColorStop(1,'rgba(8,8,24,0.95)');
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
  ctx.fillStyle=fg; ctx.fill();
  ctx.strokeStyle='rgba(168,85,247,0.45)'; ctx.lineWidth=1.5; ctx.stroke();

  // Ticks
  for(let i=0;i<60;i++){
    const a=(i/60)*Math.PI*2-Math.PI/2;
    const isHour = i%5===0;
    const inner = isHour ? r-13 : r-7;
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(a)*inner, cy+Math.sin(a)*inner);
    ctx.lineTo(cx+Math.cos(a)*(r-3), cy+Math.sin(a)*(r-3));
    ctx.strokeStyle = isHour ? 'rgba(168,85,247,0.8)' : 'rgba(148,163,184,0.2)';
    ctx.lineWidth = isHour ? 2 : 1;
    ctx.stroke();
  }

  const sec  = now.getSeconds()+ now.getMilliseconds()/1000;
  const min  = now.getMinutes()+ sec/60;
  const hour = (now.getHours()%12)+ min/60;

  function hand(angle,len,w,color,glow){
    const x=cx+Math.cos(angle-Math.PI/2)*len, y=cy+Math.sin(angle-Math.PI/2)*len;
    ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(x,y);
    ctx.strokeStyle=color; ctx.lineWidth=w; ctx.lineCap='round';
    if(glow){ctx.shadowBlur=10;ctx.shadowColor=color;}
    ctx.stroke(); ctx.shadowBlur=0;
  }
  hand((hour/12)*Math.PI*2, r*0.50, 3.5,'#c084fc');
  hand((min/60)*Math.PI*2,  r*0.70, 2.5,'#818cf8');
  hand((sec/60)*Math.PI*2,  r*0.82, 1.5,'#06b6d4', true);
  // Center cap
  ctx.beginPath(); ctx.arc(cx,cy,5,0,Math.PI*2);
  ctx.fillStyle='#c084fc'; ctx.fill();
}

/* ─────────────────────────────────────────────────────────
   6. DONUT CHART
───────────────────────────────────────────────────────── */
function drawDonut(canvasId, pct, colors, size=140) {
  const canvas = $(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W=canvas.width, H=canvas.height;
  const cx=W/2, cy=H/2, outer=(size/2)-6, inner=outer*0.62;
  const start=-Math.PI/2;
  ctx.clearRect(0,0,W,H);
  // BG ring
  ctx.beginPath();
  ctx.arc(cx,cy,outer,0,Math.PI*2); ctx.arc(cx,cy,inner,Math.PI*2,0,true);
  ctx.fillStyle='rgba(255,255,255,0.04)'; ctx.fill();
  // Used
  if(pct>0){
    const angle=(pct/100)*(Math.PI*2-0.03);
    const gr=ctx.createLinearGradient(0,0,W,H);
    gr.addColorStop(0,colors[0]); gr.addColorStop(1,colors[1]);
    ctx.beginPath();
    ctx.arc(cx,cy,outer,start,start+angle);
    ctx.arc(cx,cy,inner,start+angle,start,true);
    ctx.fillStyle=gr;
    ctx.shadowBlur=14; ctx.shadowColor=colors[0];
    ctx.fill(); ctx.shadowBlur=0;
  }
}

function drawMemDonut(canvasId, mem, size=140) {
  const canvas = $(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W=canvas.width, H=canvas.height;
  const cx=W/2, cy=H/2, outer=(size/2)-6, inner=outer*0.62;
  ctx.clearRect(0,0,W,H);
  
  // BG ring
  ctx.beginPath();
  ctx.arc(cx,cy,outer,0,Math.PI*2); ctx.arc(cx,cy,inner,Math.PI*2,0,true);
  ctx.fillStyle='rgba(255,255,255,0.04)'; ctx.fill();

  const total = mem.total_gb;
  if (!total) return;

  const gap = 0.03;
  let start = -Math.PI/2;

  const segments = [
    { val: mem.wired_gb,      color: '#f43f5e' }, // rose
    { val: mem.active_gb,     color: '#f59e0b' }, // amber
    { val: mem.inactive_gb,   color: '#3b82f6' }, // blue
    { val: mem.compressed_gb, color: '#06b6d4' }  // cyan
  ];

  segments.forEach(seg => {
    if (!seg.val || seg.val <= 0) return;
    const angle = (seg.val / total) * (Math.PI*2 - gap*segments.length);
    if (angle <= 0) return;
    
    ctx.beginPath();
    ctx.arc(cx,cy,outer,start,start+angle);
    ctx.arc(cx,cy,inner,start+angle,start,true);
    ctx.fillStyle = seg.color;
    ctx.fill();
    
    start += angle + gap;
  });
}

/* ─────────────────────────────────────────────────────────
   7. SPARKLINE
───────────────────────────────────────────────────────── */
function drawSparkline(canvasId, data, c1, c2) {
  const canvas=$(canvasId); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  const W=canvas.width, H=canvas.height;
  ctx.clearRect(0,0,W,H);
  const max=Math.max(...data,1);
  const pts=data.map((v,i)=>[(i/(data.length-1))*W, H-(v/max)*(H-4)-2]);
  const gr=ctx.createLinearGradient(0,0,0,H);
  gr.addColorStop(0,c1+'3a'); gr.addColorStop(1,c1+'00');
  ctx.beginPath(); ctx.moveTo(pts[0][0],H);
  pts.forEach(([x,y])=>ctx.lineTo(x,y));
  ctx.lineTo(pts[pts.length-1][0],H); ctx.closePath();
  ctx.fillStyle=gr; ctx.fill();
  const lg=ctx.createLinearGradient(0,0,W,0);
  lg.addColorStop(0,c1); lg.addColorStop(1,c2||c1);
  ctx.beginPath(); pts.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));
  ctx.strokeStyle=lg; ctx.lineWidth=2; ctx.lineJoin='round'; ctx.stroke();
}

/* ─────────────────────────────────────────────────────────
   8. NETWORK DUAL CHART
───────────────────────────────────────────────────────── */
function drawNetChart() {
  const canvas=$('netCanvas'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  const W=canvas.width, H=canvas.height;
  ctx.clearRect(0,0,W,H);
  const maxVal=Math.max(...netUpHist,...netDnHist,1);

  function series(data,color,flip){
    const pts=data.map((v,i)=>[(i/(data.length-1))*W, H/2-(v/maxVal)*(H/2-4)*(flip?-1:1)]);
    const gr=ctx.createLinearGradient(0,0,0,H);
    gr.addColorStop(flip?1:0, color+'55');
    gr.addColorStop(flip?0:1, color+'05');
    ctx.beginPath(); ctx.moveTo(pts[0][0],H/2);
    pts.forEach(([x,y])=>ctx.lineTo(x,y));
    ctx.lineTo(pts[pts.length-1][0],H/2);
    ctx.closePath(); ctx.fillStyle=gr; ctx.fill();
    ctx.beginPath(); pts.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));
    ctx.strokeStyle=color; ctx.lineWidth=1.8; ctx.lineJoin='round'; ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2);
  ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.lineWidth=1; ctx.stroke();
  series(netUpHist,'#10b981',false);
  series(netDnHist,'#06b6d4',true);
}

/* ─────────────────────────────────────────────────────────
   9. PER-CORE BARS  (interactive — click to highlight)
───────────────────────────────────────────────────────── */
function renderCoreGrid(cores) {
  const grid=$('coreGrid'); if(!grid) return;
  if(grid.children.length !== cores.length) {
    grid.innerHTML = cores.map((_,i)=>`
      <div class="core-item" id="core-${i}" title="Core ${i}">
        <div class="core-label">C${i}</div>
        <div class="core-bar-wrap">
          <div class="core-bar" id="corebar-${i}"></div>
        </div>
        <div class="core-val" id="coreval-${i}">0%</div>
      </div>
    `).join('');
  }
  cores.forEach((pct,i)=>{
    const bar=$(`corebar-${i}`), val=$(`coreval-${i}`);
    if(!bar||!val) return;
    bar.style.width=Math.min(pct,100)+'%';
    bar.style.background = pct>80?'linear-gradient(90deg,#f43f5e,#fb923c)'
                         : pct>60?'linear-gradient(90deg,#f59e0b,#facc15)'
                         :        'linear-gradient(90deg,#6366f1,#06b6d4)';
    val.textContent=pct.toFixed(0)+'%';
  });
}

/* ─────────────────────────────────────────────────────────
   10. PROCESS TABLE
───────────────────────────────────────────────────────── */
const STATE_CLASS = {
  running:'state-running', sleeping:'state-sleeping',
  waiting:'state-waiting', stopped:'state-stopped', zombie:'state-zombie'
};
const BAR_COLORS = [
  'linear-gradient(90deg,#f59e0b,#fb923c)',
  'linear-gradient(90deg,#94a3b8,#cbd5e1)',
  'linear-gradient(90deg,#b87333,#d4a96a)',
  'linear-gradient(90deg,#6366f1,#818cf8)',
  'linear-gradient(90deg,#06b6d4,#38bdf8)',
];

let selectedPid = null;

function renderProcessTable(procs) {
  const sorted = [...procs].sort((a,b)=>{
    if(sortKey==='cpu') return b.cpu-a.cpu;
    if(sortKey==='mem') return b.mem-a.mem;
    return a.pid-b.pid;
  }).slice(0,5);

  $('procTbody').innerHTML = sorted.map((p,i)=>`
    <tr class="proc-row ${selectedPid===p.pid?'selected':''}"
        data-pid="${p.pid}" style="animation-delay:${i*0.06}s">
      <td><div class="proc-rank rank-${i+1}">${i+1}</div></td>
      <td><span class="proc-pid">${p.pid}</span></td>
      <td><span class="proc-name">${p.name}</span></td>
      <td>
        <span class="state-badge ${STATE_CLASS[p.state]||'state-sleeping'}">
          <span class="state-dot"></span>${p.state}
        </span>
      </td>
      <td>
        <span class="proc-cpu-val ${p.cpu>50?'hot':''}">${p.cpu.toFixed(1)}%</span>
      </td>
      <td><span class="proc-mem-val">${p.mem.toFixed(2)}%</span></td>
      <td><span class="proc-thr-val">${p.threads}</span></td>
      <td>
        <div class="proc-cpu-bar-wrap">
          <div class="proc-cpu-bar" style="width:${Math.min(p.cpu,100)}%;background:${BAR_COLORS[i]}"></div>
        </div>
      </td>
    </tr>
  `).join('');

  // Row click → highlight
  document.querySelectorAll('.proc-row').forEach(row=>{
    row.addEventListener('click',()=>{
      const pid=+row.dataset.pid;
      selectedPid = selectedPid===pid ? null : pid;
      renderProcessTable(procs);
    });
  });
}

/* ─────────────────────────────────────────────────────────
   11. CPU USAGE COLOR-CODING
───────────────────────────────────────────────────────── */
function cpuBarColor(pct) {
  if(pct>80) return 'linear-gradient(90deg,#f43f5e,#fb923c)';
  if(pct>60) return 'linear-gradient(90deg,#f59e0b,#facc15)';
  return 'linear-gradient(90deg,#6366f1,#06b6d4)';
}

/* ─────────────────────────────────────────────────────────
   12. UPTIME FORMATTER
───────────────────────────────────────────────────────── */
function fmtUptime(sec) {
  const d=Math.floor(sec/86400), h=Math.floor((sec%86400)/3600);
  const m=Math.floor((sec%3600)/60), s=sec%60;
  return `${d}d ${h}h ${m}m ${s}s`;
}

/* ─────────────────────────────────────────────────────────
   13. RENDER WITH REAL DATA
───────────────────────────────────────────────────────── */
function renderReal(data) {
  const set=(id,v)=>{const e=$(id);if(e)e.textContent=v;};
  const cpu=data.cpu, mem=data.memory, dsk=data.disk,
        net=data.network, ld=data.load, os=data.os;

  // ── CPU card ──
  set('cpuName',    cpu.brand);
  set('cpuISA',     `ISA: ${cpu.isa}`);
  set('cpuCores',   cpu.physical_cores);
  set('cpuThreads', cpu.logical_cores);
  if(cpu.freq_max_mhz)
    set('cpuFreq', cpu.freq_max_mhz>=1000 ? (cpu.freq_max_mhz/1000).toFixed(2)+' GHz' : cpu.freq_max_mhz+' MHz');
  set('cpuBits', cpu.bits);
  if(cpu.cache_l2) set('cpuL2', `L2: ${cpu.cache_l2>=1024?`${(cpu.cache_l2/1024).toFixed(1)} MB`:`${cpu.cache_l2} KB`}`);
  if(cpu.cache_l3) set('cpuL3', `L3: ${cpu.cache_l3>=1024?`${(cpu.cache_l3/1024).toFixed(1)} MB`:`${cpu.cache_l3} KB`}`);

  const cpuPct = cpu.usage_total;
  set('cpuUsageVal', cpuPct.toFixed(1)+'%');
  const bar=$('cpuBar');
  if(bar){bar.style.width=cpuPct+'%';bar.style.background=cpuBarColor(cpuPct);}
  cpuHistory.push(cpuPct); if(cpuHistory.length>HIST_LEN) cpuHistory.shift();
  drawSparkline('cpuSparkline', cpuHistory,'#6366f1','#06b6d4');

  // Per-core grid
  if(cpu.usage_per_core&&cpu.usage_per_core.length) {
    cpuPerCore = cpu.usage_per_core;
    renderCoreGrid(cpuPerCore);
  }

  // ── Memory card (macOS Activity Monitor accurate) ──
  const memPct = mem.percent;
  set('memPct',        memPct.toFixed(0)+'%');
  set('memWired',      (mem.wired_gb     || 0).toFixed(2)+' GB');
  set('memActive',     (mem.active_gb    || 0).toFixed(2)+' GB');
  set('memInactive',   (mem.inactive_gb  || 0).toFixed(2)+' GB');
  set('memCompressed', (mem.compressed_gb|| 0).toFixed(2)+' GB');
  set('memFree',       (mem.free_gb      || 0).toFixed(2)+' GB');
  set('memTotal',      (mem.total_gb     || 0).toFixed(1)+' GB');
  set('swapUsed',      `${(mem.swap_used_gb||0).toFixed(1)} / ${(mem.swap_total_gb||0).toFixed(1)} GB (${(mem.swap_pct||0).toFixed(0)}%)`);
  drawMemDonut('memDonut', mem);

  // ── Disk card ──
  set('diskPct',   dsk.pct.toFixed(0)+'%');
  set('diskRead',  dsk.read_mb_s.toFixed(1)+' MB/s');
  set('diskWrite', dsk.write_mb_s.toFixed(1)+' MB/s');
  set('diskFreeGb',`${dsk.free_gb} GB free of ${dsk.total_gb} GB`);
  drawDonut('diskDonut', dsk.pct,['#f59e0b','#f43f5e'],110);

  // ── Network card ──
  const upKB=net.sent_kb_s, dnKB=net.recv_kb_s;
  set('netUp', upKB>1000?(upKB/1024).toFixed(2)+' MB/s':upKB.toFixed(0)+' KB/s');
  set('netDn', dnKB>1000?(dnKB/1024).toFixed(2)+' MB/s':dnKB.toFixed(0)+' KB/s');
  set('netSent', net.total_sent_mb.toFixed(1)+' MB');
  set('netRecv', net.total_recv_mb.toFixed(1)+' MB');
  netUpHist.push(upKB); if(netUpHist.length>HIST_LEN) netUpHist.shift();
  netDnHist.push(dnKB); if(netDnHist.length>HIST_LEN) netDnHist.shift();
  drawNetChart();

  // ── Load card ──
  const cores=cpu.physical_cores||4;
  [['load1Val','load1Bar',ld.load1],
   ['load5Val','load5Bar',ld.load5],
   ['load15Val','load15Bar',ld.load15]].forEach(([valId,barId,val])=>{
    set(valId, val.toFixed(2));
    const b=$(barId);
    if(b) b.style.width=Math.min(val/cores*100,100)+'%';
  });

  // ── OS info ──
  set('osName',    os.os);
  set('kernelVer', `${os.kernel} (${os.machine})`);
  set('shellName', os.node);

  // ── Locality Benchmark (Array Access) ──
  if (data.locality) {
    set('locRawOutput', data.locality.raw_output);
  }

  // ── Processes ──
  renderProcessTable(data.processes);
  set('procTotal',  `Total processes: ${data.total_procs}`);
  set('procUptime', `Uptime: ${fmtUptime(data.uptime_sec)}`);
  set('sysUptime',  `Uptime: ${fmtUptime(data.uptime_sec)}`);
  set('footerUptime',`System Uptime: ${fmtUptime(data.uptime_sec)}`);
}

/* ─────────────────────────────────────────────────────────
   14. RENDER SIMULATED DATA (fallback)
───────────────────────────────────────────────────────── */
function renderSim() {
  const set=(id,v)=>{const e=$(id);if(e)e.textContent=v;};
  const ua=navigator.userAgent;
  const isa=/arm|aarch64/i.test(ua)||ua.includes('Apple')?'ARM64 (AArch64)':'x86-64 (AMD64)';
  const cpu=/arm|Apple/i.test(ua)?'Apple M2 Pro':'Intel Core i7-12700H';
  const cores=navigator.hardwareConcurrency||8;

  set('cpuName', cpu); set('cpuISA','ISA: '+isa);
  set('cpuCores',cores); set('cpuThreads',cores*2);
  set('cpuFreq',/arm/i.test(ua)||ua.includes('Apple')?'3.49 GHz':'2.80 GHz');
  set('cpuBits','64-bit');

  sim.cpuPct=smoothRandom(sim.cpuPct,5,90,5);
  cpuHistory.push(sim.cpuPct); if(cpuHistory.length>HIST_LEN) cpuHistory.shift();
  set('cpuUsageVal',sim.cpuPct.toFixed(1)+'%');
  const bar=$('cpuBar');
  if(bar){bar.style.width=sim.cpuPct+'%';bar.style.background=cpuBarColor(sim.cpuPct);}
  drawSparkline('cpuSparkline',cpuHistory,'#6366f1','#06b6d4');

  // sim per-core
  if(!cpuPerCore.length) cpuPerCore=new Array(cores).fill(0).map(()=>Math.random()*60+5);
  cpuPerCore=cpuPerCore.map(v=>smoothRandom(v,2,95,6));
  renderCoreGrid(cpuPerCore);

  sim.memUsed=smoothRandom(sim.memUsed,4,12,0.2);
  sim.memCache=smoothRandom(sim.memCache,1,4,0.1);
  const memFree=Math.max(0,sim.memTotal-sim.memUsed-sim.memCache);
  const memPct=(sim.memUsed/sim.memTotal)*100;
  set('memPct',memPct.toFixed(0)+'%');
  set('memUsed',sim.memUsed.toFixed(1)+' GB');
  set('memFree',memFree.toFixed(1)+' GB');
  set('memCache',sim.memCache.toFixed(1)+' GB');
  set('memTotal',sim.memTotal.toFixed(0)+' GB');
  set('swapUsed','0.0 / 0 GB'); set('swapPct','0%');
  drawDonut('memDonut',memPct,['#06b6d4','#6366f1']);

  sim.diskRead=smoothRandom(sim.diskRead,0.1,60,4);
  sim.diskWrite=smoothRandom(sim.diskWrite,0.1,30,3);
  set('diskPct',sim.diskPct.toFixed(0)+'%');
  set('diskRead',sim.diskRead.toFixed(1)+' MB/s');
  set('diskWrite',sim.diskWrite.toFixed(1)+' MB/s');
  set('diskFreeGb',`${(sim.diskTotal*(1-sim.diskPct/100)).toFixed(0)} GB free of ${sim.diskTotal} GB`);
  drawDonut('diskDonut',sim.diskPct,['#f59e0b','#f43f5e'],110);

  sim.netUp=smoothRandom(sim.netUp,10,2000,150);
  sim.netDn=smoothRandom(sim.netDn,50,6000,300);
  netUpHist.push(sim.netUp); if(netUpHist.length>HIST_LEN) netUpHist.shift();
  netDnHist.push(sim.netDn); if(netDnHist.length>HIST_LEN) netDnHist.shift();
  set('netUp',sim.netUp>1000?(sim.netUp/1024).toFixed(2)+' MB/s':sim.netUp.toFixed(0)+' KB/s');
  set('netDn',sim.netDn>1000?(sim.netDn/1024).toFixed(2)+' MB/s':sim.netDn.toFixed(0)+' KB/s');
  drawNetChart();

  sim.load1=smoothRandom(sim.load1,0.1,3.5,0.12);
  sim.load5=sim.load1*0.85+Math.random()*0.05;
  sim.load15=sim.load5*0.80+Math.random()*0.05;
  [['load1Val','load1Bar',sim.load1],['load5Val','load5Bar',sim.load5],
   ['load15Val','load15Bar',sim.load15]].forEach(([vi,bi,val])=>{
    set(vi,val.toFixed(2));
    const b=$(bi); if(b) b.style.width=Math.min(val/cores*100,100)+'%';
  });
  set('osName',/Win/i.test(navigator.userAgent)?'Windows 11 Pro':
               /Mac/i.test(navigator.userAgent)?'macOS Sequoia 15.2':'Ubuntu 24.04 LTS');
  set('kernelVer','—'); set('shellName','—');

  SIM_PROCS.forEach(p=>{p.cpu=smoothRandom(p.cpu,0.1,55,4);p.mem=smoothRandom(p.mem,0.1,10,0.8);});
  renderProcessTable(SIM_PROCS);
  sim.uptime++;
  set('procUptime',`Uptime: ${fmtUptime(sim.uptime)}`);
  set('footerUptime',`System Uptime: ${fmtUptime(sim.uptime)}`);
  set('procTotal',`Total processes: ${sim.procs}`);
}

/* ─────────────────────────────────────────────────────────
   15. MAIN TICK
───────────────────────────────────────────────────────── */
async function tick() {
  if(isPaused) return;
  const data = await fetchStats();
  if(data) renderReal(data);
  else renderSim();
}

/* ─────────────────────────────────────────────────────────
   16. INTERACTIVE CONTROLS
───────────────────────────────────────────────────────── */
function setupControls() {
  // Sort buttons
  document.querySelectorAll('.sort-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.sort-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      sortKey=btn.dataset.sort;
    });
  });

  // Refresh button
  const rfBtn=$('refreshBtn');
  if(rfBtn) rfBtn.addEventListener('click',function(){
    this.classList.add('spinning');
    tick().then(()=>setTimeout(()=>this.classList.remove('spinning'),600));
  });

  // Theme Toggle button
  const themeBtn=$('themeBtn');
  const sunIcon = `<svg class="theme-icon sun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
  const moonIcon = `<svg class="theme-icon moon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  
  if(themeBtn) themeBtn.addEventListener('click', function() {
    darkMode = !darkMode;
    document.body.classList.toggle('light-theme', !darkMode);
    this.innerHTML = darkMode ? sunIcon : moonIcon;
    if (!isPaused) tick();
  });

  // Pause/Resume button
  const pauseBtn=$('pauseBtn');
  if(pauseBtn) pauseBtn.addEventListener('click',function(){
    isPaused=!isPaused;
    this.textContent=isPaused?'▶ Resume':'⏸ Pause';
    this.classList.toggle('paused',isPaused);
  });

  // Card hover glow effects
  document.querySelectorAll('.stat-card').forEach(card=>{
    card.addEventListener('mousemove',e=>{
      const rect=card.getBoundingClientRect();
      const x=((e.clientX-rect.left)/rect.width)*100;
      const y=((e.clientY-rect.top)/rect.height)*100;
      card.style.setProperty('--mx',x+'%');
      card.style.setProperty('--my',y+'%');
    });
  });

  // Core grid click to expand
  const coreToggle=$('coreToggle');
  const coreSection=$('coreSection');
  if(coreToggle&&coreSection){
    coreToggle.addEventListener('click',()=>{
      coreSection.classList.toggle('expanded');
      coreToggle.textContent=coreSection.classList.contains('expanded')?'▲ Hide Cores':'▼ Per-Core Usage';
    });
  }
}

/* ─────────────────────────────────────────────────────────
   17. TOOLTIP ON PROCESS ROWS
───────────────────────────────────────────────────────── */
function initTooltip() {
  const tip = document.createElement('div');
  tip.id='procTooltip'; tip.className='proc-tooltip';
  document.body.appendChild(tip);

  document.addEventListener('mouseover', e=>{
    const row=e.target.closest('.proc-row');
    if(!row) { tip.style.opacity='0'; return; }
    const pid=row.dataset.pid;
    tip.innerHTML=`<b>PID ${pid}</b> — click to highlight row`;
    tip.style.opacity='1';
  });
  document.addEventListener('mousemove', e=>{
    tip.style.left=(e.clientX+14)+'px';
    tip.style.top=(e.clientY-10)+'px';
  });
  document.addEventListener('mouseout', e=>{
    if(!e.target.closest('.proc-row')) tip.style.opacity='0';
  });
}

/* ─────────────────────────────────────────────────────────
   18. INIT
───────────────────────────────────────────────────────── */
function init() {
  setupControls();
  initTooltip();
  updateClock();
  tick();                            // immediate first fetch
  setInterval(updateClock, 1000);   // clock every second
  setInterval(tick,       2000);    // data every 2s
}

// Guarantee DOM is ready before running
if(document.readyState==='loading')
  document.addEventListener('DOMContentLoaded', init);
else
  init();
