import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const FEE = 'http://localhost:4001';
const BANK = 'http://localhost:4002';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(file, env) {
  const p = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: 'ignore' });
  p.done = new Promise((r) => p.once('exit', r));
  return p;
}
const stop = async (...ps) => { for (const p of ps) { if (p.exitCode === null && p.signalCode === null) { p.kill(); await p.done; } } };

async function call(method, url, body) {
  const t = performance.now();
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    return { code: res.status, json: await res.json().catch(() => null), ms: Math.round(performance.now() - t) };
  } catch (e) {
    return { code: 0, json: { error: e.cause?.code ?? e.message }, ms: Math.round(performance.now() - t) };
  }
}
const pay = (amount = 1000, id = 1) => call('POST', `${FEE}/students/${id}/payments`, { amount });
const fees = (id = 1) => call('GET', `${FEE}/students/${id}/fees`);
const stats = async () => (await call('GET', `${BANK}/stats`)).json;
async function up(url) { for (let i = 0; i < 100; i++) { if ((await call('GET', url)).code) return; await sleep(50); } throw new Error(`${url} không lên`); }
const feeUp = () => up(`${FEE}/students/1/fees`);
const bankUp = () => up(`${BANK}/stats`);
const count = (rs, code) => rs.filter((r) => r.code === code).length;
const max = (rs) => Math.max(...rs.map((r) => r.ms));

async function pool(n, conc, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (i < n) { i++; out.push(await fn()); } }));
  return out;
}

async function withServices(naive, bankEnv, fn, feeEnv = {}) {
  const bank = start('bank.mjs', bankEnv);
  const fee = start('fee.mjs', { ...feeEnv, ...(naive ? { NAIVE: '1' } : {}) });
  try { await bankUp(); await feeUp(); return await fn(); } finally { await stop(fee, bank); }
}

async function s1(naive) {
  const env = naive ? { NAIVE: '1' } : {};
  const fee = start('fee.mjs', env);
  let bank;
  try {
    await feeUp();
    const down = await pay();
    const feesWhileDown = await fees();
    bank = start('bank.mjs', {});
    await bankUp();
    const afterUp = await pay();
    await stop(fee, bank);
    const fee2 = start('fee.mjs', { ...env, BANK_URL: 'http://localhost:4999' });
    await feeUp();
    const wrongUrl = await pay();
    await stop(fee2);
    const r = {
      bankDown: { code: down.code, ms: down.ms, body: down.json },
      feesWhileDown: { code: feesWhileDown.code, ms: feesWhileDown.ms },
      afterBankUp: { code: afterUp.code, status: afterUp.json?.status },
      bankUrl4999: { code: wrongUrl.code, ms: wrongUrl.ms },
    };
    r.pass = {
      '503 + JSON error trong < 1,5s': down.code === 503 && !!down.json?.error && down.ms < 1500,
      'GET fees vẫn 200 nhanh': feesWhileDown.code === 200 && feesWhileDown.ms < 300,
      'Bank lên lại → 201 không restart Fee': afterUp.code === 201,
      'BANK_URL=:4999 hành vi giống': wrongUrl.code === 503 && wrongUrl.ms < 1500,
    };
    return r;
  } finally { await stop(fee, ...(bank ? [bank] : [])); }
}

const s2 = (naive) => withServices(naive, { DELAY_MS: '5000' }, async () => {
  const one = await pay();
  const burst = Array.from({ length: 20 }, () => pay());
  await sleep(300);
  const f = await fees();
  const rs = await Promise.all(burst);
  const r = {
    single: { code: one.code, status: one.json?.status, ms: one.ms },
    burst20: { codes: { 504: count(rs, 504), 201: count(rs, 201), other: rs.length - count(rs, 504) - count(rs, 201) }, maxMs: max(rs) },
    feesDuringBurst: { code: f.code, ms: f.ms },
  };
  r.pass = {
    '504 + PENDING': one.code === 504 && one.json?.status === 'PENDING' && count(rs, 504) === 20,
    'Tổng thời gian ≤ 4,5s': one.ms <= 4500 && max(rs) <= 4500,
    'GET fees < 300ms khi 20 lệnh đang chờ': f.code === 200 && f.ms < 300,
  };
  return r;
});

const s3 = (naive) => withServices(naive, {}, async () => {
  const t = performance.now();
  const rs = await pool(200, 10, () => pay(1000));
  const totalMs = Math.round(performance.now() - t);
  const conn200 = (await stats()).connections;
  await sleep(6000);
  const after = [];
  for (let i = 0; i < 5; i++) after.push(await pay(1000));
  const st = await stats();
  const r = { ok200: count(rs, 201), totalMs, connectionsAfter200: conn200, okAfterIdle: count(after, 201), connectionsTotal: st.connections };
  r.pass = {
    '200/200 thành công': r.ok200 === 200,
    'Số kết nối TCP ≤ 20': conn200 <= 20,
    'Sau nhàn rỗi 6s vẫn thành công': r.okAfterIdle === 5,
  };
  return r;
});

