// Integração com a Meta Marketing API (Graph API)
const { db } = require('./db');
const demo = require('./demo');

const VERSION = () => process.env.META_API_VERSION || 'v23.0';
const DEMO = () => process.env.DEMO_MODE === 'true';

const cache = new Map();
const TTL = 60 * 1000;
function cached(key, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < TTL) return c.p;
  const p = fn().catch(e => { cache.delete(key); throw e; });
  cache.set(key, { t: Date.now(), p });
  return p;
}
function clearCache() { cache.clear(); }

async function graph(path, params = {}, token, method = 'GET') {
  const base = path.startsWith('http') ? path : `https://graph.facebook.com/${VERSION()}/${path}`;
  const url = new URL(base);
  let body;
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : v);
    if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', token);
  } else {
    body = new URLSearchParams({ ...params, access_token: token });
  }
  const r = await fetch(url, { method, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const msg = j.error ? (j.error.error_user_msg || j.error.message) : `HTTP ${r.status}`;
    const err = new Error(`Meta: ${msg}`);
    err.status = 400;
    throw err;
  }
  return j;
}

async function graphAll(path, params, token, maxPages = 10) {
  let j = await graph(path, params, token);
  const out = [...(j.data || [])];
  let pages = 1;
  while (j.paging && j.paging.next && pages < maxPages) {
    j = await graph(j.paging.next, {}, token);
    out.push(...(j.data || []));
    pages++;
  }
  return out;
}

function tokenFor(accountId) {
  const r = db.prepare('SELECT t.access_token FROM ad_accounts a JOIN tokens t ON t.id=a.token_id WHERE a.id=?').get(accountId);
  if (!r) { const e = new Error('Conta de anúncio não cadastrada'); e.status = 404; throw e; }
  return r.access_token;
}

// ---------- parse de métricas ----------
const PICK = {
  lpv: ['landing_page_view', 'omni_landing_page_view'],
  ic: ['omni_initiated_checkout', 'offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout'],
  purchase: ['omni_purchase', 'offsite_conversion.fb_pixel_purchase', 'purchase'],
};
function pickAction(list, types) {
  if (!Array.isArray(list)) return 0;
  for (const t of types) {
    const a = list.find(x => x.action_type === t);
    if (a) return Number(a.value) || 0;
  }
  return 0;
}
function parseInsights(row) {
  row = row || {};
  const spend = Number(row.spend) || 0;
  const impressions = Number(row.impressions) || 0;
  const clicks = Number(row.inline_link_clicks) || 0;
  const m = {
    spend, impressions, clicks,
    lpv: pickAction(row.actions, PICK.lpv),
    ic: pickAction(row.actions, PICK.ic),
    purchases: pickAction(row.actions, PICK.purchase),
    purchase_value: pickAction(row.action_values, PICK.purchase),
  };
  m.cpc = clicks ? spend / clicks : 0;
  m.ctr = impressions ? (clicks / impressions) * 100 : 0;
  m.cpm = impressions ? (spend / impressions) * 1000 : 0;
  return m;
}
function sumMetrics(list) {
  const t = { spend: 0, impressions: 0, clicks: 0, lpv: 0, ic: 0, purchases: 0, purchase_value: 0 };
  for (const m of list) for (const k in t) t[k] += m[k] || 0;
  return t;
}

const INS_FIELDS = 'spend,impressions,inline_link_clicks,actions,action_values';
const LIVE_STATUSES = ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES',
  'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO'];

// ---------- API pública ----------
async function discoverAccounts(token) {
  if (DEMO()) return demo.accounts();
  const list = await graphAll('me/adaccounts', { fields: 'id,name,currency,timezone_name,account_status', limit: 200 }, token);
  return list.map(a => ({ id: a.id, name: a.name, currency: a.currency, timezone: a.timezone_name, account_status: a.account_status }));
}

