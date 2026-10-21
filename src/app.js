/**
 * 渲染层：视图渲染 + 事件绑定 + 主循环。
 * 约束：这里不读写文件、不 require，全部状态落在 state.data。
 */
(function () {
  'use strict';

  const T = window.FB.timer;
  const S = window.FB.stats;
  const store = window.FB.store.create();

  const DEFAULT_SETTINGS = {
    focusMin: 25,
    shortMin: 5,
    longMin: 15,
    roundsBeforeLong: 4,
    autoNext: false,
    notify: true,
    minimizeToTray: true
  };

  const RING_R = 98;
  const RING_C = 2 * Math.PI * RING_R;

  const state = {
    data: null,
    view: 'today',
    editingId: null,
    dragId: null,
    appInfo: null,
    loop: null
  };

  // ---------------- 工具 ----------------

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function defaultData() {
    return {
      version: 1,
      settings: Object.assign({}, DEFAULT_SETTINGS),
      tasks: [],
      sessions: [],
      timer: T.create(DEFAULT_SETTINGS)
    };
  }

  /** 兼容旧数据 / 残缺数据：缺什么补什么，保证后续代码不用到处判空 */
  function normalize(raw) {
    const base = defaultData();
    if (!raw || typeof raw !== 'object') return base;

    const settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings || {});
    const timer = Object.assign(T.create(settings), raw.timer || {});

    // 计时状态可能来自旧版本，字段缺失时按 idle 处理
    if (['idle', 'running', 'paused'].indexOf(timer.status) === -1) timer.status = 'idle';
    if (['focus', 'short', 'long'].indexOf(timer.mode) === -1) timer.mode = 'focus';
    if (timer.status !== 'running') timer.endsAt = null;

    const tasks = (Array.isArray(raw.tasks) ? raw.tasks : []).map(function (t, i) {
      return {
        id: t.id || uid('t'),
        title: String(t.title || '未命名任务').slice(0, 120),
        done: !!t.done,
        order: Number.isFinite(t.order) ? t.order : i,
        createdAt: t.createdAt || Date.now()
      };
    }).sort(function (a, b) { return a.order - b.order; });

    const sessions = (Array.isArray(raw.sessions) ? raw.sessions : []).filter(function (s) {
      return s && Number.isFinite(s.endedAt) && Number.isFinite(s.durationSec);
    });

    return {
      version: 1,
      settings: settings,
      tasks: tasks,
      sessions: sessions,
      timer: timer
    };
  }

  function persist() {
    try {
      store.save(state.data);
    } catch (err) {
      console.warn('[focusboard] 保存失败', err);
    }
  }

  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  // ---------------- 启动 ----------------

  async function boot() {
    let raw = null;
    try {
      raw = await store.load();
    } catch (err) {
      console.warn('[focusboard] 读取数据失败，使用默认值', err);
    }
    state.data = normalize(raw);

    // 支持 #stats / #settings 深链接（托盘菜单、外部唤起时用得上）
    const hashView = String(location.hash || '').replace('#', '');
    if (['today', 'stats', 'settings'].indexOf(hashView) !== -1) state.view = hashView;

    if (window.api && typeof window.api.info === 'function') {
      try { state.appInfo = await window.api.info(); } catch (e) { /* 浏览器预览时没有 */ }
    }

    $('#storage-hint').textContent = backendLabel();
    $('#version').textContent = 'v' + ((state.appInfo && state.appInfo.version) || '1.0.0');

    // 上次退出时正在计时：先结算可能已过期的这一段
    catchUp();

    bindEvents();
    render();

    if (state.data.timer.status === 'running') startLoop();
  }

  function backendLabel() {
    if (store.name === 'electron') return '本地文件存储';
    if (store.name === 'localStorage') return '浏览器本地存储';
    return '临时内存（不会保存）';
  }

  /** 处理「应用关着的时候计时已经到期」 */
  function catchUp() {
    const t = state.data.timer;
    if (t.status !== 'running') return;
    const r = T.tick(t, Date.now(), state.data.settings);
    if (r.session) {
      state.data.sessions.push(Object.assign({ id: uid('s') }, r.session));
      state.data.timer = r.state;
      persist();
    }
  }

  // ---------------- 主循环 ----------------

  function startLoop() {
    if (state.loop) return;
    state.loop = setInterval(tick, 250);
  }

  function stopLoop() {
    if (!state.loop) return;
    clearInterval(state.loop);
    state.loop = null;
  }

  function tick() {
    const now = Date.now();
    const r = T.tick(state.data.timer, now, state.data.settings);

    if (r.session) {
      state.data.sessions.push(Object.assign({ id: uid('s') }, r.session));
      state.data.timer = r.state;
      persist();
      afterSession(r.session, r.state);
      render();
      if (r.state.status === 'running') startLoop();
      else stopLoop();
      return;
    }

    if (state.data.timer.status !== 'running') {
      stopLoop();
      render();
      return;
    }

    paintClock();
  }

  /** 一个阶段结束后的提示与通知 */
  function afterSession(session, nextState) {
    const isFocus = session.mode === 'focus';
    const nextLabel = T.MODE_LABEL[nextState.mode];

    let title;
    let body;
    if (isFocus) {
      title = '专注完成 🍅';
      body = '休息一下：' + nextLabel + ' ' + Math.round(nextState.totalSec / 60) + ' 分钟';
    } else {
      title = '休息结束';
      body = '准备好可以开始下一个专注了';
    }

    toast(title + ' · ' + body);

    if (state.data.settings.notify !== false && window.api && typeof window.api.notify === 'function') {
      try { window.api.notify({ title: title, body: body }); } catch (e) { /* ignore */ }
    }
  }

  // ---------------- 渲染 ----------------

  function render() {
    document.body.dataset.mode = state.data.timer.mode;
    document.body.classList.toggle('is-running', state.data.timer.status === 'running');
    renderNav();

    const main = $('#main');
    if (state.view === 'stats') main.innerHTML = viewStats();
    else if (state.view === 'settings') main.innerHTML = viewSettings();
    else main.innerHTML = viewToday();

    paintClock();

    if (state.view === 'today' && state.editingId) {
      const input = $('.task-edit');
      if (input) {
        input.focus();
        input.select();
      }
    }
  }

  function renderNav() {
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (btn) {
      btn.classList.toggle('is-active', btn.dataset.nav === state.view);
    });
  }

  function viewToday() {
    const t = state.data.timer;
    const now = Date.now();
    const sum = S.summarize(state.data.sessions, now);
    const rounds = T.roundsBeforeLong(state.data.settings);
    const cycleInRound = (t.cycle % rounds) + 1;
    const doneCount = state.data.tasks.filter(function (x) { return x.done; }).length;
    const current = state.data.tasks.filter(function (x) { return x.id === t.taskId; })[0];

    const pomoTotal = state.data.sessions.length;

    return '' +
      '<div class="page-head">' +
        '<div>' +
          '<h1>今日</h1>' +
          '<p class="sub">' + S.fullDate(now) + ' · 今天专注 <b>' + S.humanDuration(sum.todaySec) + '</b>' +
          (sum.todayCount ? '，完成 ' + sum.todayCount + ' 个番茄' : '') + '</p>' +
        '</div>' +
        '<div class="head-side">' +
          '<div class="pill"><span>连续</span><b>' + sum.streak + '</b><span class="pill-unit">天</span></div>' +
          '<div class="pill"><span>累计</span><b>' + pomoTotal + '</b><span class="pill-unit">个番茄</span></div>' +
        '</div>' +
      '</div>' +

      '<section class="card timer-card">' +
        '<div class="mode-tabs">' +
          modeTab('focus', t.mode) + modeTab('short', t.mode) + modeTab('long', t.mode) +
          '<span class="mode-spacer"></span>' +
          '<span class="cycle-hint">本轮 ' + cycleInRound + ' / ' + rounds + '</span>' +
        '</div>' +
        '<div class="timer-stage">' +
          '<div class="ring-wrap">' +
            '<svg class="ring" viewBox="0 0 220 220" aria-hidden="true">' +
              '<circle class="ring-bg" cx="110" cy="110" r="' + RING_R + '"></circle>' +
              '<circle class="ring-fg" id="ring-fg" cx="110" cy="110" r="' + RING_R + '"></circle>' +
            '</svg>' +
            '<div class="ring-center">' +
              '<div class="clock" id="clock">' + T.formatClock(T.remaining(t, now)) + '</div>' +
              '<div class="clock-sub" id="clock-sub"></div>' +
            '</div>' +
          '</div>' +
          '<div class="timer-side">' +
            '<div class="current-task">' +
              '<div class="label">当前任务</div>' +
              '<div class="value' + (current ? '' : ' is-empty') + '">' +
                esc(current ? current.title : '未选择 · 专注记录会记为「未绑定任务」') +
              '</div>' +
            '</div>' +
            '<div class="timer-actions">' +
              '<button class="btn btn-primary" data-action="toggle-timer" type="button">' + primaryLabel(t) + '</button>' +
              '<button class="btn" data-action="reset-timer" type="button">重置</button>' +
              '<button class="btn" data-action="skip-stage" type="button">跳过</button>' +
            '</div>' +
            '<p class="hint"><kbd>空格</kbd> 开始 / 暂停 · <kbd>N</kbd> 新建任务</p>' +
          '</div>' +
        '</div>' +
      '</section>' +

      '<section class="card tasks-card">' +
        '<div class="section-head">' +
          '<h2>今日任务</h2>' +
          '<span class="count">' + doneCount + ' / ' + state.data.tasks.length + ' 完成</span>' +
        '</div>' +
        '<form class="add-row" id="add-form" autocomplete="off">' +
          '<input id="new-task" type="text" maxlength="120" placeholder="添加任务，回车确认" autocomplete="off">' +
          '<button class="btn btn-primary" type="submit">添加</button>' +
        '</form>' +
        taskListHtml() +
      '</section>';
  }

  function modeTab(mode, current) {
    return '<button class="mode-tab' + (mode === current ? ' is-active' : '') + '" data-action="set-mode" data-mode="' + mode + '" type="button">' +
      T.MODE_LABEL[mode] + '</button>';
  }

  function primaryLabel(t) {
    if (t.status === 'running') return '暂停';
    if (t.status === 'paused') return '继续';
    return t.mode === 'focus' ? '开始专注' : '开始休息';
  }

  function taskListHtml() {
    if (!state.data.tasks.length) {
      return '<div class="empty"><b>还没有任务</b>先写一件今天一定要做完的事，再去开计时。</div>';
    }

    const t = state.data.timer;
    const pomos = {};
    state.data.sessions.forEach(function (s) {
      if (s.mode === 'focus' && s.taskId) pomos[s.taskId] = (pomos[s.taskId] || 0) + 1;
    });

    return '<ul class="task-list" id="task-list">' + state.data.tasks.map(function (task) {
      const isEditing = state.editingId === task.id;
      const cls = [
        'task-item',
        task.done ? 'is-done' : '',
        task.id === t.taskId ? 'is-current' : ''
      ].filter(Boolean).join(' ');

      const count = pomos[task.id] || 0;

      return '<li class="' + cls + '" draggable="' + (isEditing ? 'false' : 'true') + '" data-task-id="' + esc(task.id) + '">' +
        '<span class="drag-handle" title="拖动排序">⠿</span>' +
        '<button class="check" data-action="toggle-task" data-task-id="' + esc(task.id) + '" type="button" aria-label="完成"></button>' +
        (isEditing
          ? '<input class="task-edit" data-edit-id="' + esc(task.id) + '" maxlength="120" value="' + esc(task.title) + '">'
          : '<span class="task-title" data-task-id="' + esc(task.id) + '" title="双击编辑">' + esc(task.title) + '</span>') +
        (count ? '<span class="task-meta has-pomo">🍅 ' + count + '</span>' : '<span class="task-meta"></span>') +
        '<span class="task-actions">' +
          '<button class="link-btn" data-action="set-current" data-task-id="' + esc(task.id) + '" type="button">设为当前</button>' +
          '<button class="icon-btn" data-action="delete-task" data-task-id="' + esc(task.id) + '" type="button" title="删除">✕</button>' +
        '</span>' +
      '</li>';
    }).join('') + '</ul>';
  }

  function viewStats() {
    const now = Date.now();
    const sum = S.summarize(state.data.sessions, now);
    const rank = S.byTask(state.data.sessions, state.data.tasks, now, 30);
    const maxRank = rank.length ? rank[0].sec : 1;
    const maxDay = Math.max.apply(null, sum.last7.map(function (d) { return d.sec; }).concat([1]));

    const bars = sum.last7.map(function (d) {
      const h = d.sec ? Math.max(4, Math.round((d.sec / maxDay) * 100)) : 0;
      return '<div class="bar-col' + (d.isToday ? ' is-today' : '') + (d.sec ? '' : ' is-empty') + '">' +
        '<div class="bar-value">' + (d.sec ? Math.round(d.sec / 60) : '·') + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="height:' + h + '%"></div></div>' +
        '<div class="bar-label">' + (d.isToday ? '今天' : d.label) + '</div>' +
      '</div>';
    }).join('');

    const heat = sum.last30.map(function (d) {
      return '<div class="heat-cell lv' + d.level + (d.isToday ? ' is-today' : '') + '" title="' +
        esc(d.key + ' · ' + S.humanDuration(d.sec)) + '">' + d.day + '</div>';
    }).join('');

    const rankHtml = rank.length
      ? '<ul class="rank-list">' + rank.map(function (r) {
        const w = Math.max(3, Math.round((r.sec / maxRank) * 100));
        return '<li class="rank-item">' +
          '<div class="rank-top"><span>' + esc(r.title) + '</span><span>' + S.humanDuration(r.sec) + '</span></div>' +
          '<div class="rank-bar"><i style="width:' + w + '%"></i></div>' +
        '</li>';
      }).join('') + '</ul>'
      : '<div class="empty"><b>还没有专注记录</b>完成第一个番茄后，这里会出现分布。</div>';

    return '' +
      '<div class="page-head">' +
        '<div><h1>统计</h1><p class="sub">只统计完成的「专注」阶段，休息时间不计入 · 按结束日期归档</p></div>' +
      '</div>' +

      '<div class="stat-grid">' +
        statCard('今日专注', S.humanDuration(sum.todaySec), sum.todayCount + ' 个番茄') +
        statCard('近 7 天', S.humanDuration(sum.weekSec), '日均 ' + S.humanDuration(Math.round(sum.weekSec / 7))) +
        statCard('近 30 天', S.humanDuration(sum.monthSec), sum.totalCount + ' 个番茄（累计）') +
        statCard('连续天数', String(sum.streak), '今天有记录即不算断') +
      '</div>' +

      '<section class="card">' +
        '<div class="section-head"><h2>近 7 天</h2><span class="muted">单位：分钟</span></div>' +
        '<div class="bars">' + bars + '</div>' +
      '</section>' +

      '<section class="card">' +
        '<div class="section-head"><h2>近 30 天</h2><span class="muted">颜色越深，专注越久</span></div>' +
        '<div class="heatmap">' + heat + '</div>' +
        '<div class="heat-legend"><span>少</span><i></i><i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><i class="lv4"></i><span>多</span></div>' +
      '</section>' +

      '<section class="card">' +
        '<div class="section-head"><h2>任务分布（近 30 天）</h2><span class="muted">按时长排序</span></div>' +
        rankHtml +
      '</section>';
  }

  function statCard(label, value, foot) {
    return '<div class="card stat">' +
      '<div class="stat-label">' + label + '</div>' +
      '<div class="stat-value">' + value + '</div>' +
      '<div class="stat-foot">' + foot + '</div>' +
    '</div>';
  }

  function viewSettings() {
    const s = state.data.settings;
    const dataPath = (state.appInfo && state.appInfo.dataPath) || '（浏览器预览：localStorage）';

    return '' +
      '<div class="page-head"><div><h1>设置</h1><p class="sub">修改后点「保存设置」生效，无需重启</p></div></div>' +

      '<section class="card">' +
        '<div class="section-head"><h2>计时</h2></div>' +
        '<form id="settings-form">' +
          numRow('专注时长', '一个番茄的长度', 'set-focus', s.focusMin, 1, 120, '分钟') +
          numRow('短休息', '每个番茄之间的小憩', 'set-short', s.shortMin, 1, 60, '分钟') +
          numRow('长休息', '每轮结束后的长休息', 'set-long', s.longMin, 1, 120, '分钟') +
          numRow('长休息间隔', '每完成几个番茄进入长休息', 'set-rounds', s.roundsBeforeLong, 2, 8, '个') +
          toggleRow('自动开始下一阶段', '专注结束直接进入休息，不用再点一次', 'set-auto', s.autoNext) +
          '<div class="form-actions">' +
            '<button class="btn btn-primary" type="submit">保存设置</button>' +
            '<span class="saved-tip" id="saved-tip">已保存</span>' +
          '</div>' +
        '</form>' +
      '</section>' +

      '<section class="card">' +
        '<div class="section-head"><h2>系统</h2></div>' +
        toggleRow('结束提示音/通知', '阶段结束时弹系统通知', 'set-notify', s.notify) +
        toggleRow('关闭窗口时最小化到托盘', '计时不中断，从托盘图标恢复', 'set-tray', s.minimizeToTray) +
        '<div class="form-actions">' +
          '<button class="btn" type="button" data-action="save-system">保存系统选项</button>' +
        '</div>' +
      '</section>' +

      '<section class="card danger-zone">' +
        '<div class="section-head"><h2>危险操作</h2></div>' +
        '<div class="form-row">' +
          '<div><div class="row-label">清空所有数据</div><div class="row-desc">删除全部任务与专注记录，不可恢复</div></div>' +
          '<button class="btn btn-danger" data-action="clear-data" type="button">清空数据</button>' +
        '</div>' +
      '</section>' +

      '<section class="card">' +
        '<div class="section-head"><h2>关于</h2></div>' +
        '<div class="about">' +
          'FocusBoard v' + ((state.appInfo && state.appInfo.version) || '1.0.0') + ' · 纯本地运行，不联网<br>' +
          '存储方式：' + backendLabel() + '<br>' +
          '数据位置：<code>' + esc(dataPath) + '</code>' +
        '</div>' +
      '</section>';
  }

  function numRow(label, desc, id, value, min, max, unit) {
    return '<div class="form-row">' +
      '<div><div class="row-label">' + label + '</div><div class="row-desc">' + desc + '</div></div>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<input class="num-input" id="' + id + '" type="number" min="' + min + '" max="' + max + '" step="1" value="' + value + '">' +
        '<span class="muted">' + unit + '</span>' +
      '</div>' +
    '</div>';
  }

  function toggleRow(label, desc, id, checked) {
    return '<div class="form-row">' +
      '<div><div class="row-label">' + label + '</div><div class="row-desc">' + desc + '</div></div>' +
      '<label class="switch"><input id="' + id + '" type="checkbox"' + (checked ? ' checked' : '') + '><i></i></label>' +
    '</div>';
  }

  // ---------------- 计时数字：只更新文本与环，不重建 DOM ----------------

  function paintClock() {
    const t = state.data.timer;
    const clockEl = $('#clock');
    if (!clockEl) return;

    const now = Date.now();
    const rem = T.remaining(t, now);
    clockEl.textContent = T.formatClock(rem);

    const ring = $('#ring-fg');
    if (ring) {
      // 环表示「还剩多少」，开局满环、随倒计时收缩，比从 0 开始填充更符合直觉
      const frac = t.totalSec ? Math.min(1, Math.max(0, rem / t.totalSec)) : 0;
      ring.style.strokeDasharray = RING_C;
      ring.style.strokeDashoffset = RING_C * (1 - frac);
      ring.style.opacity = t.status === 'idle' ? '0.28' : '1';
    }

    const sub = $('#clock-sub');
    if (sub) sub.textContent = subText(t);

    const btn = $('[data-action="toggle-timer"]');
    if (btn && btn.textContent !== primaryLabel(t)) btn.textContent = primaryLabel(t);

    document.title = t.status === 'running'
      ? T.formatClock(rem) + ' · ' + T.MODE_LABEL[t.mode] + ' · FocusBoard'
      : 'FocusBoard';

    if (window.api && typeof window.api.setTrayText === 'function') {
      const label = t.status === 'running' ? T.MODE_LABEL[t.mode] + '中' : (t.status === 'paused' ? '已暂停' : '就绪');
      window.api.setTrayText('FocusBoard · ' + label + (t.status === 'idle' ? '' : ' · ' + T.formatClock(rem)));
    }
  }

  function subText(t) {
    if (t.status === 'running') return t.mode === 'focus' ? '专注中，别切窗口' : '休息一下，起来走走';
    if (t.status === 'paused') return '已暂停';
    return t.mode === 'focus' ? '准备好就开始' : '点开始休息';
  }

  // ---------------- 事件 ----------------

  function bindEvents() {
    const main = $('#main');

    main.addEventListener('click', function (e) {
      const navBtn = e.target.closest('.nav-item');
      if (navBtn) return; // 侧边栏在 #main 外，这里防御性忽略

      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      const taskId = target.dataset.taskId;

      if (action === 'toggle-timer') toggleTimer();
      else if (action === 'reset-timer') doReset();
      else if (action === 'skip-stage') doSkip();
      else if (action === 'set-mode') doSetMode(target.dataset.mode);
      else if (action === 'toggle-task') toggleTask(taskId);
      else if (action === 'set-current') setCurrent(taskId);
      else if (action === 'delete-task') askDelete(taskId);
      else if (action === 'clear-data') askClear();
      else if (action === 'save-system') saveSystemOptions();
    });

    main.addEventListener('dblclick', function (e) {
      const title = e.target.closest('.task-title');
      if (title) startEdit(title.dataset.taskId);
    });

    main.addEventListener('submit', function (e) {
      e.preventDefault();
      if (e.target.id === 'add-form') addTask();
      else if (e.target.id === 'settings-form') saveSettings();
    });

    main.addEventListener('keydown', function (e) {
      const input = e.target.closest('.task-edit');
      if (!input) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        commitEdit(input.dataset.editId, input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        state.editingId = null;
        render();
      }
    });

    // 用 focusout 而不是 blur：blur 不冒泡，捕获阶段在部分场景下不可靠
    main.addEventListener('focusout', function (e) {
      const input = e.target.closest('.task-edit');
      if (input && state.editingId === input.dataset.editId) {
        commitEdit(input.dataset.editId, input.value);
      }
    }, true);

    // 拖拽排序
    main.addEventListener('dragstart', function (e) {
      const li = e.target.closest('.task-item');
      if (!li) return;
      state.dragId = li.dataset.taskId;
      li.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', state.dragId);
      }
    });

    main.addEventListener('dragover', function (e) {
      const li = e.target.closest('.task-item');
      if (!li || !state.dragId) return;
      e.preventDefault();
      clearDropMarks();
      if (li.dataset.taskId === state.dragId) return;
      const rect = li.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      li.classList.add(after ? 'drop-after' : 'drop-before');
    });

    main.addEventListener('drop', function (e) {
      const li = e.target.closest('.task-item');
      if (!li || !state.dragId) return;
      e.preventDefault();
      const rect = li.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      moveTask(state.dragId, li.dataset.taskId, after);
      clearDropMarks();
      state.dragId = null;
    });

    main.addEventListener('dragend', function () {
      clearDropMarks();
      state.dragId = null;
      render();
    });

    // 侧边栏导航
    $('#nav').addEventListener('click', function (e) {
      const btn = e.target.closest('.nav-item');
      if (btn) setView(btn.dataset.nav);
    });

    // 全局快捷键
    document.addEventListener('keydown', function (e) {
      // 弹窗打开时不要误触倒计时
      if (document.querySelector('.modal-mask')) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

      if (e.code === 'Space') {
        e.preventDefault();
        toggleTimer();
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setView('today');
        const input = $('#new-task');
        if (input) input.focus();
      } else if (e.key === '1') setView('today');
      else if (e.key === '2') setView('stats');
      else if (e.key === '3') setView('settings');
    });
  }

  function clearDropMarks() {
    Array.prototype.forEach.call(document.querySelectorAll('.drop-before, .drop-after'), function (el) {
      el.classList.remove('drop-before', 'drop-after', 'is-dragging');
    });
  }

  function setView(view) {
    if (state.view === view) return;
    state.view = view;
    state.editingId = null;
    render();
  }

  // ---------------- 计时操作 ----------------

  function toggleTimer() {
    const t = state.data.timer;
    const now = Date.now();

    if (t.status === 'running') {
      state.data.timer = T.pause(t, now);
      stopLoop();
      persist();
      render();
      return;
    }

    const taskId = t.taskId && taskExists(t.taskId) ? t.taskId : null;
    state.data.timer = T.start(t, now, taskId);
    persist();
    startLoop();
    render();
  }

  function doReset() {
    state.data.timer = T.reset(state.data.timer);
    stopLoop();
    persist();
    render();
  }

  function doSkip() {
    state.data.timer = T.skip(state.data.timer, state.data.settings);
    stopLoop();
    persist();
    toast('已跳过，进入' + T.MODE_LABEL[state.data.timer.mode]);
    render();
  }

  function doSetMode(mode) {
    const t = state.data.timer;
    if (t.status === 'running') {
      toast('先暂停或重置，再切换阶段');
      return;
    }
    state.data.timer = T.setMode(t, mode, state.data.settings);
    persist();
    render();
  }

  // ---------------- 任务操作 ----------------

  function taskExists(id) {
    return state.data.tasks.some(function (t) { return t.id === id; });
  }

  function addTask() {
    const input = $('#new-task');
    const title = (input.value || '').trim();
    if (!title) {
      input.focus();
      return;
    }

    const task = {
      id: uid('t'),
      title: title.slice(0, 120),
      done: false,
      order: state.data.tasks.length,
      createdAt: Date.now()
    };
    state.data.tasks.push(task);

    // 第一条任务自动设为当前，省一次点击（PRD G1：3 次点击内开始）
    if (!state.data.timer.taskId) state.data.timer.taskId = task.id;

    persist();
    render();
    const again = $('#new-task');
    if (again) again.focus();
  }

  function toggleTask(id) {
    const task = state.data.tasks.filter(function (t) { return t.id === id; })[0];
    if (!task) return;
    task.done = !task.done;
    persist();
    render();
  }

  function setCurrent(id) {
    state.data.timer = Object.assign({}, state.data.timer, { taskId: id });
    persist();
    render();
  }

  function startEdit(id) {
    state.editingId = id;
    render();
  }

  function commitEdit(id, value) {
    const title = String(value || '').trim();
    const task = state.data.tasks.filter(function (t) { return t.id === id; })[0];
    state.editingId = null;
    if (!task) {
      render();
      return;
    }
    if (!title) {
      render();
      return;
    }
    if (title !== task.title) {
      task.title = title.slice(0, 120);
      persist();
    }
    render();
  }

  function askDelete(id) {
    const task = state.data.tasks.filter(function (t) { return t.id === id; })[0];
    if (!task) return;
    confirmDialog({
      title: '删除任务',
      message: '「' + task.title + '」将被删除，已有的专注记录会保留。',
      confirmText: '删除',
      danger: true,
      onConfirm: function () {
        state.data.tasks = state.data.tasks.filter(function (t) { return t.id !== id; });
        state.data.tasks.forEach(function (t, i) { t.order = i; });
        if (state.data.timer.taskId === id) {
          state.data.timer = Object.assign({}, state.data.timer, { taskId: null });
        }
        persist();
        render();
      }
    });
  }

  function moveTask(fromId, toId, after) {
    const tasks = state.data.tasks;
    const fromIdx = tasks.findIndex(function (t) { return t.id === fromId; });
    const toIdx = tasks.findIndex(function (t) { return t.id === toId; });
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;

    const moving = tasks.splice(fromIdx, 1)[0];
    // 取出后再计算插入位置，避免索引偏移
    let insertIdx = tasks.findIndex(function (t) { return t.id === toId; });
    insertIdx = after ? insertIdx + 1 : insertIdx;
    tasks.splice(insertIdx, 0, moving);
    tasks.forEach(function (t, i) { t.order = i; });

    persist();
    render();
  }

  // ---------------- 设置 ----------------

  function readInt(id, fallback, min, max) {
    const el = $('#' + id);
    if (!el) return fallback;
    const n = Math.round(Number(el.value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function readBool(id) {
    const el = $('#' + id);
    return !!(el && el.checked);
  }

  function saveSettings() {
    const s = state.data.settings;
    s.focusMin = readInt('set-focus', s.focusMin, 1, 120);
    s.shortMin = readInt('set-short', s.shortMin, 1, 60);
    s.longMin = readInt('set-long', s.longMin, 1, 120);
    s.roundsBeforeLong = readInt('set-rounds', s.roundsBeforeLong, 2, 8);
    s.autoNext = readBool('set-auto');
    s.notify = readBool('set-notify');
    s.minimizeToTray = readBool('set-tray');

    state.data.timer = T.applySettings(state.data.timer, s);
    persist();

    const tip = $('#saved-tip');
    if (tip) {
      tip.classList.add('show');
      setTimeout(function () { tip.classList.remove('show'); }, 1600);
    }
    toast('设置已保存');
    render();
  }

  function saveSystemOptions() {
    const s = state.data.settings;
    s.notify = readBool('set-notify');
    s.minimizeToTray = readBool('set-tray');
    persist();
    toast('系统选项已保存');
    render();
  }

  function askClear() {
    confirmDialog({
      title: '清空所有数据',
      message: '全部任务和专注记录都会被删除，此操作不可恢复。',
      confirmText: '确认清空',
      danger: true,
      onConfirm: function () {
        state.data = defaultData();
        stopLoop();
        persist();
        toast('数据已清空');
        render();
      }
    });
  }

  // ---------------- 弹窗 ----------------

  function confirmDialog(opts) {
    const root = $('#modal-root');
    root.innerHTML = '<div class="modal-mask"><div class="modal" role="dialog" aria-modal="true">' +
      '<h3>' + esc(opts.title) + '</h3>' +
      '<p>' + esc(opts.message) + '</p>' +
      '<div class="modal-actions">' +
        '<button class="btn" data-modal="cancel" type="button">取消</button>' +
        '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-modal="ok" type="button">' +
          esc(opts.confirmText || '确定') + '</button>' +
      '</div>' +
    '</div></div>';

    function close() {
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') { close(); opts.onConfirm && opts.onConfirm(); }
    }

    root.querySelector('[data-modal="cancel"]').addEventListener('click', close);
    root.querySelector('[data-modal="ok"]').addEventListener('click', function () {
      close();
      opts.onConfirm && opts.onConfirm();
    });
    root.querySelector('.modal-mask').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) close();
    });
    document.addEventListener('keydown', onKey);
  }

  // 暴露给控制台调试（课程演示时可现场改数据）
  window.FB.app = {
    state: state,
    render: render,
    toast: toast
  };

  boot();
})();
