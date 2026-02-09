export function dashboardStyles(): string {
  return `
      @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap');
      :root {
        color-scheme: dark;
        --bg: #0a0a0a;
        --panel: #0d0d0d;
        --text: #00ff41;
        --text-dim: #00cc33;
        --muted: #00aa2a;
        --accent: #00ff41;
        --ok: #00ff41;
        --warn: #ffb800;
        --err: #ff0040;
        --info: #00d4ff;
        --line: #003311;
        --glow: 0 0 10px rgba(0, 255, 65, 0.5);
        --glow-strong: 0 0 20px rgba(0, 255, 65, 0.8), 0 0 40px rgba(0, 255, 65, 0.4);
      }
      @keyframes flicker {
        0%, 100% { opacity: 1; }
        92% { opacity: 1; }
        93% { opacity: 0.8; }
        94% { opacity: 1; }
        97% { opacity: 0.9; }
        98% { opacity: 1; }
      }
      @keyframes scanline {
        0% { transform: translateY(-100%); }
        100% { transform: translateY(100vh); }
      }
      @keyframes pulse-glow {
        0%, 100% { text-shadow: var(--glow); }
        50% { text-shadow: var(--glow-strong); }
      }
      @keyframes heartbeat-pulse {
        0%, 100% { box-shadow: 0 0 8px rgba(255, 60, 60, 0.3); }
        50% { box-shadow: 0 0 16px rgba(255, 60, 60, 0.6), 0 0 24px rgba(255, 60, 60, 0.3); }
      }
      body {
        font-family: 'Share Tech Mono', 'Courier New', monospace;
        margin: 0;
        background: var(--bg);
        color: var(--text);
        animation: flicker 8s infinite;
        position: relative;
      }
      body::before {
        content: '';
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: repeating-linear-gradient(
          0deg,
          rgba(0, 0, 0, 0.15),
          rgba(0, 0, 0, 0.15) 1px,
          transparent 1px,
          transparent 2px
        );
        pointer-events: none;
        z-index: 1000;
      }
      body::after {
        content: '';
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 100px;
        background: linear-gradient(
          180deg,
          rgba(0, 255, 65, 0.03) 0%,
          transparent 100%
        );
        animation: scanline 8s linear infinite;
        pointer-events: none;
        z-index: 1001;
      }
      header {
        padding: 24px 32px;
        border-bottom: 1px solid var(--line);
        background: linear-gradient(180deg, #0d120d 0%, #0a0a0a 100%);
        box-shadow: 0 2px 20px rgba(0, 255, 65, 0.1);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 28px;
        text-transform: uppercase;
        letter-spacing: 4px;
        text-shadow: var(--glow-strong);
        animation: pulse-glow 3s ease-in-out infinite;
      }
      h1::before {
        content: '> ';
        color: var(--muted);
      }
      h2, h3 {
        text-transform: uppercase;
        letter-spacing: 2px;
        text-shadow: var(--glow);
      }
      .mode-pill {
        float: right;
        display: inline-block;
        margin-left: 12px;
        font-size: 11px;
        letter-spacing: 2px;
        text-transform: uppercase;
        padding: 6px 12px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: #050805;
        box-shadow: 0 0 12px rgba(0, 255, 65, 0.08);
      }
      .mode-pill.active {
        color: var(--ok);
        border-color: rgba(0, 255, 65, 0.6);
        box-shadow: 0 0 16px rgba(0, 255, 65, 0.35);
      }
      .mode-pill.standby {
        color: var(--warn);
        border-color: rgba(255, 184, 0, 0.6);
        box-shadow: 0 0 16px rgba(255, 184, 0, 0.3);
      }
      .mode-pill.unknown {
        color: var(--muted);
      }
      .meta {
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 1px;
      }
      .meta::before {
        content: '// ';
      }
      main {
        padding: 24px 32px 48px;
        display: grid;
        gap: 20px;
      }
      section {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 4px;
        padding: 16px 18px;
        box-shadow: 0 0 30px rgba(0, 255, 65, 0.05), inset 0 0 60px rgba(0, 0, 0, 0.5);
        position: relative;
      }
      section::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 1px;
        background: linear-gradient(90deg, transparent, var(--text), transparent);
        opacity: 0.5;
      }
      section h2 {
        margin: 0 0 12px;
        font-size: 16px;
        border-bottom: 1px solid var(--line);
        padding-bottom: 8px;
      }
      section h2::before {
        content: '[';
        color: var(--muted);
      }
      section h2::after {
        content: ']';
        color: var(--muted);
      }
      .scroll-5  { max-height: 190px; overflow-y: auto; }
      .scroll-12 { max-height: 410px; overflow-y: auto; }
      .scroll-16 { max-height: 530px; overflow-y: auto; }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      th, td {
        text-align: left;
        padding: 8px 6px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
      }
      th {
        font-weight: 600;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 1px;
        font-size: 10px;
      }
      tr:hover td {
        background: rgba(0, 255, 65, 0.05);
      }
      .badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 2px;
        font-size: 10px;
        line-height: 1.4;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 1px;
        border: 1px solid currentColor;
      }
      .status-running {
        background: rgba(0, 255, 65, 0.1);
        color: var(--ok);
        box-shadow: 0 0 10px rgba(0, 255, 65, 0.3);
        animation: pulse-glow 2s ease-in-out infinite;
      }
      .status-complete { background: rgba(0, 212, 255, 0.1); color: var(--info); }
      .status-failed {
        background: rgba(255, 0, 64, 0.15);
        color: var(--err);
        box-shadow: 0 0 10px rgba(255, 0, 64, 0.3);
      }
      .status-budget_exhausted { background: rgba(255, 184, 0, 0.15); color: var(--warn); }
      .status-exited { background: rgba(255, 184, 0, 0.15); color: var(--warn); }
      .status-stopped { background: rgba(255, 0, 64, 0.15); color: var(--err); }
      .status-enabled {
        background: rgba(0, 255, 65, 0.1);
        color: var(--ok);
        box-shadow: 0 0 10px rgba(0, 255, 65, 0.3);
      }
      .status-disabled { background: rgba(255, 0, 64, 0.15); color: var(--err); }
      pre {
        margin: 0;
        padding: 12px;
        border-radius: 2px;
        background: #050505;
        border: 1px solid var(--line);
        overflow: auto;
        color: var(--text-dim);
        font-size: 11px;
        text-shadow: 0 0 5px rgba(0, 255, 65, 0.3);
      }
      .muted { color: var(--muted); }
      .split {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 16px;
      }
      .no-data {
        color: var(--muted);
        font-style: normal;
        text-transform: uppercase;
        letter-spacing: 1px;
        font-size: 11px;
      }
      .no-data::before {
        content: '// ';
      }
      .section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      .section-header h3 {
        margin: 0;
      }
      .btn-export {
        background: transparent;
        border: 1px solid var(--line);
        color: var(--text-dim);
        padding: 4px 10px;
        font-size: 11px;
        text-decoration: none;
        font-family: inherit;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        cursor: pointer;
      }
      .btn-export:hover {
        background: rgba(0, 255, 65, 0.1);
        border-color: var(--text);
        color: var(--text);
      }
      .graph-wrap {
        border: 1px solid var(--line);
        border-radius: 4px;
        padding: 12px;
        background: #050505;
        margin-bottom: 16px;
        box-shadow: inset 0 0 40px rgba(0, 0, 0, 0.8);
      }
      .tab-bar {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .section-header .tab-bar {
        margin-left: auto;
        justify-content: flex-end;
      }
      .tab-btn {
        background: transparent;
        border: 1px solid var(--line);
        color: var(--text-dim);
        padding: 4px 10px;
        font-size: 11px;
        text-decoration: none;
        font-family: inherit;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        cursor: pointer;
      }
      .tab-btn.active {
        background: rgba(0, 255, 65, 0.1);
        border-color: var(--text);
        color: var(--text);
        box-shadow: var(--glow);
      }
      .tab-panel {
        display: none;
        margin-top: 12px;
      }
      .tab-panel.active {
        display: block;
      }
      .graph-wrap .tab-panel {
        margin-top: 0;
      }
      .log-controls {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        margin-bottom: 10px;
      }
      .log-viewer {
        max-height: 520px;
        overflow: auto;
        white-space: pre-wrap;
        font-size: 11px;
        line-height: 1.45;
        color: var(--text-dim);
        border: 1px solid var(--line);
        background: #050505;
        padding: 10px;
        box-shadow: inset 0 0 25px rgba(0, 0, 0, 0.8);
      }
      .log-line {
        display: block;
        margin: 0 -6px;
        padding: 1px 6px;
        border-left: 2px solid transparent;
      }
      .log-line.level-neutral {
        color: var(--text-dim);
      }
      .log-line.level-ok {
        color: #8fffc8;
      }
      .log-line.level-warn {
        color: #ffe8b4;
        background: rgba(255, 184, 0, 0.1);
        border-left-color: rgba(255, 184, 0, 0.75);
      }
      .log-line.level-error {
        color: #ffd7e2;
        background: rgba(255, 0, 64, 0.14);
        border-left-color: rgba(255, 0, 64, 0.9);
      }
      .log-line.kind-tool-call {
        box-shadow: inset 0 0 0 1px rgba(0, 212, 255, 0.08);
      }
      .log-line.kind-tool-result {
        box-shadow: inset 0 0 0 1px rgba(0, 255, 65, 0.09);
      }
      .log-line.kind-deploy {
        box-shadow: inset 0 0 0 1px rgba(142, 192, 255, 0.2);
      }
      .log-line.kind-timeout {
        box-shadow: inset 0 0 0 1px rgba(255, 184, 0, 0.25);
      }
      .log-label {
        color: var(--muted);
      }
      .log-ts {
        color: var(--info);
      }
      .log-agent-tag {
        color: #66d4ff;
      }
      .log-tool-name {
        color: #9ac8ff;
      }
      .log-call-id {
        color: #d3b4ff;
      }
      .log-status-ok {
        color: #87ffbf;
      }
      .log-status-running,
      .log-status-complete {
        color: #73ffd1;
      }
      .log-status-error,
      .log-status-failed {
        color: #ff6f9a;
        font-weight: 700;
      }
      .log-status-budget_exhausted {
        color: #ffd369;
        font-weight: 700;
      }
      .log-token-error {
        color: #ff6f9a;
        font-weight: 700;
      }
      .log-empty {
        color: var(--muted);
      }
      .graph-header {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--muted);
        margin-bottom: 8px;
        text-transform: uppercase;
        letter-spacing: 1px;
      }
      .graph {
        width: 100%;
        height: 480px;
        position: relative;
      }
      .agent-tooltip {
        position: absolute;
        background: rgba(5, 5, 5, 0.95);
        border: 1px solid var(--text);
        border-radius: 4px;
        padding: 12px 16px;
        font-size: 11px;
        pointer-events: none;
        z-index: 100;
        max-width: 320px;
        box-shadow: 0 0 20px rgba(0, 255, 65, 0.3), inset 0 0 30px rgba(0, 0, 0, 0.5);
        display: none;
      }
      .agent-tooltip.visible {
        display: block;
      }
      .agent-tooltip::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 1px;
        background: linear-gradient(90deg, transparent, var(--text), transparent);
      }
      .agent-tooltip .tt-header {
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 8px;
        text-transform: uppercase;
        letter-spacing: 1px;
        text-shadow: var(--glow);
      }
      .agent-tooltip .tt-row {
        display: flex;
        gap: 8px;
        margin-bottom: 4px;
      }
      .agent-tooltip .tt-label {
        color: var(--muted);
        min-width: 60px;
      }
      .agent-tooltip .tt-value {
        color: var(--text);
        word-break: break-all;
      }
      .agent-tooltip .tt-task {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--line);
        color: var(--text-dim);
        line-height: 1.4;
        max-height: 80px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .graph-stats {
        position: absolute;
        top: 12px;
        left: 12px;
        background: rgba(5, 5, 5, 0.85);
        border: 1px solid var(--line);
        border-radius: 4px;
        padding: 10px 14px;
        font-size: 11px;
        z-index: 50;
        min-width: 120px;
      }
      .graph-stats .stat-row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 4px;
      }
      .graph-stats .stat-row:last-child {
        margin-bottom: 0;
      }
      .graph-stats .stat-label {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 1px;
        font-size: 9px;
      }
      .graph-stats .stat-value {
        color: var(--text);
        font-weight: 600;
      }
      .graph-stats .stat-value.running {
        color: var(--ok);
        text-shadow: var(--glow);
      }
      .graph-stats .stat-value.failed {
        color: var(--err);
      }
      .graph-controls {
        position: absolute;
        top: 12px;
        right: 12px;
        display: flex;
        gap: 8px;
        z-index: 50;
      }
      .graph-btn {
        background: rgba(5, 5, 5, 0.85);
        border: 1px solid var(--line);
        border-radius: 4px;
        padding: 6px 12px;
        font-size: 10px;
        font-family: inherit;
        color: var(--text);
        cursor: pointer;
        text-transform: uppercase;
        letter-spacing: 1px;
        transition: all 0.15s ease;
      }
      .graph-btn:hover {
        border-color: var(--text);
        box-shadow: 0 0 10px rgba(0, 255, 65, 0.2);
      }
      .graph-btn.active {
        background: rgba(0, 255, 65, 0.1);
        border-color: var(--text);
      }
      .refresh-indicator {
        position: absolute;
        bottom: 12px;
        right: 12px;
        font-size: 10px;
        color: var(--muted);
        z-index: 50;
      }
      ::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }
      ::-webkit-scrollbar-track {
        background: var(--bg);
      }
      ::-webkit-scrollbar-thumb {
        background: var(--line);
        border-radius: 2px;
      }
      ::-webkit-scrollbar-thumb:hover {
        background: var(--muted);
      }
      form.form-inline {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 16px;
        padding: 12px;
        border: 1px solid var(--line);
        background: var(--panel);
        box-shadow: var(--glow);
      }
      form.form-inline.compact {
        margin: 0;
        padding: 8px 10px;
        border: 1px dashed var(--line);
        background: rgba(0, 0, 0, 0.35);
        box-shadow: none;
      }
      .inline-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .inline-actions form {
        margin: 0;
      }
      .heartbeat-panel {
        margin-top: 14px;
        padding: 10px 12px;
        border: 1px solid var(--line);
        background: rgba(0, 255, 65, 0.05);
        box-shadow: var(--glow);
        font-size: 12px;
      }
      .heartbeat-panel.running {
        border-color: rgba(255, 60, 60, 0.4);
        background: rgba(255, 60, 60, 0.05);
        animation: heartbeat-pulse 2s ease-in-out infinite;
      }
      .heartbeat-panel.paused {
        border-color: rgba(255, 180, 0, 0.4);
        background: rgba(255, 180, 0, 0.05);
        box-shadow: 0 0 8px rgba(255, 180, 0, 0.3);
      }
      .heartbeat-title {
        text-transform: uppercase;
        letter-spacing: 1px;
        font-size: 11px;
        margin-bottom: 6px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .heartbeat-controls {
        display: flex;
        gap: 6px;
      }
      .heartbeat-btn {
        background: transparent;
        border: 1px solid var(--line);
        color: var(--text);
        padding: 2px 8px;
        font-size: 10px;
        cursor: pointer;
        font-family: inherit;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .heartbeat-btn:hover {
        background: rgba(0, 255, 65, 0.1);
        border-color: var(--text);
      }
      .heartbeat-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .heartbeat-row {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 4px;
      }
      .heartbeat-row:last-child {
        margin-bottom: 0;
      }
      .inline-input {
        background: #040804;
        border: 1px solid var(--line);
        color: var(--text);
        padding: 4px 6px;
        font-size: 11px;
        min-width: 120px;
      }
      .inline-edit {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: center;
      }
      .form-row {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 180px;
      }
      .form-row label {
        font-size: 12px;
        color: var(--muted);
      }
      .form-row input,
      .form-row select {
        background: #040804;
        border: 1px solid var(--line);
        color: var(--text);
        padding: 6px 8px;
        font-size: 12px;
      }`;
}
