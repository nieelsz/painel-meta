require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const express = require('express');
const { db, getSetting, setSetting } = require('./db');
const auth = require('./auth');
const meta = require('./meta');
const sales = require('./sales');
const demo = require('./demo');

const DEMO = process.env.DEMO_MODE === 'true';
const app = express();
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- público ----------
auth.routes(app);
sales.webhookRoute(app);
const pub = path.join(__dirname, '..', 'public');
['/login.html', '/style.css', '/favicon.svg', '/vendor/manrope.woff2'].forEach(f => app.get(f, (req, res) => res.sendFile(path.join(pub, f))));

// ---------- protegido ----------
app.use(auth.requireAuth);
app.use(express.static(pub));
app.get('/vendor/echarts.min.js', (req, res) => res.sendFile(require.resolve('echarts/dist/echarts.min.js')));

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ error: e.message || 'erro interno' });
});
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
function range(q) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ_PAINEL || 'America/Sao_Paulo' });
  return { from: isDate(q.from) ? q.from : today, to: isDate(q.to) ? q.to : today };
}
function daysBetween(from, to) {
  const out = []; const d = new Date(from + 'T12:00:00Z'); const e = new Date(to + 'T12:00:00Z');
  while (d <= e && out.length < 400) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const enabledAccounts = () => db.prepare('SELECT * FROM ad_accounts WHERE enabled=1 ORDER BY name').all();
const taxPct = () => Number(getSetting('tax_pct', 0)) || 0;
const log = (id, name, action, detail) => db.prepare('INSERT INTO action_log(entity_id, entity_name, action, detail) VALUES (?,?,?,?)').run(id, name || '', action, detail || '');

app.get('/api/config', (req, res) => res.json({
  demo: DEMO, webhookConfigured: !!process.env.WEBHOOK_SECRET,
  webhookBase: process.env.WEBHOOK_SECRET ? `/webhook/${process.env.WEBHOOK_SECRET}` : null, tz: process.env.TZ_PAINEL || 'America/Sao_Paulo',
}));

// ---------- tokens e contas ----------
app.get('/api/meta/tokens', (req, res) => {
  res.json(db.prepare('SELECT id, label, substr(access_token,1,8) || \'…\' AS preview, created_at FROM tokens').all());
});
app.post('/api/meta/tokens', wrap(async (req, res) => {
  const { label, token } = req.body || {};
  if (!token || token.length < 20) return res.status(400).json({ error: 'Token inválido' });
  const accounts = await meta.discoverAccounts(token.trim());
  const id = db.prepare('INSERT INTO tokens(label, access_token) VALUES (?,?)').run(label || 'Token', token.trim()).lastInsertRowid;
  const ins = db.prepare(`INSERT INTO ad_accounts(id,name,currency,timezone,account_status,token_id,enabled) VALUES (@id,@name,@currency,@timezone,@account_status,@token_id,1)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, token_id=excluded.token_id, account_status=excluded.account_status`);
  for (const a of accounts) ins.run({ ...a, token_id: id });
  res.json({ ok: true, accounts });
}));
app.delete('/api/meta/tokens/:id', (req, res) => {
  db.prepare('DELETE FROM ad_accounts WHERE token_id=?').run(req.params.id);
  db.prepare('DELETE FROM tokens WHERE id=?').run(req.params.id);
  meta.clearCache();
  res.json({ ok: true });
});
app.get('/api/meta/accounts', (req, res) => {
  res.json(db.prepare('SELECT a.*, t.label AS token_label FROM ad_accounts a LEFT JOIN tokens t ON t.id=a.token_id ORDER BY a.name').all());
});
app.patch('/api/meta/accounts/:id', (req, res) => {
  if (typeof req.body.enabled === 'boolean') db.prepare('UPDATE ad_accounts SET enabled=? WHERE id=?').run(req.body.enabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// visão de contas com gasto no período
app.get('/api/meta/overview', wrap(async (req, res) => {
  const { from, to } = range(req.query);
  const out = await Promise.all(enabledAccounts().map(async a => {
    try {
      const [det, daily] = await Promise.all([meta.accountDetails(a.id), meta.accountDaily(a.id, from, to)]);
      return { ...a, details: det, metrics: meta.sumMetrics(daily) };
    } catch (e) { return { ...a, error: e.message }; }
  }));
  res.json(out);
}));

// vendas agregadas por id de campanha/conjunto/anúncio (via UTM)
function salesByEntity(from, to) {
  const map = {};
  for (const s of sales.salesQuery({ from, to })) {
    for (const id of sales.idsInUtm(s)) {
      const m = map[id] || (map[id] = { approved: 0, pending: 0, gross: 0, net: 0 });
      if (s.status === 'approved') { m.approved++; m.gross += s.gross_cents; m.net += s.net_cents; }
      else if (s.status === 'pending') m.pending++;
    }
  }
  return map;
}

// produto de cada campanha = o mais vendido nas UTMs dela (todo o histórico)
function campaignProducts() {
  const rows = db.prepare(`SELECT product, utm_source, utm_medium, utm_campaign, utm_content, utm_term, COUNT(*) n FROM sales
    WHERE product IS NOT NULL GROUP BY product, utm_source, utm_medium, utm_campaign, utm_content, utm_term`).all();
  const count = {};
  for (const r of rows) for (const id of sales.idsInUtm(r)) {
    const c = count[id] || (count[id] = {}); c[r.product] = (c[r.product] || 0) + r.n;
  }
  const out = {};
  for (const [id, c] of Object.entries(count)) out[id] = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
  return out;
}

app.get('/api/meta/entities', wrap(async (req, res) => {
  const { from, to } = range(req.query);
  const level = req.query.level || 'campaign';
  const accounts = req.query.account && req.query.account !== 'all' ? [req.query.account] : enabledAccounts().map(a => a.id);
  const errors = [];
  const lists = await Promise.all(accounts.map(a => meta.listEntities(a, level, req.query.parent || null, from, to).catch(e => { errors.push(`${a}: ${e.message}`); return []; })));
  const sbe = salesByEntity(from, to);
  const tax = taxPct() / 100;
  const names = Object.fromEntries(enabledAccounts().map(a => [a.id, a.name]));
  const rows = lists.flat().map(e => {
    const s = sbe[e.id] || { approved: 0, pending: 0, gross: 0, net: 0 };
    const net = s.net / 100; const spend = e.metrics.spend;
    const profit = net - spend - net * tax;
    return { ...e, account_name: names[e.account_id] || e.account_id,
      sales: { ...s, gross: s.gross / 100, net, profit, roas: spend ? net / spend : 0, roi: spend ? profit / spend : 0, cpa: s.approved ? spend / s.approved : 0 } };
  });
  res.json({ rows, errors });
}));

app.post('/api/meta/status', wrap(async (req, res) => {
  const { account_id, id, status, name } = req.body;
  await meta.setStatus(account_id, id, status);
  log(id, name, status === 'ACTIVE' ? 'ativou' : 'pausou');
  res.json({ ok: true });
}));
app.post('/api/meta/budget', wrap(async (req, res) => {
  const { account_id, id, cents, name, previous, confirmed } = req.body;
  // trava contra erro de digitação: dobrar o orçamento (ou sem valor anterior) exige confirmação explícita
  if (!confirmed && (!previous || Number(cents) > previous * 2)) return res.status(400).json({ error: 'Aumento acima de 100% precisa ser confirmado' });
  await meta.setBudget(account_id, id, cents);
  log(id, name, 'orçamento', `${previous ? (previous / 100).toFixed(2) : '?'} → ${(cents / 100).toFixed(2)}`);
  res.json({ ok: true });
}));
app.post('/api/meta/duplicate', wrap(async (req, res) => {
  const { account_id, id, level, name } = req.body;
  const r = await meta.duplicate(account_id, id, level);
  log(id, name, 'duplicou', 'cópia criada pausada');
  res.json({ ok: true, result: r });
}));
app.get('/api/meta/log', (req, res) => res.json(db.prepare('SELECT * FROM action_log ORDER BY id DESC LIMIT 100').all()));

// ---------- operações ----------
app.get('/api/operations', (req, res) => res.json(db.prepare('SELECT * FROM operations ORDER BY name').all()
  .map(o => ({ ...o, account_ids: JSON.parse(o.account_ids), products: JSON.parse(o.products) }))));
app.post('/api/operations', (req, res) => {
  const { id, name, account_ids = [], products = [] } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  if (id) db.prepare('UPDATE operations SET name=?, account_ids=?, products=? WHERE id=?').run(name, JSON.stringify(account_ids), JSON.stringify(products), id);
  else db.prepare('INSERT INTO operations(name, account_ids, products) VALUES (?,?,?)').run(name, JSON.stringify(account_ids), JSON.stringify(products));
  res.json({ ok: true });
});
app.delete('/api/operations/:id', (req, res) => { db.prepare('DELETE FROM operations WHERE id=?').run(req.params.id); res.json({ ok: true }); });
app.get('/api/products', (req, res) => res.json(db.prepare('SELECT DISTINCT product FROM sales WHERE product IS NOT NULL ORDER BY product').all().map(r => r.product)));

app.get('/api/settings', (req, res) => res.json({ tax_pct: taxPct() }));
app.put('/api/settings', (req, res) => {
  const v = Number(req.body.tax_pct);
  if (isNaN(v) || v < 0 || v > 100) return res.status(400).json({ error: 'Imposto inválido' });
  setSetting('tax_pct', v); res.json({ ok: true });
});

// ---------- dashboard ----------
app.get('/api/dashboard', wrap(async (req, res) => {
  const { from, to } = range(req.query);
  let accounts = enabledAccounts().map(a => a.id);
  let products = req.query.product ? [req.query.product] : [];
  let accountFiltered = false;
  if (req.query.operation) {
    const op = db.prepare('SELECT * FROM operations WHERE id=?').get(req.query.operation);
    if (op) {
      const ids = JSON.parse(op.account_ids); const prods = JSON.parse(op.products);
      if (ids.length) { accounts = accounts.filter(a => ids.includes(a)); accountFiltered = true; }
      if (prods.length && !products.length) products = prods;
    }
  }
  if (req.query.account) { accounts = accounts.filter(a => a === req.query.account); accountFiltered = true; }

  const warnings = []; const notes = [];
  let dailies;
  if (products.length) {
    // com filtro de produto, o gasto é só o das campanhas daquele produto
    const owner = campaignProducts();
    const rows = (await Promise.all(accounts.map(a => meta.campaignDaily(a, from, to).catch(e => { warnings.push(`${a}: ${e.message}`); return []; })))).flat();
    const unknown = {};
    dailies = [rows.filter(r => {
      if (!owner[r.campaign_id] && r.spend > 0) unknown[r.campaign_id] = (unknown[r.campaign_id] || 0) + r.spend;
      return products.includes(owner[r.campaign_id]);
    })];
    const n = Object.keys(unknown).length;
    if (n) notes.push(`${n} ${n === 1 ? 'campanha' : 'campanhas'} sem venda registrada (produto desconhecido), com R$ ${Object.values(unknown).reduce((a, b) => a + b, 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} de gasto, não ${n === 1 ? 'entrou' : 'entraram'} no gasto deste filtro.`);
  } else {
    dailies = await Promise.all(accounts.map(a => meta.accountDaily(a, from, to).catch(e => { warnings.push(`${a}: ${e.message}`); return []; })));
  }
  const spendByDay = {};
  for (const d of dailies.flat()) spendByDay[d.day] = (spendByDay[d.day] || 0) + d.spend;
  const mt = meta.sumMetrics(dailies.flat());

  let list = sales.salesQuery({ from, to, products });
  // filtro por conta sem produto definido: usa os IDs de campanha presentes nas UTMs
  if (accountFiltered && !products.length) {
    const camps = await Promise.all(accounts.map(a => meta.listEntities(a, 'campaign', null, from, to).catch(() => [])));
    const ids = new Set(camps.flat().map(c => c.id));
    list = list.filter(s => [...sales.idsInUtm(s)].some(id => ids.has(id)));
  }

  const tax = taxPct() / 100;
  const by = st => list.filter(s => s.status === st);
  const approved = by('approved'); const pending = by('pending'); const refunded = by('refunded'); const cb = by('chargeback');
  const sum = (arr, f = 'net_cents') => arr.reduce((t, s) => t + s[f], 0) / 100;
  const gross = sum(approved, 'gross_cents'); const net = sum(approved);
  const spend = mt.spend; const taxes = net * tax; const profit = net - spend - taxes;

  const methods = {};
  for (const m of ['pix', 'card', 'boleto']) {
    const all = list.filter(s => s.payment_method === m);
    const ok = all.filter(s => ['approved', 'refunded', 'chargeback'].includes(s.status));
    methods[m] = { total: all.length, approved: ok.length, rate: all.length ? ok.length / all.length : 0, net: sum(all.filter(s => s.status === 'approved')) };
  }
  const hours = Array.from({ length: 24 }, (_, h) => {
    const a = approved.filter(s => s.hour === h);
    return { hour: h, count: a.length, net: sum(a) };
  });
  const states = {};
  for (const s of approved) if (s.customer_state) { const x = states[s.customer_state] || (states[s.customer_state] = { count: 0, net: 0 }); x.count++; x.net += s.net_cents / 100; }
  const prodMap = {};
  for (const s of approved) { const p = prodMap[s.product || '—'] || (prodMap[s.product || '—'] = { product: s.product || '—', count: 0, net: 0 }); p.count++; p.net += s.net_cents / 100; }
  const daily = daysBetween(from, to).map(day => {
    const a = approved.filter(s => s.day === day); const n = sum(a); const sp = spendByDay[day] || 0;
    return { day, net: n, gross: sum(a, 'gross_cents'), spend: sp, profit: n - sp - n * tax, count: a.length };
  });
  const initiated = list.length;
  const paid = approved.length + refunded.length + cb.length;

  res.json({
    range: { from, to }, warnings, notes, updated_at: new Date().toISOString(),
    kpis: {
      gross, net, spend, taxes, profit,
      roas: spend ? net / spend : 0, roi: spend ? profit / spend : 0, margin: net ? profit / net : 0,
      cpa: approved.length ? spend / approved.length : 0, ticket: approved.length ? gross / approved.length : 0,
      approved: approved.length, pending: pending.length, pending_value: sum(pending, 'gross_cents'),
      refunded: refunded.length, refunded_value: sum(refunded, 'gross_cents'), chargeback: cb.length,
      refund_rate: paid ? (refunded.length + cb.length) / paid : 0,
      ic: mt.ic, cpi: mt.ic ? spend / mt.ic : 0, meta_purchases: mt.purchases,
    },
    funnel: [
      { key: 'clicks', label: 'Cliques', value: mt.clicks },
      { key: 'lpv', label: 'Vis. Página', value: mt.lpv },
      { key: 'ic', label: 'ICs', value: mt.ic },
      { key: 'initiated', label: 'Vendas Inic.', value: initiated },
      { key: 'approved', label: 'Vendas Apr.', value: approved.length },
    ],
    methods, hours, states, daily,
    products: Object.values(prodMap).sort((a, b) => b.net - a.net).slice(0, 8),
    meta: { impressions: mt.impressions, clicks: mt.clicks, cpc: mt.clicks ? spend / mt.clicks : 0, ctr: mt.impressions ? mt.clicks / mt.impressions * 100 : 0, cpm: mt.impressions ? spend / mt.impressions * 1000 : 0 },
  });
}));

// ---------- vendas ----------
app.get('/api/sales', (req, res) => {
  const { from, to } = range(req.query);
  let list = sales.salesQuery({ from, to, products: req.query.product ? [req.query.product] : [] });
  if (req.query.status) list = list.filter(s => s.status === req.query.status);
  if (req.query.q) { const q = req.query.q.toLowerCase(); list = list.filter(s => [s.order_id, s.product, s.utm_campaign, s.utm_content].some(v => v && v.toLowerCase().includes(q))); }
  res.json({ total: list.length, rows: list.slice(0, 500).map(({ raw, ...s }) => s) });
});

// ---------- start ----------
if (DEMO) {
  if (!db.prepare('SELECT COUNT(*) n FROM tokens').get().n) {
    const tid = db.prepare('INSERT INTO tokens(label, access_token) VALUES (?,?)').run('Demo', 'demo-token-ficticio-000000').lastInsertRowid;
    for (const a of demo.accounts()) db.prepare('INSERT OR IGNORE INTO ad_accounts(id,name,currency,timezone,account_status,token_id,enabled) VALUES (?,?,?,?,?,?,1)').run(a.id, a.name, a.currency, a.timezone, a.account_status, tid);
    db.prepare('INSERT INTO operations(name, account_ids, products) VALUES (?,?,?)').run('Excel', JSON.stringify(['act_100001', 'act_100003']), '[]');
    db.prepare('INSERT INTO operations(name, account_ids, products) VALUES (?,?,?)').run('Emagrecimento', JSON.stringify(['act_100002']), JSON.stringify(['Método Seca 21']));
  }
  demo.seedSales(db, sales.insertSale);
}

if (!process.env.APP_PASSWORD) console.warn('⚠️  Defina APP_PASSWORD no arquivo .env');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => console.log(`Painel rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${DEMO ? ' (modo demo)' : ''}`));
