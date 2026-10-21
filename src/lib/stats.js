/**
 * 统计聚合 —— 纯函数。now 由调用方传入，保证可测。
 *
 * 口径（见 PRD 3.3）：
 *  - 只统计 mode === 'focus' 的 session，休息不计；
 *  - 一次专注归入「结束时间」所在的自然日；
 *  - 所有分桶按本地时区，用 YYYY-MM-DD 作为 key。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.FB = root.FB || {}).stats = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  /** 本地时区的 YYYY-MM-DD */
  function dateKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /**
   * 把 session 按天分桶。用日历日推进（而不是 ts -= 86400000），
   * 否则夏令时地区会错位一小时。
   */
  function bucketByDay(sessions) {
    const buckets = Object.create(null);
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      if (!s || s.mode !== 'focus') continue;
      const key = dateKey(s.endedAt);
      buckets[key] = (buckets[key] || 0) + (Number(s.durationSec) || 0);
    }
    return buckets;
  }

  function dayOffset(ts, offset) {
    const d = new Date(ts);
    d.setDate(d.getDate() + offset);
    return d.getTime();
  }

  /**
   * @param {Array} sessions
   * @param {number} now 当前时间戳
   * @param {Object} [opts] { days: 7, days30: 30 }
   */
  function summarize(sessions, now, opts) {
    const options = opts || {};
    const list = Array.isArray(sessions) ? sessions : [];
    const buckets = bucketByDay(list);

    const todayKey = dateKey(now);
    const todaySec = buckets[todayKey] || 0;

    // 近 7 天（含今天，滚动窗口）
    const last7 = [];
    let weekSec = 0;
    for (let i = 6; i >= 0; i--) {
      const ts = dayOffset(now, -i);
      const key = dateKey(ts);
      const sec = buckets[key] || 0;
      weekSec += sec;
      last7.push({
        key: key,
        weekday: WEEKDAYS[new Date(ts).getDay()],
        label: new Date(ts).getMonth() + 1 + '/' + new Date(ts).getDate(),
        sec: sec,
        isToday: i === 0
      });
    }

    // 近 30 天（含今天），用于热力图
    const last30 = [];
    let monthSec = 0;
    const maxSec = Math.max.apply(null, [0].concat(last7.map(function (d) { return d.sec; })));
    for (let i = 29; i >= 0; i--) {
      const ts = dayOffset(now, -i);
      const key = dateKey(ts);
      const sec = buckets[key] || 0;
      monthSec += sec;
      last30.push({
        key: key,
        day: new Date(ts).getDate(),
        sec: sec,
        level: levelOf(sec),
        isToday: i === 0
      });
    }

    // 今日番茄个数
    let todayCount = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].mode === 'focus' && dateKey(list[i].endedAt) === todayKey) todayCount += 1;
    }

    return {
      todaySec: todaySec,
      todayCount: todayCount,
      weekSec: weekSec,
      monthSec: monthSec,
      streak: streakDays(buckets, now),
      last7: last7,
      last30: last30,
      maxDaySec: maxSec,
      totalCount: list.filter(function (s) { return s && s.mode === 'focus'; }).length
    };
  }

  /** 热力图分级：0 无记录，1 <25min，2 <50min，3 <90min，4 ≥90min */
  function levelOf(sec) {
    if (!sec) return 0;
    if (sec < 25 * 60) return 1;
    if (sec < 50 * 60) return 2;
    if (sec < 90 * 60) return 3;
    return 4;
  }

  /**
   * 连续天数：从今天往前数。
   * 今天还没有记录时，从昨天开始数（不算断），这样早上打开应用不会显示 0。
   */
  function streakDays(buckets, now) {
    let cursor = now;
    let startOffset = 0;
    if (!buckets[dateKey(now)]) {
      startOffset = -1;
      if (!buckets[dateKey(dayOffset(now, -1))]) return 0;
    }
    let count = 0;
    for (let i = startOffset; i > -400; i--) {
      if (buckets[dateKey(dayOffset(now, i))]) count += 1;
      else break;
    }
    return count;
  }

  /** 近 N 天各任务累计专注时长，按降序 */
  function byTask(sessions, tasks, now, days) {
    const span = days || 30;
    const from = startOfDay(dayOffset(now, -(span - 1)));
    const titles = Object.create(null);
    (tasks || []).forEach(function (t) { titles[t.id] = t.title; });

    const acc = Object.create(null);
    (sessions || []).forEach(function (s) {
      if (!s || s.mode !== 'focus') return;
      if (s.endedAt < from) return;
      const key = s.taskId || '__none__';
      acc[key] = (acc[key] || 0) + (Number(s.durationSec) || 0);
    });

    return Object.keys(acc)
      .map(function (k) {
        return {
          taskId: k === '__none__' ? null : k,
          title: k === '__none__' ? '未绑定任务' : titles[k] || '已删除的任务',
          sec: acc[k]
        };
      })
      .sort(function (a, b) { return b.sec - a.sec; });
  }

  /** 人话时长，例如 "1 小时 20 分" */
  function humanDuration(sec) {
    const total = Math.max(0, Math.round(sec));
    if (total === 0) return '0 分钟';
    if (total < 60) return '不到 1 分钟';
    const h = Math.floor(total / 3600);
    let m = Math.round((total % 3600) / 60);
    if (m === 60) return (h + 1) + ' 小时';
    if (h && m) return h + ' 小时 ' + m + ' 分';
    if (h) return h + ' 小时';
    return m + ' 分钟';
  }

  function clockHM(ts) {
    const d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fullDate(ts) {
    const d = new Date(ts);
    return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' + WEEKDAYS[d.getDay()];
  }

  return {
    DAY_MS: DAY_MS,
    WEEKDAYS: WEEKDAYS,
    dateKey: dateKey,
    startOfDay: startOfDay,
    dayOffset: dayOffset,
    levelOf: levelOf,
    bucketByDay: bucketByDay,
    summarize: summarize,
    streakDays: streakDays,
    byTask: byTask,
    humanDuration: humanDuration,
    clockHM: clockHM,
    fullDate: fullDate
  };
});
