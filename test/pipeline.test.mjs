import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePage } from '../src/adapter.mjs';
import { collect } from '../src/pipeline.mjs';
import { buildReminders } from '../src/reminder.mjs';
import { RecordStore } from '../src/store.mjs';

const detailPage = (overrides = {}) => ({
  source: 'portal-east',
  observedAt: '2026-11-18T07:00:00.000Z',
  application: { id: 'A-1', memberId: 'M-1', round: 1, state: 'materials_required', revision: 1 },
  materials: [
    { id: 'id-card', state: 'accepted' },
    { id: 'photo', state: 'missing', comment: '未收到近期证件照' },
  ],
  ...overrides,
});

test('明细页规整保留来源、申请身份、审核回合和观察时间', () => {
  const records = normalizePage(detailPage());
  assert.equal(records.length, 3);
  const summary = records.find((record) => record.kind === 'application');
  const photo = records.find((record) => record.kind === 'material' && record.materialId === 'photo');
  assert.equal(summary.state, 'materials_required');
  assert.equal(summary.round, 1);
  assert.equal(photo.applicationId, 'A-1');
  assert.equal(photo.memberId, 'M-1');
  assert.equal(photo.round, 1);
  assert.equal(photo.comment, '未收到近期证件照');
  assert.equal(photo.observedAt, '2026-11-18T07:00:00.000Z');
});

test('仅总状态页只产生申请记录', () => {
  const records = normalizePage({
    source: 'portal-west',
    application: { id: 'A-2', memberId: 'M-2', round: 3, state: 'under_review' },
  });
  assert.deepEqual(records.map((record) => record.kind), ['application']);
  assert.equal(records[0].round, 3);
});

test('不完整来源记录被拒绝', () => {
  assert.throws(() => normalizePage({ source: 'p' }));
  assert.throws(() =>
    normalizePage({ source: 'p', application: { memberId: 'M-1', round: 1 }, materials: [{ id: 'x', state: 'missing' }] }),
  );
  assert.throws(() =>
    normalizePage({ source: 'p', application: { id: 'A-1', memberId: 'M-1', round: 1 }, materials: [{ id: 'x' }] }),
  );
});

test('重复身份先按回合再按修订号取舍，迟到的旧回合页不覆盖新状态', () => {
  const store = new RecordStore();
  const base = { kind: 'material', source: 'p', memberId: 'M-1', applicationId: 'A-1', materialId: 'photo' };
  store.save({ ...base, round: 2, state: 'accepted', revision: 1 });
  const late = store.save({ ...base, round: 1, state: 'missing', revision: 9 });
  assert.equal(late.state, 'accepted');
  const sameRound = store.save({ ...base, round: 2, state: 'returned', revision: 2 });
  assert.equal(sameRound.state, 'returned');
  const olderRevision = store.save({ ...base, round: 2, state: 'missing', revision: 1 });
  assert.equal(olderRevision.state, 'returned');
});

test('抓取失败页不删除既有记录，也不凭空制造缺件', async () => {
  const store = new RecordStore();
  await collect({ source: async () => ({ source: 'batch', pages: [detailPage()] }), store });

  const failed = await collect({
    source: async () => ({
      source: 'batch',
      pages: [{ source: 'portal-east', observedAt: '2026-11-18T07:20:00.000Z', error: 'gateway timeout' }],
    }),
    store,
  });
  assert.equal(failed.failures.length, 1);
  assert.equal(failed.records.length, 0);
  const member = failed.reminders.find((entry) => entry.memberId === 'M-1');
  assert.deepEqual(member.applications[0].missing.map((item) => item.materialId), ['photo']);

  const empty = await collect({
    source: async () => ({ source: 'batch', pages: [{ source: 'portal-east', error: 'dns failure' }] }),
    store: new RecordStore(),
  });
  assert.equal(empty.records.length, 0);
  assert.equal(empty.reminders.length, 0);
});

