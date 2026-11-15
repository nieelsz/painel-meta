// Modo demonstração: dados fictícios para testar o painel sem token da Meta.
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = hash(String(seed)); return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const ACCOUNTS = [
  { id: 'act_100001', name: 'BM Principal — Infoprodutos', currency: 'BRL', timezone: 'America/Sao_Paulo', account_status: 1 },
  { id: 'act_100002', name: 'BM 2 — Emagrecimento', currency: 'BRL', timezone: 'America/Sao_Paulo', account_status: 1 },
  { id: 'act_100003', name: 'Contingência 01', currency: 'BRL', timezone: 'America/Sao_Paulo', account_status: 1 },
];
const PRODUCTS = {
  act_100001: [['Curso Excel Pro', 9700], ['Pack Planilhas Premium', 4700]],
  act_100002: [['Método Seca 21', 19700]],
  act_100003: [['Curso Excel Pro', 9700]],
};
const CAMP_NAMES = {
  act_100001: ['[CBO] Excel Pro | Broad | Vendas', '[ABO] Excel Pro | Interesses', '[CBO] Planilhas | LAL 1% Compradores', '[CBO] Excel Pro | Remarketing 30d'],
  act_100002: ['[CBO] Seca 21 | Broad Mulheres 25-45', '[ABO] Seca 21 | Criativos Teste', '[CBO] Seca 21 | Advantage+'],
  act_100003: ['[CBO] Excel Pro | Escala', '[ABO] Excel Pro | Teste Público'],
};

// árvore em memória (status/orçamento alteráveis)
const tree = { campaigns: [], adsets: [], ads: [] };
(function build() {
  for (const acc of ACCOUNTS) {
    CAMP_NAMES[acc.id].forEach((name, ci) => {
      const r = rng(acc.id + name);
      const cbo = name.includes('[CBO]');
      const cid = `${acc.id.slice(4)}${ci + 1}0000`;
      const product = PRODUCTS[acc.id][name.includes('Planilhas') ? 1 : 0];
      const camp = { id: cid, name, account_id: acc.id, status: r() < 0.8 ? 'ACTIVE' : 'PAUSED', cbo,
        daily_budget: cbo ? Math.round((80 + r() * 600) / 10) * 1000 : null, product,
        quality: 0.6 + r() * 0.9 };
      tree.campaigns.push(camp);
      for (let s = 0; s < 2; s++) {
        const sid = `${cid.slice(0, -2)}${s + 1}0`;
        const set = { id: sid, name: ['Público Aberto', 'LAL 1-3%', 'Interesse Empreendedorismo', 'Engajou 90d'][(ci + s) % 4],
          campaign_id: cid, account_id: acc.id, status: r() < 0.85 ? 'ACTIVE' : 'PAUSED',
          daily_budget: cbo ? null : Math.round((40 + r() * 250) / 10) * 1000 };
        tree.adsets.push(set);
        for (let a = 0; a < 3; a++) {
          tree.ads.push({ id: `${sid.slice(0, -1)}${a + 1}`, name: `AD0${a + 1} — ${['Vídeo depoimento', 'Carrossel benefícios', 'Imagem oferta', 'Vídeo UGC'][(s + a) % 4]}`,
            adset_id: sid, campaign_id: cid, account_id: acc.id, status: r() < 0.85 ? 'ACTIVE' : 'PAUSED', w: 0.5 + r() });
        }
      }
    });
  }
})();

const find = id => tree.campaigns.find(x => x.id === id) || tree.adsets.find(x => x.id === id) || tree.ads.find(x => x.id === id);

function days(from, to) {
  const out = []; const d = new Date(from + 'T12:00:00Z'); const end = new Date(to + 'T12:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
function todayStr() { return new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ_PAINEL || 'America/Sao_Paulo' }); }

function campBudget(c) {
  if (c.daily_budget) return c.daily_budget;
  return tree.adsets.filter(s => s.campaign_id === c.id && s.status === 'ACTIVE').reduce((t, s) => t + s.daily_budget, 0);
}

