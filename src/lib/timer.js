/**
 * 计时状态机 —— 纯函数，不碰 DOM、不用 setInterval。
 *
 * 核心设计：状态里存的是「绝对结束时间戳 endsAt」，任何时刻的剩余时间都由
 * endsAt 和 now 现算。这样窗口切后台被节流、系统休眠、主循环卡顿都不会
 * 产生累加式漂移 —— 这是本项目唯一需要"技术含量"的地方，单元测试也围绕它。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.FB = root.FB || {}).timer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODE_LABEL = { focus: '专注', short: '短休息', long: '长休息' };

  function clampInt(value, fallback, min, max) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function modeDurationSec(mode, settings) {
    const s = settings || {};
    if (mode === 'short') return clampInt(s.shortMin, 5, 1, 120) * 60;
    if (mode === 'long') return clampInt(s.longMin, 15, 1, 120) * 60;
    return clampInt(s.focusMin, 25, 1, 120) * 60;
  }

  function roundsBeforeLong(settings) {
    return clampInt(settings && settings.roundsBeforeLong, 4, 2, 8);
  }

  function create(settings) {
    const total = modeDurationSec('focus', settings);
    return {
      mode: 'focus',
      status: 'idle', // idle | running | paused
      totalSec: total,
      remainingSec: total,
      endsAt: null,
      startedAt: null,
      cycle: 0, // 当前周期内已完成的专注数，跨天不清零
      taskId: null
    };
  }

  /** 剩余秒数：running 时以时间戳为准，其余情况以 remainingSec 为准 */
  function remaining(state, now) {
    if (state.status !== 'running' || !state.endsAt) {
      return Math.max(0, state.remainingSec);
    }
    return Math.max(0, Math.ceil((state.endsAt - now) / 1000));
  }

  /** 已走过的比例 0..1，用于进度环 */
  function progress(state, now) {
    if (!state.totalSec) return 0;
    const used = state.totalSec - remaining(state, now);
    return Math.min(1, Math.max(0, used / state.totalSec));
  }

  function start(state, now, taskId) {
    if (state.status === 'running') return state;
    const rem = Math.max(1, remaining(state, now));
    return Object.assign({}, state, {
      status: 'running',
      endsAt: now + rem * 1000,
      // 暂停后继续不重置 startedAt，保证一条 session 的起止时间真实
      startedAt: state.startedAt || now,
      taskId: taskId === undefined ? state.taskId : taskId
    });
  }

  function pause(state, now) {
    if (state.status !== 'running') return state;
    return Object.assign({}, state, {
      status: 'paused',
      remainingSec: remaining(state, now),
      endsAt: null
    });
  }

  /** 当前阶段回到满时长（不改变任务绑定） */
  function reset(state) {
    return Object.assign({}, state, {
      status: 'idle',
      remainingSec: state.totalSec,
      endsAt: null,
      startedAt: null
    });
  }

  function setMode(state, mode, settings) {
    const total = modeDurationSec(mode, settings);
    return {
      mode: mode,
      status: 'idle',
      totalSec: total,
      remainingSec: total,
      endsAt: null,
      startedAt: null,
      cycle: state.cycle,
      taskId: state.taskId
    };
  }

  /** 设置变更后，若当前处于 idle，同步刷新时长 */
  function applySettings(state, settings) {
    if (state.status !== 'idle') return state;
    const total = modeDurationSec(state.mode, settings);
    if (total === state.totalSec) return state;
    return Object.assign({}, state, { totalSec: total, remainingSec: total });
  }

  /** 阶段结束：记账 + 进入下一阶段（专注 → 休息，休息 → 专注） */
  function advance(state, settings, now, autoStart) {
    let session = null;
    let cycle = state.cycle;

    if (state.mode === 'focus') {
      cycle += 1;
      session = {
        taskId: state.taskId || null,
        mode: 'focus',
        startedAt: state.startedAt || now - state.totalSec * 1000,
        endedAt: now,
        durationSec: state.totalSec
      };
    }

    let nextMode;
    if (state.mode !== 'focus') {
      nextMode = 'focus';
    } else {
      nextMode = cycle % roundsBeforeLong(settings) === 0 ? 'long' : 'short';
    }

    const total = modeDurationSec(nextMode, settings);
    const base = {
      mode: nextMode,
      status: 'idle',
      totalSec: total,
      remainingSec: total,
      endsAt: null,
      startedAt: null,
      cycle: cycle,
      taskId: state.taskId
    };

    const next = autoStart ? start(base, now) : base;
    return { state: next, session: session };
  }

  /** 主循环每 250ms 调用一次；到期则结算并返回新状态 */
  function tick(state, now, settings) {
    if (state.status !== 'running') return { state: state, session: null };
    if (remaining(state, now) > 0) return { state: state, session: null };
    return advance(state, settings, now, !!(settings && settings.autoNext));
  }

  /**
   * 跳过当前阶段：不记账（跳过等于放弃这段专注）。
   * 专注阶段跳过 → 直接进休息；休息阶段跳过 → 回专注。
   */
  function skip(state, settings) {
    const nextMode = state.mode === 'focus' ? 'short' : 'focus';
    const total = modeDurationSec(nextMode, settings);
    return {
      mode: nextMode,
      status: 'idle',
      totalSec: total,
      remainingSec: total,
      endsAt: null,
      startedAt: null,
      cycle: state.cycle,
      taskId: state.taskId
    };
  }

  function formatClock(sec) {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
  }

  return {
    MODE_LABEL: MODE_LABEL,
    modeDurationSec: modeDurationSec,
    roundsBeforeLong: roundsBeforeLong,
    create: create,
    remaining: remaining,
    progress: progress,
    start: start,
    pause: pause,
    reset: reset,
    setMode: setMode,
    applySettings: applySettings,
    advance: advance,
    tick: tick,
    skip: skip,
    formatClock: formatClock
  };
});
