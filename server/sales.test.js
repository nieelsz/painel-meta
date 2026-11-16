// npm test — status, valores e datas dos webhooks
process.env.DEMO_MODE = 'true'; // sales.js abre o banco; usa o demo para não criar data/painel.db
const test = require('node:test');
const assert = require('node:assert');
const { status, cents, toIso } = require('./sales');

test('status', () => {
  for (const v of ['unpaid', 'not_paid', 'NOT PAID', 'não pago', 'incomplete', 'waiting_payment', 'pending', 'billet_printed']) assert.strictEqual(status(v), 'pending', v);
  for (const v of ['paid', 'approved', 'APPROVED', 'aprovado', 'complete', 'COMPLETED', 'pago']) assert.strictEqual(status(v), 'approved', v);
  assert.strictEqual(status('refunded'), 'refunded');
  assert.strictEqual(status('chargedback'), 'chargeback');
  assert.strictEqual(status('refused'), 'canceled');
  assert.strictEqual(status('CANCELED'), 'canceled');
});

test('cents', () => {
  assert.strictEqual(cents(97), 9700);
  assert.strictEqual(cents('97.00'), 9700);
  assert.strictEqual(cents('97,00'), 9700);
  assert.strictEqual(cents('1.234,56'), 123456);
  assert.strictEqual(cents('1,234.56'), 123456);
  assert.strictEqual(cents('R$ 87,30'), 8730);
  assert.strictEqual(cents(undefined), 0);
});

test('toIso', () => {
  assert.strictEqual(toIso('2026-11-15T14:00:00+00:00'), '2026-11-15T14:00:00.000Z');
  assert.strictEqual(toIso('2026-11-15T14:00:00Z'), '2026-11-15T14:00:00.000Z');
  assert.strictEqual(toIso('2026-11-15 11:00:00'), '2026-11-15T14:00:00.000Z'); // sem fuso = Brasília
  assert.strictEqual(toIso('2026-11-15T11:00:00-0300'), '2026-11-15T14:00:00.000Z');
  assert.strictEqual(toIso('2026-11-15'), '2026-11-15T03:00:00.000Z');
  assert.strictEqual(toIso(1763215200000), '2025-11-15T14:00:00.000Z'); // milissegundos
  assert.strictEqual(toIso(1763215200), '2025-11-15T14:00:00.000Z');    // segundos
  assert.strictEqual(toIso('lixo'), undefined);
  assert.strictEqual(toIso(null), undefined);
});
