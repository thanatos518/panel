/* Actions 定时面板 —— 前端逻辑
 *
 * 纯静态页面，直接调用 GitHub API 读写仓库（owner/repo/branch + fine-grained PAT）。
 * 保存时：一次性提交【脚本文件 + config.json + 重新生成的 .github/workflows/run.yml】。
 *
 * ⚠️ generateWorkflow() 是 gen_workflow.py 的 JS 同构实现，两边必须保持一致。
 */

const API = "https://api.github.com";
const CONFIG_PATH = "config.json";
const WORKFLOW_PATH = ".github/workflows/run.yml";

// ---------- 小工具 ----------
function toB64(str) { return btoa(unescape(encodeURIComponent(str))); }
function fromB64(b64) { return decodeURIComponent(escape(atob(String(b64).replace(/\s+/g, "")))); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function toast(msg, isErr) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = "toast"), 3500);
}

// ---------- 状态 ----------
const LS_KEY = "actions_panel_settings";
let state = {
  settings: { owner: "", repo: "", branch: "main", pat: "" },
  meta: { timeout_minutes: 45, grace_minutes: 15 },
  scripts: [],      // 每项含 _content/_isNew 等原样透传字段
  deletedPaths: [], // 待删除的文件路径
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    Object.assign(state.settings, s);
  } catch (e) {}
  document.getElementById("owner").value = state.settings.owner || "";
  document.getElementById("repo").value = state.settings.repo || "";
  document.getElementById("branch").value = state.settings.branch || "main";
  document.getElementById("pat").value = state.settings.pat || "";
  // 双仓部署（panel 公开 + tasks 业务私有）：github.io 上只探测 owner（用户名）；
  // repo 是业务仓库名，与面板仓库名不同，不能从 URL 推断，留给用户填写
  if (!state.settings.owner && location.hostname.endsWith(".github.io")) {
    const owner = location.hostname.split(".")[0];
    if (owner) document.getElementById("owner").value = owner;
  }
}
function saveSettings() {
  state.settings.owner = document.getElementById("owner").value.trim();
  state.settings.repo = document.getElementById("repo").value.trim();
  state.settings.branch = document.getElementById("branch").value.trim() || "main";
  state.settings.pat = document.getElementById("pat").value.trim();
  localStorage.setItem(LS_KEY, JSON.stringify(state.settings));
  toast("设置已保存到本地浏览器");
}

