const app = document.getElementById("app");
const toast = document.getElementById("toast");

const ADMIN = {
  username: "BaoKhang",
  password: "Kn6761617"
};

const STORE_KEY = "baoKhangVocabState.v1";
const SESSION_KEY = "baoKhangVocabSession.v1";
const THEME_KEY = "baoKhangVocabTheme.v1";

// Google Apps Script Web App endpoint for per-user JSON sync.
// Token/secret must stay inside Apps Script, not in public GitHub files.
const CLOUD_SYNC_URL = "https://script.google.com/macros/s/AKfycbyLQgbizj2nM6WvXHVQlFVS6arUTzDGD5WgwC3XYFDGJ73WDYsNYfFNovkIisOKQWHz/exec";
const CLOUD_FOLDER_ID = "1-Y1_DzW6zVNQFvTzhmFEUXoolb-efxeu";

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

let state = loadState();
let session = loadSession();
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

applyTheme();
render();

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY));
    if (parsed && typeof parsed === "object") {
      parsed.users = parsed.users || {};
      Object.values(parsed.users).forEach(ensureUserShape);
      return parsed;
    }
  } catch (error) {
    console.warn("Could not load saved state", error);
  }

  return { users: {} };
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) || null;
  } catch {
    return null;
  }
}

function saveState() {
  persistStateOnly();
  queueCloudSync();
}

function persistStateOnly() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

function saveSession() {
  if (!session) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }

  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function hasCloudSync() {
  return CLOUD_SYNC_URL.trim().length > 0;
}

function queueCloudSync() {
  if (!hasCloudSync() || !session) return;

  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(syncCurrentWorkspaceToCloud, 900);
}

async function syncCurrentWorkspaceToCloud() {
  if (!hasCloudSync() || isCloudSyncing || !session) return;

  const payload = session.type === "user"
    ? buildUserCloudPayload()
    : buildAdminCloudPayload();

  if (!payload) return;

  isCloudSyncing = true;
  try {
    await cloudRequest(payload);
    showToast("Đã đồng bộ JSON lên Drive.", 1600);
  } catch (error) {
    console.warn("Cloud sync failed", error);
    showToast("Chưa đồng bộ được Drive. Dữ liệu vẫn đã lưu trong trình duyệt.", 2600);
  } finally {
    isCloudSyncing = false;
  }
}

function buildUserCloudPayload() {
  const user = currentUser();
  if (!user) return null;

  return {
    action: "saveUserWorkspace",
    filename: `${user.username}.json`,
    username: user.username,
    user
  };
}

function buildAdminCloudPayload() {
  return {
    action: "saveAllUsers",
    filename: "baokhang-vocab-users.json",
    admin: ADMIN.username,
    state
  };
}

