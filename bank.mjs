import express from 'express';

const PORT = Number(process.env.PORT ?? 4002);
const DELAY_MS = Number(process.env.DELAY_MS ?? 0);
const FAIL_RATE = Number(process.env.FAIL_RATE ?? 0);
const DROP_RATE = Number(process.env.DROP_RATE ?? 0);
const LIMIT = 20_000_000;

const stats = { connections: 0, requests: 0, charges: 0, duplicates: 0 };
const byKey = new Map();
const byRef = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();
app.use(express.json());

app.get('/stats', (req, res) => res.json(stats));

app.get('/charges/:reference', (req, res) => {
  const charge = byRef.get(req.params.reference);
  if (!charge) return res.status(404).json({ error: 'Không có giao dịch cho reference này' });
  res.json(charge);
});

app.post('/charges', async (req, res) => {
  stats.requests++;
  if (DELAY_MS) await sleep(DELAY_MS);

  const key = req.get('Idempotency-Key');
  const old = key && byKey.get(key);
  if (old) return res.status(201).json(old);

  if (Math.random() < FAIL_RATE) return res.status(500).json({ error: 'Lỗi tạm thời của ngân hàng' });

  const { reference, amount } = req.body ?? {};
  if (!reference || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Số tiền không hợp lệ' });
  }
  if (amount > LIMIT) return res.status(402).json({ error: 'Vượt hạn mức 20.000.000đ' });

  if (byRef.has(reference)) stats.duplicates++;
  stats.charges++;
  const charge = { chargeId: `C${stats.charges}`, reference, amount };
  byRef.set(reference, charge);
  if (key) byKey.set(key, charge);

  if (Math.random() < DROP_RATE) return req.socket.destroy();
  res.status(201).json(charge);
});

const server = app.listen(PORT, () =>
  console.log(`[bank] :${PORT} DELAY_MS=${DELAY_MS} FAIL_RATE=${FAIL_RATE} DROP_RATE=${DROP_RATE}`),
);
server.on('connection', () => console.log(`[bank] kết nối TCP mới #${++stats.connections}`));
