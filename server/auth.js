const crypto = require('crypto');

const COOKIE = 'painel_sess';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 dias

function secret() {
  return process.env.SESSION_SECRET || 'troque-este-segredo';
}
function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}
function makeToken() {
  const exp = String(Date.now() + MAX_AGE_MS);
  return `${exp}.${sign(exp)}`;
}
function validToken(tok) {
  if (!tok || !tok.includes('.')) return false;
  const [exp, sig] = tok.split('.');
  const good = sign(exp);
  if (sig.length !== good.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  return Number(exp) > Date.now();
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function passwordOk(input) {
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(String(process.env.APP_PASSWORD || '')).digest();
  return crypto.timingSafeEqual(a, b) && !!process.env.APP_PASSWORD;
}

// limite de tentativas: 5 erros a cada 15 min por IP
const attempts = new Map();
function blocked(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.first > 15 * 60 * 1000) { attempts.delete(ip); return false; }
  return a.count >= 5;
}
function fail(ip) {
  const a = attempts.get(ip) || { count: 0, first: Date.now() };
  a.count++; attempts.set(ip, a);
}

function cookieHeader(value, maxAgeSec) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`;
}

function routes(app) {
  app.post('/api/login', (req, res) => {
    const ip = req.ip;
    if (blocked(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
    if (!passwordOk(req.body && req.body.password)) {
      fail(ip);
      return res.status(401).json({ error: 'Senha incorreta' });
    }
    attempts.delete(ip);
    res.setHeader('Set-Cookie', cookieHeader(makeToken(), MAX_AGE_MS / 1000));
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    res.json({ ok: true });
  });
}

function requireAuth(req, res, next) {
  if (validToken(parseCookies(req)[COOKIE])) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'não autenticado' });
  return res.redirect('/login.html');
}

module.exports = { routes, requireAuth };
