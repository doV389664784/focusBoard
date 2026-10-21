# TECH_DESIGN：FocusBoard 技术设计

> 配套文档：[PRD.md](./PRD.md) · 结论先行：**Electron + 原生 ES 脚本（无打包器）+ JSON 原子写**。

---

## 1. 选型

### 1.1 桌面框架

| 方案 | 包体积 | 上手成本 | 系统能力 | 结论 |
| --- | --- | --- | --- | --- |
| **Electron** | ~90MB | 低（会写前端即可） | 托盘/通知/全局快捷键齐全 | ✅ 采用 |
| Tauri | ~5MB | 中（需 Rust 工具链） | 同样齐全 | 备选，课程工期不划算 |
| PWA | 极小 | 最低 | 无托盘、无系统通知持久化、不能离线装 | ❌ 不满足「桌面应用」要求 |

选 Electron 的实质理由：本项目的复杂度瓶颈在**界面与交互**，不在包体积；Electron 让我们把全部精力放在状态机与 UI 上。

### 1.2 渲染层：不用框架、不用打包器

浏览器端只有 3 个视图、约 500 行逻辑，引入 React + Vite 的收益（组件复用、HMR）小于成本（构建配置、依赖版本、打包后调试）。因此：

- 渲染层用**原生 ES 脚本 + 手写 DOM 渲染**，`<script>` 直接加载；
- 纯逻辑（计时、统计）抽成 **UMD 风格模块**：浏览器里挂到 `window.FB`，Node 里 `require` 得到同一份代码 → **同一套逻辑既能跑在界面上，也能被单测覆盖**；
- 样式用 CSS 变量 + 原生 CSS，无 Tailwind 构建步骤。

代价：没有组件框架的 diff，每次整块重绘。解决办法是**只重绘变化区域**（计时数字单独 `textContent` 更新，任务列表只在数据变更时重建）。

### 1.3 数据存储

| 方案 | 评价 |
| --- | --- |
| **JSON 文件（原子写）** | ✅ 采用。数据量（万级 session ≈ 1MB）完全够用，零原生依赖 |
| SQLite (better-sqlite3) | 更强，但要 `electron-rebuild` 编译原生模块，跨机器容易翻车 |
| localStorage | ❌ 与主进程隔离、清缓存即丢、讲不出工程性 |

写入策略：`写 tmp → fsync 语义靠 rename 原子替换`；读取失败时把损坏文件重命名为 `*.corrupt-<时间戳>` 再回落默认值，保证「永远能启动」。

### 1.4 关键结论

> 计时器**不做「每秒累加」**，而是记录绝对结束时间戳 `endsAt`，任何时刻 `remaining = max(0, ceil((endsAt - now)/1000))`。这样窗口切后台、系统休眠、主循环被节流都不会产生漂移——这是本设计里唯一「必须有技术含量」的点。

---

## 2. 进程模型

```
┌─────────────────────── 主进程 (electron/main.js) ───────────────────────┐
│  窗口生命周期 · 托盘 · 单实例锁 · 系统通知 · JSON 持久化（唯一写盘者）    │
└───────────────▲───────────────────────────────────────┬─────────────────┘
        ipcRenderer.invoke                      webContents.send
┌───────────────┴───────────────────────────────────────▼─────────────────┐
│ preload.js  contextBridge → window.api = { load, save, notify, info,     │
│                                            platform, onCommand }         │
├─────────────────────────────────────────────────────────────────────────┤
│ 渲染进程  index.html + app.js + lib/{timer,stats,store}.js                │
│   · 只做 UI 与状态机推进，绝不直接碰文件系统                              │
└─────────────────────────────────────────────────────────────────────────┘
```

安全基线：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，渲染层只能看到白名单里的 6 个方法。

### IPC 契约

| 通道 | 方向 | 载荷 | 返回 |
| --- | --- | --- | --- |
| `db:load` | invoke | — | `Store \| null` |
| `db:save` | invoke | `Store` | `boolean` |
| `notify` | send | `{title, body}` | — |
| `app:info` | invoke | — | `{version, platform, dataDir}` |
| `command` | main→renderer | `'show' \| 'quit' \| 'toggle-timer'` | — |

---

## 3. 目录结构