// ---------- GitHub API ----------
async function gh(path, { method = "GET", body, raw } = {}) {
  const opts = {
    method,
    headers: {
      "Authorization": "Bearer " + state.settings.pat,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(API + path, opts);
  if (r.status === 204) return null;
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!r.ok) {
    const msg = (data && data.message) || ("HTTP " + r.status);
    const err = new Error(msg);
    err.status = r.status;   // 供 commitFiles 判断是否为可重试的竞态冲突
    throw err;
  }
  return raw ? data : data;
}

async function getFile(path) {
  const d = await gh(`/repos/${state.settings.owner}/${state.settings.repo}/contents/${path}`);
  return { content: fromB64(d.content), sha: d.sha };
}

/** 原子提交多个文件（content 为 null 表示删除）。
 *  Actions 每天会自动回写日志到 main，面板保存若恰好基于旧 ref 会被拒；
 *  对 fast-forward / tree 冲突（409/422）自动重拉最新 ref 重试一次。 */
async function commitFiles(message, files, attempt = 0) {
  const { owner, repo, branch } = state.settings;
  try {
    const ref = await gh(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    const baseCommit = ref.object.sha;
    const baseInfo = await gh(`/repos/${owner}/${repo}/git/commits/${baseCommit}`);
    const baseTree = baseInfo.tree.sha;

    const tree = [];
    for (const f of files) {
      if (f.content === null) {
        tree.push({ path: f.path, mode: "100644", type: "blob", sha: null });
      } else {
        const blob = await gh(`/repos/${owner}/${repo}/git/blobs`, {
          method: "POST", body: { content: toB64(f.content), encoding: "base64" },
        });
        tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
      }
    }
    const newTree = await gh(`/repos/${owner}/${repo}/git/trees`, {
      method: "POST", body: { base_tree: baseTree, tree },
    });
    const commit = await gh(`/repos/${owner}/${repo}/git/commits`, {
      method: "POST",
      body: { message, tree: newTree.sha, parents: [baseCommit] },
    });
    await gh(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      method: "PATCH", body: { sha: commit.sha, force: false },
    });
    return commit.sha;
  } catch (err) {
    if (attempt < 1 && (err.status === 409 || err.status === 422)) {
      if (err.status === 422 && files.some(f => f.content === null)) {
        // 删除条目指向不存在的文件（GitRPC::BadObjectState）：剔除删除条目，保住其余变更重试
        files = files.filter(f => f.content !== null);
        return commitFiles(message, files, attempt + 1);
      }
      await new Promise(r => setTimeout(r, 800));
      return commitFiles(message, files, attempt + 1);
    }
    throw err;
  }
}

// ---------- 预设定时（值为 UTC cron；config.json 与 workflow 一律存 UTC） ----------
const CRON_PRESETS = [
  { label: "每天 07:00（北京）", cron: "0 23 * * *" },
  { label: "每天 08:00（北京）", cron: "0 0 * * *" },
  { label: "每天 12:00（北京）", cron: "0 4 * * *" },
  { label: "每天 20:00（北京）", cron: "0 12 * * *" },
  { label: "每天 23:30（北京）", cron: "30 15 * * *" },
  { label: "每 6 小时", cron: "0 */6 * * *" },
  { label: "每 12 小时", cron: "0 */12 * * *" },
  { label: "每周一 09:00（北京）", cron: "0 1 * * 1" },
  { label: "手动触发（无定时）", cron: "" },
];

function presetOptions(current) {
  const opts = CRON_PRESETS.map(p =>
    `<option value="${esc(p.cron)}" ${p.cron === current ? "selected" : ""}>${esc(p.label)}</option>`).join("");
  // 兼容历史自定义 cron：不在预设里就多给一个「自定义」项，避免数据丢失
  if (current && !CRON_PRESETS.some(p => p.cron === current))
    return `<option value="${esc(current)}" selected>自定义: ${esc(current)}</option>` + opts;
  return opts;
}

/** 仅用于显示：UTC 时 +8 成北京时间（不处理跨天）。 */
function bjDisplay(cron) {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return cron;
  if (/^\d+$/.test(p[1])) return `北京时间 ${String((parseInt(p[1]) + 8) % 24).padStart(2, "0")}:${(p[0].padStart(2, "0"))}`;
  return "UTC " + cron;
}

// ---------- GitHub Secrets 同步（libsodium sealed box，值不落 config.json） ----------
let knownSecrets = [];   // 仓库里已存在的 secret 名（大写），来自 connect 时的列表

function sealBox(value, pkB64) {
  const enc = new TextEncoder().encode(value);
  const pk = Uint8Array.from(atob(pkB64), c => c.charCodeAt(0));
  const sealed = nacl.sealedbox.seal(enc, pk);
  let bin = "";
  for (let i = 0; i < sealed.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, sealed.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function fetchSecretNames() {
  try {
    const d = await gh(`/repos/${state.settings.owner}/${state.settings.repo}/actions/secrets?per_page=100`);
    knownSecrets = (d.secrets || []).map(x => x.name);
  } catch (e) { knownSecrets = []; }   // PAT 没有 Secrets 读权限时静默降级，只是不显示「已设置」徽标
}

// ---------- workflow 生成（JS 同构 gen_workflow.py） ----------
function q(s) { return "'" + String(s == null ? "" : s).replace(/'/g, "''") + "'"; }

function generateWorkflow(cfg) {
  const scripts = (cfg.scripts || []).filter(s => s.enabled);
  const crons = [];
  const seenCron = new Set();
  for (const s of scripts) {
    const c = (s.cron || "").trim();
    if (c && !seenCron.has(c)) { seenCron.add(c); crons.push([c, s.name || s.id]); }
  }
  const literal = {};
  const secrets = [];
  for (const s of scripts) {
    for (const e of (s.env || [])) {
      const key = (e.key || "").trim();
      if (!key || key === "TZ") continue;
      if (e.secret) {
        if (!secrets.includes(key)) secrets.push(key);
        delete literal[key];
      } else if (!secrets.includes(key) && !(key in literal)) {
        literal[key] = e.value == null ? "" : e.value;
      }
    }
  }
  const py = [], node = [], ps = new Set(), ns = new Set();
  for (const s of scripts) {
    const lang = (s.language || "").toLowerCase();
    for (const d of (s.deps || [])) {
      const dd = String(d).trim();
      if (!dd) continue;
      if (lang === "python" || lang === "py") { if (!ps.has(dd)) { ps.add(dd); py.push(dd); } }
      else if (lang === "node" || lang === "js" || lang === "javascript") { if (!ns.has(dd)) { ns.add(dd); node.push(dd); } }
    }
  }
  const timeout = String(parseInt(cfg.timeout_minutes || 45));
  const L = [];
  L.push("name: ⏰ Actions 定时面板", "", "on:");
  if (crons.length) {
    L.push("  schedule:");
    for (const [c, name] of crons) L.push(`    - cron: "${c}"   # ${bjDisplay(c)} (${name})`);
  }
  L.push("  workflow_dispatch:", "    inputs:", "      script:",
    '        description: "可选：仅运行某个脚本 id（留空运行全部启用脚本）"',
    "        required: false", '        default: ""', "",
    "permissions:", "  contents: write", "",
    "concurrency:", "  group: actions-panel", "  cancel-in-progress: false", "",
    "jobs:", "  run:", "    runs-on: ubuntu-latest", `    timeout-minutes: ${timeout}`,
    "    env:", "      TZ: Asia/Shanghai");
  for (const k of Object.keys(literal).sort()) L.push(`      ${k}: ${q(literal[k])}`);
  for (const k of secrets) L.push(`      ${k}: \${{ secrets.${k} }}`);
  L.push("    steps:", "      - name: Checkout", "        uses: actions/checkout@v4", "",
    "      - name: Setup Python", "        uses: actions/setup-python@v5", "        with:",
    '          python-version: "3.11"', "",
    "      - name: Setup Node", "        uses: actions/setup-node@v4", "        with:",
    '          node-version: "20"', "");
  if (py.length || node.length) {
    L.push("      - name: 安装依赖", "        run: |");
    if (py.length) L.push(`          pip install --quiet ${[...py].sort().join(" ")}`);
    if (node.length) {
      L.push("          npm init -y >/dev/null 2>&1 || true");
      L.push(`          npm install --quiet ${[...node].sort().join(" ")}`);
    }
    L.push("");
  }
  L.push("      - name: 运行调度器", "        env:",
    "          INPUT_SCRIPT: \${{ github.event.inputs.script }}",
    "        run: python dispatcher.py", "",
    "      # 私有仓库才提交日志/状态（兼作防 60 天休眠的 keepalive）",
    "      - name: 提交日志与状态", "        if: always() && github.event.repository.private == true",
    "        run: |", '          git config user.name "github-actions[bot]"',
    '          git config user.email "github-actions[bot]@users.noreply.github.com"',
    "          git add -f logs 2>/dev/null || true",
    "          git add -f scripts/wb_refresh_tokens.json 2>/dev/null || true",
    "          if git diff --cached --quiet; then", '            echo "无变化"',
    "          else", '            git commit -m "chore: 更新运行日志 [skip ci]"', "            git push",
    "          fi", "");
  return L.join("\n");
}

// ---------- 渲染 ----------
const scriptsEl = document.getElementById("scripts");
const emptyEl = document.getElementById("empty");

function currentScript(id) { return state.scripts.find(s => s.id === id); }

function renderTasks() {
  scriptsEl.innerHTML = "";
  emptyEl.style.display = state.scripts.length ? "none" : "block";
  for (const s of state.scripts) scriptsEl.appendChild(scriptCard(s));
}

function scriptCard(s) {
  const card = document.createElement("div");
  card.className = "script-card";
  const envRows = (s.env || []).map((e, i) => envRow(s.id, i, e)).join("");
  card.innerHTML = `
    <div class="script-head">
      <input value="${esc(s.name)}" data-sid="${esc(s.id)}" data-field="name" placeholder="名称" style="font-size:14px;font-weight:600;border:none;border-bottom:1px dashed #d0d7de;padding:2px" />
      <span class="id">${esc(s.id)}</span>
      <span class="file">${esc(s.file)}</span>
      <div class="spacer"></div>
      <label class="enabled"><input type="checkbox" data-sid="${esc(s.id)}" data-field="enabled" ${s.enabled ? "checked" : ""} /> 启用</label>
      <button class="edit" data-edit="${esc(s.id)}">✎ 编辑代码</button>
      <button class="danger" data-run="${esc(s.id)}">▶ 运行一次</button>
      <button class="danger" data-del="${esc(s.id)}">删除</button>
    </div>
    <div class="script-body">
      <label>脚本路径 <input value="${esc(s.file)}" data-sid="${esc(s.id)}" data-field="file" placeholder="scripts/x.py" /></label>
      <label>语言
        <select data-sid="${esc(s.id)}" data-field="language">
          ${["python", "node", "shell"].map(l => `<option ${s.language === l ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      <label>定时（预设档位）
        <select data-sid="${esc(s.id)}" data-field="cron">${presetOptions(s.cron || "")}</select>
        <small style="color:#8a9099">UTC: ${esc(s.cron || "无定时，仅手动触发")}</small>
      </label>
      <label>运行参数 <input value="${esc(s.args || "")}" data-sid="${esc(s.id)}" data-field="args" placeholder="--only 1" /></label>
      <label style="grid-column:span 2">依赖（逗号分隔）<input value="${esc((s.deps || []).join(", "))}" data-sid="${esc(s.id)}" data-field="deps" placeholder="requests / axios" /></label>
    </div>
    <div class="env-block">
      <small style="color:#57606a">环境变量（secret 勾选后只写 \${{ secrets.KEY }}，值请到 Settings → Secrets 手动建）</small>
      ${envRows}
      <button class="add-env" data-addenv="${esc(s.id)}">＋ 添加变量</button>
    </div>`;
  return card;
}

function envRow(sid, i, e) {
  return `
    <div class="env-row">
      <input value="${esc(e.key || "")}" placeholder="变量名" data-sid="${esc(sid)}" data-field="env.${i}.key" />
      <input value="${esc(e.secret ? "" : (e.value == null ? "" : e.value))}"
             placeholder="${e.secret ? "填新值→保存时同步到 Secrets" : "值"}"
             data-sid="${esc(sid)}" data-field="env.${i}.value" />
      <label class="secret-tag"><input type="checkbox" data-sid="${esc(sid)}" data-field="env.${i}.secret" ${e.secret ? "checked" : ""} /> secret${e.secret && knownSecrets.includes((e.key || "").toUpperCase()) ? ' <span class="set-badge">已设置</span>' : ""}</label>
      <button class="rm" data-rmenv="${esc(sid)}" data-env-index="${i}">×</button>
    </div>`;
}

// 事件委托：文本/下拉/勾选
scriptsEl.addEventListener("input", e => {
  const t = e.target;
  if (!t.dataset || !t.dataset.sid) return;
  applyField(t.dataset.sid, t.dataset.field, t.value);
});
scriptsEl.addEventListener("change", e => {
  const t = e.target;
  if (!t.dataset || !t.dataset.sid) return;
  if (t.dataset.field === "enabled") {
    applyField(t.dataset.sid, t.dataset.field, t.checked);
  } else if (/\.secret$/.test(t.dataset.field || "")) {
    const s = currentScript(t.dataset.sid);
    const e = s.env[parseInt(t.dataset.field.match(/^env\.(\d+)\./)[1])];
    e.secret = t.checked;
    // 勾选切换时迁移已填的文字，避免用户输的内容丢掉
    if (e.secret) { e._secretValue = e._secretValue || e.value || ""; e.value = ""; }
    else { e.value = e._secretValue || e.value || ""; e._secretValue = ""; }
    renderTasks();
  }
});
scriptsEl.addEventListener("click", e => {
  if (e.target.dataset && e.target.dataset.del) removeScript(e.target.dataset.del);
  else if (e.target.dataset && e.target.dataset.edit) openCodeModal(e.target.dataset.edit);
  else if (e.target.dataset && e.target.dataset.run) runNow(e.target.dataset.run);
  else if (e.target.dataset && e.target.dataset.rmenv) removeEnv(e.target.dataset.rmenv, parseInt(e.target.dataset.envIndex));
  else if (e.target.dataset && e.target.dataset.addenv) { currentScript(e.target.dataset.addenv).env.push({ key: "", value: "", secret: false }); renderTasks(); }
});

function setField(sid, field, val) {
  const s = currentScript(sid);
  const m = field.match(/^env\.(\d+)\.(.+)$/);
  if (m) {
    const e = s.env[parseInt(m[1])];
    if (m[2] === "value" && e.secret) e._secretValue = val;   // secret 值只存内存，不进 config.json
    else e[m[2]] = val;
    return;
  }
  s[field] = val;
}
function applyField(sid, field, val) { setField(sid, field, val); }

function removeEnv(sid, i) { currentScript(sid).env.splice(i, 1); renderTasks(); }

function removeScript(id) {
  const i = state.scripts.findIndex(s => s.id === id);
  if (i < 0) return;
  const s = state.scripts[i];
  if (!s._isNew) state.deletedPaths.push(s.file); // 已入库的脚本：提交时删文件
  state.scripts.splice(i, 1);
  renderTasks();
}

// ---------- 添加脚本（多文件上传） ----------
document.getElementById("btn-add").addEventListener("click", () => document.getElementById("file-input").click());
document.getElementById("file-input").addEventListener("change", async e => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  let added = 0;
  for (const f of files) {
    const ext = f.name.split(".").pop().toLowerCase();
    const lang = { py: "python", js: "node", sh: "shell" }[ext];
    if (!lang) { toast("跳过不支持的类型：" + f.name, true); continue; }
    // 路径查重：同一文件只允许一个任务拥有（否则保存时 tree 重复 path 会 422）
    if (state.scripts.some(s => s.file === "scripts/" + f.name)) {
      toast("已存在同路径脚本 " + f.name + "，跳过（如需替换请先删除旧任务）", true);
      continue;
    }
    // id 查重：重名自动加后缀（a → a_2），避免幽灵任务/编辑串卡/运行双跑
    const baseId = f.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "_") || "script";
    let id = baseId, n = 2;
    while (state.scripts.some(s => s.id === id)) { id = baseId + "_" + n; n++; }
    const content = await f.text();
    state.scripts.push({
      id, name: f.name.replace(/\.[^.]+$/, ""),
      file: "scripts/" + f.name, language: lang, cron: "", enabled: true,
      args: "", deps: [], env: [],
      _content: content, _isNew: true,
    });
    added++;
  }
  renderTasks();
  if (added) toast(`已添加 ${added} 个脚本，请补全定时/依赖后保存`);
});

// ---------- 保存：提交脚本 + config.json + workflow ----------
async function doSave() {
  const cfg = {
    schema_version: 1,
    timeout_minutes: state.meta.timeout_minutes,
    grace_minutes: state.meta.grace_minutes,
    scripts: state.scripts.map(s => {
      const out = {
        id: s.id, name: s.name, file: s.file, language: s.language,
        cron: s.cron || "",
        enabled: !!s.enabled, args: s.args || "",
        deps: (s.deps || []).filter(Boolean),
        env: (s.env || []).filter(e => e.key).map(e => ({ key: e.key, value: e.secret ? undefined : e.value, secret: !!e.secret })),
      };
      return out;
    }),
  };
  const configText = JSON.stringify(cfg, null, 2) + "\n";
  const workflowText = generateWorkflow(cfg);

  // 按 path 去重（Map 后写覆盖先写）：同一文件被多条任务引用时（如 WorkBuddy
  // 三条任务共用一个脚本），以最后编辑的版本为准，避免 tree 重复 path 导致 422；
  // 同轮「删除 + 同名新增」冲突时以上传为准（丢弃删除条目）
  const fileMap = new Map();   // path -> content（null 表示删除）
  for (const s of state.scripts) {
    // 新上传的脚本、或在弹窗里改过内容的脚本（_dirty）才重新提交
    if ((s._isNew || s._dirty) && s._content !== undefined) fileMap.set(s.file, s._content);
  }
  for (const p of state.deletedPaths) {
    if (fileMap.has(p)) continue;
    // 只删除真实存在的文件：config 里的任务可能从未上传过文件（如示例任务），
    // 对不存在的路径发删除条目会让 git trees API 报 GitRPC::BadObjectState (422)
    try {
      await gh(`/repos/${state.settings.owner}/${state.settings.repo}/contents/${p}?ref=${encodeURIComponent(state.settings.branch)}`, { method: "HEAD" });
      fileMap.set(p, null);
    } catch (e) {
      if (e.status !== 404) throw e;
      console.log("跳过删除（文件本就不存在）：" + p);
    }
  }
  const files = [...fileMap].map(([path, content]) => ({ path, content }));
  files.push({ path: CONFIG_PATH, content: configText });
  files.push({ path: WORKFLOW_PATH, content: workflowText });

  await commitFiles("chore: 面板更新脚本与定时", files);
  state.deletedPaths = [];
  for (const s of state.scripts) { delete s._isNew; delete s._dirty; }

  // ---- 把勾选了 secret 且填了新值的环境变量加密同步到 GitHub Secrets ----
  let synced = 0;
  try {
    const pending = [];
    for (const s of state.scripts) for (const e of (s.env || [])) {
      if (e.secret && e.key && e._secretValue && e._secretValue.trim() !== "")
        pending.push({ name: e.key.trim(), value: e._secretValue, ref: e });
    }
    if (pending.length) {
      const bad = pending.filter(p => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name));
      if (bad.length) throw new Error("Secret 名不合法（仅字母/数字/下划线，字母开头）: " + bad.map(p => p.name).join(", "));
      if (!(window.nacl && nacl.sealedbox)) throw new Error("加密库未加载（检查能否访问 cdn.jsdelivr.net / unpkg.com）");
      const pk = await gh(`/repos/${state.settings.owner}/${state.settings.repo}/actions/secrets/public-key`);
      for (const p of pending) {
        const enc = sealBox(p.value, pk.key);
        await gh(`/repos/${state.settings.owner}/${state.settings.repo}/actions/secrets/${encodeURIComponent(p.name.toUpperCase())}`, {
          method: "PUT", body: { encrypted_value: enc, key_id: pk.key_id },
        });
        p.ref._secretValue = "";   // 同步成功后立刻从内存清掉明文
        const upper = p.name.toUpperCase();
        if (!knownSecrets.includes(upper)) knownSecrets.push(upper);
        synced++;
      }
    }
  } catch (se) {
    renderTasks();
    toast("文件已提交，但 Secrets 同步失败：" + se.message, true);
    return;
  }
  renderTasks();
  toast(synced ? `✅ 已保存并重写 workflow；同步 ${synced} 个 Secret 到 GitHub` : "✅ 已保存，workflow 已重写");
}

// ---------- 运行一次（触发 workflow_dispatch） ----------
async function runNow(id) {
  try {
    await gh(`/repos/${state.settings.owner}/${state.settings.repo}/actions/workflows/run.yml/dispatches`, {
      method: "POST", body: { ref: state.settings.branch, inputs: { script: id } },
    });
    toast("✅ 已触发运行 " + id + "（稍后看 Actions 页）");
  } catch (err) { toast("触发失败：" + err.message, true); }
}

// ---------- 连接 / 读取 ----------
async function connect() {
  saveSettings();
  try {
    const info = await gh(`/repos/${state.settings.owner}/${state.settings.repo}`);
    if (!state.settings.branch || document.getElementById("branch").value === "main") {
      state.settings.branch = info.default_branch || "main";
      document.getElementById("branch").value = state.settings.branch;
      localStorage.setItem(LS_KEY, JSON.stringify(state.settings));
    }
    const cfg = await getFile(CONFIG_PATH);
    const j = JSON.parse(cfg.content);
    state.meta.timeout_minutes = j.timeout_minutes || 45;
    state.meta.grace_minutes = j.grace_minutes || 15;
    state.scripts = (j.scripts || []).map(s => ({
      id: s.id, name: s.name || s.id, file: s.file, language: s.language || "python",
      cron: s.cron || "", enabled: !!s.enabled, args: s.args || "",
      deps: s.deps || [], env: (s.env || []).map(e => ({ key: e.key || "", value: e.value == null ? "" : e.value, secret: !!e.secret })),
    }));
    state.deletedPaths = [];
    await fetchSecretNames();   // 拉取已存在的 secret 名单，用于「已设置」徽标
    renderTasks();
    toast("已读取 config.json（" + state.scripts.length + " 个脚本）");
  } catch (err) { toast("连接/读取失败：" + err.message, true); }
}

// ---------- 日志 ----------
async function loadLogs() {
  const logsEl = document.getElementById("logs");
  try {
    const list = await gh(`/repos/${state.settings.owner}/${state.settings.repo}/contents/logs`);
    const files = list.filter(f => f.name.endsWith(".log")).slice().reverse();
    if (!files.length) { logsEl.innerHTML = '<div class="empty">还没有运行日志。</div>'; return; }
    logsEl.innerHTML = "";
    for (const f of files) {
      const d = await getFile("logs/" + f.name);
      const div = document.createElement("div");
      div.className = "log-item";
      const name = document.createElement("div");
      name.className = "log-name";
      name.textContent = f.name;
      const pre = document.createElement("pre");
      pre.textContent = d.content;
      div.appendChild(name); div.appendChild(pre);
      logsEl.appendChild(div);
    }
  } catch (err) { logsEl.innerHTML = '<div class="empty">读取日志失败：' + esc(err.message) + "</div>"; }
}

// ---------- 代码编辑弹窗（查看/修改已入库脚本内容） ----------
const codeModal = document.getElementById("code-modal");
const codeArea = document.getElementById("code-area");
let codeSid = null;

async function openCodeModal(sid) {
  const s = currentScript(sid);
  if (!s) return;
  codeSid = sid;
  document.getElementById("code-modal-title").textContent = "编辑脚本：" + s.file;
  if (s._content === undefined) {
    try {
      const d = await getFile(s.file);
      s._content = d.content;   // 缓存下来，二次打开不用再拉
    } catch (err) { toast("读取脚本失败：" + err.message, true); codeSid = null; return; }
  }
  codeArea.value = s._content;
  codeModal.classList.remove("hidden");
  codeArea.focus();
}

function closeCodeModal() {
  codeModal.classList.add("hidden");
  codeSid = null;
}

document.getElementById("code-close").addEventListener("click", closeCodeModal);
document.getElementById("code-save").addEventListener("click", () => {
  if (!codeSid) return closeCodeModal();
  const s = currentScript(codeSid);
  if (s && s._content !== codeArea.value) {
    s._content = codeArea.value;
    s._dirty = true;   // 标记为已改，点「保存全部」时才真正提交
    toast("代码已暂存，记得点「保存全部并重写 workflow」提交到仓库");
  }
  closeCodeModal();
});
codeModal.addEventListener("click", e => { if (e.target === codeModal) closeCodeModal(); });
document.addEventListener("keydown", e => {
  if (codeModal.classList.contains("hidden")) return;
  if (e.key === "Escape") closeCodeModal();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    document.getElementById("code-save").click();
  }
});

// ---------- 事件绑定 ----------
document.getElementById("btn-connect").addEventListener("click", connect);
document.getElementById("btn-settings-save").addEventListener("click", saveSettings);
document.getElementById("btn-save").addEventListener("click", () => doSave().catch(err => toast("保存失败：" + err.message, true)));
document.getElementById("btn-refresh-logs").addEventListener("click", loadLogs);
document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === t));
  document.querySelectorAll(".tab-body").forEach(x => x.classList.toggle("active", x.id === "tab-" + t.dataset.tab));
  if (t.dataset.tab === "logs") loadLogs();
}));

loadSettings();