async function accountDetails(accountId) {
  if (DEMO()) return demo.accountDetails(accountId);
  const token = tokenFor(accountId);
  return cached(`det:${accountId}`, () =>
    graph(accountId, { fields: 'id,name,account_status,disable_reason,currency,amount_spent,balance,spend_cap' }, token));
}

// gasto diário + funil da conta
async function accountDaily(accountId, from, to) {
  if (DEMO()) return demo.accountDaily(accountId, from, to);
  const token = tokenFor(accountId);
  return cached(`daily:${accountId}:${from}:${to}`, async () => {
    const rows = await graphAll(`${accountId}/insights`, {
      level: 'account', time_increment: 1, fields: INS_FIELDS,
      time_range: { since: from, until: to }, limit: 500,
    }, token);
    return rows.map(r => ({ day: r.date_start, ...parseInsights(r) }));
  });
}

// lista campanhas / conjuntos / anúncios com métricas do período
async function listEntities(accountId, level, parentId, from, to) {
  if (DEMO()) return demo.listEntities(accountId, level, parentId, from, to);
  const token = tokenFor(accountId);
  const edge = { campaign: 'campaigns', adset: 'adsets', ad: 'ads' }[level];
  if (!edge) throw Object.assign(new Error('nível inválido'), { status: 400 });
  const base = parentId ? `${parentId}/${edge}` : `${accountId}/${edge}`;
  const ins = `insights.time_range(${JSON.stringify({ since: from, until: to })}){${INS_FIELDS}}`;
  const extra = {
    campaign: 'objective,daily_budget,lifetime_budget,budget_remaining',
    adset: 'campaign_id,daily_budget,lifetime_budget,budget_remaining,optimization_goal',
    ad: 'campaign_id,adset_id,creative{thumbnail_url}',
  }[level];
  return cached(`ent:${base}:${from}:${to}`, async () => {
    const rows = await graphAll(base, {
      fields: `id,name,status,effective_status,${extra},${ins}`,
      filtering: [{ field: 'effective_status', operator: 'IN', value: LIVE_STATUSES }],
      limit: 200,
    }, token);
    return rows.map(r => ({
      id: r.id, name: r.name, level, account_id: accountId,
      status: r.status, effective_status: r.effective_status,
      campaign_id: level === 'campaign' ? r.id : r.campaign_id,
      adset_id: level === 'ad' ? r.adset_id : (level === 'adset' ? r.id : null),
      daily_budget: r.daily_budget ? Number(r.daily_budget) : null,
      lifetime_budget: r.lifetime_budget ? Number(r.lifetime_budget) : null,
      objective: r.objective || r.optimization_goal || null,
      thumbnail: r.creative && r.creative.thumbnail_url || null,
      metrics: parseInsights(r.insights && r.insights.data && r.insights.data[0]),
    }));
  });
}

async function setStatus(accountId, id, status) {
  if (!['ACTIVE', 'PAUSED'].includes(status)) throw Object.assign(new Error('status inválido'), { status: 400 });
  clearCache();
  if (DEMO()) return demo.setStatus(id, status);
  return graph(id, { status }, tokenFor(accountId), 'POST');
}

async function setBudget(accountId, id, cents, kind = 'daily') {
  cents = Math.round(Number(cents));
  if (!cents || cents < 100) throw Object.assign(new Error('orçamento inválido'), { status: 400 });
  clearCache();
  if (DEMO()) return demo.setBudget(id, cents, kind);
  const field = kind === 'lifetime' ? 'lifetime_budget' : 'daily_budget';
  return graph(id, { [field]: cents }, tokenFor(accountId), 'POST');
}

async function duplicate(accountId, id, level) {
  clearCache();
  if (DEMO()) return demo.duplicate(id, level);
  // cria a cópia pausada para revisão antes de ativar
  return graph(`${id}/copies`, { status_option: 'PAUSED', ...(level !== 'ad' ? { deep_copy: 'true' } : {}) }, tokenFor(accountId), 'POST');
}

module.exports = { discoverAccounts, accountDetails, accountDaily, listEntities, setStatus, setBudget, duplicate, sumMetrics, clearCache };