test('会员补齐后，晚到的旧审核页不会把材料再次列为缺件', async () => {
  const store = new RecordStore();
  const result = await collect({
    source: async () => ({
      source: 'batch',
      pages: [
        detailPage(),
        detailPage({
          observedAt: '2026-11-18T07:40:00.000Z',
          application: { id: 'A-1', memberId: 'M-1', round: 2, state: 'under_review', revision: 1 },
          materials: [
            { id: 'id-card', state: 'accepted' },
            { id: 'photo', state: 'accepted', comment: '补传已接收' },
          ],
        }),
        detailPage({
          observedAt: '2026-11-18T07:50:00.000Z',
          application: { id: 'A-1', memberId: 'M-1', round: 1, state: 'materials_required', revision: 2 },
          materials: [{ id: 'photo', state: 'missing', comment: '未收到近期证件照' }],
        }),
      ],
    }),
    store,
  });
  const member = result.reminders.find((entry) => entry.memberId === 'M-1');
  assert.equal(member.hasOutstanding, false);
  assert.equal(member.applications[0].round, 2);
  assert.equal(member.applications[0].missing.length, 0);
});

test('申请进入终态后旧缺件被清除，同一会员不会收到矛盾通知', async () => {
  const store = new RecordStore();
  const result = await collect({
    source: async () => [
      detailPage(),
      {
        source: 'portal-west',
        observedAt: '2026-11-18T08:00:00.000Z',
        application: { id: 'A-1', memberId: 'M-1', round: 2, state: 'approved', revision: 1 },
      },
    ],
    store,
  });
  const member = result.reminders.find((entry) => entry.memberId === 'M-1');
  const view = member.applications.find((entry) => entry.applicationId === 'A-1');
  assert.equal(view.state, 'approved');
  assert.equal(view.missing.length, 0);
  assert.equal(member.hasOutstanding, false);
});

test('材料明细落后于申请最新回合时标记 stale', async () => {
  const store = new RecordStore();
  const result = await collect({
    source: async () => ({
      source: 'batch',
      pages: [
        detailPage(),
        {
          source: 'portal-east',
          observedAt: '2026-11-18T07:30:00.000Z',
          application: { id: 'A-1', memberId: 'M-1', round: 2, state: 'materials_required', revision: 1 },
        },
      ],
    }),
    store,
  });
  const view = result.reminders.find((entry) => entry.memberId === 'M-1').applications[0];
  assert.equal(view.round, 2);
  assert.deepEqual(view.missing.map((item) => item.materialId), ['photo']);
  assert.equal(view.missing[0].round, 1);
  assert.equal(view.stale, true);
});

test('仓库自带样例批次端到端复现高峰季场景', async () => {
  const result = await collect();
  assert.equal(result.failures.length, 1);
  const byMember = Object.fromEntries(result.reminders.map((entry) => [entry.memberId, entry]));
  assert.equal(byMember['M-01'].hasOutstanding, false);
  assert.equal(byMember['M-02'].hasOutstanding, false);
  assert.equal(byMember['M-03'].hasOutstanding, true);
  const view = byMember['M-03'].applications.find((entry) => entry.applicationId === 'A-3003');
  assert.deepEqual(view.missing.map((item) => item.materialId), ['photo']);
  assert.equal(view.stale, true);
});

test('提醒视图对同一会员只输出一份一致快照', () => {
  const store = new RecordStore();
  store.save({ kind: 'application', source: 'a', memberId: 'M-1', applicationId: 'A-1', round: 2, state: 'approved', revision: 1 });
  store.save({ kind: 'material', source: 'a', memberId: 'M-1', applicationId: 'A-1', materialId: 'photo', round: 1, state: 'missing', revision: 1 });
  store.save({ kind: 'material', source: 'b', memberId: 'M-1', applicationId: 'A-1', materialId: 'photo', round: 2, state: 'accepted', revision: 1 });
  const [member] = buildReminders(store.list());
  assert.equal(member.hasOutstanding, false);
  assert.equal(member.applications[0].missing.length, 0);
});