const s4 = (naive, env) => withServices(naive, env, async () => {
  const before = (await fees()).json.debt;
  const rs = [];
  for (let i = 0; i < 60; i++) rs.push(await pay(1000));
  const paid = rs.filter((x) => x.json?.status === 'PAID').length;
  const failed = rs.filter((x) => x.code !== 201);
  const debtDrop = before - (await fees()).json.debt;
  const st = await stats();
  return {
    paid, failedCodes: [...new Set(failed.map((x) => `${x.code} ${x.json?.status ?? x.json?.error ?? ''}`))],
    bankCharges: st.charges, duplicates: st.duplicates, debtDrop, paidAmount: paid * 1000, maxMs: max(rs),
  };
});

async function s4all(naive) {
  const a = await s4(naive, { DROP_RATE: '0.3' });
  const b = await s4(naive, { FAIL_RATE: '0.3' });
  const c = await withServices(naive, {}, async () => {
    const x = await pay(25_000_000);
    return { code: x.code, status: x.json?.status, bankRequests: (await stats()).requests, ms: x.ms };
  });
  const pass = {
    '(a) duplicates = 0': a.duplicates === 0,
    '(a) ≥ 54/60 thành công': a.paid >= 54,
    '(a) lệnh lỗi trả 504 + PENDING': a.failedCodes.every((s) => s === '504 PENDING'),
    '(a) công nợ giảm đúng tiền lệnh PAID': a.debtDrop === a.paidAmount,
    '(b) ≥ 54/60 thành công': b.paid >= 54,
    '(b) không trừ tiền hai lần': b.duplicates === 0 && b.bankCharges === b.paid,
    '(c) 402 + bank nhận đúng 1 yêu cầu': c.code === 402 && c.bankRequests === 1,
    'Vẫn ≤ 4,5s': Math.max(a.maxMs, b.maxMs, c.ms) <= 4500,
  };
  return { a, b, c, pass };
}

const reconcileCase = (bankEnv) => withServices(false, bankEnv, async () => {
  const debt0 = (await fees()).json.debt;
  const x = await pay(1000);
  const pendingNow = (await fees()).json.pendingAmount;
  const t = performance.now();
  let p;
  do { await sleep(250); p = (await call('GET', `${FEE}/payments/${x.json?.paymentId}`)).json; }
  while (p?.status === 'PENDING' && performance.now() - t < 20_000);
  const f = (await fees()).json;
  return {
    payCode: x.code, payStatus: x.json?.status, pendingAmountBefore: pendingNow,
    finalStatus: p?.status, settledAfterMs: Math.round(performance.now() - t),
    debtDrop: debt0 - f.debt, pendingAmountAfter: f.pendingAmount, bankCharges: (await stats()).charges,
  };
}, { RECONCILE_MS: '1000', PENDING_EXPIRE_MS: '8000' });

async function s5() {
  const paid = await reconcileCase({ DELAY_MS: '5000' });
  const failed = await reconcileCase({ DELAY_MS: '5000', FAIL_RATE: '1' });
  const pass = {
    'Bank đã trừ tiền: PENDING -> PAID, công nợ giảm đúng': paid.payCode === 504 && paid.finalStatus === 'PAID' && paid.debtDrop === 1000 && paid.pendingAmountAfter === 0 && paid.bankCharges === 1,
    'Bank chưa trừ tiền: PENDING -> FAILED, công nợ giữ nguyên': failed.payCode === 504 && failed.finalStatus === 'FAILED' && failed.debtDrop === 0 && failed.pendingAmountAfter === 0 && failed.bankCharges === 0,
  };
  return { paid, failed, pass };
}

const results = {};
const plan = [['tinhHuong1', s1], ['tinhHuong2', s2], ['tinhHuong3', s3], ['tinhHuong4', s4all], ['doiSoatPending', s5, ['sau']]];
for (const [name, fn, modes = ['truoc', 'sau']] of plan) {
  for (const mode of modes) {
    console.log(`>> ${name} — ${mode}`);
    (results[name] ??= {})[mode] = await fn(mode === 'truoc');
    console.log(JSON.stringify(results[name][mode], null, 1));
  }
}
await writeFile('results.json', JSON.stringify(results, null, 2));
const fails = Object.entries(results).flatMap(([n, r]) => Object.entries(r.sau.pass).filter(([, ok]) => !ok).map(([k]) => `${n}: ${k}`));
console.log(fails.length ? `\nCHƯA ĐẠT (bản sau):\n${fails.join('\n')}` : '\nBản sau khi sửa: ĐẠT tất cả tiêu chí');
process.exitCode = fails.length ? 1 : 0;
