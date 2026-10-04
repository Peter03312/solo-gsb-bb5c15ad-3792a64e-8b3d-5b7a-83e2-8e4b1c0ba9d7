import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import {
  normalizeCalibrationInput,
  evaluateCalibrationGate,
} from '../src/calibration.js';

let baseUrl;
let server;
let db;

before(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const { SCHEMA } = await import('../src/db.js');
  db.exec(SCHEMA);
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, p, body) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

const cfg = { holes: 4, tolerance: 1, holeMaxMass: [100, 100, 100, 100] };
const tube = (id, mass) => ({ id, mass, usableHoles: [0, 1, 2, 3] });

let pub1;
let v1;
let batchSeq = 0;

// 依据已发布图建立核验并完成（entries 直接按冻结图构造，必然通过）
async function completeVerificationFor(pubId) {
  const created = await call('POST', '/api/verifications', { publicationId: pubId });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const vid = created.json.id;
  const pub = await call('GET', `/api/publications/${pubId}`);
  const entries = pub.json.result.arrangement.map((s, h) => ({
    hole: h,
    ref: s ? s.ref : '',
    mass: s ? s.mass : 0,
  }));
  const saved = await call('PUT', `/api/verifications/${vid}`, { version: 1, entries });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const done = await call('POST', `/api/verifications/${vid}/complete`);
  assert.equal(done.status, 201, JSON.stringify(done.json));
  return vid;
}

// 新建一条覆盖当前时刻的宽时段预约（返回 { id, endUtc }）
async function makeReservation(endDeltaMs = 3600_000) {
  const now = Date.now();
  batchSeq += 1;
  const res = await call('POST', '/api/reservations', {
    batchNo: `CB-${batchSeq}`,
    publicationId: pub1,
    startUtc: iso(now - 3600_000),
    endUtc: iso(now + endDeltaMs),
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { id: res.json.id, endUtc: res.json.endUtc };
}

async function startRun(deviceNo, runNo, reservationId) {
  return call('POST', '/api/runs', {
    runNo,
    deviceNo,
    verificationId: v1,
    reservationId,
  });
}

async function calibCount() {
  return (await call('GET', '/api/calibrations')).json.length;
}

async function runCount() {
  return (await call('GET', '/api/runs')).json.length;
}

test('准备：发布图 + 已完成核验', async () => {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50)]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 20 }]);
  await call('POST', '/api/solve');
  const p1 = await call('POST', '/api/publish');
  assert.equal(p1.status, 201, JSON.stringify(p1.json));
  pub1 = p1.json.id;
  v1 = await completeVerificationFor(pub1);
});

test('纯函数：校准登记输入规整', () => {
  const now = Date.now();
  const ok = normalizeCalibrationInput(
    {
      calibNo: ' CAL-1 ',
      deviceNo: ' CENT-01 ',
      calibratedAtUtc: iso(now - 1000),
      expiresAtUtc: iso(now + 1000),
      result: 'pass',
    },
    now,
  );
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.clean, {
    calibNo: 'CAL-1',
    deviceNo: 'CENT-01',
    calibratedAtUtc: iso(now - 1000),
    expiresAtUtc: iso(now + 1000),
    result: 'pass',
  });

  // 校准时间恰等于服务端当前时刻：允许（不得晚于）
  const edge = normalizeCalibrationInput(
    {
      calibNo: 'C',
      deviceNo: 'D',
      calibratedAtUtc: iso(now),
      expiresAtUtc: iso(now + 1),
      result: 'fail',
    },
    now,
  );
  assert.deepEqual(edge.errors, []);

  for (const [body, hint] of [
    [null, '非对象'],
    [{}, '缺字段'],
    [
      { calibNo: ' ', deviceNo: 'D', calibratedAtUtc: iso(now - 2), expiresAtUtc: iso(now + 2), result: 'pass' },
      '空单号',
    ],
    [
      { calibNo: 'C', deviceNo: '', calibratedAtUtc: iso(now - 2), expiresAtUtc: iso(now + 2), result: 'pass' },
      '空设备',
    ],
    [
      { calibNo: 'x'.repeat(101), deviceNo: 'D', calibratedAtUtc: iso(now - 2), expiresAtUtc: iso(now + 2), result: 'pass' },
      '单号过长',
    ],
    [
      { calibNo: 'C', deviceNo: 'D', calibratedAtUtc: 'not-a-time', expiresAtUtc: iso(now + 2), result: 'pass' },
      '非法校准时间',
    ],
    [
      { calibNo: 'C', deviceNo: 'D', calibratedAtUtc: iso(now - 2), expiresAtUtc: '2026-13-01', result: 'pass' },
      '非法到期时间',
    ],
    [
      { calibNo: 'C', deviceNo: 'D', calibratedAtUtc: iso(now + 2), expiresAtUtc: iso(now - 2), result: 'pass' },
      '校准时间未早于到期时间',
    ],
    [
      { calibNo: 'C', deviceNo: 'D', calibratedAtUtc: iso(now - 2), expiresAtUtc: iso(now - 2), result: 'pass' },
      '校准时间等于到期时间',
    ],
    [
      { calibNo: 'C', deviceNo: 'D', calibratedAtUtc: iso(now + 60_000), expiresAtUtc: iso(now + 120_000), result: 'pass' },
      '校准时间晚于服务端当前时刻',
    ],
    [
      { calibNo: 'C', deviceNo: 'D', calibratedAtUtc: iso(now - 2), expiresAtUtc: iso(now + 2), result: 'ok' },
      '非法结论',
    ],
    [
      { calibNo: 'C', deviceNo: 'D', calibratedAtUtc: iso(now - 2), expiresAtUtc: iso(now + 2), result: 'PASS' },
      '结论大小写敏感',
    ],
  ]) {
    const r = normalizeCalibrationInput(body, now);
    assert.ok(r.errors.length > 0, `${hint}: ${JSON.stringify(body)}`);
    assert.equal(r.clean, null);
  }
});