// métricas de uma campanha num dia
function campDay(c, day) {
  const r = rng(c.id + day);
  const today = todayStr();
  if (day > today) return null;
  let factor = 0.75 + r() * 0.3;
  if (day === today) {
    if (c.status !== 'ACTIVE') return null;
    const h = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
    factor *= Math.max(h, 1) / 24;
  }
  const spend = campBudget(c) / 100 * factor;
  const cpm = 22 + r() * 25;
  const impressions = Math.round(spend / cpm * 1000);
  const clicks = Math.round(impressions * (0.011 + r() * 0.014));
  const lpv = Math.round(clicks * (0.68 + r() * 0.15));
  const ic = Math.round(lpv * (0.08 + r() * 0.08) * c.quality);
  const purchases = Math.round(ic * (0.3 + r() * 0.15));
  return { spend, impressions, clicks, lpv, ic, purchases, purchase_value: purchases * c.product[1] / 100 };
}

function aggregate(list) {
  const t = { spend: 0, impressions: 0, clicks: 0, lpv: 0, ic: 0, purchases: 0, purchase_value: 0 };
  for (const m of list) if (m) for (const k in t) t[k] += m[k];
  t.cpc = t.clicks ? t.spend / t.clicks : 0; t.ctr = t.impressions ? t.clicks / t.impressions * 100 : 0; t.cpm = t.impressions ? t.spend / t.impressions * 1000 : 0;
  return t;
}
function scale(m, f) { const o = {}; for (const k in m) o[k] = ['cpc', 'ctr', 'cpm'].includes(k) ? m[k] : m[k] * f; return o; }

function campRange(c, from, to) { return aggregate(days(from, to).map(d => campDay(c, d))); }