async function cloudRequest(payload) {
  const response = await fetch(CLOUD_SYNC_URL.trim(), {
    method: "POST",
    body: JSON.stringify({
      app: "BaoKhangVocab",
      folderId: CLOUD_FOLDER_ID,
      sentAt: Date.now(),
      ...payload
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.error || "Cloud sync error");
  }

  return data;
}

async function hydrateFromCloudLogin({ role, username, password }) {
  if (!hasCloudSync()) return false;

  try {
    const data = await cloudRequest({
      action: "login",
      role,
      username,
      password
    });

    if (data.state?.users) {
      state = data.state;
      state.users = state.users || {};
      Object.values(state.users).forEach(ensureUserShape);
      persistStateOnly();
      return true;
    }

    if (data.user) {
      state.users[username] = {
        ...data.user,
        username,
        password: data.user.password || password
      };
      ensureUserShape(state.users[username]);
      persistStateOnly();
      return true;
    }

    return false;
  } catch (error) {
    console.warn("Cloud login failed", error);
    return false;
  }
}

function ensureUserShape(user) {
  user.settings = { ...DEFAULT_SETTINGS, ...(user.settings || {}) };
  user.folders = Array.isArray(user.folders) ? user.folders : [];
  user.createdAt = user.createdAt || Date.now();

  user.folders.forEach(folder => {
    folder.id = folder.id || uid();
    folder.name = folder.name || "Untitled folder";
    folder.createdAt = folder.createdAt || Date.now();
    folder.files = Array.isArray(folder.files) ? folder.files : [];

    folder.files.forEach(file => {
      file.id = file.id || uid();
      file.name = file.name || "Untitled file";
      file.createdAt = file.createdAt || Date.now();
      file.words = Array.isArray(file.words) ? file.words : [];

      file.words.forEach(word => {
        word.id = word.id || uid();
        word.term = word.term || "";
        word.meaning = word.meaning || "";
        word.example = word.example || "";
        word.level = Number(word.level || 0);
        word.nextReviewAt = word.nextReviewAt || null;
        word.createdAt = word.createdAt || Date.now();
        word.studiedCount = Number(word.studiedCount || 0);
      });
    });
  });
}

function getInitialRoute() {
  if (session?.type === "admin") {
    return { view: "admin" };
  }

  if (session?.type === "user" && state.users[session.username]) {
    return { view: "home" };
  }

  session = null;
  saveSession();
  return { view: "landing" };
}

function render() {
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
}

function createIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
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

        <form id="loginForm" class="form-grid">
          <div class="field full">
            <label for="username">Tên đăng nhập</label>
            <input id="username" name="username" autocomplete="username" placeholder="${isAdmin ? "Tên đăng nhập Admin" : "Tên đăng nhập User"}" required />
          </div>
          <div class="field full">
            <label for="password">Mật khẩu</label>
            <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Mật khẩu" required />
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
  const totalWords = users.reduce((sum, user) => sum + getAllWords(user).length, 0);

  return `
    <section class="screen">
      ${topbar({
        title: "Admin Dashboard",
        subtitle: `Đang đăng nhập: ${ADMIN.username}`,
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
            <input id="newUsername" required minlength="2" placeholder="Ví dụ: test" />
          </div>
          <div class="field">
            <label for="newPassword">Mật khẩu</label>
            <input id="newPassword" required minlength="4" placeholder="Tạo mật khẩu" />
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
              const words = getAllWords(user);
              const learned = words.filter(item => item.word.level > 0).length;
              return `
                <article class="admin-row">
                  <div>
                    <strong>${escapeHtml(user.username)} - ${escapeHtml(user.password)}</strong>
                    <span>${user.folders.length} folder · ${learned}/${words.length} từ đã học · tạo ${formatDate(user.createdAt)}</span>
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
  const dueCount = getSelectableWords(user, { kind: "review" }).length;
  const newCount = getSelectableWords(user, { kind: "new" }).length;
  const settings = user.settings;
  const reviewSummary = getReviewSummary(user);

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

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Đồng hồ ôn tập</h2>
            <p>Hiển thị mốc ôn tập gần nhất.</p>
          </div>
        </div>
        ${reviewSummary ? renderReviewSummary(reviewSummary) : emptyState("timer", "Chưa có lịch ôn tập", "Sau khi học từ mới, app sẽ tự tạo đồng hồ đếm ngược cho lần ôn tiếp theo.")}
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Nhận link chia sẻ</h2>
            <p>Dán link folder hoặc file từ vựng của user khác để import vào workspace này.</p>
          </div>
        </div>
        <form id="receiveShareForm" class="share-box">
          <input class="field-input" id="shareInput" placeholder="Dán link chia sẻ vào đây" required />
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
              <input id="folderName" placeholder="Tên folder mới" required />
            </div>
            <button class="btn primary" type="submit"><i data-lucide="plus"></i>Tạo folder</button>
          </form>
        </div>

        <div class="item-grid" style="margin-top: 16px;">
          ${user.folders.length ? user.folders.map(folder => renderFolderCard(user, folder)).join("") : emptyState("folder", "Chưa có folder", "Tạo folder đầu tiên, sau đó tạo file và thêm từ vựng vào file.")}
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

  return `
    <section class="screen">
      ${topbar({
        title: escapeHtml(folder.name),
        subtitle: `${folder.files.length} file · ${folderWords.length} từ`,
        back: true,
        actions: `
          ${themeButton()}
          <button class="icon-btn" title="Settings" aria-label="Settings" data-action="open-settings"><i data-lucide="settings"></i></button>
          <button class="btn ghost" data-action="share-folder" data-folder-id="${folder.id}"><i data-lucide="share-2"></i>Share folder</button>
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
            <input id="fileName" required placeholder="Ví dụ: Unit 1 - Daily routines" />
          </div>
          <div class="form-actions">
            <button class="btn ghost" type="button" data-action="back">Cancel</button>
            <button class="btn primary" type="submit"><i data-lucide="file-plus-2"></i>Tạo file</button>
          </div>
        </form>

        <div class="item-grid" style="margin-top: 16px;">
          ${folder.files.length ? folder.files.map(file => renderFileCard(user, folder, file)).join("") : emptyState("file", "Folder chưa có file", "Tạo file từ vựng để bắt đầu thêm từ và học.")}
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

  return `
    <section class="screen">
      ${topbar({
        title: escapeHtml(file.name),
        subtitle: `${escapeHtml(folder.name)} · ${learned}/${words.length} từ đã học`,
        back: true,
        actions: `
          ${themeButton()}
          <button class="icon-btn" title="Settings" aria-label="Settings" data-action="open-settings"><i data-lucide="settings"></i></button>
          <button class="btn ghost" data-action="share-file" data-folder-id="${folder.id}" data-file-id="${file.id}"><i data-lucide="share-2"></i>Share file</button>
        `
      })}

      <section class="panel">
        <div class="grid-3">
          ${actionCard("Học từ mới", `${newCount} từ chưa học`, "play", "start-new-file", newCount === 0)}
          ${actionCard("Ôn tập đến hạn", `${dueCount} từ cần ôn`, "rotate-ccw", "start-review-file", dueCount === 0)}
          ${actionCard("Random file", "Luyện lại từ đã học", "shuffle", "open-random-file", learned === 0)}
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Thêm từ vựng</h2>
            <p>Mỗi từ cần tiếng Anh và định nghĩa tiếng Việt để tạo bài học.</p>
          </div>
        </div>
        <form id="addWordForm" class="form-grid">
          <div class="entry-tabs field full" role="tablist" aria-label="Chọn cách nhập từ vựng">
            <button class="${wordEntryMode === "manual" ? "active" : ""}" type="button" data-action="set-word-entry-mode" data-mode="manual">
              <i data-lucide="keyboard"></i>Nhập từng từ
            </button>
            <button class="${wordEntryMode === "bulk" ? "active" : ""}" type="button" data-action="set-word-entry-mode" data-mode="bulk">
              <i data-lucide="list-plus"></i>Nhập nhanh nhiều dòng
            </button>
          </div>
          ${wordEntryMode === "manual" ? `
            <div class="field">
              <label for="wordTerm">Từ tiếng Anh</label>
              <input id="wordTerm" required placeholder="Ví dụ: happy" />
            </div>
            <div class="field">
              <label for="wordMeaning">Định nghĩa tiếng Việt</label>
              <input id="wordMeaning" required placeholder="Ví dụ: vui vẻ" />
            </div>
            <div class="field full">
              <label for="wordExample">Ví dụ hoặc ghi chú</label>
              <textarea id="wordExample" placeholder="Tùy chọn"></textarea>
            </div>
          ` : `
            <div class="field full">
              <label for="bulkWords">Nhập mỗi dòng theo định dạng english - nghĩa tiếng Việt</label>
              <textarea id="bulkWords" required placeholder="happy - Vui vẻ&#10;hello - xin chào"></textarea>
            </div>
          `}
          <div class="form-actions">
            <button class="btn ghost" type="button" data-action="back">Cancel</button>
            <button class="btn primary" type="submit"><i data-lucide="plus"></i>Thêm từ</button>
          </div>
        </form>
      </section>

      <section class="panel">
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

  return `
    <section class="screen session-screen">
      ${topbar({
        title: escapeHtml(activeStudy.title),
        subtitle: `${completedCount}/${activeStudy.tasks.length} lượt đã đúng`,
        actions: `
          <button class="btn ghost" data-action="cancel-study"><i data-lucide="x"></i>Cancel</button>
        `
      })}

      <div class="tracker">
        <div class="tracker-top">
          <span>Tracker</span>
          <span>${completedCount}/${activeStudy.tasks.length}</span>
        </div>
        <div class="tracker-bar"><span style="width: ${progress}%"></span></div>
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
  const isLocked = feedback?.correct;
  return `
    <form id="typeAnswerForm" class="form-grid">
      <div class="field full">
        <label for="typedAnswer">Từ tiếng Anh</label>
        <input id="typedAnswer" autocomplete="off" placeholder="${feedback?.retry ? "Gõ lại đúng đáp án để tiếp tục" : "Gõ đáp án"}" ${isLocked ? "disabled" : ""} required />
      </div>
      <div class="field full">
        <div class="feedback ${feedback?.correct ? "good" : feedback ? "bad" : ""}">
          ${feedback ? feedback.message : "Nhập từ tiếng Anh đúng với định nghĩa ở trên."}
        </div>
      </div>
      <div class="form-actions">
        ${isLocked ? "" : `
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
    <div class="feedback ${feedback?.correct ? "good" : feedback ? "bad" : ""}">
      ${feedback ? feedback.message : "Chọn từ tiếng Anh khớp với định nghĩa."}
    </div>
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
              <input id="editWordTerm" value="${escapeAttr(modal.word.term)}" required />
            </div>
            <div class="field">
              <label for="editWordMeaning">Định nghĩa tiếng Việt</label>
              <input id="editWordMeaning" value="${escapeAttr(modal.word.meaning)}" required />
            </div>
            <div class="field full">
              <label for="editWordExample">Ví dụ hoặc ghi chú</label>
              <textarea id="editWordExample">${escapeHtml(modal.word.example || "")}</textarea>
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

  return "";
}

function bindCurrentView() {
  app.querySelectorAll("[data-action]").forEach(element => {
    element.addEventListener("click", handleAction);
  });

  const loginForm = document.getElementById("loginForm");
  if (loginForm) loginForm.addEventListener("submit", handleLogin);

  const createUserForm = document.getElementById("createUserForm");
  if (createUserForm) createUserForm.addEventListener("submit", handleCreateUser);

  const createFolderForm = document.getElementById("createFolderForm");
  if (createFolderForm) createFolderForm.addEventListener("submit", handleCreateFolder);

  const receiveShareForm = document.getElementById("receiveShareForm");
  if (receiveShareForm) receiveShareForm.addEventListener("submit", handleReceiveShare);

  const createFileForm = document.getElementById("createFileForm");
  if (createFileForm) createFileForm.addEventListener("submit", handleCreateFile);

  const addWordForm = document.getElementById("addWordForm");
  if (addWordForm) addWordForm.addEventListener("submit", handleAddWord);

  const randomForm = document.getElementById("randomForm");
  if (randomForm) randomForm.addEventListener("submit", handleRandomStart);

  const typeAnswerForm = document.getElementById("typeAnswerForm");
  if (typeAnswerForm) typeAnswerForm.addEventListener("submit", handleTypeAnswer);

  const settingsForm = document.getElementById("settingsForm");
  if (settingsForm) settingsForm.addEventListener("submit", handleSettingsSave);

  const editWordForm = document.getElementById("editWordForm");
  if (editWordForm) editWordForm.addEventListener("submit", handleEditWordSave);

  const typedAnswer = document.getElementById("typedAnswer");
  if (typedAnswer && !typedAnswer.disabled) {
    typedAnswer.focus();
  }

  startCountdownClock();
}

function handleAction(event) {
  const button = event.currentTarget;
  const action = button.dataset.action;

  if (action === "login-admin") navigate({ view: "login", role: "admin" });
  if (action === "login-user") navigate({ view: "login", role: "user" });
  if (action === "back") goBack();
  if (action === "logout") logout();
  if (action === "toggle-theme") toggleTheme();
  if (action === "open-settings") openSettings();
  if (action === "close-modal") closeModal();
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
  if (action === "copy-modal-link") copyModalLink();
}

async function handleLogin(event) {
  event.preventDefault();
  const role = route.role || "user";
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  if (role === "admin") {
    if (username === ADMIN.username && password === ADMIN.password) {
      await hydrateFromCloudLogin({ role: "admin", username, password });
      session = { type: "admin" };
      saveSession();
      routeStack = [];
      navigate({ view: "admin" }, false);
      showToast("Đăng nhập Admin thành công.");
      return;
    }

    showToast("Sai tài khoản hoặc mật khẩu Admin.");
    return;
  }

  let user = state.users[username];
  if (!user || user.password !== password) {
    await hydrateFromCloudLogin({ role: "user", username, password });
    user = state.users[username];
  }

  if (!user || user.password !== password) {
    showToast("User chưa được Admin cấp tài khoản hoặc mật khẩu không đúng.");
    return;
  }

  session = { type: "user", username };
  saveSession();
  routeStack = [];
  navigate({ view: "home" }, false);
  showToast(`Đã vào workspace của ${username}.`);
}

function handleCreateUser(event) {
  event.preventDefault();
  const username = document.getElementById("newUsername").value.trim();
  const password = document.getElementById("newPassword").value;

  if (!username || !password) {
    showToast("Vui lòng nhập đủ username và password.");
    return;
  }

  if (username === ADMIN.username) {
    showToast("Username này đang dùng cho Admin.");
    return;
  }

  if (state.users[username]) {
    showToast("Username đã tồn tại.");
    return;
  }

  state.users[username] = {
    username,
    password,
    createdAt: Date.now(),
    settings: { ...DEFAULT_SETTINGS },
    folders: []
  };
  saveState();
  event.target.reset();
  showToast("Đã tạo user mới.");
  render();
}

function resetUserPassword(username) {
  const user = state.users[username];
  if (!user) return;

  const password = prompt(`Mật khẩu mới cho ${username}:`);
  if (!password) return;

  user.password = password;
  saveState();
  showToast("Đã đổi mật khẩu user.");
  render();
}

function deleteUser(username) {
  if (!state.users[username]) return;
  if (!confirm(`Xóa user "${username}" và toàn bộ workspace?`)) return;

  delete state.users[username];
  saveState();
  showToast("Đã xóa user.");
  render();
}

function handleCreateFolder(event) {
  event.preventDefault();
  const user = currentUser();
  const input = document.getElementById("folderName");
  const name = input.value.trim();
  if (!name) return;

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
  if (!confirm(`Xóa folder "${folder.name}" và mọi file bên trong?`)) return;

  user.folders = user.folders.filter(item => item.id !== folderId);
  saveState();
  showToast("Đã xóa folder.");
  if (route.view === "folder" && route.folderId === folderId) {
    navigate({ view: "home" }, false);
  } else {
    render();
  }
}

function handleCreateFile(event) {
  event.preventDefault();
  const user = currentUser();
  const folder = findFolder(user, route.folderId);
  const input = document.getElementById("fileName");
  const name = input.value.trim();
  if (!folder || !name) return;

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
  if (!confirm(`Xóa file "${file.name}"?`)) return;

  folder.files = folder.files.filter(item => item.id !== fileId);
  saveState();
  showToast("Đã xóa file.");
  if (route.view === "file" && route.fileId === fileId) {
    navigate({ view: "folder", folderId }, false);
  } else {
    render();
  }
}

function setWordEntryMode(mode) {
  wordEntryMode = mode === "bulk" ? "bulk" : "manual";
  render();
}

function handleAddWord(event) {
  event.preventDefault();
  const user = currentUser();
  const folder = findFolder(user, route.folderId);
  const file = folder ? findFile(folder, route.fileId) : null;
  if (!file) return;

  let added = 0;

  if (wordEntryMode === "manual") {
    const term = document.getElementById("wordTerm").value.trim();
    const meaning = document.getElementById("wordMeaning").value.trim();
    const example = document.getElementById("wordExample").value.trim();

    if (!term || !meaning) {
      showToast("Nhập đủ từ tiếng Anh và nghĩa tiếng Việt.");
      return;
    }

    file.words.unshift(createWord(term, meaning, example));
    added += 1;
  }

  if (wordEntryMode === "bulk") {
    const bulk = document.getElementById("bulkWords").value.trim();
    if (!bulk) {
      showToast("Nhập ít nhất một dòng theo định dạng english - nghĩa.");
      return;
    }

    parseBulkWords(bulk).forEach(item => {
      file.words.unshift(createWord(item.term, item.meaning, item.example));
      added += 1;
    });
  }

  if (added === 0) {
    showToast("Không tìm thấy dòng hợp lệ. Ví dụ: happy - Vui vẻ");
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
    term,
    meaning,
    example,
    level: 0,
    createdAt: Date.now(),
    learnedAt: null,
    lastStudiedAt: null,
    nextReviewAt: null,
    studiedCount: 0
  };
}

function parseBulkWords(text) {
  return text
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split(/\s[-–—|,]\s|[-–—|,]/);
      const term = (parts.shift() || "").trim();
      const meaning = parts.join(" ").trim();
      return { term, meaning };
    })
    .filter(item => item.term && item.meaning);
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
  if (!modal || modal.type !== "edit-word") return;

  const user = currentUser();
  const word = findWord(user, modal.folderId, modal.fileId, modal.wordId);
  if (!word) return;

  const term = document.getElementById("editWordTerm").value.trim();
  const meaning = document.getElementById("editWordMeaning").value.trim();
  const example = document.getElementById("editWordExample").value.trim();

  if (!term || !meaning) {
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
  if (!user) return;

  if (payload.type === "folder") {
    const folder = cloneFolderForImport(payload.data, payload.owner);
    user.folders.unshift(folder);
    saveState();
    showToast("Đã import folder vào workspace.");
    render();
    return;
  }

  if (payload.type === "file") {
    const folder = getOrCreateSharedFolder(user);
    const file = cloneFileForImport(payload.data, payload.owner);
    folder.files.unshift(file);
    saveState();
    showToast("Đã import file vào folder Shared imports.");
    render();
    return;
  }

  showToast("Link chia sẻ không hợp lệ.");
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
    ? "Đúng rồi."
    : `Chưa đúng. Đáp án: ${task.word.term}. Hãy gõ lại đúng đáp án để tiếp tục.`;

  recordResult(task, correct);
  activeStudy.feedback = { correct, message, retry: !correct };
  render();

  if (correct) {
    scheduleStudyAuto(nextTask, 700);
  }
}

