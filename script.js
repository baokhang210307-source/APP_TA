const app = document.getElementById("app");
const toast = document.getElementById("toast");

const STORE_KEY = "baoKhangVocabState.v1";
const SESSION_KEY = "baoKhangVocabSession.v1";
const ADMIN_STATE_KEY = "baoKhangVocabAdminState.v1";
const THEME_KEY = "baoKhangVocabTheme.v1";

// Google Apps Script Web App endpoint for per-user JSON sync.
// Keep Drive folder IDs, admin password, and private tokens inside Apps Script.
const CLOUD_SYNC_URL = "https://script.google.com/macros/s/AKfycbz9xxUk6vWa2tFEVcvRDscp3Ml36Va9CyThsZ9-2WV6pe9sWdRM9Zw2xeO9I5nsqTwK/exec";

const SECURITY_LIMITS = Object.freeze({
  usernameLength: 40,
  passwordLength: 128,
  nameLength: 120,
  termLength: 120,
  meaningLength: 300,
  exampleLength: 1000,
  bulkCharacters: 200000,
  bulkLines: 1000,
  shareCharacters: 750000,
  users: 500,
  foldersPerUser: 250,
  filesPerFolder: 500,
  wordsPerFile: 5000,
  cloudPayloadBytes: 5 * 1024 * 1024,
  cloudTimeoutMs: 20000
});

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{2,40}$/;
const USER_VIEWS = new Set(["home", "folder", "file", "randomSetup", "study"]);
const PUBLIC_ACTIONS = new Set(["login-admin", "login-user", "back", "toggle-theme", "close-modal"]);
const ADMIN_ACTIONS = new Set(["reset-password", "delete-user"]);
const USER_ACTIONS = new Set([
  "open-settings", "set-word-entry-mode", "open-folder", "delete-folder", "share-folder",
  "open-file", "delete-file", "share-file", "edit-word", "delete-word", "start-new",
  "start-review", "open-random", "start-new-folder", "start-review-folder", "open-random-folder",
  "start-new-file", "start-review-file", "open-random-file", "choose-answer", "next-task",
  "cancel-study", "import-pending-share", "dismiss-pending-share", "import-file-to-folder",
  "copy-modal-link", "review-lower-level", "review-keep-level"
]);

const DEFAULT_SETTINGS = {
  newWordsPerSession: 10,
  reviewWordsPerSession: 10,
  typeRepetitions: 5,
  choiceRepetitions: 2
};

const LEVELS = [
  { key: "lv1", label: "LV1", level: 1 },
  { key: "lv2", label: "LV2", level: 2 },
  { key: "lv3", label: "LV3", level: 3 },
  { key: "lv4", label: "LV4", level: 4 },
  { key: "lv5", label: "LV5", level: 5 },
  { key: "mastered", label: "mastered", level: 6 }
];
const LEVEL_KEY_BY_NUMBER = Object.freeze(
  Object.fromEntries(LEVELS.map(item => [item.level, item.key]))
);

const REVIEW_INTERVALS = {
  1: 60 * 60 * 1000,
  2: 24 * 60 * 60 * 1000,
  3: 3 * 24 * 60 * 60 * 1000,
  4: 7 * 24 * 60 * 60 * 1000,
  5: 14 * 24 * 60 * 60 * 1000,
  6: 30 * 24 * 60 * 60 * 1000
};

const FALLBACK_CHOICES = [
  "accurate",
  "curious",
  "steady",
  "brilliant",
  "journey",
  "capture",
  "gentle",
  "native",
  "resolve",
  "wonder"
];

let session = loadSession();
let state = loadState();
let routeStack = [];
let route = getInitialRoute();
let modal = null;
let activeStudy = null;
let pendingShare = readShareFromHash();
let wordEntryMode = "manual";
let studyAutoTimer = null;
let countdownTimer = null;
let cloudSyncTimer = null;
let isCloudSyncing = false;
let isLoginPending = false;
let lastRenderedRouteKey = "";

applyTheme();
bindAppEvents();
render();

function loadState() {
  if (!session) {
    localStorage.removeItem(STORE_KEY);
    sessionStorage.removeItem(ADMIN_STATE_KEY);
    return { users: {} };
  }

  try {
    const storage = session?.type === "admin" ? sessionStorage : localStorage;
    const key = session?.type === "admin" ? ADMIN_STATE_KEY : STORE_KEY;
    const parsed = JSON.parse(storage.getItem(key));
    const cleanState = normalizeState(parsed, session?.type === "user" ? session.username : null);
    storage.setItem(key, JSON.stringify(cleanState));
    if (session?.type === "admin") localStorage.removeItem(STORE_KEY);
    return cleanState;
  } catch (error) {
    console.warn("Could not load saved state", error);
  }

  return { users: {} };
}

function loadSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
    const parsed = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    if (!parsed || !["admin", "user"].includes(parsed.type)) return null;
    if (!parsed.cloudToken || Number(parsed.expiresAt || 0) <= Date.now()) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    if (!isValidUsername(parsed.username)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveState() {
  persistStateOnly();
  queueCloudSync();
}

function persistStateOnly() {
  if (session?.type === "admin") {
    const cleanState = normalizeState(state);
    sessionStorage.setItem(ADMIN_STATE_KEY, JSON.stringify(cleanState));
    localStorage.removeItem(STORE_KEY);
    return;
  }

  if (session?.type === "user") {
    const user = currentUser();
    if (user) {
      localStorage.setItem(STORE_KEY, JSON.stringify({ users: { [user.username]: user } }));
    }
    sessionStorage.removeItem(ADMIN_STATE_KEY);
    return;
  }

  localStorage.removeItem(STORE_KEY);
  sessionStorage.removeItem(ADMIN_STATE_KEY);
}

function saveSession() {
  if (!session) {
    sessionStorage.removeItem(SESSION_KEY);
    return;
  }

  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function hasCloudSync() {
  try {
    const url = new URL(CLOUD_SYNC_URL.trim());
    return url.protocol === "https:" && url.hostname === "script.google.com";
  } catch {
    return false;
  }
}

function hasCloudSession() {
  return Boolean(session?.cloudToken);
}

function queueCloudSync() {
  if (!hasCloudSync() || session?.type !== "user" || !hasCloudSession()) return;

  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(syncCurrentWorkspaceToCloud, 900);
}

async function syncCurrentWorkspaceToCloud() {
  if (!hasCloudSync() || isCloudSyncing || session?.type !== "user" || !hasCloudSession()) return;

  isCloudSyncing = true;
  try {
    await saveUserToCloud(currentUser());
  } catch (error) {
    console.warn("Cloud sync failed", error);
  } finally {
    isCloudSyncing = false;
  }
}

async function saveUserToCloud(user) {
  if (!user) return null;

  return cloudSave(cloudUserFileName(user.username), {
    type: "userWorkspace",
    username: user.username,
    user: serializeUserForCloud(user),
    updatedAt: Date.now()
  });
}

function cloudUserFileName(username) {
  const safeName = String(username || "user")
    .trim()
    .replace(/[\\/:*?"<>|#%{}~&]/g, "_");
  return `${safeName || "user"}.json`;
}

async function cloudSave(filename, data) {
  return cloudRequest({
    action: "save",
    filename,
    data
  });
}

function cloudAuthPayload() {
  if (!hasCloudSession()) return {};

  return {
    sessionToken: session.cloudToken,
    role: session.type,
    username: session.username
  };
}

async function cloudRequest(payload, options = {}) {
  const body = JSON.stringify({
      app: "BaoKhangVocab",
      sentAt: Date.now(),
      ...(options.skipAuth ? {} : (options.auth || cloudAuthPayload())),
      ...payload
  });

  if (new TextEncoder().encode(body).byteLength > SECURITY_LIMITS.cloudPayloadBytes) {
    throw new Error("Dữ liệu đồng bộ vượt quá giới hạn an toàn.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SECURITY_LIMITS.cloudTimeoutMs);
  let response;
  try {
    response = await fetch(CLOUD_SYNC_URL.trim(), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Đồng bộ quá thời gian chờ.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Google Apps Script did not return JSON. Check Web App deployment URL and access.");
  }

  if (!response.ok || data.success === false) {
    if (/session expired|session invalid/i.test(String(data.error || ""))) {
      logout(false);
    }
    throw new Error(data.error || "Cloud sync error");
  }

  return data;
}

async function hydrateFromCloudLogin({ role, username, password }) {
  if (!hasCloudSync()) return { success: false };

  try {
    const data = await cloudRequest({
      action: "login",
      role,
      username,
      password
    }, { skipAuth: true });

    if (role === "admin") {
      state = normalizeState(data.state || { users: {} });
      persistStateOnly();
      return {
        success: true,
        cloudToken: data.sessionToken,
        expiresAt: Number(data.expiresAt || 0),
        username: sanitizeUsername(data.username || username)
      };
    }

    if (role === "user" && data.user) {
      const user = data.user;
      user.username = username;
      ensureUserShape(user);
      state = { users: { [username]: user } };
      persistStateOnly();
      return {
        success: true,
        cloudToken: data.sessionToken,
        expiresAt: Number(data.expiresAt || 0)
      };
    }

    return { success: false };
  } catch (error) {
    console.warn("Cloud login failed", error);
    return { success: false };
  }
}

function ensureUserShape(user) {
  if (!isPlainObject(user)) return;

  user.username = sanitizeUsername(user.username);
  delete user.password;
  delete user.passwordHash;
  delete user.passwordSalt;
  delete user.passwordAlgo;
  user.settings = sanitizeSettings(user.settings);
  user.folders = Array.isArray(user.folders)
    ? user.folders.slice(0, SECURITY_LIMITS.foldersPerUser).filter(isPlainObject)
    : [];
  user.createdAt = safeTimestamp(user.createdAt, Date.now());

  user.folders.forEach(folder => {
    folder.id = sanitizeId(folder.id);
    folder.name = sanitizeText(folder.name || "Untitled folder", SECURITY_LIMITS.nameLength);
    folder.createdAt = safeTimestamp(folder.createdAt, Date.now());
    folder.files = Array.isArray(folder.files)
      ? folder.files.slice(0, SECURITY_LIMITS.filesPerFolder).filter(isPlainObject)
      : [];

    folder.files.forEach(file => {
      file.id = sanitizeId(file.id);
      file.name = sanitizeText(file.name || "Untitled file", SECURITY_LIMITS.nameLength);
      file.createdAt = safeTimestamp(file.createdAt, Date.now());
      file.words = Array.isArray(file.words)
        ? file.words.slice(0, SECURITY_LIMITS.wordsPerFile).filter(isPlainObject)
        : [];

      file.words.forEach(word => {
        word.id = sanitizeId(word.id);
        word.term = sanitizeText(word.term, SECURITY_LIMITS.termLength);
        word.meaning = sanitizeText(word.meaning, SECURITY_LIMITS.meaningLength);
        word.example = sanitizeMultiline(word.example, SECURITY_LIMITS.exampleLength);
        word.level = clampNumber(word.level, 0, 6);
        word.nextReviewAt = nullableTimestamp(word.nextReviewAt);
        word.createdAt = safeTimestamp(word.createdAt, Date.now());
        word.learnedAt = nullableTimestamp(word.learnedAt);
        word.lastStudiedAt = nullableTimestamp(word.lastStudiedAt);
        word.studiedCount = clampNumber(word.studiedCount, 0, 1000000);
      });
    });
  });
}

function normalizeState(input, onlyUsername = null) {
  const cleanState = { users: {} };
  if (!isPlainObject(input) || !isPlainObject(input.users)) return cleanState;

  Object.entries(input.users)
    .slice(0, SECURITY_LIMITS.users)
    .forEach(([key, value]) => {
      if (!isPlainObject(value)) return;
      const username = sanitizeUsername(value.username || key);
      if (!isValidUsername(username) || (onlyUsername && username !== onlyUsername)) return;
      value.username = username;
      ensureUserShape(value);
      cleanState.users[username] = value;
    });

  return cleanState;
}

function replaceAdminState(nextState) {
  if (!requireRole("admin")) return;
  state = normalizeState(nextState || { users: {} });
  persistStateOnly();
}

function serializeUserForCloud(user) {
  if (!isPlainObject(user)) return null;
  const copy = JSON.parse(JSON.stringify(user));
  ensureUserShape(copy);
  return copy;
}

function sanitizeSettings(settings) {
  const value = isPlainObject(settings) ? settings : {};
  return {
    newWordsPerSession: clampNumber(value.newWordsPerSession ?? DEFAULT_SETTINGS.newWordsPerSession, 1, 100),
    reviewWordsPerSession: clampNumber(value.reviewWordsPerSession ?? DEFAULT_SETTINGS.reviewWordsPerSession, 1, 100),
    typeRepetitions: clampNumber(value.typeRepetitions ?? DEFAULT_SETTINGS.typeRepetitions, 0, 20),
    choiceRepetitions: clampNumber(value.choiceRepetitions ?? DEFAULT_SETTINGS.choiceRepetitions, 0, 20)
  };
}

function getInitialRoute() {
  if (hasActiveSession("admin")) {
    return { view: "admin" };
  }

  if (hasActiveSession("user") && state.users[session.username]) {
    return { view: "home" };
  }

  session = null;
  saveSession();
  return { view: "landing" };
}

function render() {
  const adminView = route.view === "admin";
  if ((adminView && !hasActiveSession("admin")) || (USER_VIEWS.has(route.view) && !hasActiveSession("user"))) {
    session = null;
    saveSession();
    routeStack = [];
    route = { view: "landing" };
  }

  const routeKey = [route.view, route.role, route.folderId, route.fileId].filter(Boolean).join(":");
  app.classList.toggle("is-route-changing", routeKey !== lastRenderedRouteKey);
  lastRenderedRouteKey = routeKey;

  const html = {
    landing: renderLanding,
    login: renderLogin,
    admin: renderAdmin,
    home: renderHome,
    folder: renderFolder,
    file: renderFile,
    randomSetup: renderRandomSetup,
    study: renderStudy
  }[route.view]();

  app.innerHTML = html + renderModal();
  bindCurrentView();
  createIcons();
  animateProgressBars();
}

function createIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function animateProgressBars() {
  requestAnimationFrame(() => {
    app.querySelectorAll("[data-progress-target]").forEach(element => {
      element.style.width = `${Number(element.dataset.progressTarget) || 0}%`;
    });
  });
}

function renderLanding() {
  return `
    <section class="auth-layout">
      <div class="auth-header">
        <div class="brand-line">
          <span class="brand-mark">BK</span>
          <span class="brand-title">
            <strong>BaoKhang Vocab</strong>
            <span>English spaced repetition workspace</span>
          </span>
        </div>
        <h1>Chọn khu vực đăng nhập</h1>
        <p>Admin cấp tài khoản. User chỉ vào được workspace học từ vựng khi đã có tài khoản do Admin tạo.</p>
      </div>

      <div class="role-grid">
        <button class="role-card" data-action="login-admin">
          <span class="role-icon"><i data-lucide="shield-check"></i></span>
          <h2>Admin</h2>
          <p>Tạo tài khoản, đặt mật khẩu, xóa user và sao lưu toàn bộ dữ liệu.</p>
        </button>

        <button class="role-card" data-action="login-user">
          <span class="role-icon teal"><i data-lucide="graduation-cap"></i></span>
          <h2>User</h2>
          <p>Quản lý folder, file từ vựng, học ngắt quãng và nhận link chia sẻ.</p>
        </button>
      </div>
    </section>
  `;
}

function renderLogin() {
  const role = route.role || "user";
  const isAdmin = role === "admin";

  return `
    <section class="auth-layout login-layout">
      ${topbar({
        title: isAdmin ? "Đăng nhập Admin" : "Đăng nhập User",
        subtitle: isAdmin ? "Tài khoản quản trị hệ thống" : "Chỉ tài khoản được Admin cấp mới đăng nhập được",
        back: true,
        actions: themeButton()
      })}

      <section class="panel login-panel">
        <div class="panel-header">
          <div>
            <h2>${isAdmin ? "Admin" : "User"}</h2>
            <p>${isAdmin ? "Nhập tài khoản quản trị để vào khu vực Admin." : "Nhập username và mật khẩu do Admin cấp."}</p>
          </div>
        </div>

        <form id="loginForm" class="form-grid" autocomplete="off" data-form-type="other">
          <div class="field full">
            <label for="username">Tên đăng nhập</label>
            <input id="username" name="username" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="${SECURITY_LIMITS.usernameLength}" pattern="[A-Za-z0-9._-]{2,40}" placeholder="${isAdmin ? "Tên đăng nhập Admin" : "Tên đăng nhập User"}" required />
          </div>
          <div class="field full">
            <label for="loginSecret">Mật khẩu</label>
            <input id="loginSecret" class="masked-input" name="password" type="password" autocomplete="current-password" maxlength="${SECURITY_LIMITS.passwordLength}" placeholder="Mật khẩu" required />
          </div>
          <div class="form-actions">
            <button class="btn ghost" type="button" data-action="back">Cancel</button>
            <button class="btn primary" type="submit">
              <i data-lucide="log-in"></i>
              Đăng nhập
            </button>
          </div>
        </form>
      </section>
    </section>
  `;
}

function renderAdmin() {
  const users = Object.values(state.users).sort((a, b) => a.username.localeCompare(b.username));
  const userMetrics = new Map(users.map(user => {
    const words = getAllWords(user);
    return [user.username, {
      total: words.length,
      learned: words.reduce((sum, item) => sum + (item.word.level > 0 ? 1 : 0), 0)
    }];
  }));
  const totalWords = [...userMetrics.values()].reduce((sum, metrics) => sum + metrics.total, 0);

  return `
    <section class="screen">
      ${topbar({
        title: "Admin Dashboard",
        subtitle: `Đang đăng nhập: ${escapeHtml(session.username || "Admin")}`,
        actions: `
          ${themeButton()}
          <button class="btn secondary" data-action="logout"><i data-lucide="log-out"></i>Đăng xuất</button>
        `
      })}

      <div class="grid-3">
        ${metricCard("Users", users.length, "Tài khoản đã cấp")}
        ${metricCard("Folders", users.reduce((sum, user) => sum + user.folders.length, 0), "Tổng folder")}
        ${metricCard("Vocabulary", totalWords, "Tổng từ trong mọi workspace")}
      </div>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Cấp tài khoản User</h2>
            <p>Mỗi username sẽ có workspace riêng, không trộn dữ liệu với user khác.</p>
          </div>
        </div>

        <form id="createUserForm" class="form-grid">
          <div class="field">
            <label for="newUsername">Tên đăng nhập</label>
            <input id="newUsername" required minlength="2" maxlength="${SECURITY_LIMITS.usernameLength}" pattern="[A-Za-z0-9._-]{2,40}" autocomplete="off" placeholder="Ví dụ: test" />
          </div>
          <div class="field">
            <label for="newPassword">Mật khẩu</label>
            <input id="newPassword" type="password" autocomplete="new-password" required minlength="4" maxlength="${SECURITY_LIMITS.passwordLength}" placeholder="Tạo mật khẩu" />
          </div>
          <div class="form-actions">
            <button class="btn primary" type="submit"><i data-lucide="user-plus"></i>Tạo user</button>
          </div>
        </form>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Danh sách User</h2>
            <p>Admin có thể đổi mật khẩu hoặc xóa workspace của từng user.</p>
          </div>
        </div>
        ${users.length ? `
          <div class="admin-table">
            ${users.map(user => {
              const metrics = userMetrics.get(user.username);
              return `
                <article class="admin-row">
                  <div>
                    <strong>${escapeHtml(user.username)}</strong>
                    <span>${user.folders.length} folder · ${metrics.learned}/${metrics.total} từ đã học · tạo ${formatDate(user.createdAt)}</span>
                  </div>
                  <div class="row-actions">
                    <button class="btn ghost" data-action="reset-password" data-username="${escapeAttr(user.username)}">
                      <i data-lucide="key-round"></i>Đổi mật khẩu
                    </button>
                    <button class="btn danger" data-action="delete-user" data-username="${escapeAttr(user.username)}">
                      <i data-lucide="trash-2"></i>Xóa
                    </button>
                  </div>
                </article>
              `;
            }).join("")}
          </div>
        ` : emptyState("users", "Chưa có user", "Tạo user đầu tiên để bắt đầu cấp workspace học từ vựng.")}
      </section>
    </section>
  `;
}

function renderHome() {
  const user = currentUser();
  const stats = getStats(user);
  const dueCount = stats.due;
  const newCount = stats.new;
  const settings = user.settings;
  const reviewSummary = getReviewSummary(user);
  const sortedFolders = sortFoldersForDisplay(user);

  return `
    <section class="screen">
      ${topbar({
        title: `Xin chào, ${escapeHtml(user.username)}`,
        subtitle: "Workspace học từ vựng riêng của bạn",
        actions: `
          ${themeButton()}
          <button class="icon-btn" title="Settings" aria-label="Settings" data-action="open-settings"><i data-lucide="settings"></i></button>
          <button class="btn secondary" data-action="logout"><i data-lucide="log-out"></i>Đăng xuất</button>
        `
      })}

      ${pendingShare ? renderPendingShare() : ""}

      <div class="dashboard-grid">
        <section class="stat-card">
          <div class="stat-heading">
            <span class="role-icon teal"><i data-lucide="book-open-check"></i></span>
            <h3>Tổng tiến độ</h3>
          </div>
          <div class="stat-number">
            <strong>${stats.learned}/${stats.total}</strong>
            <span>từ đã học</span>
          </div>
          <div class="stat-grid">
            <div class="mini-stat"><strong>${newCount}</strong><span>Từ mới</span></div>
            <div class="mini-stat"><strong>${dueCount}</strong><span>Đến hạn ôn</span></div>
            <div class="mini-stat"><strong>${stats.mastered}</strong><span>Mastered</span></div>
          </div>
        </section>

        ${renderChart(stats)}
      </div>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Học hôm nay</h2>
            <p>Mặc định: ${settings.newWordsPerSession} từ mới, ${settings.reviewWordsPerSession} từ ôn, ${settings.typeRepetitions} lần gõ, ${settings.choiceRepetitions} lần chọn.</p>
          </div>
        </div>
        <div class="grid-3">
          ${actionCard("Học từ mới", `${newCount} từ chưa học`, "play", "start-new", newCount === 0)}
          ${actionCard("Ôn tập đến hạn", `${dueCount} từ cần ôn`, "rotate-ccw", "start-review", dueCount === 0)}
          ${actionCard("Học random", "Chọn số từ và số lần hiển thị", "shuffle", "open-random", stats.learned === 0)}
        </div>
      </section>

      ${renderReviewClockPanel(reviewSummary, "Đồng hồ ôn tập", "Hiển thị mốc ôn tập gần nhất.")}

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Nhận link chia sẻ</h2>
            <p>Dán link folder hoặc file từ vựng của user khác để import vào workspace này.</p>
          </div>
        </div>
        <form id="receiveShareForm" class="share-box">
          <input class="field-input" id="shareInput" maxlength="${SECURITY_LIMITS.shareCharacters}" placeholder="Dán link chia sẻ vào đây" required />
          <button class="btn primary" type="submit"><i data-lucide="folder-down"></i>Nhận link</button>
        </form>
      </section>

      <section class="panel">
        <div class="workspace-toolbar">
          <div>
            <h2>Folders</h2>
            <p class="muted">Tạo folder, file và thêm từ vựng để học.</p>
          </div>
          <form id="createFolderForm" class="inline-actions">
            <div class="search-box">
              <i data-lucide="folder-plus"></i>
              <input id="folderName" maxlength="${SECURITY_LIMITS.nameLength}" placeholder="Tên folder mới" required />
            </div>
            <button class="btn primary" type="submit"><i data-lucide="plus"></i>Tạo folder</button>
          </form>
        </div>

        <div class="item-grid" style="margin-top: 16px;">
          ${sortedFolders.length ? sortedFolders.map(folder => renderFolderCard(user, folder)).join("") : emptyState("folder", "Chưa có folder", "Tạo folder đầu tiên, sau đó tạo file và thêm từ vựng vào file.")}
        </div>
      </section>
    </section>
  `;
}

function renderFolder() {
  const user = currentUser();
  const folder = findFolder(user, route.folderId);

  if (!folder) {
    navigate({ view: "home" }, false);
    return "";
  }

  const folderWords = getAllWords(user, { folderId: folder.id });
  const newCount = folderWords.filter(item => item.word.level === 0).length;
  const dueCount = folderWords.filter(item => item.word.level > 0 && item.word.nextReviewAt && item.word.nextReviewAt <= Date.now()).length;
  const reviewSummary = getReviewSummary(user, { folderId: folder.id });
  const sortedFiles = sortFilesForDisplay(user, folder);

  return `
    <section class="screen">
      ${topbar({
        title: escapeHtml(folder.name),
        subtitle: `${folder.files.length} file · ${folderWords.length} từ`,
        back: true,
        actions: `
          ${themeButton()}
          <button class="icon-btn" title="Settings" aria-label="Settings" data-action="open-settings"><i data-lucide="settings"></i></button>
          <button class="btn ghost" data-action="share-folder" data-folder-id="${escapeAttr(folder.id)}"><i data-lucide="share-2"></i>Share folder</button>
        `
      })}

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Học trong folder</h2>
            <p>Chỉ chọn từ vựng nằm trong folder này.</p>
          </div>
        </div>
        <div class="grid-3">
          ${actionCard("Học từ mới", `${newCount} từ chưa học`, "play", "start-new-folder", newCount === 0)}
          ${actionCard("Ôn tập đến hạn", `${dueCount} từ cần ôn`, "rotate-ccw", "start-review-folder", dueCount === 0)}
          ${actionCard("Random folder", "Luyện lại từ đã học", "shuffle", "open-random-folder", folderWords.filter(item => item.word.level > 0).length === 0)}
        </div>
      </section>

      ${renderReviewClockPanel(reviewSummary, "Đồng hồ ôn tập trong folder", "Hiển thị mốc ôn tập gần nhất trong folder này.")}

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Files từ vựng</h2>
            <p>Tạo file theo chủ đề, bài học hoặc nguồn tài liệu.</p>
          </div>
        </div>

        <form id="createFileForm" class="form-grid">
          <div class="field full">
            <label for="fileName">Tên file mới</label>
            <input id="fileName" maxlength="${SECURITY_LIMITS.nameLength}" required placeholder="Ví dụ: Unit 1 - Daily routines" />
          </div>
          <div class="form-actions">
            <button class="btn ghost" type="button" data-action="back">Cancel</button>
            <button class="btn primary" type="submit"><i data-lucide="file-plus-2"></i>Tạo file</button>
          </div>
        </form>

        <div class="item-grid" style="margin-top: 16px;">
          ${sortedFiles.length ? sortedFiles.map(file => renderFileCard(user, folder, file)).join("") : emptyState("file", "Folder chưa có file", "Tạo file từ vựng để bắt đầu thêm từ và học.")}
        </div>
      </section>
    </section>
  `;
}

function renderFile() {
  const user = currentUser();
  const folder = findFolder(user, route.folderId);
  const file = folder ? findFile(folder, route.fileId) : null;

  if (!folder || !file) {
    navigate({ view: "home" }, false);
    return "";
  }

  const words = file.words;
  const sortedWords = sortWordsForDisplay(words);
  const learned = words.filter(word => word.level > 0).length;
  const newCount = words.filter(word => word.level === 0).length;
  const dueCount = words.filter(word => word.level > 0 && word.nextReviewAt && word.nextReviewAt <= Date.now()).length;
  const reviewSummary = getReviewSummary(user, { folderId: folder.id, fileId: file.id });
  return `
    <section class="screen">
      ${topbar({
        title: escapeHtml(file.name),
        subtitle: `${escapeHtml(folder.name)} · ${learned}/${words.length} từ đã học`,
        back: true,
        actions: `
          ${themeButton()}
          <button class="icon-btn" title="Settings" aria-label="Settings" data-action="open-settings"><i data-lucide="settings"></i></button>
          <button class="btn ghost" data-action="share-file" data-folder-id="${escapeAttr(folder.id)}" data-file-id="${escapeAttr(file.id)}"><i data-lucide="share-2"></i>Share file</button>
        `
      })}

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Học trong file</h2>
            <p>Chỉ chọn từ vựng nằm trong file này.</p>
          </div>
        </div>
        <div class="grid-3">
          ${actionCard("Học từ mới", `${newCount} từ chưa học`, "play", "start-new-file", newCount === 0)}
          ${actionCard("Ôn tập đến hạn", `${dueCount} từ cần ôn`, "rotate-ccw", "start-review-file", dueCount === 0)}
          ${actionCard("Random file", "Luyện lại từ đã học", "shuffle", "open-random-file", learned === 0)}
        </div>
      </section>

      ${renderReviewClockPanel(reviewSummary, "Đồng hồ ôn tập trong file", "Chỉ hiển thị mốc ôn tập của từ vựng đã học trong file này.")}

      <section class="panel word-entry-panel">
        <div class="panel-header">
          <div>
            <h2>Thêm từ vựng</h2>
            <p>Mỗi từ cần tiếng Anh và định nghĩa tiếng Việt để tạo bài học.</p>
          </div>
        </div>
        <form id="addWordForm" class="form-grid">
          <div class="entry-tabs field full" role="tablist" aria-label="Chọn cách nhập từ vựng" data-active="${wordEntryMode}">
            <button class="${wordEntryMode === "manual" ? "active" : ""}" type="button" data-action="set-word-entry-mode" data-mode="manual">
              <i data-lucide="keyboard"></i>Nhập từng từ
            </button>
            <button class="${wordEntryMode === "bulk" ? "active" : ""}" type="button" data-action="set-word-entry-mode" data-mode="bulk">
              <i data-lucide="list-plus"></i>Nhập nhanh nhiều dòng
            </button>
          </div>
          <div class="word-entry-content ${wordEntryMode} field full">
            ${renderWordEntryFields(wordEntryMode)}
          </div>
          <div class="form-actions">
            <button class="btn ghost" type="button" data-action="back">Cancel</button>
            <button class="btn primary" type="submit"><i data-lucide="plus"></i>Thêm từ</button>
          </div>
        </form>
      </section>

      <section class="panel word-list-panel">
        <div class="panel-header">
          <div>
            <h2>Danh sách từ</h2>
            <p>${words.length} từ trong file này.</p>
          </div>
        </div>
        ${words.length ? `
          <div class="word-list">
            ${sortedWords.map(word => renderWordRow(word)).join("")}
          </div>
        ` : emptyState("book-open", "File chưa có từ", "Thêm từ vựng đầu tiên để bắt đầu học.")}
      </section>
    </section>
  `;
}

function renderWordEntryFields(mode) {
  return mode === "manual" ? `
    <div class="field">
      <label for="wordTerm">Từ tiếng Anh</label>
      <input id="wordTerm" maxlength="${SECURITY_LIMITS.termLength}" required placeholder="Ví dụ: happy" />
    </div>
    <div class="field">
      <label for="wordMeaning">Định nghĩa tiếng Việt</label>
      <input id="wordMeaning" maxlength="${SECURITY_LIMITS.meaningLength}" required placeholder="Ví dụ: vui vẻ" />
    </div>
    <div class="field full">
      <label for="wordExample">Ví dụ hoặc ghi chú</label>
      <textarea id="wordExample" maxlength="${SECURITY_LIMITS.exampleLength}" placeholder="Tùy chọn"></textarea>
    </div>
  ` : `
    <div class="field full">
      <label for="bulkWords">Nhập mỗi dòng theo định dạng english: nghĩa tiếng Việt</label>
      <textarea id="bulkWords" maxlength="${SECURITY_LIMITS.bulkCharacters}" required placeholder="happy: Vui vẻ&#10;hello xin chào"></textarea>
    </div>
  `;
}

function renderRandomSetup() {
  const user = currentUser();
  const settings = user.settings;
  const learnedWords = getSelectableWords(user, {
    kind: "random",
    folderId: route.folderId,
    fileId: route.fileId
  });

  return `
    <section class="screen">
      ${topbar({
        title: "Tạo phiên học random",
        subtitle: `${learnedWords.length} từ đã học có thể chọn`,
        back: true,
        actions: themeButton()
      })}

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Cài đặt phiên random</h2>
            <p>Phiên random dùng từ đã học và không tạo thêm file mới.</p>
          </div>
        </div>
        <form id="randomForm" class="form-grid">
          <div class="field">
            <label for="randomCount">Số từ</label>
            <input id="randomCount" type="number" min="1" max="${Math.max(1, learnedWords.length)}" value="${Math.min(settings.reviewWordsPerSession, Math.max(1, learnedWords.length))}" required />
          </div>
          <div class="field">
            <label for="randomTypeReps">Số lần gõ lại theo định nghĩa</label>
            <input id="randomTypeReps" type="number" min="0" max="20" value="${settings.typeRepetitions}" required />
          </div>
          <div class="field">
            <label for="randomChoiceReps">Số lần chọn từ cho nghĩa</label>
            <input id="randomChoiceReps" type="number" min="0" max="20" value="${settings.choiceRepetitions}" required />
          </div>
          <div class="form-actions">
            <button class="btn ghost" type="button" data-action="back">Cancel</button>
            <button class="btn primary" type="submit" ${learnedWords.length === 0 ? "disabled" : ""}>
              <i data-lucide="play"></i>Bắt đầu
            </button>
          </div>
        </form>
      </section>
    </section>
  `;
}

function renderStudy() {
  if (!activeStudy || activeStudy.tasks.length === 0) {
    navigate({ view: "home" }, false);
    return "";
  }

  const task = activeStudy.tasks[activeStudy.index];
  const isChoice = task.type === "choice";
  const feedback = activeStudy.feedback;
  const completedCount = activeStudy.index + (feedback?.correct ? 1 : 0);
  const progress = Math.round((completedCount / activeStudy.tasks.length) * 100);
  const previousProgress = activeStudy.renderedProgress ?? progress;
  activeStudy.renderedProgress = progress;
  const progressLabel = `${completedCount}/${activeStudy.tasks.length} lượt đã đúng`;

  return `
    <section class="screen session-screen">
      ${topbar({
        title: escapeHtml(activeStudy.title),
        subtitle: `${completedCount}/${activeStudy.tasks.length} lượt đã đúng`,
        actions: `
          <button class="btn ghost" data-action="cancel-study"><i data-lucide="x"></i>Cancel</button>
        `
      })}

      <div class="tracker progress-tracker">
        <div class="tracker-top">
          <span>Tiến độ</span>
          <strong>${progressLabel}</strong>
        </div>
        <div class="tracker-bar" aria-label="${escapeAttr(progressLabel)}">
          <span
            style="width: ${previousProgress}%"
            data-progress-target="${progress}"
          ></span>
        </div>
      </div>

      <section class="study-card">
        <div class="badge-row">
          <span class="badge blue">${isChoice ? "Chọn từ cho nghĩa" : "Gõ lại theo định nghĩa"}</span>
          <span class="badge">${levelLabel(task.word.level)}</span>
        </div>

        <div class="study-prompt">
          <span>Định nghĩa tiếng Việt</span>
          <h1>${escapeHtml(task.word.meaning)}</h1>
          ${task.word.example ? `<p>${escapeHtml(task.word.example)}</p>` : ""}
        </div>

        ${isChoice ? renderChoiceTask(task, feedback) : renderTypeTask(task, feedback)}
      </section>
    </section>
  `;
}

function renderTypeTask(task, feedback) {
  return `
    <form id="typeAnswerForm" class="form-grid type-answer-form ${feedback ? "answered" : ""}">
      ${feedback ? `
        <div class="field full">
          <div class="feedback prominent ${feedback.correct ? "good" : "bad"}">
            ${escapeHtml(feedback.message)}
          </div>
        </div>
      ` : `
        <div class="field full">
          <label for="typedAnswer">Từ tiếng Anh</label>
          <input id="typedAnswer" autocomplete="off" placeholder="Gõ đáp án" required />
        </div>
      `}
      <div class="form-actions">
        ${feedback ? "" : `
          <button class="btn primary" type="submit"><i data-lucide="check"></i>Kiểm tra</button>
        `}
      </div>
    </form>
  `;
}

function renderChoiceTask(task, feedback) {
  return `
    <div class="answer-grid">
      ${task.choices.map(choice => {
        const selected = feedback?.selected === choice;
        const isCorrect = choice === task.word.term;
        const className = feedback ? (isCorrect ? "correct" : selected ? "wrong" : "") : "";
        return `<button class="choice-btn ${className}" data-action="choose-answer" data-choice="${escapeAttr(choice)}" ${feedback ? "disabled" : ""}>${escapeHtml(choice)}</button>`;
      }).join("")}
    </div>
    ${feedback ? `
      <div class="feedback prominent choice-feedback ${feedback.correct ? "good" : "bad"}">
        ${escapeHtml(feedback.message)}
      </div>
    ` : ""}
  `;
}

function renderModal() {
  if (!modal) return "";

  if (modal.type === "settings") {
    const user = currentUser();
    const settings = user.settings;
    return `
      <div class="modal" role="dialog" aria-modal="true">
        <section class="modal-card">
          <div class="panel-header">
            <div>
              <h2>Settings học từ vựng</h2>
              <p>Áp dụng cho tất cả phiên học mới và ôn tập.</p>
            </div>
            <button class="icon-btn" data-action="close-modal" aria-label="Close"><i data-lucide="x"></i></button>
          </div>
          <form id="settingsForm" class="form-grid">
            ${numberField("newWordsPerSession", "Số từ học mỗi lần", settings.newWordsPerSession, 1, 100)}
            ${numberField("reviewWordsPerSession", "Số từ ôn tập mỗi lần", settings.reviewWordsPerSession, 1, 100)}
            ${numberField("typeRepetitions", "Số lần gõ lại theo định nghĩa", settings.typeRepetitions, 0, 20)}
            ${numberField("choiceRepetitions", "Số lần chọn từ cho nghĩa", settings.choiceRepetitions, 0, 20)}
            <div class="form-actions">
              <button class="btn ghost" type="button" data-action="close-modal">Cancel</button>
              <button class="btn primary" type="submit"><i data-lucide="save"></i>Lưu settings</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  if (modal.type === "share") {
    return `
      <div class="modal" role="dialog" aria-modal="true">
        <section class="modal-card wide">
          <div class="panel-header">
            <div>
              <h2>Link chia sẻ</h2>
              <p>Nếu trình duyệt không cho copy tự động, hãy copy link bên dưới.</p>
            </div>
            <button class="icon-btn" data-action="close-modal" aria-label="Close"><i data-lucide="x"></i></button>
          </div>
          <div class="field">
            <label for="shareLinkText">Share link</label>
            <textarea id="shareLinkText" readonly>${escapeHtml(modal.link)}</textarea>
          </div>
          <div class="form-actions">
            <button class="btn ghost" data-action="close-modal">Cancel</button>
            <button class="btn primary" data-action="copy-modal-link"><i data-lucide="copy"></i>Copy</button>
          </div>
        </section>
      </div>
    `;
  }

  if (modal.type === "edit-word") {
    return `
      <div class="modal" role="dialog" aria-modal="true">
        <section class="modal-card">
          <div class="panel-header">
            <div>
              <h2>Sửa từ vựng</h2>
              <p>Cập nhật từ tiếng Anh, định nghĩa hoặc ghi chú.</p>
            </div>
            <button class="icon-btn" data-action="close-modal" aria-label="Close"><i data-lucide="x"></i></button>
          </div>
          <form id="editWordForm" class="form-grid">
            <div class="field">
              <label for="editWordTerm">Từ tiếng Anh</label>
              <input id="editWordTerm" maxlength="${SECURITY_LIMITS.termLength}" value="${escapeAttr(modal.word.term)}" required />
            </div>
            <div class="field">
              <label for="editWordMeaning">Định nghĩa tiếng Việt</label>
              <input id="editWordMeaning" maxlength="${SECURITY_LIMITS.meaningLength}" value="${escapeAttr(modal.word.meaning)}" required />
            </div>
            <div class="field full">
              <label for="editWordExample">Ví dụ hoặc ghi chú</label>
              <textarea id="editWordExample" maxlength="${SECURITY_LIMITS.exampleLength}">${escapeHtml(modal.word.example || "")}</textarea>
            </div>
            <div class="form-actions">
              <button class="btn ghost" type="button" data-action="close-modal">Cancel</button>
              <button class="btn primary" type="submit"><i data-lucide="save"></i>Lưu từ</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  if (modal.type === "confirm") {
    return `
      <div class="modal" role="dialog" aria-modal="true">
        <section class="modal-card compact">
          <div class="modal-hero-icon ${modal.variant === "danger" ? "danger" : ""}">
            <i data-lucide="${modal.icon || "circle-help"}"></i>
          </div>
          <div class="modal-copy centered">
            <h2>${escapeHtml(modal.title)}</h2>
            <p>${escapeHtml(modal.message)}</p>
          </div>
          <div class="form-actions centered-actions">
            <button class="btn ghost" type="button" data-action="close-modal">${escapeHtml(modal.cancelText || "Cancel")}</button>
            <button class="btn ${modal.variant === "danger" ? "danger" : "primary"}" type="button" data-action="modal-confirm">
              ${escapeHtml(modal.confirmText || "OK")}
            </button>
          </div>
        </section>
      </div>
    `;
  }

  if (modal.type === "password-prompt") {
    return `
      <div class="modal" role="dialog" aria-modal="true">
        <section class="modal-card compact">
          <div class="panel-header">
            <div>
              <h2>Đổi mật khẩu</h2>
              <p>Tạo mật khẩu mới cho user ${escapeHtml(modal.username)}.</p>
            </div>
          </div>
          <form id="passwordPromptForm" class="form-grid">
            <div class="field full">
              <label for="passwordPromptInput">Mật khẩu mới</label>
              <input id="passwordPromptInput" type="password" autocomplete="new-password" minlength="4" maxlength="${SECURITY_LIMITS.passwordLength}" required />
            </div>
            <div class="form-actions">
              <button class="btn ghost" type="button" data-action="close-modal">Cancel</button>
              <button class="btn primary" type="submit"><i data-lucide="key-round"></i>Lưu mật khẩu</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  if (modal.type === "review-level-decision") {
    return `
      <div class="modal" role="dialog" aria-modal="true">
        <section class="modal-card compact">
          <div class="modal-hero-icon warning">
            <i data-lucide="rotate-ccw"></i>
          </div>
          <div class="modal-copy centered">
            <h2>Ôn sai nhiều lần</h2>
            <p>Từ "${escapeHtml(modal.term)}" đã sai quá 3 lần trong phiên ôn này. Bạn muốn lùi từ này về một level hay giữ nguyên level hiện tại?</p>
          </div>
          <div class="form-actions centered-actions">
            <button class="btn ghost" type="button" data-action="review-keep-level">Giữ nguyên</button>
            <button class="btn primary" type="button" data-action="review-lower-level">Lùi 1 level</button>
          </div>
        </section>
      </div>
    `;
  }

  if (modal.type === "import-file-target") {
    const user = currentUser();
    const folders = user?.folders || [];
    return `
      <div class="modal" role="dialog" aria-modal="true">
        <section class="modal-card compact import-folder-modal">
          <div class="modal-hero-icon">
            <i data-lucide="folder-input"></i>
          </div>
          <div class="modal-copy centered">
            <h2>Chọn folder lưu file</h2>
            <p>File "${escapeHtml(modal.fileName)}" sẽ được thêm vào folder bạn chọn trong workspace hiện tại.</p>
          </div>
          ${folders.length ? `
            <div class="import-folder-list" role="list" aria-label="Folder hiện có">
              ${folders.map(folder => `
                <article class="import-folder-row" role="listitem">
                  <div>
                    <strong>${escapeHtml(folder.name)}</strong>
                    <span>${folder.files.length} file</span>
                  </div>
                  <button class="btn primary compact-btn" type="button" data-action="import-file-to-folder" data-folder-id="${escapeAttr(folder.id)}">
                    <i data-lucide="folder-down"></i>Import
                  </button>
                </article>
              `).join("")}
            </div>
            <div class="form-actions centered-actions">
              <button class="btn ghost" type="button" data-action="close-modal">Cancel</button>
            </div>
          ` : `
            <p class="modal-note">Workspace này chưa có folder. Hãy tạo folder trước rồi nhận lại link file.</p>
            <div class="form-actions centered-actions">
              <button class="btn primary" type="button" data-action="close-modal">OK</button>
            </div>
          `}
        </section>
      </div>
    `;
  }

  return "";
}

function bindAppEvents() {
  app.addEventListener("click", handleDelegatedAction);
  app.addEventListener("submit", handleDelegatedSubmit);
  document.addEventListener("keydown", handleGlobalKeydown);
  document.addEventListener("visibilitychange", () => {
    document.documentElement.classList.toggle("is-page-hidden", document.hidden);
    if (!document.hidden) startCountdownClock();
  });
}

function handleGlobalKeydown(event) {
  if (event.key !== "Enter" || event.repeat || event.isComposing || event.defaultPrevented) return;

  const target = event.target;
  const actionTarget = target.closest?.("[data-action]");

  if (route.view === "login") {
    if (actionTarget?.dataset.action === "back") return;
    const loginForm = document.getElementById("loginForm");
    if (!loginForm || isLoginPending) return;
    event.preventDefault();
    loginForm.requestSubmit();
    return;
  }

  if (!session || modal || route.view === "study") return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable) return;
  if (actionTarget && actionTarget.dataset.action !== "logout") return;

  const logoutButton = app.querySelector('[data-action="logout"]');
  if (!logoutButton || logoutButton.disabled) return;
  event.preventDefault();
  logoutButton.click();
}

function handleDelegatedAction(event) {
  const button = event.target.closest("[data-action]");
  if (!button || !app.contains(button) || button.disabled) return;
  handleAction(button);
}

function handleDelegatedSubmit(event) {
  switch (event.target.id) {
    case "loginForm": handleLogin(event); break;
    case "createUserForm": handleCreateUser(event); break;
    case "createFolderForm": handleCreateFolder(event); break;
    case "receiveShareForm": handleReceiveShare(event); break;
    case "createFileForm": handleCreateFile(event); break;
    case "addWordForm": handleAddWord(event); break;
    case "randomForm": handleRandomStart(event); break;
    case "typeAnswerForm": handleTypeAnswer(event); break;
    case "settingsForm": handleSettingsSave(event); break;
    case "editWordForm": handleEditWordSave(event); break;
    case "passwordPromptForm": handlePasswordPromptSave(event); break;
    default: break;
  }
}

function bindCurrentView() {
  const typedAnswer = document.getElementById("typedAnswer");
  if (typedAnswer && !typedAnswer.disabled) {
    requestAnimationFrame(() => typedAnswer.focus({ preventScroll: true }));
  }

  startCountdownClock();
}

function requireRole(role) {
  const valid = hasActiveSession(role);
  if (!valid) showToast("Phiên đăng nhập đã hết hạn hoặc không hợp lệ.");
  return valid;
}

function hasActiveSession(role) {
  return session?.type === role
    && hasCloudSession()
    && Number(session.expiresAt || 0) > Date.now();
}

function isActionAllowed(action) {
  if (PUBLIC_ACTIONS.has(action)) return true;
  if (action === "logout") return ["admin", "user"].includes(session?.type);
  if (action === "modal-confirm") return ["admin", "user"].includes(session?.type) && hasCloudSession();
  if (ADMIN_ACTIONS.has(action)) return requireRole("admin");
  if (USER_ACTIONS.has(action)) return requireRole("user");
  return false;
}

function handleAction(button) {
  const action = button.dataset.action;

  if (!isActionAllowed(action)) {
    showToast("Phiên đăng nhập không có quyền thực hiện thao tác này.");
    return;
  }

  if (action === "login-admin") navigate({ view: "login", role: "admin" });
  if (action === "login-user") navigate({ view: "login", role: "user" });
  if (action === "back") goBack();
  if (action === "logout") {
    setButtonBusy(button, "Đang đăng xuất");
    void logout().then(completed => {
      if (!completed) restoreButton(button);
    });
  }
  if (action === "toggle-theme") toggleTheme();
  if (action === "open-settings") openSettings();
  if (action === "close-modal") closeModal();
  if (action === "modal-confirm") confirmModalAction();
  if (action === "review-lower-level") resolveReviewLevelDecision("down");
  if (action === "review-keep-level") resolveReviewLevelDecision("keep");
  if (action === "set-word-entry-mode") setWordEntryMode(button.dataset.mode);
  if (action === "reset-password") resetUserPassword(button.dataset.username);
  if (action === "delete-user") deleteUser(button.dataset.username);
  if (action === "open-folder") navigate({ view: "folder", folderId: button.dataset.folderId });
  if (action === "delete-folder") deleteFolder(button.dataset.folderId);
  if (action === "share-folder") shareFolder(button.dataset.folderId);
  if (action === "open-file") navigate({ view: "file", folderId: button.dataset.folderId, fileId: button.dataset.fileId });
  if (action === "delete-file") deleteFile(button.dataset.folderId, button.dataset.fileId);
  if (action === "share-file") shareFile(button.dataset.folderId, button.dataset.fileId);
  if (action === "edit-word") openEditWordModal(button.dataset.folderId, button.dataset.fileId, button.dataset.wordId);
  if (action === "delete-word") deleteWord(button.dataset.folderId, button.dataset.fileId, button.dataset.wordId);
  if (action === "start-new") startStudy({ kind: "new" });
  if (action === "start-review") startStudy({ kind: "review" });
  if (action === "open-random") navigate({ view: "randomSetup" });
  if (action === "start-new-folder") startStudy({ kind: "new", folderId: route.folderId });
  if (action === "start-review-folder") startStudy({ kind: "review", folderId: route.folderId });
  if (action === "open-random-folder") navigate({ view: "randomSetup", folderId: route.folderId });
  if (action === "start-new-file") startStudy({ kind: "new", folderId: route.folderId, fileId: route.fileId });
  if (action === "start-review-file") startStudy({ kind: "review", folderId: route.folderId, fileId: route.fileId });
  if (action === "open-random-file") navigate({ view: "randomSetup", folderId: route.folderId, fileId: route.fileId });
  if (action === "choose-answer") handleChoiceAnswer(button.dataset.choice);
  if (action === "next-task") nextTask();
  if (action === "cancel-study") cancelStudy();
  if (action === "import-pending-share") importPendingShare();
  if (action === "dismiss-pending-share") dismissPendingShare();
  if (action === "import-file-to-folder") importSharedFileToFolder(button.dataset.folderId);
  if (action === "copy-modal-link") copyModalLink();
}

async function handleLogin(event) {
  event.preventDefault();
  if (isLoginPending) return;

  const role = route.role || "user";
  const username = sanitizeUsername(document.getElementById("username").value);
  const password = document.getElementById("loginSecret").value;

  if (!isValidUsername(username) || !isValidPassword(password)) {
    showToast("Tên đăng nhập hoặc mật khẩu không hợp lệ.");
    return;
  }

  if (!hasCloudSync()) {
    showToast(role === "admin"
      ? "Cần cấu hình Apps Script để đăng nhập Admin an toàn."
      : "Cần kết nối Apps Script để đăng nhập an toàn.");
    return;
  }

  const submitButton = event.submitter || event.target.querySelector('button[type="submit"]');
  isLoginPending = true;
  setButtonBusy(submitButton, "Đang đăng nhập");

  try {
    if (role === "admin") {
      const cloudLogin = await hydrateFromCloudLogin({ role: "admin", username, password });
      if (cloudLogin.success && cloudLogin.cloudToken) {
        session = {
          type: "admin",
          username: cloudLogin.username,
          cloudToken: cloudLogin.cloudToken,
          expiresAt: cloudLogin.expiresAt
        };
        saveSession();
        persistStateOnly();
        routeStack = [];
        navigate({ view: "admin" }, false);
        showToast("Đăng nhập Admin thành công.");
        return;
      }

      showToast("Sai tài khoản hoặc mật khẩu Admin.");
      return;
    }

    const cloudLogin = await hydrateFromCloudLogin({ role: "user", username, password });
    if (!cloudLogin.success || !cloudLogin.cloudToken) {
      showToast("User chưa được Admin cấp tài khoản hoặc mật khẩu không đúng.");
      return;
    }

    session = {
      type: "user",
      username,
      cloudToken: cloudLogin.cloudToken,
      expiresAt: cloudLogin.expiresAt
    };
    saveSession();
    persistStateOnly();
    routeStack = [];
    navigate({ view: "home" }, false);
    showToast(`Đã vào workspace của ${username}.`);
  } finally {
    isLoginPending = false;
    restoreButton(submitButton);
  }
}

function setButtonBusy(button, label) {
  if (!button || button.disabled) return;
  button.dataset.idleHtml = button.innerHTML;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span>${escapeHtml(label)}`;
}

function restoreButton(button) {
  if (!button?.isConnected || !button.dataset.idleHtml) return;
  button.innerHTML = button.dataset.idleHtml;
  delete button.dataset.idleHtml;
  button.disabled = false;
  button.removeAttribute("aria-busy");
  createIcons();
}

async function handleCreateUser(event) {
  event.preventDefault();
  if (!requireRole("admin")) return;

  const username = sanitizeUsername(document.getElementById("newUsername").value);
  const password = document.getElementById("newPassword").value;

  if (!isValidUsername(username) || !isValidPassword(password)) {
    showToast("Username chỉ gồm chữ, số, dấu chấm, gạch dưới hoặc gạch ngang; mật khẩu dài 4-128 ký tự.");
    return;
  }

  if (username === session.username) {
    showToast("Username này đang dùng cho Admin.");
    return;
  }

  if (state.users[username]) {
    showToast("Username đã tồn tại.");
    return;
  }

  try {
    const data = await cloudRequest({ action: "createUser", username, password });
    replaceAdminState(data.state);
    event.target.reset();
    showToast("Đã tạo user mới.");
    render();
  } catch (error) {
    showToast(error.message || "Không thể tạo user.");
  }
}

function resetUserPassword(username) {
  if (!requireRole("admin")) return;
  const user = state.users[username];
  if (!user) return;

  openPasswordPrompt(username);
}

function deleteUser(username) {
  if (!requireRole("admin")) return;
  if (!state.users[username]) return;

  openConfirmModal({
    title: "Xóa user?",
    message: `Xóa user "${username}" và toàn bộ workspace của user này?`,
    confirmText: "Xóa user",
    variant: "danger",
    icon: "trash-2",
    onConfirm: async () => {
      try {
        const data = await cloudRequest({ action: "deleteUser", username });
        replaceAdminState(data.state);
        showToast("Đã xóa user.");
        render();
      } catch (error) {
        showToast(error.message || "Không thể xóa user.");
      }
    }
  });
}

function handleCreateFolder(event) {
  event.preventDefault();
  if (!requireRole("user")) return;
  const user = currentUser();
  const input = document.getElementById("folderName");
  const name = sanitizeText(input.value, SECURITY_LIMITS.nameLength);
  if (!name) return;

  if (user.folders.length >= SECURITY_LIMITS.foldersPerUser) {
    showToast("Workspace đã đạt giới hạn folder.");
    return;
  }

  user.folders.unshift({
    id: uid(),
    name,
    createdAt: Date.now(),
    files: []
  });

  saveState();
  input.value = "";
  showToast("Đã tạo folder.");
  render();
}

function deleteFolder(folderId) {
  const user = currentUser();
  const folder = findFolder(user, folderId);
  if (!folder) return;

  openConfirmModal({
    title: "Xóa folder?",
    message: `Xóa folder "${folder.name}" và mọi file bên trong?`,
    confirmText: "Xóa folder",
    variant: "danger",
    icon: "folder-x",
    onConfirm: () => {
      user.folders = user.folders.filter(item => item.id !== folderId);
      saveState();
      showToast("Đã xóa folder.");
      if (route.view === "folder" && route.folderId === folderId) {
        navigate({ view: "home" }, false);
      } else {
        render();
      }
    }
  });
}

function handleCreateFile(event) {
  event.preventDefault();
  if (!requireRole("user")) return;
  const user = currentUser();
  const folder = findFolder(user, route.folderId);
  const input = document.getElementById("fileName");
  const name = sanitizeText(input.value, SECURITY_LIMITS.nameLength);
  if (!folder || !name) return;

  if (folder.files.length >= SECURITY_LIMITS.filesPerFolder) {
    showToast("Folder đã đạt giới hạn file.");
    return;
  }

  folder.files.unshift({
    id: uid(),
    name,
    createdAt: Date.now(),
    words: []
  });

  saveState();
  input.value = "";
  showToast("Đã tạo file.");
  render();
}

function deleteFile(folderId, fileId) {
  const user = currentUser();
  const folder = findFolder(user, folderId);
  const file = folder ? findFile(folder, fileId) : null;
  if (!folder || !file) return;

  openConfirmModal({
    title: "Xóa file?",
    message: `Xóa file "${file.name}"?`,
    confirmText: "Xóa file",
    variant: "danger",
    icon: "file-x-2",
    onConfirm: () => {
      folder.files = folder.files.filter(item => item.id !== fileId);
      saveState();
      showToast("Đã xóa file.");
      if (route.view === "file" && route.fileId === fileId) {
        navigate({ view: "folder", folderId }, false);
      } else {
        render();
      }
    }
  });
}

function setWordEntryMode(mode) {
  const nextMode = mode === "bulk" ? "bulk" : "manual";
  if (wordEntryMode === nextMode) return;
  const previousMode = wordEntryMode;
  wordEntryMode = nextMode;

  const tabs = document.querySelector(".entry-tabs");
  const content = document.querySelector(".word-entry-content");
  const entryPanel = content?.closest(".word-entry-panel");
  const listPanel = document.querySelector(".word-list-panel");

  if (!tabs || !content) {
    render();
    return;
  }

  clearWordEntryMorph(content, entryPanel, listPanel);

  tabs.dataset.active = nextMode;
  tabs.querySelectorAll("button[data-mode]").forEach(button => {
    button.classList.toggle("active", button.dataset.mode === nextMode);
  });

  clearTimeout(tabs.morphTimer);
  cancelAnimationFrame(tabs.fadeFrame);
  tabs.classList.remove("is-fading");
  tabs.fadeFrame = requestAnimationFrame(() => {
    tabs.classList.add("is-fading");
    tabs.morphTimer = setTimeout(() => {
      tabs.classList.remove("is-fading");
    }, 260);
  });

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    content.classList.remove(previousMode, "manual", "bulk", "entry-swap");
    content.classList.add(nextMode);
    content.innerHTML = renderWordEntryFields(nextMode);
    return;
  }

  const currentHeight = content.getBoundingClientRect().height;
  const panelStartHeight = entryPanel ? entryPanel.getBoundingClientRect().height : 0;
  const form = document.getElementById("addWordForm");
  const ghost = createWordEntryGhost(content, form, currentHeight, previousMode);

  if (entryPanel) {
    entryPanel.style.overflow = "hidden";
    entryPanel.classList.add("is-morph-resizing");
  }

  if (listPanel) {
    listPanel.classList.add("is-following-entry");
  }

  content.style.overflow = "hidden";
  content.classList.add("entry-transitioning");
  content.classList.remove(previousMode, "manual", "bulk", "entry-swap");
  content.classList.add(nextMode);
  content.innerHTML = renderWordEntryFields(nextMode);

  content.style.height = "auto";
  content.style.opacity = "1";
  content.style.transform = "translateY(0) scaleY(1)";
  const targetHeight = content.scrollHeight;
  content.style.height = `${targetHeight}px`;
  const panelTargetHeight = entryPanel ? entryPanel.scrollHeight : 0;

  content.style.height = `${currentHeight}px`;
  if (entryPanel) entryPanel.style.height = `${panelStartHeight}px`;

  void content.offsetHeight;
  if (entryPanel) void entryPanel.offsetHeight;

  const duration = 520;
  const direction = targetHeight >= currentHeight ? 1 : -1;
  const runId = uid();
  content.entryMorphId = runId;

  const finishMorph = () => {
    if (content.entryMorphId !== runId) return;
    clearTimeout(content.entryTimer);
    cancelAnimationFrame(content.entryFrame);
    content.entryFrame = null;
    content.entryMorphId = null;
    ghost?.remove();
    content.classList.remove("entry-transitioning");
    content.style.height = "";
    content.style.overflow = "";
    content.style.opacity = "";
    content.style.transform = "";
    if (entryPanel) {
      entryPanel.classList.remove("is-morph-resizing");
      entryPanel.style.height = "";
      entryPanel.style.overflow = "";
    }
    if (listPanel) {
      listPanel.classList.remove("is-following-entry");
    }
  };

  const startTime = performance.now();
  const easeFade = value => 1 - Math.pow(1 - value, 3);
  const mix = (start, end, amount) => start + (end - start) * amount;
  let framePending = false;
  const step = now => {
    if (content.entryMorphId !== runId) return;

    const progress = Math.min(1, (now - startTime) / duration);
    const fade = easeFade(progress);
    const contentHeight = mix(currentHeight, targetHeight, progress);
    const panelHeight = mix(panelStartHeight, panelTargetHeight, progress);
    const offset = direction * (1 - fade) * 5;
    const newScale = mix(direction > 0 ? 0.992 : 1.006, 1, fade);
    const oldScale = mix(1, direction > 0 ? 1.006 : 0.992, fade);

    content.style.height = `${contentHeight}px`;
    content.style.opacity = `${fade}`;
    content.style.transform = `translateY(${offset}px) scaleY(${newScale})`;

    if (entryPanel) {
      entryPanel.style.height = `${panelHeight}px`;
    }

    if (ghost) {
      ghost.style.height = `${contentHeight}px`;
      ghost.style.opacity = `${1 - fade}`;
      ghost.style.transform = `translateY(${-offset}px) scaleY(${oldScale})`;
    }

    if (progress < 1) {
      scheduleFrame();
    } else {
      finishMorph();
    }
  };

  const scheduleFrame = () => {
    if (framePending || content.entryMorphId !== runId) return;
    framePending = true;
    content.entryFrame = requestAnimationFrame(now => {
      framePending = false;
      step(now);
    });
  };

  scheduleFrame();
  content.entryTimer = setTimeout(finishMorph, duration + 140);
}

function clearWordEntryMorph(content, entryPanel, listPanel) {
  if (!content) return;

  clearTimeout(content.entryTimer);
  cancelAnimationFrame(content.entryFrame);
  content.entryFrame = null;
  content.entryMorphId = null;
  app.querySelector(".word-entry-ghost")?.remove();

  content.classList.remove("entry-transitioning");
  content.style.height = "";
  content.style.overflow = "";
  content.style.opacity = "";
  content.style.transform = "";

  if (entryPanel) {
    entryPanel.classList.remove("is-morph-resizing");
    entryPanel.style.height = "";
    entryPanel.style.overflow = "";
  }

  if (listPanel) {
    listPanel.classList.remove("is-following-entry");
  }
}

function createWordEntryGhost(content, form, currentHeight, previousMode) {
  if (!form) return null;

  const formRect = form.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  const ghost = content.cloneNode(true);
  ghost.className = `word-entry-ghost ${previousMode}`;
  ghost.style.left = `${contentRect.left - formRect.left}px`;
  ghost.style.top = `${contentRect.top - formRect.top}px`;
  ghost.style.width = `${contentRect.width}px`;
  ghost.style.height = `${currentHeight}px`;
  form.appendChild(ghost);
  return ghost;
}

function handleAddWord(event) {
  event.preventDefault();
  if (!requireRole("user")) return;
  const user = currentUser();
  const folder = findFolder(user, route.folderId);
  const file = folder ? findFile(folder, route.fileId) : null;
  if (!file) return;

  let added = 0;

  if (file.words.length >= SECURITY_LIMITS.wordsPerFile) {
    showToast("File đã đạt giới hạn từ vựng.");
    return;
  }

  if (wordEntryMode === "manual") {
    const term = sanitizeText(document.getElementById("wordTerm").value, SECURITY_LIMITS.termLength);
    const meaning = sanitizeText(document.getElementById("wordMeaning").value, SECURITY_LIMITS.meaningLength);
    const example = sanitizeMultiline(document.getElementById("wordExample").value, SECURITY_LIMITS.exampleLength);

    if (!isValidWordPair(term, meaning)) {
      showToast("Nhập đủ từ tiếng Anh và nghĩa tiếng Việt.");
      return;
    }

    file.words.unshift(createWord(term, meaning, example));
    added += 1;
  }

  if (wordEntryMode === "bulk") {
    const bulk = document.getElementById("bulkWords").value.trim();
    if (!bulk) {
      showToast("Nhập ít nhất một dòng theo định dạng english: nghĩa.");
      return;
    }

    try {
      const remaining = SECURITY_LIMITS.wordsPerFile - file.words.length;
      const parsed = parseBulkWords(bulk);
      if (parsed.length > remaining) {
        showToast(`File chỉ còn chỗ cho ${Math.max(0, remaining)} từ.`);
        return;
      }
      parsed.forEach(item => {
        file.words.unshift(createWord(item.term, item.meaning, item.example));
        added += 1;
      });
    } catch (error) {
      showToast(error.message || "Dữ liệu nhập hàng loạt không hợp lệ.");
      return;
    }
  }

  if (added === 0) {
    showToast("Không tìm thấy dòng hợp lệ. Ví dụ: happy: Vui vẻ");
    return;
  }

  saveState();
  event.target.reset();
  showToast(`Đã thêm ${added} từ.`);
  render();
}

function createWord(term, meaning, example = "") {
  return {
    id: uid(),
    term: sanitizeText(term, SECURITY_LIMITS.termLength),
    meaning: sanitizeText(meaning, SECURITY_LIMITS.meaningLength),
    example: sanitizeMultiline(example, SECURITY_LIMITS.exampleLength),
    level: 0,
    createdAt: Date.now(),
    learnedAt: null,
    lastStudiedAt: null,
    nextReviewAt: null,
    studiedCount: 0
  };
}

function parseBulkWords(text) {
  const source = String(text || "").replace(/\r\n?/g, "\n");
  if (source.length > SECURITY_LIMITS.bulkCharacters) {
    throw new Error("Nội dung nhập hàng loạt quá lớn.");
  }

  const lines = source.split("\n");
  if (lines.length > SECURITY_LIMITS.bulkLines) {
    throw new Error(`Chỉ được nhập tối đa ${SECURITY_LIMITS.bulkLines} dòng mỗi lần.`);
  }

  return lines
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseBulkLine)
    .filter(item => isValidWordPair(item.term, item.meaning));
}

function parseBulkLine(line) {
  const cleanLine = sanitizeText(line, SECURITY_LIMITS.termLength + SECURITY_LIMITS.meaningLength + 16);
  const separated = cleanLine.match(/^(.+?)\s*[:：]\s*(.+)$/)
    || cleanLine.match(/^(.+?)\s+[-–—|,]\s+(.+)$/)
    || cleanLine.match(/^(.+?)\s*[-–—|,]\s*(.+)$/)
    || cleanLine.match(/^(.+?)\s{2,}(.+)$/);

  if (separated) {
    return {
      term: sanitizeText(separated[1], SECURITY_LIMITS.termLength),
      meaning: sanitizeText(separated[2], SECURITY_LIMITS.meaningLength)
    };
  }

  const words = cleanLine.split(/\s+/);
  if (words.length < 2) return { term: "", meaning: "" };

  return {
    term: sanitizeText(words[0], SECURITY_LIMITS.termLength),
    meaning: sanitizeText(words.slice(1).join(" "), SECURITY_LIMITS.meaningLength)
  };
}

function openEditWordModal(folderId, fileId, wordId) {
  const user = currentUser();
  const word = findWord(user, folderId, fileId, wordId);
  if (!word) return;

  modal = {
    type: "edit-word",
    folderId,
    fileId,
    wordId,
    word
  };
  render();
}

function handleEditWordSave(event) {
  event.preventDefault();
  if (!requireRole("user")) return;
  if (!modal || modal.type !== "edit-word") return;

  const user = currentUser();
  const word = findWord(user, modal.folderId, modal.fileId, modal.wordId);
  if (!word) return;

  const term = sanitizeText(document.getElementById("editWordTerm").value, SECURITY_LIMITS.termLength);
  const meaning = sanitizeText(document.getElementById("editWordMeaning").value, SECURITY_LIMITS.meaningLength);
  const example = sanitizeMultiline(document.getElementById("editWordExample").value, SECURITY_LIMITS.exampleLength);

  if (!isValidWordPair(term, meaning)) {
    showToast("Từ tiếng Anh và định nghĩa không được để trống.");
    return;
  }

  word.term = term;
  word.meaning = meaning;
  word.example = example;
  word.updatedAt = Date.now();
  saveState();
  modal = null;
  showToast("Đã cập nhật từ vựng.");
  render();
}

function deleteWord(folderId, fileId, wordId) {
  const user = currentUser();
  const folder = findFolder(user, folderId);
  const file = folder ? findFile(folder, fileId) : null;
  if (!file) return;

  file.words = file.words.filter(word => word.id !== wordId);
  saveState();
  showToast("Đã xóa từ.");
  render();
}

function handleReceiveShare(event) {
  event.preventDefault();
  if (!requireRole("user")) return;
  const input = document.getElementById("shareInput");
  const payload = parseShareLink(input.value.trim());

  if (!payload) {
    showToast("Link chia sẻ không hợp lệ.");
    return;
  }

  importSharePayload(payload);
  input.value = "";
}

function importPendingShare() {
  if (!pendingShare) return;
  importSharePayload(pendingShare);
  dismissPendingShare(false);
}

function dismissPendingShare(shouldRender = true) {
  pendingShare = null;
  if (window.location.hash.startsWith("#share=")) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  if (shouldRender) render();
}

function importSharePayload(payload) {
  const user = currentUser();
  if (!user || !isValidSharePayload(payload)) {
    showToast("Link chia sẻ không hợp lệ.");
    return;
  }

  if (payload.type === "folder") {
    if (user.folders.length >= SECURITY_LIMITS.foldersPerUser) {
      showToast("Workspace đã đạt giới hạn folder.");
      return;
    }
    const folder = cloneFolderForImport(payload.data, payload.owner);
    user.folders.unshift(folder);
    saveState();
    showToast("Đã import folder vào workspace.");
    render();
    return;
  }

  if (payload.type === "file") {
    modal = {
      type: "import-file-target",
      payload,
      fileName: payload.data?.name || "File được chia sẻ"
    };
    render();
    return;
  }

  showToast("Link chia sẻ không hợp lệ.");
}

function importSharedFileToFolder(folderId) {
  if (!modal || modal.type !== "import-file-target") return;

  const user = currentUser();
  const folder = user ? findFolder(user, folderId) : null;

  if (!folder) {
    showToast("Không tìm thấy folder đã chọn.");
    return;
  }

  if (folder.files.length >= SECURITY_LIMITS.filesPerFolder) {
    showToast("Folder đã đạt giới hạn file.");
    return;
  }

  const file = cloneFileForImport(modal.payload.data, modal.payload.owner);
  folder.files.unshift(file);
  saveState();
  modal = null;
  showToast(`Đã import file vào folder ${folder.name}.`);
  render();
}

function shareFolder(folderId) {
  const user = currentUser();
  const folder = findFolder(user, folderId);
  if (!folder) return;

  const payload = {
    type: "folder",
    owner: user.username,
    exportedAt: Date.now(),
    data: stripFolderForShare(folder)
  };

  sharePayload(payload);
}

function shareFile(folderId, fileId) {
  const user = currentUser();
  const folder = findFolder(user, folderId);
  const file = folder ? findFile(folder, fileId) : null;
  if (!file) return;

  const payload = {
    type: "file",
    owner: user.username,
    exportedAt: Date.now(),
    data: stripFileForShare(file)
  };

  sharePayload(payload);
}

async function sharePayload(payload) {
  const link = `${window.location.origin}${window.location.pathname}#share=${encodeURIComponent(encodePayload(payload))}`;

  try {
    await navigator.clipboard.writeText(link);
    showToast("Đã copy link chia sẻ.");
  } catch {
    modal = { type: "share", link };
    render();
  }
}

function copyModalLink() {
  if (!modal?.link) return;
  navigator.clipboard?.writeText(modal.link);
  showToast("Đã copy link.");
}

function handleSettingsSave(event) {
  event.preventDefault();
  const user = currentUser();
  user.settings = {
    newWordsPerSession: clampNumber(document.getElementById("newWordsPerSession").value, 1, 100),
    reviewWordsPerSession: clampNumber(document.getElementById("reviewWordsPerSession").value, 1, 100),
    typeRepetitions: clampNumber(document.getElementById("typeRepetitions").value, 0, 20),
    choiceRepetitions: clampNumber(document.getElementById("choiceRepetitions").value, 0, 20)
  };

  if (user.settings.typeRepetitions + user.settings.choiceRepetitions === 0) {
    showToast("Cần ít nhất một kiểu học có số lần lớn hơn 0.");
    return;
  }

  saveState();
  closeModal();
  showToast("Đã lưu settings.");
}

function openSettings() {
  modal = { type: "settings" };
  render();
}

function closeModal() {
  modal = null;
  render();
}

function openConfirmModal({ title, message, confirmText = "OK", cancelText = "Cancel", variant = "primary", icon = "circle-help", onConfirm }) {
  modal = {
    type: "confirm",
    title,
    message,
    confirmText,
    cancelText,
    variant,
    icon,
    onConfirm
  };
  render();
}

function confirmModalAction() {
  if (!modal || modal.type !== "confirm") return;
  const onConfirm = modal.onConfirm;
  modal = null;
  if (typeof onConfirm === "function") {
    onConfirm();
    return;
  }
  render();
}

function openPasswordPrompt(username) {
  modal = {
    type: "password-prompt",
    username
  };
  render();
}

async function handlePasswordPromptSave(event) {
  event.preventDefault();
  if (!requireRole("admin") || !modal || modal.type !== "password-prompt") return;

  const user = state.users[modal.username];
  const username = modal.username;
  const password = document.getElementById("passwordPromptInput").value;
  if (!user || !isValidPassword(password)) {
    showToast("Mật khẩu phải dài từ 4 đến 128 ký tự.");
    return;
  }

  try {
    const data = await cloudRequest({ action: "resetUserPassword", username, password });
    replaceAdminState(data.state);
    modal = null;
    showToast("Đã đổi mật khẩu user.");
    render();
  } catch (error) {
    showToast(error.message || "Không thể đổi mật khẩu.");
  }
}

function startStudy(options) {
  const user = currentUser();
  const settings = user.settings;
  const count = options.kind === "new" ? settings.newWordsPerSession : settings.reviewWordsPerSession;
  const words = getSelectableWords(user, options).slice(0, count);

  if (words.length === 0) {
    showToast(options.kind === "new" ? "Không có từ mới để học." : "Chưa có từ đến hạn ôn tập.");
    return;
  }

  const title = options.kind === "new" ? "Học từ mới" : "Ôn tập ngắt quãng";
  buildStudy({
    title,
    mode: options.kind,
    words,
    typeRepetitions: settings.typeRepetitions,
    choiceRepetitions: settings.choiceRepetitions
  });
}

function handleRandomStart(event) {
  event.preventDefault();
  const user = currentUser();
  const words = getSelectableWords(user, {
    kind: "random",
    folderId: route.folderId,
    fileId: route.fileId
  });
  const count = clampNumber(document.getElementById("randomCount").value, 1, Math.max(1, words.length));
  const typeRepetitions = clampNumber(document.getElementById("randomTypeReps").value, 0, 20);
  const choiceRepetitions = clampNumber(document.getElementById("randomChoiceReps").value, 0, 20);

  if (typeRepetitions + choiceRepetitions === 0) {
    showToast("Chọn ít nhất một cách học.");
    return;
  }

  if (words.length === 0) {
    showToast("Chưa có từ đã học để random.");
    return;
  }

  buildStudy({
    title: "Học random",
    mode: "random",
    words: words.slice(0, count),
    typeRepetitions,
    choiceRepetitions
  });
}

function buildStudy({ title, mode, words, typeRepetitions, choiceRepetitions }) {
  const tasks = [];
  const allWords = getAllWords(currentUser()).map(item => item.word);

  words.forEach(item => {
    for (let index = 0; index < typeRepetitions; index += 1) {
      tasks.push({
        type: "type",
        folderId: item.folder.id,
        fileId: item.file.id,
        wordId: item.word.id,
        word: { ...item.word }
      });
    }

    for (let index = 0; index < choiceRepetitions; index += 1) {
      tasks.push({
        type: "choice",
        folderId: item.folder.id,
        fileId: item.file.id,
        wordId: item.word.id,
        word: { ...item.word },
        choices: buildChoices(item.word, allWords)
      });
    }
  });

  if (tasks.length === 0) {
    showToast("Phiên học cần ít nhất một lượt hiển thị.");
    return;
  }

  activeStudy = {
    title,
    mode,
    words: words.map(item => ({
      folderId: item.folder.id,
      fileId: item.file.id,
      wordId: item.word.id
    })),
    tasks: shuffle(tasks),
    index: 0,
    feedback: null,
    results: {}
  };

  navigate({ view: "study" });
}

function handleTypeAnswer(event) {
  event.preventDefault();
  if (!activeStudy || activeStudy.feedback?.correct) return;
  const task = activeStudy.tasks[activeStudy.index];
  const answer = document.getElementById("typedAnswer").value;
  const correct = normalizeAnswer(answer) === normalizeAnswer(task.word.term);
  const message = correct
    ? "Đúng"
    : `đáp án: ${task.word.term}`;

  const result = recordResult(task, correct);
  activeStudy.feedback = { correct, message, retry: !correct };
  const needsDecision = maybeAskReviewLevelDecision(task, result, correct);
  render();

  if (correct) {
    scheduleStudyAuto(nextTask, 700);
  } else if (!needsDecision) {
    scheduleStudyAuto(deferCurrentTask, 1200);
  }
}

function handleChoiceAnswer(choice) {
  if (!activeStudy || activeStudy.feedback) return;
  const task = activeStudy.tasks[activeStudy.index];
  const correct = choice === task.word.term;
  const message = correct
    ? "Đúng"
    : `đáp án: ${task.word.term}`;

  const result = recordResult(task, correct);
  activeStudy.feedback = { correct, selected: choice, message };
  const needsDecision = maybeAskReviewLevelDecision(task, result, correct);
  render();

  if (correct) {
    scheduleStudyAuto(nextTask, 700);
  } else if (!needsDecision) {
    scheduleStudyAuto(deferCurrentTask, 1200);
  }
}

function recordResult(task, correct) {
  const result = activeStudy.results[task.wordId] || { correct: 0, total: 0, wrong: false, wrongCount: 0, levelDecision: null, levelDecisionAsked: false };
  result.total += 1;
  if (correct) {
    result.correct += 1;
  } else {
    result.wrong = true;
    result.wrongCount = (result.wrongCount || 0) + 1;
  }
  activeStudy.results[task.wordId] = result;
  return result;
}

function maybeAskReviewLevelDecision(task, result, correct) {
  if (correct || !activeStudy || activeStudy.mode !== "review") return false;
  if ((result.wrongCount || 0) <= 3 || result.levelDecisionAsked) return false;

  result.levelDecisionAsked = true;
  activeStudy.results[task.wordId] = result;
  modal = {
    type: "review-level-decision",
    wordId: task.wordId,
    term: task.word.term
  };
  clearStudyAutoTimer();
  return true;
}

function resolveReviewLevelDecision(decision) {
  if (!modal || modal.type !== "review-level-decision") return;
  const wordId = modal.wordId;
  const result = activeStudy?.results?.[wordId];

  if (result) {
    result.levelDecision = decision === "down" ? "down" : "keep";
    activeStudy.results[wordId] = result;
  }

  modal = null;
  render();

  if (activeStudy?.feedback && !activeStudy.feedback.correct) {
    scheduleStudyAuto(deferCurrentTask, 600);
  }
}

function nextTask() {
  if (!activeStudy) return;
  clearStudyAutoTimer();

  if (activeStudy.index >= activeStudy.tasks.length - 1) {
    finishStudy();
    return;
  }

  activeStudy.index += 1;
  activeStudy.feedback = null;
  render();
}

function deferCurrentTask() {
  if (!activeStudy) return;
  clearStudyAutoTimer();

  if (activeStudy.tasks.length > 1) {
    const [task] = activeStudy.tasks.splice(activeStudy.index, 1);
    activeStudy.tasks.push(task);
    if (activeStudy.index >= activeStudy.tasks.length) {
      activeStudy.index = activeStudy.tasks.length - 1;
    }
  }

  activeStudy.feedback = null;
  render();
}

function cancelStudy() {
  if (!activeStudy) return;

  openConfirmModal({
    title: "Hủy phiên học?",
    message: "Tiến độ phiên học hiện tại sẽ không được tính.",
    confirmText: "Hủy phiên",
    variant: "danger",
    icon: "x-circle",
    onConfirm: () => {
      clearStudyAutoTimer();
      activeStudy = null;
      goBack();
    }
  });
}

function finishStudy() {
  clearStudyAutoTimer();
  const user = currentUser();
  const finishedAt = Date.now();
  let advanced = 0;
  let retried = 0;
  let lowered = 0;
  let kept = 0;

  activeStudy.words.forEach(ref => {
    const word = findWord(user, ref.folderId, ref.fileId, ref.wordId);
    if (!word) return;

    const result = activeStudy.results[word.id] || { wrong: false };

    if (activeStudy.mode === "random") {
      word.lastPracticedAt = finishedAt;
      return;
    }

    if (result.wrong) retried += 1;

    if (result.levelDecision === "down") {
      regressWord(word, finishedAt);
      lowered += 1;
      return;
    }

    if (result.levelDecision === "keep") {
      keepWordForSoon(word, finishedAt);
      kept += 1;
      return;
    }

    advanceWord(word, finishedAt);
    advanced += 1;
  });

  saveState();
  const mode = activeStudy.mode;
  activeStudy = null;
  navigate({ view: "home" }, false);

  if (mode === "random") {
    showToast("Hoàn thành phiên random.");
  } else {
    const detail = [
      `${advanced} từ lên mức`,
      lowered ? `${lowered} từ lùi level` : "",
      kept ? `${kept} từ giữ nguyên` : "",
      retried ? `${retried} từ đã làm lại đúng` : ""
    ].filter(Boolean).join(", ");
    showToast(`Hoàn thành phiên học: ${detail}.`);
  }
}

function scheduleStudyAuto(callback, delay) {
  clearStudyAutoTimer();
  studyAutoTimer = setTimeout(callback, delay);
}

function clearStudyAutoTimer() {
  if (!studyAutoTimer) return;
  clearTimeout(studyAutoTimer);
  studyAutoTimer = null;
}

function advanceWord(word, now) {
  const nextLevel = word.level >= 6 ? 6 : word.level + 1;
  word.level = nextLevel;
  word.studiedCount = (word.studiedCount || 0) + 1;
  word.lastStudiedAt = now;
  word.learnedAt = word.learnedAt || now;
  if (nextLevel === 6) {
    word.masteredAt = word.masteredAt || now;
  }
  word.nextReviewAt = now + REVIEW_INTERVALS[nextLevel];
}

function keepWordForSoon(word, now) {
  word.studiedCount = (word.studiedCount || 0) + 1;
  word.lastStudiedAt = now;
  if (word.level > 0) {
    word.nextReviewAt = now + 30 * 60 * 1000;
  }
}

function regressWord(word, now) {
  const nextLevel = Math.max(1, Number(word.level || 1) - 1);
  word.level = nextLevel;
  word.studiedCount = (word.studiedCount || 0) + 1;
  word.lastStudiedAt = now;
  word.nextReviewAt = now + REVIEW_INTERVALS[nextLevel];
}

function getSelectableWords(user, options) {
  const now = Date.now();
  const words = getAllWords(user, options);

  if (options.kind === "new") {
    return shuffle(words.filter(item => item.word.level === 0));
  }

  if (options.kind === "review") {
    return words
      .filter(item => item.word.level > 0 && item.word.nextReviewAt && item.word.nextReviewAt <= now)
      .sort((a, b) => a.word.nextReviewAt - b.word.nextReviewAt);
  }

  if (options.kind === "random") {
    return shuffle(words.filter(item => item.word.level > 0));
  }

  return shuffle(words);
}

function getReviewSummary(user, filters = {}) {
  const now = Date.now();
  let dueCount = 0;
  let nextReviewAt = Number.MAX_SAFE_INTEGER;
  let nextReviewCount = 0;

  forEachWord(user, filters, word => {
    if (word.level <= 0 || !word.nextReviewAt) return;
    if (word.nextReviewAt <= now) {
      dueCount += 1;
      return;
    }
    if (word.nextReviewAt < nextReviewAt) {
      nextReviewAt = word.nextReviewAt;
      nextReviewCount = 1;
    } else if (word.nextReviewAt === nextReviewAt) {
      nextReviewCount += 1;
    }
  });

  if (dueCount > 0) {
    return {
      count: dueCount,
      nextReviewAt: now,
      overdue: true
    };
  }

  if (nextReviewAt === Number.MAX_SAFE_INTEGER) return null;
  return {
    count: nextReviewCount,
    nextReviewAt,
    overdue: false
  };
}

function getEarliestReviewAtForFile(file) {
  let earliest = Number.MAX_SAFE_INTEGER;
  (file?.words || []).forEach(word => {
    if (word.level > 0 && word.nextReviewAt && word.nextReviewAt < earliest) {
      earliest = word.nextReviewAt;
    }
  });
  return earliest;
}

function getEarliestReviewAtForFolder(folder) {
  let earliest = Number.MAX_SAFE_INTEGER;
  (folder?.files || []).forEach(file => {
    earliest = Math.min(earliest, getEarliestReviewAtForFile(file));
  });
  return earliest;
}

function sortFoldersForDisplay(user) {
  return [...user.folders].sort((a, b) => {
    const aTime = getEarliestReviewAtForFolder(a);
    const bTime = getEarliestReviewAtForFolder(b);
    if (aTime !== bTime) return aTime - bTime;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function sortFilesForDisplay(user, folder) {
  return [...folder.files].sort((a, b) => {
    const aTime = getEarliestReviewAtForFile(a);
    const bTime = getEarliestReviewAtForFile(b);
    if (aTime !== bTime) return aTime - bTime;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function sortWordsForDisplay(words) {
  return [...words].sort((a, b) => {
    const aTime = a.nextReviewAt || Number.MAX_SAFE_INTEGER;
    const bTime = b.nextReviewAt || Number.MAX_SAFE_INTEGER;
    if (aTime !== bTime) return aTime - bTime;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function buildChoices(word, allWords) {
  const terms = allWords
    .map(item => item.term)
    .filter(term => term && term !== word.term);

  const pool = shuffle([...new Set([...terms, ...FALLBACK_CHOICES.filter(term => term !== word.term)])]);
  return shuffle([word.term, ...pool.slice(0, 3)]);
}

function getStats(user) {
  const counts = Object.fromEntries(LEVELS.map(level => [level.key, 0]));
  const now = Date.now();
  let total = 0;
  let learned = 0;
  let newCount = 0;
  let dueCount = 0;

  forEachWord(user, {}, word => {
    total += 1;
    if (word.level === 0) newCount += 1;
    if (word.level > 0) learned += 1;
    if (word.level > 0 && word.nextReviewAt && word.nextReviewAt <= now) dueCount += 1;
    const levelKey = LEVEL_KEY_BY_NUMBER[word.level];
    if (levelKey) counts[levelKey] += 1;
  });

  return {
    total,
    learned,
    new: newCount,
    due: dueCount,
    mastered: counts.mastered,
    counts
  };
}

function getAllWords(user, filters = {}) {
  const items = [];
  forEachWord(user, filters, (word, folder, file) => items.push({ folder, file, word }));
  return items;
}

function forEachWord(user, filters = {}, callback) {
  if (!user || !Array.isArray(user.folders)) return;
  user.folders.forEach(folder => {
    if (filters.folderId && folder.id !== filters.folderId) return;
    folder.files.forEach(file => {
      if (filters.fileId && file.id !== filters.fileId) return;
      file.words.forEach(word => callback(word, folder, file));
    });
  });
}

function currentUser() {
  if (!hasActiveSession("user") || !session?.username) return null;
  return state.users[session.username] || null;
}

function findFolder(user, folderId) {
  return user?.folders?.find(folder => folder.id === folderId) || null;
}

function findFile(folder, fileId) {
  return folder?.files?.find(file => file.id === fileId) || null;
}

function findWord(user, folderId, fileId, wordId) {
  const folder = findFolder(user, folderId);
  const file = folder ? findFile(folder, fileId) : null;
  return file ? file.words.find(word => word.id === wordId) : null;
}

function topbar({ title, subtitle, back = false, actions = "" }) {
  return `
    <header class="topbar">
      <div class="topbar-left">
        ${back ? `<button class="icon-btn" data-action="back" aria-label="Back"><i data-lucide="arrow-left"></i></button>` : `<span class="brand-mark">BK</span>`}
        <div class="topbar-title">
          <strong>${title}</strong>
          <small>${subtitle || ""}</small>
        </div>
      </div>
      <div class="topbar-actions">${actions}</div>
    </header>
  `;
}

function themeButton() {
  return `<button class="icon-btn" title="Theme" aria-label="Theme" data-action="toggle-theme"><i data-lucide="sun-moon"></i></button>`;
}

function metricCard(title, value, label) {
  return `
    <section class="stat-card">
      <h3>${title}</h3>
      <div class="stat-number"><strong>${value}</strong><span>${label}</span></div>
    </section>
  `;
}

function actionCard(title, subtitle, icon, action, disabled = false) {
  return `
    <article class="item-card action-card ${disabled ? "is-disabled" : ""}">
      <span class="role-icon"><i data-lucide="${icon}"></i></span>
      <h3>${title}</h3>
      <p>${subtitle}</p>
      <div class="item-card-footer">
        <button class="btn primary start-btn" data-action="${action}" ${disabled ? "disabled" : ""}>
          <i data-lucide="arrow-right"></i>Bắt đầu
        </button>
      </div>
    </article>
  `;
}

function renderChart(stats) {
  const maxValue = Math.max(1, ...Object.values(stats.counts));

  return `
    <section class="chart-card">
      <div class="panel-header">
        <div>
          <h2>Biểu đồ cấp độ</h2>
          <p>Từ mới chưa học không hiển thị trên cột.</p>
        </div>
      </div>
      <div class="chart-bars" aria-label="Vocabulary level chart">
        ${LEVELS.map(level => {
          const value = stats.counts[level.key];
          const height = value ? Math.max(12, Math.round((value / maxValue) * 100)) : 0;
          return `
            <div class="bar-wrap">
              <div class="bar-track">
                <div class="bar ${level.key} ${value ? "has-value" : ""}" style="height: ${height}%">
                  ${value ? `<span>${value}</span>` : ""}
                </div>
              </div>
              <span class="bar-label">${level.label}</span>
            </div>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderReviewSummary(summary) {
  const message = summary.overdue
    ? `Bạn có ${summary.count} từ cần được ôn tập ngay bây giờ`
    : `Bạn có ${summary.count} từ cần được ôn tập sau ${formatCountdown(summary.nextReviewAt)}`;

  return `
    <article class="review-summary ${summary.overdue ? "overdue" : ""}">
      <i data-lucide="${summary.overdue ? "alarm-clock" : "timer"}"></i>
      <strong
        data-countdown="${summary.nextReviewAt}"
        data-review-count="${summary.count}"
      >${escapeHtml(message)}</strong>
    </article>
  `;
}

function renderReviewClockPanel(summary, title, subtitle) {
  return `
    <section class="panel review-clock-panel ${summary ? "" : "is-empty"}">
      <div class="panel-header review-clock-header">
        <span class="review-clock-icon"><i data-lucide="timer"></i></span>
        <div>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(subtitle)}</p>
        </div>
      </div>
      ${summary ? renderReviewSummary(summary) : renderEmptyReviewClock()}
    </section>
  `;
}

function renderEmptyReviewClock() {
  return `
    <article class="review-clock-empty">
      <div>
        <h3>Chưa có lịch ôn tập</h3>
        <p>Sau khi học từ mới, app sẽ tự tạo đồng hồ đếm ngược cho lần ôn tiếp theo.</p>
      </div>
    </article>
  `;
}

function renderFolderCard(user, folder) {
  const words = getAllWords(user, { folderId: folder.id });
  const learned = words.filter(item => item.word.level > 0).length;

  return `
    <article class="item-card">
      <div class="badge-row">
        <span class="badge blue">${folder.files.length} file</span>
        <span class="badge teal">${learned}/${words.length} từ đã học</span>
      </div>
      <h3>${escapeHtml(folder.name)}</h3>
      <p>Tạo ${formatDate(folder.createdAt)}</p>
      <div class="item-card-footer">
        <button class="btn primary" data-action="open-folder" data-folder-id="${escapeAttr(folder.id)}"><i data-lucide="folder-open"></i>Mở</button>
        <button class="btn ghost" data-action="share-folder" data-folder-id="${escapeAttr(folder.id)}"><i data-lucide="share-2"></i>Share</button>
        <button class="btn danger" data-action="delete-folder" data-folder-id="${escapeAttr(folder.id)}"><i data-lucide="trash-2"></i>Xóa</button>
      </div>
    </article>
  `;
}

function renderFileCard(user, folder, file) {
  const learned = file.words.filter(word => word.level > 0).length;

  return `
    <article class="item-card">
      <div class="badge-row">
        <span class="badge blue">${file.words.length} từ</span>
        <span class="badge green">${learned} đã học</span>
      </div>
      <h3>${escapeHtml(file.name)}</h3>
      <p>${file.words.length ? `Cập nhật lần cuối ${formatDate(file.createdAt)}` : "File trống"}</p>
      <div class="item-card-footer">
        <button class="btn primary" data-action="open-file" data-folder-id="${escapeAttr(folder.id)}" data-file-id="${escapeAttr(file.id)}"><i data-lucide="file-text"></i>Mở</button>
        <button class="btn ghost" data-action="share-file" data-folder-id="${escapeAttr(folder.id)}" data-file-id="${escapeAttr(file.id)}"><i data-lucide="share-2"></i>Share</button>
        <button class="btn danger" data-action="delete-file" data-folder-id="${escapeAttr(folder.id)}" data-file-id="${escapeAttr(file.id)}"><i data-lucide="trash-2"></i>Xóa</button>
      </div>
    </article>
  `;
}

function renderWordRow(word) {
  const overdue = word.nextReviewAt && word.nextReviewAt <= Date.now();

  return `
    <article class="word-row ${overdue ? "overdue" : ""}">
      <div class="word-term">
        <strong>${escapeHtml(word.term)}</strong>
        <span>${levelLabel(word.level)}${word.nextReviewAt ? ` · ôn ${relativeTime(word.nextReviewAt)}` : ""}</span>
      </div>
      <div class="word-meaning">
        ${escapeHtml(word.meaning)}
        ${word.example ? `<br><span>${escapeHtml(word.example)}</span>` : ""}
      </div>
      <div class="row-actions">
        ${word.nextReviewAt ? `<span class="countdown ${overdue ? "overdue" : ""}" data-countdown="${word.nextReviewAt}">${formatCountdown(word.nextReviewAt)}</span>` : ""}
        <button class="btn ghost" data-action="edit-word" data-folder-id="${escapeAttr(route.folderId)}" data-file-id="${escapeAttr(route.fileId)}" data-word-id="${escapeAttr(word.id)}">
          <i data-lucide="pencil"></i>Sửa
        </button>
        <button class="btn danger" data-action="delete-word" data-folder-id="${escapeAttr(route.folderId)}" data-file-id="${escapeAttr(route.fileId)}" data-word-id="${escapeAttr(word.id)}">
          <i data-lucide="trash-2"></i>Xóa
        </button>
      </div>
    </article>
  `;
}

function renderPendingShare() {
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Có link chia sẻ đang chờ nhận</h2>
          <p>${pendingShare.type === "folder" ? "Folder" : "File"} từ user ${escapeHtml(pendingShare.owner || "khác")} sẽ được import vào workspace hiện tại.</p>
        </div>
        <div class="row-actions">
          <button class="btn ghost" data-action="dismiss-pending-share">Cancel</button>
          <button class="btn primary" data-action="import-pending-share"><i data-lucide="folder-down"></i>Nhận</button>
        </div>
      </div>
    </section>
  `;
}

function emptyState(icon, title, text) {
  return `
    <div class="empty-state">
      <div>
        <span class="empty-icon"><i data-lucide="${icon}"></i></span>
        <h3>${title}</h3>
        <p>${text}</p>
      </div>
    </div>
  `;
}

function numberField(id, label, value, min, max) {
  return `
    <div class="field">
      <label for="${id}">${label}</label>
      <input id="${id}" type="number" min="${min}" max="${max}" value="${value}" required />
    </div>
  `;
}

function navigate(nextRoute, push = true) {
  if (push) routeStack.push(route);
  route = nextRoute;
  render();
}

function goBack() {
  modal = null;
  if (route.view === "study" && activeStudy) {
    cancelStudy();
    return;
  }

  route = routeStack.pop() || { view: "landing" };
  render();
}

async function logout(notifyServer = true) {
  const logoutAuth = cloudAuthPayload();

  if (notifyServer && session?.type === "user" && hasCloudSession()) {
    clearTimeout(cloudSyncTimer);
    try {
      await saveUserToCloud(currentUser());
    } catch (error) {
      showToast("Chưa thể đồng bộ dữ liệu. Vui lòng thử đăng xuất lại khi có mạng.");
      return false;
    }
  }

  session = null;
  state = { users: {} };
  activeStudy = null;
  clearStudyAutoTimer();
  routeStack = [];
  saveSession();
  localStorage.removeItem(STORE_KEY);
  sessionStorage.removeItem(ADMIN_STATE_KEY);
  navigate({ view: "landing" }, false);
  if (notifyServer) showToast("Đã đăng xuất.");

  if (notifyServer && logoutAuth.sessionToken) {
    void cloudRequest({ action: "logout" }, { auth: logoutAuth }).catch(() => {
      // The local session is already closed; the server token will expire automatically.
    });
  }

  return true;
}

function applyTheme() {
  const theme = localStorage.getItem(THEME_KEY) || "light";
  document.documentElement.dataset.theme = theme;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  const applyNextTheme = () => {
    localStorage.setItem(THEME_KEY, next);
    document.documentElement.dataset.theme = next;
  };

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !document.startViewTransition) {
    document.documentElement.classList.add("theme-transitioning");
    applyNextTheme();
    clearTimeout(toggleTheme.timer);
    toggleTheme.timer = setTimeout(() => {
      document.documentElement.classList.remove("theme-transitioning");
    }, 380);
    return;
  }

  document.startViewTransition(applyNextTheme);
}

function stripFolderForShare(folder) {
  return {
    name: folder.name,
    files: folder.files.map(stripFileForShare)
  };
}

function stripFileForShare(file) {
  return {
    name: file.name,
    words: file.words.map(word => ({
      term: word.term,
      meaning: word.meaning,
      example: word.example || ""
    }))
  };
}

function cloneFolderForImport(folder, owner) {
  const cleanOwner = sanitizeText(owner, SECURITY_LIMITS.usernameLength);
  const files = Array.isArray(folder?.files)
    ? folder.files.slice(0, SECURITY_LIMITS.filesPerFolder)
    : [];
  return {
    id: uid(),
    name: sanitizeText(`${folder?.name || "Shared folder"}${cleanOwner ? ` - ${cleanOwner}` : ""}`, SECURITY_LIMITS.nameLength),
    createdAt: Date.now(),
    files: files.filter(isPlainObject).map(file => cloneFileForImport(file))
  };
}

function cloneFileForImport(file, owner) {
  const cleanOwner = sanitizeText(owner, SECURITY_LIMITS.usernameLength);
  const words = Array.isArray(file?.words)
    ? file.words.slice(0, SECURITY_LIMITS.wordsPerFile)
    : [];
  return {
    id: uid(),
    name: sanitizeText(`${file?.name || "Shared file"}${cleanOwner ? ` - ${cleanOwner}` : ""}`, SECURITY_LIMITS.nameLength),
    createdAt: Date.now(),
    words: words.filter(isPlainObject)
      .map(word => createWord(word.term || "", word.meaning || "", word.example || ""))
      .filter(word => isValidWordPair(word.term, word.meaning))
  };
}

function getOrCreateSharedFolder(user) {
  let folder = user.folders.find(item => item.name === "Shared imports");
  if (!folder) {
    folder = {
      id: uid(),
      name: "Shared imports",
      createdAt: Date.now(),
      files: []
    };
    user.folders.unshift(folder);
  }
  return folder;
}

function encodePayload(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodePayload(encoded) {
  if (typeof encoded !== "string" || encoded.length > SECURITY_LIMITS.shareCharacters) {
    throw new Error("Share payload is too large");
  }
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function parseShareLink(value) {
  try {
    const input = String(value || "").trim();
    if (!input || input.length > SECURITY_LIMITS.shareCharacters) return null;
    const hashPart = input.includes("#share=")
      ? input.split("#share=")[1]
      : input.startsWith("share=")
        ? input.replace("share=", "")
        : input;

    const payload = decodePayload(decodeURIComponent(hashPart));
    return isValidSharePayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

function readShareFromHash() {
  if (!window.location.hash.startsWith("#share=")) return null;
  return parseShareLink(window.location.hash.replace("#share=", ""));
}

function levelLabel(level) {
  if (level === 0) return "Chưa học";
  if (level === 6) return "mastered";
  return `LV${level}`;
}

function relativeTime(timestamp) {
  const diff = timestamp - Date.now();
  const abs = Math.abs(diff);
  const units = [
    ["ngày", 24 * 60 * 60 * 1000],
    ["giờ", 60 * 60 * 1000],
    ["phút", 60 * 1000]
  ];
  const [label, size] = units.find(([, unitSize]) => abs >= unitSize) || ["phút", 60 * 1000];
  const value = Math.max(1, Math.round(abs / size));
  return diff <= 0 ? `đến hạn` : `sau ${value} ${label}`;
}

function formatCountdown(timestamp, now = Date.now()) {
  const diff = timestamp - now;
  if (diff <= 0) return "Đến hạn ôn";

  const totalSeconds = Math.floor(diff / 1000);
  const daySeconds = 24 * 60 * 60;
  if (totalSeconds >= daySeconds) {
    return `${Math.ceil(totalSeconds / daySeconds)} ngày`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours} giờ ${minutes} phút ${seconds} giây`;
}

function startCountdownClock() {
  if (countdownTimer) {
    clearTimeout(countdownTimer);
    countdownTimer = null;
  }

  const countdowns = Array.from(app.querySelectorAll("[data-countdown]"), element => ({
    element,
    timestamp: Number(element.dataset.countdown),
    reviewCount: element.dataset.reviewCount || "",
    container: element.closest(".review-summary, .word-row")
  })).filter(item => Number.isFinite(item.timestamp));
  if (countdowns.length === 0) return;

  const updateCountdowns = () => {
    const now = Date.now();

    if (!document.hidden) {
      countdowns.forEach(({ element, timestamp, reviewCount, container }) => {
        const overdue = timestamp <= now;
        if (reviewCount) {
          element.textContent = overdue
            ? `Bạn có ${reviewCount} từ cần được ôn tập ngay bây giờ`
            : `Bạn có ${reviewCount} từ cần được ôn tập sau ${formatCountdown(timestamp, now)}`;
        } else {
          element.textContent = formatCountdown(timestamp, now);
        }
        element.classList.toggle("overdue", overdue);
        container?.classList.toggle("overdue", overdue);
      });
    }

    const showSeconds = !document.hidden && countdowns.some(({ timestamp }) => {
      const remaining = timestamp - now;
      return remaining > 0 && remaining < 24 * 60 * 60 * 1000;
    });
    countdownTimer = setTimeout(updateCountdowns, showSeconds ? 1000 : 60 * 1000);
  };

  updateCountdowns();
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(timestamp));
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeText(value, maxLength = SECURITY_LIMITS.nameLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeMultiline(value, maxLength = SECURITY_LIMITS.exampleLength) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLength);
}

function sanitizeUsername(value) {
  return sanitizeText(value, SECURITY_LIMITS.usernameLength);
}

function isValidUsername(value) {
  const username = sanitizeUsername(value);
  return USERNAME_PATTERN.test(username)
    && !["__proto__", "prototype", "constructor"].includes(username.toLowerCase());
}

function isValidPassword(value) {
  return typeof value === "string" && value.length >= 4 && value.length <= SECURITY_LIMITS.passwordLength;
}

function isValidWordPair(term, meaning) {
  return typeof term === "string"
    && typeof meaning === "string"
    && term.length > 0
    && term.length <= SECURITY_LIMITS.termLength
    && meaning.length > 0
    && meaning.length <= SECURITY_LIMITS.meaningLength;
}

function sanitizeId(value) {
  const id = String(value || "");
  return /^[A-Za-z0-9._:-]{1,80}$/.test(id) ? id : uid();
}

function safeTimestamp(value, fallback) {
  const timestamp = Number(value);
  const upperBound = Date.now() + (10 * 365 * 24 * 60 * 60 * 1000);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= upperBound ? timestamp : fallback;
}

function nullableTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  return safeTimestamp(value, null);
}

function isValidSharePayload(payload) {
  if (!isPlainObject(payload) || !["folder", "file"].includes(payload.type) || !isPlainObject(payload.data)) {
    return false;
  }

  if (payload.owner !== undefined && sanitizeText(payload.owner, SECURITY_LIMITS.usernameLength).length === 0) {
    return false;
  }

  const validFile = file => {
    if (!isPlainObject(file) || !Array.isArray(file.words) || file.words.length > SECURITY_LIMITS.wordsPerFile) return false;
    if (!sanitizeText(file.name || "Shared file", SECURITY_LIMITS.nameLength)) return false;
    return file.words.every(word => isPlainObject(word)
      && isValidWordPair(
        sanitizeText(word.term, SECURITY_LIMITS.termLength),
        sanitizeText(word.meaning, SECURITY_LIMITS.meaningLength)
      ));
  };

  if (payload.type === "file") return validFile(payload.data);
  if (!Array.isArray(payload.data.files) || payload.data.files.length > SECURITY_LIMITS.filesPerFolder) return false;
  return Boolean(sanitizeText(payload.data.name || "Shared folder", SECURITY_LIMITS.nameLength))
    && payload.data.files.every(validFile);
}

function normalizeAnswer(value) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
}

function clampNumber(value, min, max) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function shuffle(array) {
  const copy = [...array];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function showToast(message, duration = 2800) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), duration);
}