test('纯函数：放行判定（无记录 / 不合格 / 有效期不足 / 边界）', () => {
  const end = '2026-10-04T12:00:00.000Z';
  // 无记录：沿用现有开始规则
  assert.deepEqual(
    evaluateCalibrationGate({ deviceNo: 'D', latest: null, reservationEndUtc: end }),
    { ok: true, errors: [] },
  );
  const base = {
    calib_no: 'CAL-1',
    calibrated_at: '2026-10-01T00:00:00.000Z',
    expires_at: '2026-10-05T00:00:00.000Z',
    result: 'pass',
  };
  // 合格且有效期覆盖预约终点
  assert.equal(
    evaluateCalibrationGate({ deviceNo: 'D', latest: base, reservationEndUtc: end }).ok,
    true,
  );
  // 到期时间恰等于预约终点：不早于 → 放行
  assert.equal(
    evaluateCalibrationGate({
      deviceNo: 'D',
      latest: { ...base, expires_at: end },
      reservationEndUtc: end,
    }).ok,
    true,
  );
  // 不合格
  const fail = evaluateCalibrationGate({
    deviceNo: 'D',
    latest: { ...base, result: 'fail' },
    reservationEndUtc: end,
  });
  assert.equal(fail.ok, false);
  assert.ok(fail.errors.join(' ').includes('不合格'));
  // 有效期不足
  const short = evaluateCalibrationGate({
    deviceNo: 'D',
    latest: { ...base, expires_at: '2026-10-04T11:59:59.999Z' },
    reservationEndUtc: end,
  });
  assert.equal(short.ok, false);
  assert.ok(short.errors.join(' ').includes('有效期不足'));
});