module.exports = {
  accounts: () => ACCOUNTS,
  accountDetails: id => {
    const a = ACCOUNTS.find(x => x.id === id);
    return { ...a, amount_spent: String(Math.round(hash(id) % 900000) * 100), balance: '0', spend_cap: null, disable_reason: 0 };
  },
  accountDaily: (id, from, to) => days(from, to).map(day => {
    const m = aggregate(tree.campaigns.filter(c => c.account_id === id).map(c => campDay(c, day)));
    return { day, ...m };
  }),
  listEntities: (accountId, level, parentId, from, to) => {
    if (level === 'campaign') {
      return tree.campaigns.filter(c => c.account_id === accountId).map(c => ({
        id: c.id, name: c.name, level, account_id: accountId, status: c.status, effective_status: c.status,
        campaign_id: c.id, daily_budget: c.daily_budget, lifetime_budget: null, objective: 'OUTCOME_SALES', metrics: campRange(c, from, to),
      }));
    }
    if (level === 'adset') {
      return tree.adsets.filter(s => s.account_id === accountId && (!parentId || s.campaign_id === parentId)).map(s => {
        const c = find(s.campaign_id); const sib = tree.adsets.filter(x => x.campaign_id === c.id);
        const share = c.cbo ? 1 / sib.length : s.daily_budget / Math.max(sib.reduce((t, x) => t + x.daily_budget, 0), 1);
        return { id: s.id, name: s.name, level, account_id: accountId, status: s.status,
          effective_status: c.status !== 'ACTIVE' ? 'CAMPAIGN_PAUSED' : s.status, campaign_id: c.id, adset_id: s.id,
          daily_budget: s.daily_budget, lifetime_budget: null, objective: 'OFFSITE_CONVERSIONS', metrics: scale(campRange(c, from, to), share) };
      });
    }
    return tree.ads.filter(a => a.account_id === accountId && (!parentId || a.adset_id === parentId)).map(a => {
      const c = find(a.campaign_id); const s = find(a.adset_id);
      const sib = tree.ads.filter(x => x.adset_id === s.id); const wt = sib.reduce((t, x) => t + x.w, 0);
      const sets = tree.adsets.filter(x => x.campaign_id === c.id);
      return { id: a.id, name: a.name, level, account_id: accountId, status: a.status,
        effective_status: c.status !== 'ACTIVE' ? 'CAMPAIGN_PAUSED' : s.status !== 'ACTIVE' ? 'ADSET_PAUSED' : a.status,
        campaign_id: c.id, adset_id: s.id, daily_budget: null, lifetime_budget: null, thumbnail: null,
        metrics: scale(campRange(c, from, to), (1 / sets.length) * (a.w / wt)) };
    });
  },
  setStatus: (id, status) => { const e = find(id); if (!e) throw new Error('não encontrado'); e.status = status; return { success: true }; },
  setBudget: (id, cents) => { const e = find(id); if (!e) throw new Error('não encontrado'); e.daily_budget = cents; return { success: true }; },
  duplicate: (id) => {
    const e = find(id); if (!e) throw new Error('não encontrado');
    if (tree.campaigns.includes(e)) { tree.campaigns.push({ ...e, id: e.id + '9', name: e.name + ' - Cópia', status: 'PAUSED' }); }
    else if (tree.adsets.includes(e)) { tree.adsets.push({ ...e, id: e.id + '9', name: e.name + ' - Cópia', status: 'PAUSED' }); }
    else tree.ads.push({ ...e, id: e.id + '9', name: e.name + ' - Cópia', status: 'PAUSED' });
    return { success: true };
  },

  // gera vendas fictícias coerentes com as campanhas
  seedSales(db, insertSale) {
    if (db.prepare('SELECT COUNT(*) n FROM sales').get().n > 0) return;
    const STATES = [['SP', 30], ['MG', 11], ['RJ', 10], ['RS', 6], ['PR', 6], ['BA', 6], ['SC', 4], ['PE', 4], ['GO', 3], ['CE', 3], ['DF', 3], ['PA', 2], ['ES', 2], ['MT', 2], ['MS', 2], ['AM', 1], ['MA', 1], ['PB', 1], ['RN', 1], ['AL', 1], ['PI', 1], ['SE', 1], ['TO', 1], ['RO', 1]];
    const totalW = STATES.reduce((t, s) => t + s[1], 0);
    const pickState = r => { let x = r() * totalW; for (const [s, w] of STATES) { if ((x -= w) < 0) return s; } return 'SP'; };
    const HOURS = [1, 1, 0.5, 0.3, 0.3, 0.4, 1, 2, 4, 5, 6, 6, 6, 6, 6, 6, 6, 7, 8, 9, 10, 9, 7, 4];
    const today = todayStr();
    const nowH = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
    const start = new Date(); start.setDate(start.getDate() - 60);
    const tx = db.transaction(() => {
      for (const day of days(start.toISOString().slice(0, 10), today)) {
        for (const c of tree.campaigns) {
          const m = campDay(c, day); if (!m) continue;
          const r = rng('s' + c.id + day);
          const initiated = Math.round(m.ic * (0.42 + r() * 0.1));
          const ads = tree.ads.filter(a => a.campaign_id === c.id);
          for (let i = 0; i < initiated; i++) {
            const pm = r(); const method = pm < 0.62 ? 'pix' : pm < 0.93 ? 'card' : 'boleto';
            const appr = { pix: 0.78, card: 0.88, boleto: 0.35 }[method];
            const q = r(); let status = q < appr ? 'approved' : 'pending';
            if (status === 'approved' && r() < 0.035) status = 'refunded';
            if (status === 'approved' && method === 'card' && r() < 0.006) status = 'chargeback';
            let hour; let x = r() * HOURS.reduce((a, b) => a + b, 0); for (hour = 0; hour < 24; hour++) { if ((x -= HOURS[hour]) < 0) break; }
            hour = Math.min(hour, 23);
            if (day === today && hour > nowH) hour = Math.floor(r() * (nowH + 1));
            const ad = ads[Math.floor(r() * ads.length)];
            const gross = c.product[1]; const net = Math.round(gross * (method === 'card' ? 0.9 : 0.93) - 249);
            const created = new Date(`${day}T${String(hour).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}:00-03:00`).toISOString();
            insertSale({ platform: 'demo', order_id: `${c.id}-${day}-${i}`, status, payment_method: method, product: c.product[0],
              gross_cents: gross, net_cents: net, customer_state: pickState(r), utm_source: 'FB', utm_medium: `${ad.adset_id}`,
              utm_campaign: `${c.name}|${c.id}`, utm_content: `${ad.name}|${ad.id}`, utm_term: 'Instagram_Reels', created_at: created, raw: null });
          }
        }
      }
    });
    tx();
  },
};
