import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../src/lib/stats.js');

const MIN = 60 * 1000;

/** 用本地时间构造，避免测试依赖运行机器的时区 */
function day(y, m, d, h, min) {
  return new Date(y, m - 1, d, h || 9, min || 0, 0).getTime();
}

function session(endedAt, durationSec, taskId, mode) {
  return {
    id: 's' + endedAt,
    mode: mode || 'focus',
    taskId: taskId === undefined ? 't1' : taskId,
    startedAt: endedAt - durationSec * 1000,
    endedAt: endedAt,
    durationSec: durationSec
  };
}

const NOW = day(2026, 10, 21, 18, 0);

test('dateKey 用本地时区，不出现 UTC 偏移', () => {
  assert.equal(S.dateKey(day(2026, 10, 21, 0, 5)), '2026-10-21');
  assert.equal(S.dateKey(day(2026, 10, 21, 23, 55)), '2026-10-21');
});

test('只统计 focus，休息不计入', () => {
  const sessions = [
    session(day(2026, 10, 21, 9, 30), 1500),
    session(day(2026, 10, 21, 9, 35), 300, null, 'short')
  ];
  const sum = S.summarize(sessions, NOW);
  assert.equal(sum.todaySec, 1500);
  assert.equal(sum.todayCount, 1);
});

test('跨零点的一次专注归入结束那天', () => {
  const endedNextDay = day(2026, 10, 21, 0, 10);
  const sum = S.summarize([session(endedNextDay, 1500)], NOW);
  assert.equal(sum.todaySec, 1500);
  assert.equal(sum.totalCount, 1);
});

test('近 7 天是含今天的滚动窗口', () => {
  const sessions = [
    session(day(2026, 10, 21, 10), 600), // 今天
    session(day(2026, 10, 20, 10), 1200), // 昨天
    session(day(2026, 10, 15, 10), 300), // 6 天前，在窗口内
    session(day(2026, 10, 14, 10), 1800) // 7 天前，在窗口外
  ];
  const sum = S.summarize(sessions, NOW);
  assert.equal(sum.weekSec, 2100);
  assert.equal(sum.last7.length, 7);
  assert.equal(sum.last7[6].isToday, true);
  assert.equal(sum.last7[6].sec, 600);
});

test('近 30 天包含 30 个桶，且累加正确', () => {
  const sessions = [
    session(day(2026, 10, 21, 10), 600),
    session(day(2026, 10, 1, 10), 900),
    session(day(2026, 9, 1, 10), 900) // 超出 30 天窗口
  ];
  const sum = S.summarize(sessions, NOW);
  assert.equal(sum.last30.length, 30);
  assert.equal(sum.monthSec, 1500);
});

test('连续天数：今天有记录 → 从今天往前数', () => {
  const sessions = [
    session(day(2026, 10, 21, 10), 600),
    session(day(2026, 10, 20, 10), 600),
    session(day(2026, 10, 19, 10), 600),
    session(day(2026, 10, 17, 10), 600) // 18 号断档
  ];
  assert.equal(S.summarize(sessions, NOW).streak, 3);
});

test('连续天数：今天还没专注但有昨天的记录，仍算连续', () => {
  const sessions = [
    session(day(2026, 10, 20, 10), 600),
    session(day(2026, 10, 19, 10), 600)
  ];
  assert.equal(S.summarize(sessions, NOW).streak, 2);
});

test('连续天数：昨天和今天都没有记录 → 0', () => {
  const sessions = [session(day(2026, 10, 18, 10), 600)];
  assert.equal(S.summarize(sessions, NOW).streak, 0);
});

test('热力图分级阈值', () => {
  assert.equal(S.levelOf(0), 0);
  assert.equal(S.levelOf(10 * 60), 1);
  assert.equal(S.levelOf(25 * 60), 2);
  assert.equal(S.levelOf(50 * 60), 3);
  assert.equal(S.levelOf(90 * 60), 4);
});

test('任务维度聚合：按时长降序，未绑定归为一类', () => {
  const tasks = [
    { id: 't1', title: '写 PRD' },
    { id: 't2', title: '调样式' }
  ];
  const sessions = [
    session(day(2026, 10, 21, 10), 600, 't1'),
    session(day(2026, 10, 20, 10), 1500, 't2'),
    session(day(2026, 10, 19, 10), 300, null),
    session(day(2026, 9, 1, 10), 9999, 't1') // 超出窗口
  ];
  const rows = S.byTask(sessions, tasks, NOW, 30);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, '调样式');
  assert.equal(rows[0].sec, 1500);
  assert.equal(rows[1].title, '写 PRD');
  assert.equal(rows[1].sec, 600);
  assert.equal(rows[2].title, '未绑定任务');
});

test('已删除任务仍有历史记录时显示占位名', () => {
  const rows = S.byTask([session(day(2026, 10, 21, 10), 600, 'gone')], [], NOW, 30);
  assert.equal(rows[0].title, '已删除的任务');
});

test('humanDuration 输出人话', () => {
  assert.equal(S.humanDuration(0), '0 分钟');
  assert.equal(S.humanDuration(45), '不到 1 分钟');
  assert.equal(S.humanDuration(600), '10 分钟');
  assert.equal(S.humanDuration(3600), '1 小时');
  assert.equal(S.humanDuration(4800), '1 小时 20 分');
});

test('空数据不炸', () => {
  const sum = S.summarize([], NOW);
  assert.equal(sum.todaySec, 0);
  assert.equal(sum.streak, 0);
  assert.equal(sum.last7.length, 7);
  assert.deepEqual(S.byTask([], [], NOW), []);
});