test('登记校准：201 新建，字段与服务端登记时刻齐全', async () => {
  const now = Date.now();
  const r = await call('POST', '/api/calibrations', {
    calibNo: 'CAL-0001',
    deviceNo: 'CENT-01',
    calibratedAtUtc: iso(now - 7200_000),
    expiresAtUtc: iso(now + 30 * 24 * 3600_000),
    result: 'pass',
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.calibNo, 'CAL-0001');
  assert.equal(r.json.deviceNo, 'CENT-01');
  assert.equal(r.json.calibratedAtUtc, iso(now - 7200_000));
  assert.equal(r.json.expiresAtUtc, iso(now + 30 * 24 * 3600_000));
  assert.equal(r.json.result, 'pass');
  assert.ok(Date.parse(r.json.createdAt) > 0);

  // 列表 / 单条 / 按设备过滤 / 状态汇总
  const list = await call('GET', '/api/calibrations');
  assert.equal(list.json.length, 1);
  const one = await call('GET', `/api/calibrations/${r.json.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.calibNo, 'CAL-0001');
  const filtered = await call('GET', '/api/calibrations?deviceNo=CENT-01');
  assert.equal(filtered.json.length, 1);
  const empty = await call('GET', '/api/calibrations?deviceNo=NO-SUCH');
  assert.equal(empty.json.length, 0);
  const state = await call('GET', '/api/state');
  assert.equal(state.json.calibrations.length, 1);

  // 设备视图携带最新校准；仅有校准记录的设备即为已知设备
  const dev = await call('GET', '/api/devices/CENT-01');
  assert.equal(dev.status, 200);
  assert.equal(dev.json.latestCalibration.calibNo, 'CAL-0001');
});

test('登记校准：非法输入 → 400 且不留校准记录', async () => {
  const now = Date.now();
  const before0 = await calibCount();
  for (const body of [
    {},
    null,
    { calibNo: '', deviceNo: 'D', calibratedAtUtc: iso(now - 2), expiresAtUtc: iso(now + 2000), result: 'pass' },
    { calibNo: 'C-X', deviceNo: ' ', calibratedAtUtc: iso(now - 2), expiresAtUtc: iso(now + 2000), result: 'pass' },
    { calibNo: 'C-X', deviceNo: 'D', calibratedAtUtc: 'bad', expiresAtUtc: iso(now + 2000), result: 'pass' },
    { calibNo: 'C-X', deviceNo: 'D', calibratedAtUtc: iso(now + 2000), expiresAtUtc: iso(now - 2), result: 'pass' },
    { calibNo: 'C-X', deviceNo: 'D', calibratedAtUtc: iso(now + 60_000), expiresAtUtc: iso(now + 120_000), result: 'pass' },
    { calibNo: 'C-X', deviceNo: 'D', calibratedAtUtc: iso(now - 2), expiresAtUtc: iso(now + 2000), result: 'unknown' },
  ]) {
    const r = await call('POST', '/api/calibrations', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(await calibCount(), before0);
});

test('幂等：同号同内容返回原记录（200），异内容拒绝（409）', async () => {
  const now = Date.now();
  const body = {
    calibNo: 'CAL-0002',
    deviceNo: 'CENT-02',
    calibratedAtUtc: iso(now - 3600_000),
    expiresAtUtc: iso(now + 3600_000),
    result: 'fail',
  };
  const first = await call('POST', '/api/calibrations', body);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const before0 = await calibCount();

  // 同号同内容（字符串形式时间等价规范化后相同）→ 200 原记录
  const replay = await call('POST', '/api/calibrations', body);
  assert.equal(replay.status, 200, JSON.stringify(replay.json));
  assert.equal(replay.json.id, first.json.id);
  assert.equal(await calibCount(), before0);

  // 同号异内容（结论 / 时间 / 设备任一不同）→ 409 附 existingId
  for (const diff of [
    { ...body, result: 'pass' },
    { ...body, expiresAtUtc: iso(now + 7200_000) },
    { ...body, deviceNo: 'CENT-09' },
    { ...body, calibratedAtUtc: iso(now - 1800_000) },
  ]) {
    const r = await call('POST', '/api/calibrations', diff);
    assert.equal(r.status, 409, JSON.stringify(diff));
    assert.equal(r.json.existingId, first.json.id);
  }
  assert.equal(await calibCount(), before0);
});

test('同设备校准时间须晚于上一条；记录只追加，不同设备互不影响', async () => {
  const now = Date.now();
  const first = await call('POST', '/api/calibrations', {
    calibNo: 'CAL-0003',
    deviceNo: 'CENT-03',
    calibratedAtUtc: iso(now - 3600_000),
    expiresAtUtc: iso(now + 3600_000),
    result: 'pass',
  });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const before0 = await calibCount();

  // 同设备：校准时间等于 / 早于上一条 → 409（附上一条记录），不留记录
  for (const t of [iso(now - 3600_000), iso(now - 7200_000)]) {
    const r = await call('POST', '/api/calibrations', {
      calibNo: `CAL-SEQ-${t}`,
      deviceNo: 'CENT-03',
      calibratedAtUtc: t,
      expiresAtUtc: iso(now + 3600_000),
      result: 'pass',
    });
    assert.equal(r.status, 409, t);
    assert.equal(r.json.detail.calibration.calibNo, 'CAL-0003');
  }
  assert.equal(await calibCount(), before0);

  // 同设备：校准时间更晚 → 201，成为最新一条
  const newer = await call('POST', '/api/calibrations', {
    calibNo: 'CAL-0004',
    deviceNo: 'CENT-03',
    calibratedAtUtc: iso(now - 1800_000),
    expiresAtUtc: iso(now + 3600_000),
    result: 'fail',
  });
  assert.equal(newer.status, 201, JSON.stringify(newer.json));
  const dev = await call('GET', '/api/devices/CENT-03');
  assert.equal(dev.json.latestCalibration.calibNo, 'CAL-0004');

  // 不同设备：校准时间早于其他设备的记录也允许（按设备各自判定）
  const other = await call('POST', '/api/calibrations', {
    calibNo: 'CAL-0005',
    deviceNo: 'CENT-04',
    calibratedAtUtc: iso(now - 7200_000),
    expiresAtUtc: iso(now + 3600_000),
    result: 'pass',
  });
  assert.equal(other.status, 201, JSON.stringify(other.json));
});

test('放行：最新结论不合格 → 409 说明不合格且不留运行', async () => {
  // CENT-03 最新一条为 fail（CAL-0004）
  const res = await makeReservation();
  const before0 = await runCount();
  const r = await startRun('CENT-03', 'CRUN-REJ-FAIL', res.id);
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(r.json.errors.join(' ').includes('不合格'));
  assert.equal(r.json.detail.calibration.calibNo, 'CAL-0004');
  assert.equal(await runCount(), before0);
});

test('放行：有效期不足（到期时间早于预约终点）→ 409 且不留运行', async () => {
  const now = Date.now();
  // CENT-05 最新记录合格，但到期时间早于预约终点
  const res = await makeReservation(4 * 3600_000);
  const reg = await call('POST', '/api/calibrations', {
    calibNo: 'CAL-0006',
    deviceNo: 'CENT-05',
    calibratedAtUtc: iso(now - 3600_000),
    expiresAtUtc: iso(now + 3600_000), // 预约终点为 now+4h
    result: 'pass',
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const before0 = await runCount();
  const r = await startRun('CENT-05', 'CRUN-REJ-EXP', res.id);
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(r.json.errors.join(' ').includes('有效期不足'));
  assert.equal(r.json.detail.calibration.calibNo, 'CAL-0006');
  assert.equal(await runCount(), before0);
});

let runOkId;
let runOkCalibId;

test('放行：合格且有效期覆盖 → 201 并冻结校准依据；到期时间恰等于预约终点亦放行', async () => {
  const now = Date.now();
  // CENT-01（已有 CAL-0001 合格，到期 now+30d）：正常放行
  const res1 = await makeReservation();
  const reg = await call('POST', '/api/calibrations', {
    calibNo: 'CAL-0007',
    deviceNo: 'CENT-01',
    calibratedAtUtc: iso(now - 1000),
    expiresAtUtc: iso(now + 30 * 24 * 3600_000),
    result: 'pass',
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  runOkCalibId = reg.json.id;
  const start = await startRun('CENT-01', 'CRUN-001', res1.id);
  assert.equal(start.status, 201, JSON.stringify(start.json));
  runOkId = start.json.id;
  const cal = start.json.frozenBasis.calibration;
  assert.equal(cal.id, runOkCalibId);
  assert.equal(cal.calibNo, 'CAL-0007');
  assert.equal(cal.result, 'pass');
  assert.equal(cal.calibratedAtUtc, iso(now - 1000));

  // CENT-06：到期时间恰等于预约终点（不早于）→ 放行
  const res2 = await makeReservation();
  const reg2 = await call('POST', '/api/calibrations', {
    calibNo: 'CAL-0008',
    deviceNo: 'CENT-06',
    calibratedAtUtc: iso(now - 1000),
    expiresAtUtc: res2.endUtc,
    result: 'pass',
  });
  assert.equal(reg2.status, 201, JSON.stringify(reg2.json));
  const start2 = await startRun('CENT-06', 'CRUN-002', res2.id);
  assert.equal(start2.status, 201, JSON.stringify(start2.json));
  assert.equal(start2.json.frozenBasis.calibration.expiresAtUtc, res2.endUtc);
  await call('POST', `/api/runs/${start2.json.id}/complete`, { outcome: 'completed' });
});

test('无校准记录设备：沿用现有开始规则，冻结校准依据为空', async () => {
  const res = await makeReservation();
  const start = await startRun('CENT-NOCAL', 'CRUN-003', res.id);
  assert.equal(start.status, 201, JSON.stringify(start.json));
  assert.equal(start.json.frozenBasis.calibration, null);
  await call('POST', `/api/runs/${start.json.id}/complete`, { outcome: 'aborted' });
});

test('冻结后新增记录、完结与超时不改写历史；同号重放不受新记录影响', async () => {
  // 运行进行中登记更新的校准记录（结论转为不合格）；
  // 校准时间取当前时刻（允许 == 服务端当前时刻），保证晚于该设备既有记录
  const newer = await call('POST', '/api/calibrations', {
    calibNo: 'CAL-0009',
    deviceNo: 'CENT-01',
    calibratedAtUtc: iso(Date.now()),
    expiresAtUtc: iso(Date.now() + 3600_000),
    result: 'fail',
  });
  assert.equal(newer.status, 201, JSON.stringify(newer.json));

  // 历史运行冻结依据不变（仍为 CAL-0007 合格）
  const during = await call('GET', `/api/runs/${runOkId}`);
  assert.equal(during.json.frozenBasis.calibration.calibNo, 'CAL-0007');
  assert.equal(during.json.frozenBasis.calibration.result, 'pass');

  // 完结不改写冻结校准依据
  const done = await call('POST', `/api/runs/${runOkId}/complete`, { outcome: 'completed' });
  assert.equal(done.status, 201, JSON.stringify(done.json));
  assert.equal(done.json.frozenBasis.calibration.calibNo, 'CAL-0007');

  // 同号同内容重放：即使设备最新校准已不合格，仍返回原记录（200）
  const orig = await call('GET', `/api/runs/${runOkId}`);
  const replay = await call('POST', '/api/runs', {
    runNo: 'CRUN-001',
    deviceNo: 'CENT-01',
    verificationId: orig.json.verificationId,
    reservationId: orig.json.reservationId,
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.json));
  assert.equal(replay.json.id, runOkId);

  // 同号异内容：409（与原约定一致）
  const resX = await makeReservation();
  const diff = await call('POST', '/api/runs', {
    runNo: 'CRUN-001',
    deviceNo: 'CENT-01',
    verificationId: orig.json.verificationId,
    reservationId: resX.id,
  });
  assert.equal(diff.status, 409);
  assert.equal(diff.json.existingId, runOkId);

  // 新运行编号：按最新一条（不合格）判定 → 409 且不留运行
  const before0 = await runCount();
  const resY = await makeReservation();
  const rejected = await startRun('CENT-01', 'CRUN-004', resY.id);
  assert.equal(rejected.status, 409, JSON.stringify(rejected.json));
  assert.ok(rejected.json.errors.join(' ').includes('不合格'));
  assert.equal(await runCount(), before0);
});

test('超时完结如实标记且不改写冻结校准依据', async () => {
  const now = Date.now();
  // 预约窗口很短（400ms 后结束）；校准有效期覆盖预约终点即可开始
  const res = await makeReservation(400);
  const reg = await call('POST', '/api/calibrations', {
    calibNo: 'CAL-0010',
    deviceNo: 'CENT-07',
    calibratedAtUtc: iso(now - 1000),
    expiresAtUtc: iso(now + 3600_000),
    result: 'pass',
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const start = await startRun('CENT-07', 'CRUN-005', res.id);
  assert.equal(start.status, 201, JSON.stringify(start.json));

  await sleep(600); // 越过预约终点
  const done = await call('POST', `/api/runs/${start.json.id}/complete`, {
    outcome: 'completed',
  });
  assert.equal(done.status, 201, JSON.stringify(done.json));
  assert.equal(done.json.timedOut, true);
  assert.equal(done.json.frozenBasis.calibration.calibNo, 'CAL-0010');
  assert.equal(done.json.frozenBasis.calibration.result, 'pass');
});

test('单条查询 404；列表包含全部设备记录', async () => {
  const notFound = await call('GET', '/api/calibrations/999999');
  assert.equal(notFound.status, 404);
  const list = await call('GET', '/api/calibrations');
  const nos = list.json.map((c) => c.calibNo);
  for (const n of ['CAL-0001', 'CAL-0004', 'CAL-0007', 'CAL-0009', 'CAL-0010']) {
    assert.ok(nos.includes(n), `缺少校准记录 ${n}`);
  }
});
