import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../src/lib/timer.js');

const MIN = 60 * 1000;
const S = { focusMin: 25, shortMin: 5, longMin: 15, roundsBeforeLong: 4, autoNext: false };

function at(min) {
  return new Date(2026, 9, 21, 9, 0, 0).getTime() + (min || 0) * MIN;
}

test('初始状态：25 分钟、idle、无结束时间', () => {
  const s = T.create(S);
  assert.equal(s.mode, 'focus');
  assert.equal(s.status, 'idle');
  assert.equal(s.totalSec, 1500);
  assert.equal(s.remainingSec, 1500);
  assert.equal(s.endsAt, null);
  assert.equal(s.cycle, 0);
});

test('开始后写入绝对结束时间戳，剩余时间按时间戳计算', () => {
  let s = T.start(T.create(S), at(0), 't1');
  assert.equal(s.status, 'running');
  assert.equal(s.endsAt, at(25));
  assert.equal(s.taskId, 't1');
  assert.equal(T.remaining(s, at(0)), 1500);
  assert.equal(T.remaining(s, at(10)), 900);
  assert.equal(T.remaining(s, at(24.99)), 1);
});

test('暂停冻结剩余时间，继续后不从头开始', () => {
  let s = T.start(T.create(S), at(0));
  s = T.pause(s, at(10)); // 用了 10 分钟
  assert.equal(s.status, 'paused');
  assert.equal(s.endsAt, null);
  assert.equal(s.remainingSec, 900);

  // 暂停期间时间流逝不影响剩余
  assert.equal(T.remaining(s, at(60)), 900);

  s = T.start(s, at(60));
  assert.equal(s.endsAt, at(75)); // 60 + 15 分钟剩余
  assert.equal(T.remaining(s, at(65)), 600);
});

test('未到期时 tick 原样返回，不会误结算', () => {
  const s = T.start(T.create(S), at(0));
  const r = T.tick(s, at(5), S);
  assert.equal(r.session, null);
  assert.equal(r.state, s);
});

test('专注自然结束：产生一条 session，并进入短休息', () => {
  // 直接模拟「休眠 40 分钟后回来」
  const s = T.start(T.create(S), at(0));
  const r = T.tick(s, at(40), S);

  assert.ok(r.session, '应该产生 session');
  assert.equal(r.session.durationSec, 1500);
  assert.equal(r.session.endedAt, at(40));
  assert.equal(r.state.mode, 'short');
  assert.equal(r.state.status, 'idle');
  assert.equal(r.state.cycle, 1);
  assert.equal(r.state.totalSec, 300);
});

test('第 4 个专注结束后进入长休息', () => {
  let s = T.create(S);
  for (let i = 1; i <= 4; i++) {
    s = T.start(s, at(0));
    const r = T.tick(s, at(30), S);
    s = r.state;
    if (i < 4) {
      assert.equal(s.mode, 'short', '第 ' + i + ' 个之后应是短休息');
      s = T.start(s, at(31));
      s = T.tick(s, at(40), S).state; // 休息结束
      assert.equal(s.mode, 'focus');
    } else {
      assert.equal(s.mode, 'long', '第 4 个之后应是长休息');
    }
  }
  assert.equal(s.cycle, 4);
});

test('休息结束回到专注，且不记录 session', () => {
  let s = T.setMode(T.create(S), 'short', S);
  s = T.start(s, at(0));
  const r = T.tick(s, at(6), S);
  assert.equal(r.session, null);
  assert.equal(r.state.mode, 'focus');
  assert.equal(r.state.cycle, 0);
});

test('跳过不记账；跳过专注进休息，跳过休息回专注', () => {
  const s = T.start(T.create(S), at(0));
  const skipped = T.skip(s, S);
  assert.equal(skipped.mode, 'short');
  assert.equal(skipped.status, 'idle');
  assert.equal(skipped.cycle, 0);

  const back = T.skip(T.setMode(s, 'short', S), S);
  assert.equal(back.mode, 'focus');
});

test('autoNext 打开时下一阶段自动开始', () => {
  const s = T.start(T.create(S), at(0));
  const r = T.tick(s, at(25), Object.assign({}, S, { autoNext: true }));
  assert.equal(r.state.status, 'running');
  assert.equal(r.state.mode, 'short');
  assert.equal(r.state.endsAt, at(30));
});

test('进度环：0 → 0.5 → 1', () => {
  const s = T.start(T.create(S), at(0));
  assert.equal(T.progress(s, at(0)), 0);
  assert.equal(T.progress(s, at(12.5)), 0.5);
  assert.equal(T.progress(s, at(30)), 1);
});

test('reset 回到满时长并清空起始时间', () => {
  const s = T.reset(T.start(T.create(S), at(0)));
  assert.equal(s.status, 'idle');
  assert.equal(s.remainingSec, s.totalSec);
  assert.equal(s.startedAt, null);
});

test('setMode 切换阶段保留任务绑定与周期计数', () => {
  let s = T.start(T.create(S), at(0), 't9');
  s = Object.assign({}, s, { cycle: 2, status: 'idle' });
  const long = T.setMode(s, 'long', S);
  assert.equal(long.mode, 'long');
  assert.equal(long.totalSec, 900);
  assert.equal(long.taskId, 't9');
  assert.equal(long.cycle, 2);
});

test('设置变更只在 idle 时同步时长，运行中不打断', () => {
  const idle = T.create(S);
  const updated = T.applySettings(idle, Object.assign({}, S, { focusMin: 50 }));
  assert.equal(updated.totalSec, 3000);
  assert.equal(updated.remainingSec, 3000);

  const running = T.start(idle, at(0));
  const untouched = T.applySettings(running, Object.assign({}, S, { focusMin: 50 }));
  assert.equal(untouched, running);
});

test('时长配置被夹在合法区间内', () => {
  assert.equal(T.modeDurationSec('focus', { focusMin: 0 }), 60);
  assert.equal(T.modeDurationSec('focus', { focusMin: 999 }), 120 * 60);
  assert.equal(T.modeDurationSec('short', { shortMin: 'abc' }), 5 * 60);
  assert.equal(T.roundsBeforeLong({ roundsBeforeLong: 99 }), 8);
});

test('formatClock 补零', () => {
  assert.equal(T.formatClock(0), '00:00');
  assert.equal(T.formatClock(65), '01:05');
  assert.equal(T.formatClock(1500), '25:00');
});