```
focusboard/
├─ package.json            # electron 依赖、start/test/dist 脚本
├─ PRD.md
├─ TECH_DESIGN.md
├─ AGENTS.md
├─ README.md
├─ build/                  # 图标（tray.png 32×32、icon.png 512×512）
├─ electron/
│  ├─ main.js              # 窗口 / 托盘 / 通知 / 持久化
│  └─ preload.js           # contextBridge 白名单
├─ src/
│  ├─ index.html
│  ├─ styles.css
│  ├─ app.js               # 视图渲染 + 事件绑定 + 主循环
│  └─ lib/
│     ├─ timer.js          # 纯函数状态机（无 DOM、无 setInterval）
│     ├─ stats.js          # 纯函数统计聚合
│     └─ store.js          # 存储适配层：Electron IPC / localStorage / 内存
└─ tests/
   ├─ timer.test.mjs
   └─ stats.test.mjs
```

---

## 4. 计时状态机

状态：`(mode, status)`，`mode ∈ {focus, short, long}`，`status ∈ {idle, running, paused}`。

```
idle ──start──> running ──pause──> paused ──start──> running
  ▲                 │                  │
  │                 └──── remaining=0 ─┴─> 结算 → 下一阶段(idle 或 running)
  └──────reset──────┘
```

纯函数签名（`lib/timer.js`）：

```js
create(settings)                        // 初始状态
remaining(state, now)                   // 剩余秒数（唯一的时间真相来源）
start(state, now, taskId)               // 开始/继续
pause(state, now)                       // 冻结剩余时间
reset(state)                            // 当前阶段清零
setMode(state, mode, settings)          // 手动切模式
skip(state, settings)                   // 跳过，不记账
tick(state, now, settings)              // → { state, session? }  到期则结算
modeDuration(mode, settings)            // 某模式的秒数
```

**轮转规则**：专注结束 `cycle += 1`；`cycle % roundsBeforeLong === 0 ? long : short`；休息结束回 `focus`，不再改变 cycle。`cycle` 跨天不清零（它是周期计数，不是当日计数）。

**会话记账**：只有 `mode === 'focus'` 且自然结束时写 session；`skip` 与 `reset` 不写。

---

## 5. 统计口径

| 指标 | 定义 |
| --- | --- |
| 今日专注 | `endedAt` 落在本地今天的所有 focus session 的 `durationSec` 之和 |
| 近 7 天 | 含今天在内的滚动 7 个自然日 |
| 近 30 天 | 含今天在内的滚动 30 个自然日，按 `dateKey` 分桶 |
| 连续天数 | 从今天（若今天无记录则从昨天）往前连续有记录的天数 |
| 任务维度 | 近 30 天内按 `taskId` 聚合，`null` 归为「未绑定任务」 |

性能：session 数万级时按 `endedAt` 倒序线性扫描即可（不建索引），预估 < 5ms。

---

## 6. 主循环与渲染

- `requestAnimationFrame` 不适合：窗口最小化时会被暂停，而我们需要在恢复时立刻算准。改用 `setInterval(..., 250)`，只刷新计时数字与进度环；**逻辑依赖时间戳，不依赖 tick 次数**。
- 后台节流（Chromium 把隐藏页的 timer 降到 1 次/分钟）不影响正确性：`tick` 一进来就用当前时间重算，超时则结算。
- 视图切换用一个 `render()` 全量重绘主区域，计时数字通过 `#clock` 单独更新，避免每 250ms 重建 DOM。

---

## 7. 打包

```bash
npm i
npm run start        # 开发直接跑
npm run dist         # electron-builder → dist/FocusBoard Setup 1.0.0.exe
```

- `win.target: nsis + portable`，`nsis.oneClick: false`（可改安装路径，答辩更有说服力）。
- 应用图标 `build/icon.png`（512×512），托盘 `build/tray.png`（32×32）。
- 不签名（课程项目），首次运行 SmartScreen 会提示「更多信息 → 仍要运行」。

---

## 8. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 系统休眠导致计时不准 | 时间戳方案天然免疫；重开后按 `endsAt` 结算 |
| 数据文件损坏导致打不开 | 解析失败即备份 + 回落默认值，保证启动 |
| 托盘图标在打包后丢失 | 用 `path.join(__dirname, '../build')`，并 `files` 白名单包含 build |
| 通知在某些系统不弹 | 设 `app.setAppUserModelId` + 应用内 Toast 兜底 |
| 手写 DOM 后期难维护 | 纯逻辑全部外置到 lib/，UI 层保持「状态 → HTML 字符串」单向 |

---

## 9. 测试策略

1. **单元测试（`node --test`）**：timer 的 9 个转移路径、跨休眠结算、长休息轮转；stats 的今日/7 天/30 天/连续天数/时区边界。
2. **手工验收**：按 PRD 第 8 节清单逐条走。
3. 不做 E2E（Playwright + Electron 的投入产出比在这个体量下不划算），改为「逻辑全测 + 界面人眼过一遍」。
