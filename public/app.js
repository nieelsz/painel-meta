/* Painel de anúncios — frontend */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');
const TZ = 'America/Sao_Paulo';

// ---------- utilidades ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brlF = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brl = n => brlF.format(n || 0);
const num = (n, d = 0) => (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x, d = 1) => `${num((x || 0) * 100, d)}%`;
const cls = n => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body });
  if (r.status === 401) { location.href = '/login.html'; throw new Error('sessão expirada'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Erro ${r.status}`);
  return j;
}
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`; el.textContent = msg;
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), 4500);
}
function modal({ title, body, confirm = 'Confirmar', danger = false, onOpen, onConfirm }) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h3>${title}</h3><div class="mbody">${body || ''}</div>
    <div class="actions"><button class="btn ghost" data-x>Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${confirm}</button></div></div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target === bg || e.target.hasAttribute('data-x')) close(); });
  const ok = $('[data-ok]', bg);
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    try { if ((await onConfirm(bg)) !== false) close(); } catch (e) { toast(e.message, 'err'); } finally { ok.disabled = false; }
  });
  if (onOpen) onOpen(bg);
  return bg;
}
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copiado!'); } catch { toast('Não foi possível copiar', 'err'); } }

// ---------- período ----------
function todayStr() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
function addDays(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const PERIODS = { today: 'Hoje', yesterday: 'Ontem', '7d': 'Últimos 7 dias', '30d': 'Últimos 30 dias', month: 'Este mês', lastmonth: 'Mês passado', custom: 'Personalizado' };
function periodRange() {
  const t = todayStr();
  switch (S.period) {
    case 'yesterday': return { from: addDays(t, -1), to: addDays(t, -1) };
    case '7d': return { from: addDays(t, -6), to: t };
    case '30d': return { from: addDays(t, -29), to: t };
    case 'month': return { from: t.slice(0, 8) + '01', to: t };
    case 'lastmonth': { const first = t.slice(0, 8) + '01'; const end = addDays(first, -1); return { from: end.slice(0, 8) + '01', to: end }; }
    case 'custom': return { from: S.from || t, to: S.to || t };
    default: return { from: t, to: t };
  }
}

// estado (persistido)
const S = Object.assign({ period: 'today', operation: '', account: '', product: '', from: '', to: '' }, JSON.parse(localStorage.getItem('painel') || '{}'));
const save = () => localStorage.setItem('painel', JSON.stringify({ period: S.period, operation: S.operation, account: S.account, product: S.product, from: S.from, to: S.to }));
const G = { accounts: [], operations: [], products: [], config: {} };
async function loadGlobals() {
  [G.accounts, G.operations, G.products, G.config] = await Promise.all([api('/api/meta/accounts'), api('/api/operations'), api('/api/products'), api('/api/config')]);
  $('#demo').hidden = !G.config.demo;
}

function periodFields() {
  return `<label class="field">Período
      <div class="seg" id="f-period" role="group">${Object.entries(PERIODS).map(([k, v]) => `<button type="button" data-p="${k}" class="${S.period === k ? 'active' : ''}">${v.replace('Últimos ', '')}</button>`).join('')}</div></label>
    <label class="field" ${S.period === 'custom' ? '' : 'hidden'} id="f-cust1">De<input class="input" type="date" id="f-from" value="${S.from || todayStr()}"></label>
    <label class="field" ${S.period === 'custom' ? '' : 'hidden'} id="f-cust2">Até<input class="input" type="date" id="f-to" value="${S.to || todayStr()}"></label>`;
}
function bindPeriod(reload) {
  $$('#f-period button').forEach(b => b.onclick = () => {
    S.period = b.dataset.p; $$('#f-period button').forEach(x => x.classList.toggle('active', x === b));
    $('#f-cust1').hidden = $('#f-cust2').hidden = S.period !== 'custom'; save(); reload();
  });
  $('#f-from').onchange = e => { S.from = e.target.value; save(); reload(); };
  $('#f-to').onchange = e => { S.to = e.target.value; save(); reload(); };
}
const accountOptions = (sel, allLabel = 'Todas') => `<option value="">${allLabel}</option>` +
  G.accounts.filter(a => a.enabled).map(a => `<option value="${esc(a.id)}" ${sel === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('');

// ---------- gráficos ----------
let charts = [];
function chart(el) { const c = echarts.init(el, null, { renderer: 'canvas' }); charts.push(c); return c; }
function disposeCharts() { charts.forEach(c => c.dispose()); charts = []; }
window.addEventListener('resize', () => charts.forEach(c => c.resize()));
const AX = { axisLine: { lineStyle: { color: '#1f2c4b' } }, axisLabel: { color: '#8a9bc2', fontFamily: 'Manrope', fontWeight: 600 }, splitLine: { lineStyle: { color: 'rgba(120,150,220,.09)' } } };
const TT = { backgroundColor: '#15223f', borderColor: 'rgba(120,150,220,.25)', borderRadius: 10, padding: [8, 12], textStyle: { color: '#eaf0ff', fontFamily: 'Manrope' }, extraCssText: 'box-shadow:0 10px 30px rgba(0,0,0,.4)' };
let brMap = null;
async function ensureMap() {
  if (brMap) return;
  brMap = await fetch('/vendor/brazil-states.json').then(r => r.json());
  echarts.registerMap('BR', brMap);
}

// ---------- roteador ----------
let current = null; let timer = null; let lastUpdate = null;
const ROUTES = {
  resumo: { title: 'Resumo', render: renderDashboard },
  meta: { title: 'Meta Ads', render: renderMeta },
  vendas: { title: 'Vendas', render: renderSales },
  operacoes: { title: 'Operações', render: renderOperations },
  integracoes: { title: 'Integrações', render: renderIntegrations },
  config: { title: 'Configurações', render: renderConfig },
};
async function route() {
  const key = (location.hash.replace('#/', '') || 'resumo').split('?')[0];
  const r = ROUTES[key] || ROUTES.resumo;
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.r === key));
  $('#title').textContent = r.title; $('#subtitle').textContent = '';
  disposeCharts(); clearInterval(timer); lastUpdate = null;
  current = await r.render();
}
function markUpdated() { lastUpdate = Date.now(); }
setInterval(() => {
  $('#updated').textContent = lastUpdate ? `Atualizado há ${Math.round((Date.now() - lastUpdate) / 1000)}s` : '';
}, 1000);
$('#refresh').onclick = () => current && current();
$('#logout').onclick = async e => { e.preventDefault(); await api('/api/logout', { method: 'POST' }); location.href = '/login.html'; };
window.addEventListener('hashchange', route);

// =================================================================
// RESUMO
// =================================================================
const svg = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const I = {
  cart: svg('<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.7 12.4a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  target: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  pix: svg('<path d="m12 3 9 9-9 9-9-9Z"/><path d="m8.5 12 3.5 3.5 3.5-3.5L12 8.5Z"/>'),
  card: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>'),
  boleto: svg('<path d="M4 5v14M7 5v14M11 5v14M14 5v14M18 5v14M20 5v14"/>'),
  chev: svg('<path d="m9 6 6 6-6 6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
};

function prevRange(from, to) {
  const len = Math.round((new Date(to + 'T12:00:00Z') - new Date(from + 'T12:00:00Z')) / 864e5) + 1;
  const pto = addDays(from, -1);
  return { from: addDays(pto, -(len - 1)), to: pto };
}
// chip de variação; up = true quando subir é bom
function delta(cur, prev, up = true) {
  if (!prev || !isFinite(cur)) return '';
  const d = (cur - prev) / Math.abs(prev);
  if (Math.abs(d) < 0.005) return `<span class="delta flat" title="Anterior: ${num(prev, 2)}">0%</span>`;
  const good = (d > 0) === up;
  return `<span class="delta ${good ? 'good' : 'bad'}" title="Anterior: ${num(prev, 2)}">${d > 0 ? '▲' : '▼'} ${num(Math.abs(d) * 100, 1)}%</span>`;
}
const compareLabel = () => S.period === 'today' ? 'Comparado com ontem' : 'Comparado com o período anterior';

async function renderDashboard() {
  view.innerHTML = `
  <div class="filters">
    ${periodFields()}
    <label class="field">Operação<select class="input" id="f-op"><option value="">Todas</option>${G.operations.map(o => `<option value="${o.id}" ${String(S.operation) === String(o.id) ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>
    <label class="field">Conta de anúncio<select class="input" id="f-acc">${accountOptions(S.account)}</select></label>
    <label class="field">Produto<select class="input" id="f-prod"><option value="">Todos</option>${G.products.map(p => `<option ${S.product === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
  </div>
  <div id="warn"></div>
  <div id="dash"></div>`;
  bindPeriod(load);
  $('#f-op').onchange = e => { S.operation = e.target.value; save(); load(); };
  $('#f-acc').onchange = e => { S.account = e.target.value; save(); load(); };
  $('#f-prod').onchange = e => { S.product = e.target.value; save(); load(); };

  async function load() {
    const { from, to } = periodRange();
    const p = prevRange(from, to);
    const base = { operation: S.operation, account: S.account, product: S.product };
    $('#dash').classList.add('loading');
    try {
      const [d, prev] = await Promise.all([
        api('/api/dashboard?' + new URLSearchParams({ from, to, ...base })),
        api('/api/dashboard?' + new URLSearchParams({ ...p, ...base })).catch(() => null),
      ]);
      drawDashboard(d, prev);
      const br = s => s.split('-').reverse().join('/');
      $('#subtitle').textContent = from === to ? br(from) : `${br(from)} até ${br(to)}`;
      $('#warn').innerHTML = d.warnings.length ? `<div class="alert">Algumas contas não responderam: ${esc(d.warnings.join('; '))}</div>` : '';
      markUpdated();
    } catch (e) { toast(e.message, 'err'); }
    $('#dash').classList.remove('loading');
  }
  await load();
  timer = setInterval(load, 60000);
  return load;
}

function kpi(icon, tone, title, value, sub = '', tip = '') {
  return `<div class="card kpi"><div class="kpi-top"><span class="ico ${tone}">${I[icon]}</span>${title}${tip ? `<span class="tip" title="${esc(tip)}">?</span>` : ''}</div>
    <div class="v">${value}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
}
function money(n) {
  const s = brl(n); const i = s.lastIndexOf(',');
  return i > 0 ? `${s.slice(0, i)}<span class="cents">${s.slice(i)}</span>` : s;
}

function drawDashboard(d, prev) {
  const k = d.kpis; const pk = prev ? prev.kpis : {};
  disposeCharts();
  $('#dash').innerHTML = `
  <section class="hero">
    <div class="hero-main">
      <div class="hero-label">Faturamento líquido</div>
      <div class="hero-value">${money(k.net)}</div>
      <div class="hero-meta">
        ${delta(k.net, pk.net)}
        <span>Bruto <b>${brl(k.gross)}</b></span>
        <span><b>${num(k.approved)}</b> vendas aprovadas</span>
      </div>
      <div class="hero-meta" style="margin-top:6px;font-size:12px;color:#7f93c6">${prev ? compareLabel() : ''}</div>
      <div class="hero-spark" id="c-spark"></div>
    </div>
    <div class="hero-side">
      <div class="hero-stat"><span class="l">Lucro <span class="tip" title="Líquido menos gastos com anúncios e impostos">?</span></span><span class="v ${cls(k.profit)}">${brl(k.profit)}</span>${delta(k.profit, pk.profit)}</div>
      <div class="hero-stat"><span class="l">Gastos com anúncios</span><span class="v">${brl(k.spend)}</span>${delta(k.spend, pk.spend, false)}</div>
      <div class="hero-stat"><span class="l">ROAS <span class="tip" title="Faturamento líquido dividido pelos gastos">?</span></span><span class="v ${k.spend ? (k.roas >= 1 ? 'pos' : 'neg') : ''}">${num(k.roas, 2)}</span>${delta(k.roas, pk.roas)}</div>
      <div class="hero-stat"><span class="l">ROI <span class="tip" title="Lucro dividido pelos gastos">?</span></span><span class="v ${cls(k.roi)}">${pct(k.roi)}</span>${delta(k.roi, pk.roi)}</div>
    </div>
  </section>

  <div class="grid g4 mt">
    ${kpi('cart', 'blue', 'Vendas aprovadas', num(k.approved), `${delta(k.approved, pk.approved)}<span>Ticket médio ${brl(k.ticket)}</span>`)}
    ${kpi('clock', 'amber', 'Vendas pendentes', brl(k.pending_value), `<span>${num(k.pending)} pedidos aguardando pagamento</span>`)}
    ${kpi('target', 'violet', 'CPA', brl(k.cpa), `${delta(k.cpa, pk.cpa, false)}<span>CPI ${brl(k.cpi)} em ${num(k.ic)} ICs</span>`, 'Gastos divididos pelas vendas aprovadas')}
    ${kpi('undo', 'red', 'Reembolsos', brl(k.refunded_value), `<span>${num(k.refunded)} reembolsos e ${num(k.chargeback)} chargebacks (${pct(k.refund_rate)})</span>`)}
  </div>

  <div class="card ministats mt">
    <div><span class="l">Margem</span><span class="v ${cls(k.margin)}">${pct(k.margin)}</span></div>
    <div><span class="l">Faturamento bruto</span><span class="v">${brl(k.gross)}</span></div>
    <div><span class="l">Impostos</span><span class="v">${brl(k.taxes)}</span></div>
    <div><span class="l" title="Compras contadas pelo Pixel da Meta, para comparar com as vendas reais">Compras no Pixel</span><span class="v">${num(k.meta_purchases)}</span></div>
  </div>

  <div class="grid g3 mt">
    <div class="card"><div class="card-h"><div class="card-t">Vendas por pagamento</div><span class="card-note">Taxa de aprovação</span></div><div class="pay" id="pay"></div></div>
    <div class="card span2"><div class="card-h"><div class="card-t">Funil de conversão</div><span class="card-note">% em relação à etapa anterior</span></div><div id="funnel"></div></div>
  </div>

  <div class="grid g2 mt">
    <div class="card"><div class="card-h"><div class="card-t">Vendas por estado</div><span class="card-note" id="topstates"></span></div><div class="chart tall" id="c-map"></div></div>
    <div class="card"><div class="card-h"><div class="card-t">Vendas por horário</div><span class="card-note" id="peak"></span></div><div class="chart tall" id="c-hours"></div></div>
  </div>

  <div class="grid g3 mt">
    <div class="card span2"><div class="card-h"><div class="card-t">Faturamento, gastos e lucro por dia</div></div><div class="chart" id="c-daily"></div></div>
    <div class="card"><div class="card-h"><div class="card-t">Produtos</div><span class="card-note">Por faturamento líquido</span></div><div class="prod" id="prods"></div></div>
  </div>`;

  // sparkline do hero
  const single = d.daily.length === 1;
  let acc = 0;
  const nowH = Number(new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }));
  const spark = single ? d.hours.filter(h => d.range.to !== todayStr() || h.hour <= nowH).map(h => (acc += h.net)) : d.daily.map(x => x.net);
  chart($('#c-spark')).setOption({
    grid: { left: 0, right: 0, top: 6, bottom: 0 }, animationDuration: 900,
    xAxis: { type: 'category', show: false, boundaryGap: false, data: spark.map((_, i) => i) },
    yAxis: { type: 'value', show: false, min: v => v.min - (v.max - v.min) * 0.15 },
    series: [{ type: 'line', data: spark, smooth: 0.35, symbol: 'none', lineStyle: { width: 2.5, color: '#6e93ff' },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(110,147,255,.35)' }, { offset: 1, color: 'rgba(110,147,255,0)' }]) } }],
  });

  // pagamentos
  const PM = { pix: ['Pix', 'pix', 'green', '#2bd98a'], card: ['Cartão', 'card', 'blue', '#3b6cff'], boleto: ['Boleto', 'boleto', 'amber', '#ffb547'] };
  $('#pay').innerHTML = Object.entries(PM).map(([key, [label, icon, tone, color]]) => {
    const m = d.methods[key];
    return `<div class="pay-item"><span class="ico ${tone}">${I[icon]}</span>
      <div><div class="nm">${label}</div><div class="bar"><i style="width:${(m.rate * 100).toFixed(1)}%;background:${color}"></i></div>
      <div class="det">${num(m.approved)} de ${num(m.total)} aprovadas</div></div>
      <div><div class="rate">${pct(m.rate, 0)}</div><div class="det" style="text-align:right">${brl(m.net)}</div></div></div>`;
  }).join('');

  drawFunnel($('#funnel'), d.funnel);

  // mapa
  ensureMap().then(() => {
    const el = $('#c-map'); if (!el) return;
    const data = Object.entries(d.states).map(([uf, v]) => ({ name: uf, value: v.count, net: v.net }));
    const max = Math.max(1, ...data.map(x => x.value));
    chart(el).setOption({
      tooltip: { ...TT, trigger: 'item', formatter: p => `<b>${p.name}</b><br>${num(p.data ? p.data.value : 0)} vendas<br>${brl(p.data ? p.data.net : 0)}` },
      visualMap: { min: 0, max, left: 4, bottom: 8, itemHeight: 100, itemWidth: 10, calculable: false, text: ['Mais', 'Menos'], textStyle: { color: '#8a9bc2', fontFamily: 'Manrope' },
        inRange: { color: ['#18284d', '#3b6cff', '#8b5cf6', '#e44bb0'] } },
      series: [{ type: 'map', map: 'BR', roam: false, data, layoutCenter: ['56%', '50%'], layoutSize: '105%',
        itemStyle: { areaColor: '#121e3b', borderColor: '#0b1326', borderWidth: 1.2 },
        emphasis: { label: { show: true, color: '#fff', fontWeight: 800, fontFamily: 'Manrope' }, itemStyle: { areaColor: '#6e93ff' } }, select: { disabled: true } }],
    });
    const top = [...data].sort((a, b) => b.value - a.value).slice(0, 3);
    $('#topstates').textContent = top.length ? 'Mais vendas: ' + top.map(t => t.name).join(', ') : '';
  }).catch(() => { $('#c-map').innerHTML = '<div class="empty">Mapa indisponível</div>'; });

  // horas
  const peak = d.hours.reduce((a, b) => (b.count > a.count ? b : a), d.hours[0]);
  $('#peak').textContent = peak.count ? `Pico às ${String(peak.hour).padStart(2, '0')}h` : '';
  chart($('#c-hours')).setOption({
    grid: { left: 34, right: 6, top: 14, bottom: 26 },
    tooltip: { ...TT, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(110,147,255,.06)' } },
      formatter: p => `<b>${p[0].axisValue}</b><br>${num(p[0].value)} vendas<br>${brl(d.hours[p[0].dataIndex].net)}` },
    xAxis: { type: 'category', data: d.hours.map(h => String(h.hour).padStart(2, '0') + 'h'), ...AX, axisTick: { show: false }, splitLine: { show: false } },
    yAxis: { type: 'value', minInterval: 1, ...AX, axisLine: { show: false } },
    series: [{ type: 'bar', barWidth: '58%',
      data: d.hours.map(h => ({ value: h.count, itemStyle: h.hour === peak.hour && peak.count ? { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#b48bff' }, { offset: 1, color: 'rgba(139,92,246,.25)' }]) } : undefined })),
      itemStyle: { borderRadius: [6, 6, 2, 2], color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#6e93ff' }, { offset: 1, color: 'rgba(59,108,255,.18)' }]) } }],
  });

  // diário
  chart($('#c-daily')).setOption({
    grid: { left: 58, right: 12, top: 40, bottom: 26 },
    legend: { textStyle: { color: '#8a9bc2', fontFamily: 'Manrope', fontWeight: 600 }, top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8 },
    tooltip: { ...TT, trigger: 'axis', valueFormatter: v => brl(v) },
    xAxis: { type: 'category', data: d.daily.map(x => x.day.slice(8) + '/' + x.day.slice(5, 7)), ...AX, axisTick: { show: false }, splitLine: { show: false } },
    yAxis: { type: 'value', ...AX, axisLine: { show: false }, axisLabel: { color: '#8a9bc2', formatter: v => Math.abs(v) >= 1000 ? 'R$' + num(v / 1000, Math.abs(v) < 10000 ? 1 : 0) + 'k' : 'R$' + num(v) } },
    series: [
      { name: 'Líquido', type: 'bar', barMaxWidth: 44, data: d.daily.map(x => +x.net.toFixed(2)),
        itemStyle: { borderRadius: [6, 6, 2, 2], color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#4f7cff' }, { offset: 1, color: 'rgba(59,108,255,.35)' }]) } },
      { name: 'Gastos', type: 'line', smooth: true, data: d.daily.map(x => +x.spend.toFixed(2)), itemStyle: { color: '#ffb547' }, lineStyle: { width: 2.5 }, symbolSize: 6 },
      { name: 'Lucro', type: 'line', smooth: true, data: d.daily.map(x => +x.profit.toFixed(2)), itemStyle: { color: '#2bd98a' }, lineStyle: { width: 2.5 }, symbolSize: 6 },
    ],
  });

  const maxP = Math.max(1, ...d.products.map(p => p.net));
  $('#prods').innerHTML = d.products.length ? d.products.map((p, i) => `<div class="prod-row">
      <div class="top"><span>${esc(p.product)}</span><span>${brl(p.net)}</span></div>
      <div class="bar"><i style="width:${(p.net / maxP * 100).toFixed(1)}%;background:${['#3b6cff', '#8b5cf6', '#e44bb0', '#2bd98a', '#ffb547'][i % 5]}"></i></div>
      <div class="sub">${num(p.count)} ${p.count === 1 ? 'venda' : 'vendas'}</div></div>`).join('')
    : '<div class="empty">Nenhuma venda no período. As vendas chegam pelo webhook do checkout.</div>';
}

function drawFunnel(el, stages) {
  const W = 1000, H = 196, mid = H / 2, n = stages.length;
  const base = stages[0].value || 1;
  const hs = stages.map(s => H * 0.94 * Math.max(0.1, Math.pow(Math.min(1, (s.value || 0) / base), 0.32)));
  const xs = stages.map((_, i) => (i + 0.5) * W / n);
  const pts = [[0, hs[0]], ...xs.map((x, i) => [x, hs[i]]), [W, hs[n - 1]]];
  let top = `M${pts[0][0]},${mid - pts[0][1] / 2}`;
  for (let i = 1; i < pts.length; i++) { const [x0, h0] = pts[i - 1], [x1, h1] = pts[i]; const cx = (x0 + x1) / 2; top += ` C${cx},${mid - h0 / 2} ${cx},${mid - h1 / 2} ${x1},${mid - h1 / 2}`; }
  let bot = '';
  for (let i = pts.length - 1; i > 0; i--) { const [x0, h0] = pts[i], [x1, h1] = pts[i - 1]; const cx = (x0 + x1) / 2; bot += ` C${cx},${mid + h0 / 2} ${cx},${mid + h1 / 2} ${x1},${mid + h1 / 2}`; }
  const path = `${top} L${W},${mid + pts[pts.length - 1][1] / 2}${bot} Z`;
  const rel = stages.map((s, i) => i === 0 ? 1 : (stages[i - 1].value ? s.value / stages[i - 1].value : 0));
  const cols = `grid-template-columns:repeat(${n},1fr)`;
  el.innerHTML = `
    <div class="funnel-head" style="${cols}">${stages.map(s => `<div><div class="l">${s.label}</div><div class="n">${num(s.value)}</div></div>`).join('')}</div>
    <div class="funnel">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="fg" x1="0" x2="1"><stop offset="0" stop-color="#3b6cff"/><stop offset=".45" stop-color="#6a4dff"/><stop offset=".75" stop-color="#a94bdc"/><stop offset="1" stop-color="#e44bb0"/></linearGradient>
          <linearGradient id="fs" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".18"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
        </defs>
        <path d="${path}" fill="url(#fg)"/><path d="${path}" fill="url(#fs)"/>
      </svg>
      <div class="funnel-labels" style="${cols}">${rel.map(r => `<div><span class="p">${pct(r)}</span></div>`).join('')}</div>
    </div>`;
}
// =================================================================
// META ADS
// =================================================================
const M = { tab: 'campaign', account: '', parents: [], sort: { key: 'spend', dir: -1 }, q: '', onlyActive: false, rows: [] };
const LEVEL_LABEL = { campaign: 'Campanhas', adset: 'Conjuntos', ad: 'Anúncios' };
const EFF = { ACTIVE: ['Ativo', 'green'], PAUSED: ['Pausado', ''], CAMPAIGN_PAUSED: ['Campanha pausada', 'yellow'], ADSET_PAUSED: ['Conjunto pausado', 'yellow'],
  WITH_ISSUES: ['Com problemas', 'red'], DISAPPROVED: ['Reprovado', 'red'], PENDING_REVIEW: ['Em análise', 'blue'], IN_PROCESS: ['Processando', 'blue'],
  PENDING_BILLING_INFO: ['Pagamento pendente', 'red'], PREAPPROVED: ['Pré-aprovado', 'blue'] };
const ACC_STATUS = { 1: ['Ativa', 'green'], 2: ['Desativada', 'red'], 3: ['Pagamento pendente', 'red'], 7: ['Em análise', 'yellow'], 8: ['Liquidação pendente', 'yellow'], 9: ['Período de carência', 'yellow'], 100: ['Encerramento pendente', 'red'], 101: ['Encerrada', 'red'] };

async function renderMeta() {
  view.innerHTML = `
  <div class="tabs" id="mtabs">
    <button data-t="accounts">Contas</button><button data-t="campaign">Campanhas</button><button data-t="adset">Conjuntos</button><button data-t="ad">Anúncios</button>
  </div>
  <div class="filters">
    ${periodFields()}
    <label class="field">Conta de anúncio<select class="input" id="m-acc">${accountOptions(M.account, 'Todas as contas')}</select></label>
    <label class="field grow">Buscar<input class="input" id="m-q" placeholder="Nome contém..." value="${esc(M.q)}"></label>
    <label class="field" style="flex-direction:row;align-items:center;gap:9px;padding-bottom:10px;color:var(--text)"><span class="switch"><input type="checkbox" id="m-active" ${M.onlyActive ? 'checked' : ''}><span></span></span>Só ativos</label>
  </div>
  <div id="mbody"></div>`;
  const paintTabs = () => $$('#mtabs button').forEach(b => b.classList.toggle('active', b.dataset.t === M.tab));
  $$('#mtabs button').forEach(b => b.onclick = () => { M.tab = b.dataset.t; M.parents = []; paintTabs(); load(); });
  paintTabs();
  bindPeriod(() => load());
  $('#m-acc').onchange = e => { M.account = e.target.value; M.parents = []; load(); };
  $('#m-q').oninput = e => { M.q = e.target.value; drawTable(); };
  $('#m-active').onchange = e => { M.onlyActive = e.target.checked; drawTable(); };

  async function load() {
    const { from, to } = periodRange();
    $('#mbody').classList.add('loading');
    try {
      if (M.tab === 'accounts') await drawAccounts(from, to);
      else {
        const parent = M.parents[M.parents.length - 1];
        const qs = new URLSearchParams({ from, to, level: M.tab, account: parent ? parent.account_id : (M.account || 'all'), ...(parent ? { parent: parent.id } : {}) });
        const r = await api('/api/meta/entities?' + qs);
        M.rows = r.rows; M.errors = r.errors;
        drawTable();
      }
      markUpdated();
    } catch (e) { toast(e.message, 'err'); $('#mbody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    $('#mbody').classList.remove('loading');
  }
  M.reload = load;
  M.paintTabs = paintTabs;
  await load();
  timer = setInterval(load, 120000);
  return load;
}

async function drawAccounts(from, to) {
  const list = await api(`/api/meta/overview?from=${from}&to=${to}`);
  if (!list.length) { $('#mbody').innerHTML = `<div class="empty">Nenhuma conta conectada. <a href="#/integracoes">Adicione um token da Meta</a>.</div>`; return; }
  $('#mbody').innerHTML = `<div class="grid g3">${list.map(a => {
    const st = ACC_STATUS[a.details ? a.details.account_status : a.account_status] || ['?', ''];
    const m = a.metrics || {};
    return `<div class="card acc-card">
      <div class="card-h"><div><b style="font-size:15px">${esc(a.name)}</b><div class="id">${esc(a.id)}, ${esc(a.currency || '')}</div></div><span class="badge ${st[1]}">${st[0]}</span></div>
      ${a.error ? `<div class="alert">${esc(a.error)}</div>` : `
      <div class="row">
        <div><div class="l">Gasto no período</div><div class="big">${brl(m.spend)}</div></div>
        <div><div class="l">ICs</div><div class="big">${num(m.ic)}</div><div class="id">CPI ${brl(m.ic ? m.spend / m.ic : 0)}</div></div>
        <div><div class="l">Gasto total da conta</div><div>${brl((Number(a.details.amount_spent) || 0) / 100)}</div></div>
        <div><div class="l">Limite de gastos</div><div>${a.details.spend_cap ? brl(Number(a.details.spend_cap) / 100) : 'Sem limite'}</div></div>
      </div>`}
      <div style="margin-top:14px"><button class="btn sm" data-open="${esc(a.id)}">Ver campanhas</button></div>
    </div>`;
  }).join('')}</div>`;
  $$('[data-open]').forEach(b => b.onclick = () => { M.account = b.dataset.open; $('#m-acc').value = M.account; M.tab = 'campaign'; M.parents = []; M.paintTabs(); M.reload(); });
}

const COLS = [
  { key: 'spend', label: 'Gastos', get: r => r.metrics.spend, fmt: brl },
  { key: 'approved', label: 'Vendas', get: r => r.sales.approved, fmt: v => num(v) },
  { key: 'net', label: 'Faturamento', get: r => r.sales.net, fmt: brl },
  { key: 'profit', label: 'Lucro', get: r => r.sales.profit, fmt: v => `<span class="${cls(v)}">${brl(v)}</span>` },
  { key: 'roas', label: 'ROAS', get: r => r.sales.roas, fmt: (v, r) => r.metrics.spend ? `<span class="roas ${v >= 1.5 ? 'good' : v >= 1 ? 'mid' : 'bad'}">${num(v, 2)}</span>` : '—' },
  { key: 'cpa', label: 'CPA', get: r => r.sales.cpa, fmt: v => v ? brl(v) : '—' },
  { key: 'ic', label: 'ICs', get: r => r.metrics.ic, fmt: v => num(v) },
  { key: 'cpi', label: 'CPI', get: r => r.metrics.ic ? r.metrics.spend / r.metrics.ic : 0, fmt: v => v ? brl(v) : '—' },
  { key: 'cpc', label: 'CPC', get: r => r.metrics.cpc, fmt: v => v ? brl(v) : '—' },
  { key: 'ctr', label: 'CTR', get: r => r.metrics.ctr, fmt: v => `${num(v, 2)}%` },
  { key: 'cpm', label: 'CPM', get: r => r.metrics.cpm, fmt: v => v ? brl(v) : '—' },
];

function drawTable() {
  if (M.tab === 'accounts') return;
  let rows = M.rows.slice();
  if (M.q) rows = rows.filter(r => r.name.toLowerCase().includes(M.q.toLowerCase()));
  if (M.onlyActive) rows = rows.filter(r => r.effective_status === 'ACTIVE');
  const col = COLS.find(c => c.key === M.sort.key);
  if (col) rows.sort((a, b) => (col.get(a) - col.get(b)) * M.sort.dir);
  else if (M.sort.key === 'name') rows.sort((a, b) => a.name.localeCompare(b.name) * M.sort.dir);

  const tot = rows.reduce((t, r) => { t.spend += r.metrics.spend; t.approved += r.sales.approved; t.net += r.sales.net; t.profit += r.sales.profit; t.ic += r.metrics.ic; t.clicks += r.metrics.clicks; t.imp += r.metrics.impressions; return t; },
    { spend: 0, approved: 0, net: 0, profit: 0, ic: 0, clicks: 0, imp: 0 });
  const crumbs = M.parents.length ? `<div class="crumbs"><a data-crumb="-1">Todas as campanhas</a>${M.parents.map((p, i) => `${I.chev}<a data-crumb="${i}">${esc(p.name)}</a>`).join('')}${I.chev}<span>${LEVEL_LABEL[M.tab]}</span></div>` : '';
  const arrow = k => M.sort.key === k ? (M.sort.dir > 0 ? ' ↑' : ' ↓') : '';
  const showAcc = !M.account && !M.parents.length;

  $('#mbody').innerHTML = `${crumbs}
  ${M.errors && M.errors.length ? `<div class="alert">${esc(M.errors.join('; '))}</div>` : ''}
  <div class="table-wrap"><table class="t">
    <thead><tr><th style="width:50px">Status</th><th data-sort="name">${LEVEL_LABEL[M.tab].slice(0, -1)}${arrow('name')}</th>
      ${M.tab !== 'ad' ? '<th>Orçamento</th>' : ''}
      ${COLS.map(c => `<th class="num" data-sort="${c.key}">${c.label}${arrow(c.key)}</th>`).join('')}<th></th></tr></thead>
    <tbody>${rows.length ? rows.map(r => rowHtml(r, showAcc)).join('') : `<tr><td colspan="20" class="empty">Nada encontrado</td></tr>`}</tbody>
    <tfoot><tr><td></td><td>Total (${rows.length})</td>${M.tab !== 'ad' ? '<td></td>' : ''}
      <td class="num">${brl(tot.spend)}</td><td class="num">${num(tot.approved)}</td><td class="num">${brl(tot.net)}</td>
      <td class="num ${cls(tot.profit)}">${brl(tot.profit)}</td><td class="num">${tot.spend ? num(tot.net / tot.spend, 2) : '—'}</td>
      <td class="num">${tot.approved ? brl(tot.spend / tot.approved) : '—'}</td><td class="num">${num(tot.ic)}</td><td class="num">${tot.ic ? brl(tot.spend / tot.ic) : '—'}</td>
      <td class="num">${tot.clicks ? brl(tot.spend / tot.clicks) : '—'}</td><td class="num">${tot.imp ? num(tot.clicks / tot.imp * 100, 2) + '%' : '—'}</td>
      <td class="num">${tot.imp ? brl(tot.spend / tot.imp * 1000) : '—'}</td><td></td></tr></tfoot>
  </table></div>`;

  $$('[data-sort]').forEach(th => th.onclick = () => { const k = th.dataset.sort; M.sort = { key: k, dir: M.sort.key === k ? -M.sort.dir : -1 }; drawTable(); });
  $$('[data-crumb]').forEach(a => a.onclick = () => {
    const i = Number(a.dataset.crumb);
    M.parents = M.parents.slice(0, i + 1);
    M.tab = i < 0 ? 'campaign' : (M.parents[i].level === 'campaign' ? 'adset' : 'ad');
    M.paintTabs(); M.reload();
  });
  const byId = id => M.rows.find(r => r.id === id);
  $$('[data-drill]').forEach(a => a.onclick = e => {
    e.preventDefault(); const r = byId(a.dataset.drill);
    M.parents.push({ id: r.id, name: r.name, level: r.level, account_id: r.account_id });
    M.tab = r.level === 'campaign' ? 'adset' : 'ad'; M.paintTabs(); M.reload();
  });
  $$('[data-toggle]').forEach(inp => inp.onchange = async () => {
    const r = byId(inp.dataset.toggle); const status = inp.checked ? 'ACTIVE' : 'PAUSED';
    inp.disabled = true;
    try {
      await api('/api/meta/status', { method: 'POST', body: { account_id: r.account_id, id: r.id, status, name: r.name } });
      r.status = status; toast(`${status === 'ACTIVE' ? 'Ativado' : 'Pausado'}: ${r.name}`);
      setTimeout(() => M.reload(), 800);
    } catch (e) { inp.checked = !inp.checked; toast(e.message, 'err'); }
    inp.disabled = false;
  });
  $$('[data-budget]').forEach(b => b.onclick = () => budgetModal(byId(b.dataset.budget), Number(b.dataset.pct || 0)));
  $$('[data-dup]').forEach(b => b.onclick = () => {
    const r = byId(b.dataset.dup);
    modal({ title: 'Duplicar', body: `<p class="muted">Criar uma cópia de <b>${esc(r.name)}</b>? A cópia é criada <b>pausada</b>${r.level !== 'ad' ? ' (com conjuntos e anúncios)' : ''}.</p>`, confirm: 'Duplicar',
      onConfirm: async () => { await api('/api/meta/duplicate', { method: 'POST', body: { account_id: r.account_id, id: r.id, level: r.level, name: r.name } }); toast('Cópia criada (pausada)'); M.reload(); } });
  });
}

function rowHtml(r, showAcc) {
  const eff = EFF[r.effective_status] || [r.effective_status, ''];
  const budget = r.daily_budget
    ? `<div class="budget"><button class="iconbtn down" data-budget="${r.id}" data-pct="-20" title="Diminuir 20%" aria-label="Diminuir 20%">${I.minus}</button><span class="val">${brl(r.daily_budget / 100)}<small>/dia</small></span><button class="iconbtn up" data-budget="${r.id}" data-pct="20" title="Aumentar 20%" aria-label="Aumentar 20%">${I.plus}</button><button class="iconbtn" data-budget="${r.id}" title="Editar valor" aria-label="Editar valor">${I.edit}</button></div>`
    : r.lifetime_budget ? `${brl(r.lifetime_budget / 100)} <span class="sub">total</span>`
    : `<span class="sub">${r.level === 'campaign' ? 'No conjunto (ABO)' : 'Na campanha (CBO)'}</span>`;
  return `<tr class="${r.effective_status === 'ACTIVE' ? '' : 'off'}">
    <td><label class="switch"><input type="checkbox" data-toggle="${r.id}" ${r.status === 'ACTIVE' ? 'checked' : ''}><span></span></label></td>
    <td class="name">${r.level !== 'ad' ? `<a href="#" data-drill="${r.id}" title="${esc(r.name)}">${esc(r.name)}</a>` : `<span title="${esc(r.name)}">${esc(r.name)}</span>`}
      <div class="sub">${r.effective_status !== 'ACTIVE' || r.status !== 'ACTIVE' ? `<span class="badge ${eff[1]}">${eff[0]}</span>` : ''}${showAcc ? `<span>${esc(r.account_name)}</span>` : ''}<span>${esc(r.id)}</span></div></td>
    ${r.level !== 'ad' ? `<td>${budget}</td>` : ''}
    ${COLS.map(c => `<td class="num">${c.fmt(c.get(r), r)}</td>`).join('')}
    <td><button class="iconbtn" data-dup="${r.id}" title="Duplicar" aria-label="Duplicar">${I.copy}</button></td>
  </tr>`;
}

function budgetModal(r, presetPct) {
  const cur = r.daily_budget / 100;
  const start = presetPct ? +(cur * (1 + presetPct / 100)).toFixed(2) : cur;
  modal({
    title: 'Orçamento diário',
    body: `<p class="muted" style="margin:0 0 16px">${esc(r.name)}</p>
      <label class="field">Novo orçamento (R$)<input class="input" type="number" min="1" step="0.01" id="bv" value="${start}"></label>
      <div class="chips">${[-30, -20, -10, 10, 20, 30, 50, 100].map(p => `<button class="btn sm ${p > 0 ? 'up' : 'down'}" data-p="${p}">${p > 0 ? '+' : ''}${p}%</button>`).join('')}</div>
      <div class="preview" id="bprev"></div>`,
    confirm: 'Salvar orçamento',
    onOpen: bg => {
      const inp = $('#bv', bg);
      const prev = () => { const v = Number(inp.value) || 0; const d = cur ? (v / cur - 1) : 0; $('#bprev', bg).innerHTML = `<span class="muted">${brl(cur)}</span>${I.chev}<b>${brl(v)}</b><span class="delta ${d > 0 ? 'good' : d < 0 ? 'bad' : 'flat'}" style="margin-left:auto">${d > 0 ? '+' : ''}${pct(d)}</span>`; };
      $$('[data-p]', bg).forEach(b => b.onclick = () => { inp.value = (cur * (1 + Number(b.dataset.p) / 100)).toFixed(2); prev(); });
      inp.oninput = prev; prev(); inp.focus(); inp.select();
    },
    onConfirm: async bg => {
      const v = Number($('#bv', bg).value);
      if (!v || v < 1) { toast('Valor inválido', 'err'); return false; }
      await api('/api/meta/budget', { method: 'POST', body: { account_id: r.account_id, id: r.id, cents: Math.round(v * 100), previous: r.daily_budget, name: r.name } });
      toast(`Orçamento atualizado: ${brl(v)}/dia`);
      M.reload();
    },
  });
}

// =================================================================
// VENDAS
// =================================================================
const STATUS = { approved: ['Aprovada', 'green'], pending: ['Pendente', 'yellow'], refunded: ['Reembolsada', 'red'], chargeback: ['Chargeback', 'red'], canceled: ['Cancelada', ''] };
const PAY = { pix: 'Pix', card: 'Cartão', boleto: 'Boleto', other: 'Outro' };
async function renderSales() {
  let st = '', q = '';
  view.innerHTML = `<div class="filters">${periodFields()}
    <label class="field">Status<select class="input" id="s-st"><option value="">Todos</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select></label>
    <label class="field">Produto<select class="input" id="s-prod"><option value="">Todos</option>${G.products.map(p => `<option>${esc(p)}</option>`).join('')}</select></label>
    <label class="field grow">Buscar<input class="input" id="s-q" placeholder="Pedido, produto, campanha..."></label></div><div id="sbody"></div>`;
  bindPeriod(load);
  $('#s-st').onchange = e => { st = e.target.value; load(); };
  $('#s-prod').onchange = load;
  let deb; $('#s-q').oninput = e => { clearTimeout(deb); q = e.target.value; deb = setTimeout(load, 300); };
  const utmName = v => v ? String(v).split('|')[0] : '';
  async function load() {
    const { from, to } = periodRange();
    const r = await api('/api/sales?' + new URLSearchParams({ from, to, status: st, q, product: $('#s-prod').value }));
    $('#sbody').innerHTML = `<p class="muted">${num(r.total)} vendas${r.total > 500 ? ' (mostrando 500)' : ''}</p>
    <div class="table-wrap"><table class="t"><thead><tr><th>Data</th><th>Pedido</th><th>Produto</th><th>Status</th><th>Pagamento</th><th class="num">Bruto</th><th class="num">Líquido</th><th>UF</th><th>Campanha</th><th>Anúncio</th></tr></thead>
    <tbody>${r.rows.map(s => `<tr><td>${new Date(s.created_at).toLocaleString('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' })}</td>
      <td>${esc(s.order_id)}<div class="sub">${esc(s.platform)}</div></td><td>${esc(s.product)}</td>
      <td><span class="badge ${(STATUS[s.status] || ['', ''])[1]}">${(STATUS[s.status] || [s.status])[0]}</span></td><td>${PAY[s.payment_method] || '—'}</td>
      <td class="num">${brl(s.gross_cents / 100)}</td><td class="num">${brl(s.net_cents / 100)}</td><td>${esc(s.customer_state || '—')}</td>
      <td class="name" title="${esc(s.utm_campaign)}">${esc(utmName(s.utm_campaign)) || '<span class="muted">sem UTM</span>'}</td><td class="name">${esc(utmName(s.utm_content))}</td></tr>`).join('') || '<tr><td colspan="10" class="empty">Nenhuma venda</td></tr>'}</tbody></table></div>`;
    markUpdated();
  }
  await load();
  return load;
}

// =================================================================
// OPERAÇÕES
// =================================================================
async function renderOperations() {
  await loadGlobals();
  const accName = id => (G.accounts.find(a => a.id === id) || { name: id }).name;
  view.innerHTML = `<p class="muted" style="margin-top:0">Uma operação junta contas de anúncio e produtos. No Resumo você filtra por operação para ver o resultado só dela.</p>
  <button class="btn primary" id="newop">+ Nova operação</button>
  <div class="grid g3 mt">${G.operations.map(o => `<div class="card"><div class="card-h"><b>${esc(o.name)}</b>
    <div><button class="btn sm" data-edit="${o.id}">Editar</button> <button class="btn sm danger" data-del="${o.id}">Excluir</button></div></div>
    <div class="muted" style="font-size:12px">Contas</div><div>${o.account_ids.length ? o.account_ids.map(id => esc(accName(id))).join('<br>') : 'Todas'}</div>
    <div class="muted" style="font-size:12px;margin-top:8px">Produtos</div><div>${o.products.length ? o.products.map(esc).join('<br>') : 'Todos (filtra vendas pelas campanhas das contas)'}</div></div>`).join('') || '<div class="empty">Nenhuma operação criada</div>'}</div>`;
  const form = (o = { name: '', account_ids: [], products: [] }) => modal({
    title: o.id ? 'Editar operação' : 'Nova operação',
    body: `<label class="field">Nome<input class="input" id="op-n" value="${esc(o.name)}"></label>
      <div class="field" style="margin-top:12px">Contas de anúncio<div class="list-check">${G.accounts.map(a => `<label><input type="checkbox" value="${esc(a.id)}" data-a ${o.account_ids.includes(a.id) ? 'checked' : ''}>${esc(a.name)}</label>`).join('') || '<span class="muted">Nenhuma conta</span>'}</div></div>
      <div class="field" style="margin-top:12px">Produtos (opcional)<div class="list-check">${G.products.map(p => `<label><input type="checkbox" value="${esc(p)}" data-p ${o.products.includes(p) ? 'checked' : ''}>${esc(p)}</label>`).join('') || '<span class="muted">Os produtos aparecem quando chegarem vendas</span>'}</div></div>`,
    confirm: 'Salvar',
    onConfirm: async bg => {
      await api('/api/operations', { method: 'POST', body: { id: o.id, name: $('#op-n', bg).value.trim(),
        account_ids: $$('[data-a]:checked', bg).map(i => i.value), products: $$('[data-p]:checked', bg).map(i => i.value) } });
      toast('Operação salva'); renderOperations();
    },
  });
  $('#newop').onclick = () => form();
  $$('[data-edit]').forEach(b => b.onclick = () => form(G.operations.find(o => String(o.id) === b.dataset.edit)));
  $$('[data-del]').forEach(b => b.onclick = () => modal({ title: 'Excluir operação?', confirm: 'Excluir', danger: true,
    onConfirm: async () => { await api('/api/operations/' + b.dataset.del, { method: 'DELETE' }); renderOperations(); } }));
  return renderOperations;
}

// =================================================================
// INTEGRAÇÕES
// =================================================================
async function renderIntegrations() {
  await loadGlobals();
  const tokens = await api('/api/meta/tokens');
  const base = location.origin + (G.config.webhookBase || '/webhook/SEU_SEGREDO');
  const UTM = 'utm_source=FB&utm_campaign={{campaign.name}}|{{campaign.id}}&utm_medium={{adset.name}}|{{adset.id}}&utm_content={{ad.name}}|{{ad.id}}&utm_term={{placement}}';
  view.innerHTML = `
  <h2 class="sec" style="margin-top:0">Meta Ads — tokens de acesso</h2>
  <div class="grid g2">
    <div class="card">
      <div class="card-t" style="margin-bottom:10px">Adicionar token</div>
      <label class="field">Nome (ex.: BM Principal)<input class="input" id="tk-l"></label>
      <label class="field" style="margin-top:10px">Token de acesso<textarea class="input" id="tk-t" rows="3" placeholder="EAAB..."></textarea></label>
      <button class="btn primary" id="tk-add" style="margin-top:12px">Conectar e buscar contas</button>
      <p class="muted" style="font-size:12px">Use um token de <b>Usuário do Sistema</b> do Business Manager com as permissões <code>ads_management</code> e <code>ads_read</code>. Cada BM diferente = um token. Todas as contas que o token enxerga são importadas.</p>
    </div>
    <div class="card"><div class="card-t" style="margin-bottom:10px">Tokens conectados</div>
      ${tokens.length ? `<table class="t"><tbody>${tokens.map(t => `<tr><td>${esc(t.label)}<div class="sub">${esc(t.preview)}</div></td><td class="num"><button class="btn sm danger" data-deltk="${t.id}">Remover</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhum token</div>'}
    </div>
  </div>
  <h2 class="sec">Contas de anúncio</h2>
  <div class="table-wrap"><table class="t"><thead><tr><th>Usar no painel</th><th>Conta</th><th>ID</th><th>Moeda</th><th>Token</th></tr></thead>
  <tbody>${G.accounts.map(a => `<tr><td><label class="switch"><input type="checkbox" data-acc="${esc(a.id)}" ${a.enabled ? 'checked' : ''}><span></span></label></td>
    <td>${esc(a.name)}</td><td>${esc(a.id)}</td><td>${esc(a.currency)}</td><td>${esc(a.token_label)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhuma conta</td></tr>'}</tbody></table></div>

  <h2 class="sec">Vendas — webhooks dos checkouts</h2>
  ${G.config.webhookConfigured ? '' : '<div class="alert">Defina <b>WEBHOOK_SECRET</b> no arquivo .env para ativar os webhooks.</div>'}
  <div class="grid g3">
    ${[['kiwify', 'Kiwify'], ['hotmart', 'Hotmart'], ['generic', 'Genérico (qualquer checkout / n8n / Make)']].map(([k, n]) =>
      `<div class="card"><div class="card-t">${n}</div><div class="copyrow"><div class="code">${esc(base)}/${k}</div><button class="btn sm" data-copy="${esc(base)}/${k}">Copiar</button></div></div>`).join('')}
  </div>
  <div class="card mt"><div class="card-t">Formato do webhook genérico (POST JSON)</div>
    <div class="code" style="margin-top:8px">{
  "order_id": "123", "status": "paid | pending | refunded | chargeback | canceled",
  "payment_method": "pix | credit_card | boleto", "product": "Nome do produto",
  "amount": 97.00, "net_amount": 87.30, "state": "SP",
  "utm_source": "FB", "utm_campaign": "Nome|120210000000", "utm_medium": "...", "utm_content": "...", "utm_term": "...",
  "created_at": "2026-11-15T13:00:00-03:00"
}</div></div>

  <h2 class="sec">Parâmetros de URL dos anúncios</h2>
  <div class="card"><p class="muted" style="margin-top:0">Cole no campo <b>Parâmetros de URL</b> de cada anúncio (mesmo padrão da Utmify). É assim que cada venda é ligada à campanha, conjunto e anúncio na aba Meta Ads. Seu checkout precisa repassar as UTMs da página para o pedido.</p>
    <div class="copyrow"><div class="code">${esc(UTM)}</div><button class="btn sm" data-copy="${esc(UTM)}">Copiar</button></div></div>`;

  $('#tk-add').onclick = async e => {
    const btn = e.target; btn.disabled = true; btn.textContent = 'Conectando...';
    try {
      const r = await api('/api/meta/tokens', { method: 'POST', body: { label: $('#tk-l').value || 'Token', token: $('#tk-t').value } });
      toast(`${r.accounts.length} contas encontradas`); renderIntegrations();
    } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = 'Conectar e buscar contas'; }
  };
  $$('[data-deltk]').forEach(b => b.onclick = () => modal({ title: 'Remover token?', body: '<p class="muted">As contas desse token saem do painel.</p>', confirm: 'Remover', danger: true,
    onConfirm: async () => { await api('/api/meta/tokens/' + b.dataset.deltk, { method: 'DELETE' }); renderIntegrations(); } }));
  $$('[data-acc]').forEach(i => i.onchange = async () => { await api('/api/meta/accounts/' + encodeURIComponent(i.dataset.acc), { method: 'PATCH', body: { enabled: i.checked } }); await loadGlobals(); toast('Salvo'); });
  $$('[data-copy]').forEach(b => b.onclick = () => copy(b.dataset.copy));
  return renderIntegrations;
}

// =================================================================
// CONFIGURAÇÕES
// =================================================================
async function renderConfig() {
  const [s, logs] = await Promise.all([api('/api/settings'), api('/api/meta/log')]);
  view.innerHTML = `<div class="grid g3"><div class="card">
    <div class="card-t" style="margin-bottom:10px">Impostos</div>
    <label class="field">Alíquota sobre o faturamento líquido (%)<input class="input" type="number" step="0.01" min="0" max="100" id="tax" value="${s.tax_pct}"></label>
    <button class="btn primary" id="savetax" style="margin-top:12px">Salvar</button></div></div>
  <h2 class="sec">Histórico de ações nos anúncios</h2>
  <div class="table-wrap"><table class="t"><thead><tr><th>Quando</th><th>Ação</th><th>Item</th><th>Detalhe</th></tr></thead>
  <tbody>${logs.map(l => `<tr><td>${new Date(l.at.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { timeZone: TZ })}</td><td>${esc(l.action)}</td><td class="name">${esc(l.entity_name)}<div class="sub">${esc(l.entity_id)}</div></td><td>${esc(l.detail)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhuma ação ainda</td></tr>'}</tbody></table></div>`;
  $('#savetax').onclick = async () => { try { await api('/api/settings', { method: 'PUT', body: { tax_pct: Number($('#tax').value) } }); toast('Salvo'); } catch (e) { toast(e.message, 'err'); } };
  return renderConfig;
}

// ---------- start ----------
loadGlobals().then(route).catch(e => toast(e.message, 'err'));