function handleChoiceAnswer(choice) {
  if (!activeStudy || activeStudy.feedback) return;
  const task = activeStudy.tasks[activeStudy.index];
  const correct = choice === task.word.term;
  const message = correct
    ? "Đúng rồi."
    : `Chưa đúng. Đáp án: ${task.word.term}.`;

  recordResult(task, correct);
  activeStudy.feedback = { correct, selected: choice, message };
  render();

  if (correct) {
    scheduleStudyAuto(nextTask, 700);
  } else {
    scheduleStudyAuto(retryCurrentTask, 1200);
  }
}

function recordResult(task, correct) {
  const result = activeStudy.results[task.wordId] || { correct: 0, total: 0, wrong: false };
  result.total += 1;
  if (correct) {
    result.correct += 1;
  } else {
    result.wrong = true;
  }
  activeStudy.results[task.wordId] = result;
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

function retryCurrentTask() {
  if (!activeStudy) return;
  clearStudyAutoTimer();
  activeStudy.feedback = null;
  render();
}

function cancelStudy() {
  if (!activeStudy) return;
  if (!confirm("Hủy phiên học hiện tại? Tiến độ phiên này sẽ không được tính.")) return;

  clearStudyAutoTimer();
  activeStudy = null;
  goBack();
}

function finishStudy() {
  clearStudyAutoTimer();
  const user = currentUser();
  const now = Date.now();
  let advanced = 0;
  let retried = 0;

  activeStudy.words.forEach(ref => {
    const word = findWord(user, ref.folderId, ref.fileId, ref.wordId);
    if (!word) return;

    const result = activeStudy.results[word.id] || { wrong: false };

    if (activeStudy.mode === "random") {
      word.lastPracticedAt = now;
      return;
    }

    if (result.wrong) retried += 1;

    advanceWord(word, now);
    advanced += 1;
  });

  saveState();
  const mode = activeStudy.mode;
  activeStudy = null;
  navigate({ view: "home" }, false);

  if (mode === "random") {
    showToast("Hoàn thành phiên random.");
  } else {
    showToast(`Hoàn thành phiên học: ${advanced} từ lên mức${retried ? `, ${retried} từ đã làm lại đúng` : ""}.`);
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

function getReviewSchedule(user, filters = {}) {
  return getAllWords(user, filters)
    .filter(item => item.word.level > 0 && item.word.nextReviewAt)
    .sort((a, b) => a.word.nextReviewAt - b.word.nextReviewAt);
}

function getReviewSummary(user, filters = {}) {
  const schedule = getReviewSchedule(user, filters);
  if (schedule.length === 0) return null;

  const now = Date.now();
  const dueNow = schedule.filter(item => item.word.nextReviewAt <= now);
  if (dueNow.length > 0) {
    return {
      count: dueNow.length,
      nextReviewAt: now,
      overdue: true
    };
  }

  const nextReviewAt = schedule[0].word.nextReviewAt;
  const count = schedule.filter(item => item.word.nextReviewAt === nextReviewAt).length;
  return {
    count,
    nextReviewAt,
    overdue: false
  };
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
  const words = getAllWords(user);
  const counts = Object.fromEntries(LEVELS.map(level => [level.key, 0]));
  let learned = 0;

  words.forEach(item => {
    if (item.word.level > 0) learned += 1;
    const level = LEVELS.find(entry => entry.level === item.word.level);
    if (level) counts[level.key] += 1;
  });

  return {
    total: words.length,
    learned,
    mastered: counts.mastered,
    counts
  };
}

function getAllWords(user, filters = {}) {
  const items = [];
  user.folders.forEach(folder => {
    if (filters.folderId && folder.id !== filters.folderId) return;
    folder.files.forEach(file => {
      if (filters.fileId && file.id !== filters.fileId) return;
      file.words.forEach(word => items.push({ folder, file, word }));
    });
  });
  return items;
}

function currentUser() {
  if (!session?.username) return null;
  const user = state.users[session.username];
  if (user) ensureUserShape(user);
  return user || null;
}

function findFolder(user, folderId) {
  return user.folders.find(folder => folder.id === folderId);
}

function findFile(folder, fileId) {
  return folder.files.find(file => file.id === fileId);
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
    <article class="item-card">
      <span class="role-icon"><i data-lucide="${icon}"></i></span>
      <h3>${title}</h3>
      <p>${subtitle}</p>
      <div class="item-card-footer">
        <button class="btn primary" data-action="${action}" ${disabled ? "disabled" : ""}>
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
        <button class="btn primary" data-action="open-folder" data-folder-id="${folder.id}"><i data-lucide="folder-open"></i>Mở</button>
        <button class="btn ghost" data-action="share-folder" data-folder-id="${folder.id}"><i data-lucide="share-2"></i>Share</button>
        <button class="btn danger" data-action="delete-folder" data-folder-id="${folder.id}"><i data-lucide="trash-2"></i>Xóa</button>
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
        <button class="btn primary" data-action="open-file" data-folder-id="${folder.id}" data-file-id="${file.id}"><i data-lucide="file-text"></i>Mở</button>
        <button class="btn ghost" data-action="share-file" data-folder-id="${folder.id}" data-file-id="${file.id}"><i data-lucide="share-2"></i>Share</button>
        <button class="btn danger" data-action="delete-file" data-folder-id="${folder.id}" data-file-id="${file.id}"><i data-lucide="trash-2"></i>Xóa</button>
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
        <button class="btn ghost" data-action="edit-word" data-folder-id="${route.folderId}" data-file-id="${route.fileId}" data-word-id="${word.id}">
          <i data-lucide="pencil"></i>Sửa
        </button>
        <button class="btn danger" data-action="delete-word" data-folder-id="${route.folderId}" data-file-id="${route.fileId}" data-word-id="${word.id}">
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

function logout() {
  session = null;
  activeStudy = null;
  clearStudyAutoTimer();
  routeStack = [];
  saveSession();
  navigate({ view: "landing" }, false);
  showToast("Đã đăng xuất.");
}

function applyTheme() {
  const theme = localStorage.getItem(THEME_KEY) || "light";
  document.documentElement.dataset.theme = theme;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme();
  render();
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
  return {
    id: uid(),
    name: `${folder.name || "Shared folder"}${owner ? ` - ${owner}` : ""}`,
    createdAt: Date.now(),
    files: (folder.files || []).map(file => cloneFileForImport(file))
  };
}

function cloneFileForImport(file, owner) {
  return {
    id: uid(),
    name: `${file.name || "Shared file"}${owner ? ` - ${owner}` : ""}`,
    createdAt: Date.now(),
    words: (file.words || []).map(word => createWord(word.term || "", word.meaning || "", word.example || ""))
      .filter(word => word.term && word.meaning)
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
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}

function decodePayload(encoded) {
  return JSON.parse(decodeURIComponent(escape(atob(encoded))));
}

function parseShareLink(value) {
  try {
    const hashPart = value.includes("#share=")
      ? value.split("#share=")[1]
      : value.startsWith("share=")
        ? value.replace("share=", "")
        : value;

    const payload = decodePayload(decodeURIComponent(hashPart));
    if (!payload || !["folder", "file"].includes(payload.type)) return null;
    return payload;
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

function formatCountdown(timestamp) {
  const diff = timestamp - Date.now();
  if (diff <= 0) return "Đến hạn ôn";

  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days} ngày ${hours} giờ`;
  if (hours > 0) return `${hours} giờ ${minutes} phút`;
  if (minutes > 0) return `${minutes} phút ${seconds} giây`;
  return `${seconds} giây`;
}

function startCountdownClock() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  const countdowns = Array.from(document.querySelectorAll("[data-countdown]"));
  if (countdowns.length === 0) return;

  const updateCountdowns = () => {
    countdowns.forEach(element => {
      const timestamp = Number(element.dataset.countdown);
      const overdue = timestamp <= Date.now();
      if (element.dataset.reviewCount) {
        const count = element.dataset.reviewCount;
        element.textContent = overdue
          ? `Bạn có ${count} từ cần được ôn tập ngay bây giờ`
          : `Bạn có ${count} từ cần được ôn tập sau ${formatCountdown(timestamp)}`;
      } else {
        element.textContent = formatCountdown(timestamp);
      }
      element.classList.toggle("overdue", overdue);
      element.closest(".review-summary, .word-row")?.classList.toggle("overdue", overdue);
    });
  };

  updateCountdowns();
  countdownTimer = setInterval(updateCountdowns, 1000);
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(timestamp));
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
