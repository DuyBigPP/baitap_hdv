import express from 'express';
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 4001);
const BANK_URL = process.env.BANK_URL ?? 'http://localhost:4002';
const NAIVE = process.env.NAIVE === '1';
const DEADLINE_MS = 4000;
const MAX_ATTEMPTS = 5;

const agent = NAIVE
  ? new http.Agent({ keepAlive: false })
  : new http.Agent({ keepAlive: true, maxSockets: 50, timeout: 4000 });

const students = new Map([
  ['1', { debt: 50_000_000, reserved: 0 }],
  ['2', { debt: 0, reserved: 0 }],
  ['3', { debt: 3_200_000, reserved: 0 }],
]);
const payments = new Map();
let seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function postCharge(body, key, signal) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    if (key) headers['idempotency-key'] = key;
    let sent = false;
    const req = http.request(new URL('/charges', BANK_URL), { method: 'POST', agent, headers, signal }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ code: res.statusCode, body: parse(data) }));
      res.on('error', (e) => reject(Object.assign(e, { sent: true })));
    });
    req.on('socket', (s) => {
      if (s.connecting) s.once('connect', () => (sent = true));
      else sent = true;
    });
    req.on('error', (e) => reject(Object.assign(e, { sent })));
    req.end(body);
  });
}

const fromBank = (r) =>
  r.code === 201
    ? { http: 201, status: 'PAID', chargeId: r.body?.chargeId }
    : { http: r.code, status: 'FAILED', error: r.body?.error ?? `Ngân hàng trả ${r.code}` };

async function chargeNaive(p) {
  try {
    return fromBank(await postCharge(JSON.stringify({ reference: p.id, amount: p.amount })));
  } catch (e) {
    return { http: 500, status: 'FAILED', error: e.message };
  }
}

async function charge(p) {
  const body = JSON.stringify({ reference: p.id, amount: p.amount });
  const end = Date.now() + DEADLINE_MS;
  const signal = AbortSignal.timeout(DEADLINE_MS);
  let maybeCharged = false;
  let last = '';
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      const r = await postCharge(body, p.id, signal);
      if (r.code < 500) return fromBank(r);
      last = `Ngân hàng lỗi ${r.code}`;
    } catch (e) {
      maybeCharged ||= e.sent;
      last = signal.aborted ? 'Hết thời gian chờ ngân hàng' : `Lỗi kết nối ngân hàng: ${e.code ?? e.message}`;
      if (signal.aborted || !e.sent) break;
    }
    const backoff = 50 * 2 ** i;
    if (Date.now() + backoff >= end) break;
    await sleep(backoff);
  }
  return maybeCharged
    ? { http: 504, status: 'PENDING', error: `${last} — chưa rõ đã trừ tiền hay chưa` }
    : { http: 503, status: 'FAILED', error: `${last} — chưa trừ tiền` };
}

const app = express();
app.use(express.json());

app.get('/students/:id/fees', (req, res) => {
  const s = students.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy sinh viên' });
  res.json({ studentId: req.params.id, debt: s.debt, pendingAmount: s.reserved });
});

app.post('/students/:id/payments', async (req, res) => {
  const s = students.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy sinh viên', paymentId: null, status: 'FAILED' });
  const amount = req.body?.amount;
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Số tiền không hợp lệ', paymentId: null, status: 'FAILED' });
  }
  if (amount > s.debt - s.reserved) {
    return res.status(400).json({ error: 'Số tiền vượt công nợ', paymentId: null, status: 'FAILED' });
  }

  const p = { id: `P${++seq}`, studentId: req.params.id, amount, status: 'PENDING' };
  payments.set(p.id, p);
  s.reserved += amount;

  const r = await (NAIVE ? chargeNaive(p) : charge(p));
  p.status = r.status;
  if (r.status !== 'PENDING') s.reserved -= amount;
  if (r.status === 'PAID') s.debt -= amount;

  if (r.http === 201) return res.status(201).json({ paymentId: p.id, status: 'PAID', amount, chargeId: r.chargeId, debt: s.debt });
  res.status(r.http).json({ error: r.error, paymentId: p.id, status: r.status });
});

app.listen(PORT, () => console.log(`[fee] :${PORT} BANK_URL=${BANK_URL}${NAIVE ? ' (NAIVE)' : ''}`));
