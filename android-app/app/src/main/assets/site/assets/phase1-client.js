(function () {
  function escapeHtml(str) {
    return String(str || "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  function resolveApiBase() {
    const configured = (
      window.__THREADBORN_API_BASE ||
      localStorage.getItem("threadborn_api_base") ||
      ""
    ).replace(/\/$/, "");
    if (configured) {
      return configured;
    }
    const host = window.location.hostname;
    if (
      host === "appassets.androidplatform.net" ||
      window.location.protocol === "file:"
    ) {
      return "https://threadborn.vercel.app";
    }
    if (
      (host === "localhost" || host === "127.0.0.1") &&
      window.location.port !== "3000"
    ) {
      return "https://threadborn.vercel.app";
    }
    return "";
  }

  const API_BASE = resolveApiBase();
  const QUEUE_KEY = "threadborn_sync_queue_v1";
  const FALLBACK_PROGRESS_KEY = "threadborn_reader_progress";
  const APP_SESSION_KEY = "threadborn_app_session";
  let csrfToken = localStorage.getItem("threadborn_csrf_token") || "";
  let authUser = null;
  let bookmarkCache = [];
  let analyticsBuffer = [];
  let analyticsTimer = null;
  let syncTimer = null;
  let readerActiveSince = null;
  let authConfigMissing = false;

  function apiPath(path) {
    return `${API_BASE}${path}`;
  }

  function getAppMode() {
    return String(
      window.__THREADBORN_APP_MODE ||
        localStorage.getItem("threadborn_app_mode") ||
        "",
    )
      .trim()
      .toLowerCase();
  }

  function buildAuthHeaders(headers = {}) {
    const next = Object.assign({ "Content-Type": "application/json" }, headers);
    const appMode = getAppMode();
    const appSession = localStorage.getItem(APP_SESSION_KEY) || "";
    if (appMode) {
      next["X-Threadborn-App-Mode"] = appMode;
      localStorage.setItem("threadborn_app_mode", appMode);
    }
    if (appSession) {
      next.Authorization = `Bearer ${appSession}`;
    }
    return next;
  }

  function rememberAuthData(data) {
    if (!data || typeof data !== "object") {
      return;
    }
    if (data.csrfToken) {
      csrfToken = data.csrfToken;
      localStorage.setItem("threadborn_csrf_token", data.csrfToken);
    }
    if (data.sessionToken) {
      localStorage.setItem(APP_SESSION_KEY, data.sessionToken);
    }
    if (data.user) {
      authUser = data.user;
      localStorage.setItem(
        "threadborn_user",
        JSON.stringify({
          id: data.user.id,
          email: data.user.email,
          displayName: data.user.username || data.user.displayName,
          avatarUrl: data.user.avatarUrl,
          verified: data.user.verified,
          role: data.user.role,
        }),
      );
    }
  }

  function makeApiError(response, payload) {
    const err = new Error(payload.error || "Request failed");
    err.status = response.status || 500;
    err.payload = payload;
    return err;
  }

  function isRecoverableCsrfError(error) {
    return (
      error &&
      error.status === 403 &&
      /csrf|session/i.test(String(error.message || ""))
    );
  }

  async function refreshAuthSession() {
    const headers = buildAuthHeaders();
    delete headers["X-CSRF-Token"];
    const response = await fetch(apiPath("/api/auth/me"), {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) {
      return false;
    }
    rememberAuthData(payload.data);
    return Boolean(payload.data?.csrfToken);
  }

  async function apiFetchOnce(path, options = {}) {
    const headers = buildAuthHeaders(options.headers || {});
    if (csrfToken) {
      headers["X-CSRF-Token"] = csrfToken;
    }
    const response = await fetch(
      apiPath(path),
      Object.assign({}, options, {
        credentials: "include",
        cache: "no-store",
        headers,
      }),
    );
    let payload = {};
    try {
      payload = await response.json();
    } catch (error) {
      payload = { success: false, error: "Invalid response" };
    }
    if (!response.ok || !payload.success) {
      throw makeApiError(response, payload);
    }
    return payload.data;
  }

  async function apiFetch(path, options = {}) {
    try {
      return await apiFetchOnce(path, options);
    } catch (error) {
      if (isRecoverableCsrfError(error) && (await refreshAuthSession())) {
        return apiFetchOnce(path, options);
      }
      throw error;
    }
  }

  window.apiFetch = apiFetch;

  function saveQueue(queue) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  }

  function readQueue() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    } catch (error) {
      return [];
    }
  }

  function enqueue(item) {
    const queue = readQueue();
    queue.push(Object.assign({ retries: 0 }, item));
    saveQueue(queue);
  }

  async function drainQueue() {
    const queue = readQueue();
    if (!queue.length || !authUser) {
      return;
    }
    const nextQueue = [];
    for (const item of queue) {
      try {
        if (item.type === "progress") {
          await apiFetch("/api/reader/progress", {
            method: "PUT",
            body: JSON.stringify(item.payload),
          });
        } else if (item.type === "bookmark") {
          await apiFetch("/api/reader/bookmarks", {
            method: "POST",
            body: JSON.stringify(item.payload),
          });
        } else if (item.type === "bookmark_delete") {
          await apiFetch("/api/reader/bookmarks", {
            method: "DELETE",
            body: JSON.stringify(item.payload),
          });
        } else if (item.type === "analytics") {
          await apiFetch("/api/reader/analytics", {
            method: "POST",
            body: JSON.stringify({ events: item.payload.events }),
          });
        }
      } catch (error) {
        item.retries += 1;
        if (item.retries <= 7) {
          nextQueue.push(item);
        }
      }
    }
    saveQueue(nextQueue);
  }

  function toggleAuthNav() {
    const loggedIn = Boolean(authUser);
    const isOwner = loggedIn && authUser.role === "owner";
    const dashEl = document.getElementById("nav-dashboard");
    if (dashEl) dashEl.style.display = isOwner ? "" : "none";
    const mDashEl = document.getElementById("mobile-nav-dashboard");
    if (mDashEl) mDashEl.style.display = isOwner ? "" : "none";
    const loginEl = document.getElementById("nav-login");
    const signupEl = document.getElementById("nav-signup");
    const profileEl = document.getElementById("nav-profile");
    const logoutEl = document.getElementById("nav-logout");
    const mLoginEl = document.getElementById("mobile-nav-login");
    const mSignupEl = document.getElementById("mobile-nav-signup");
    const mProfileEl = document.getElementById("mobile-nav-profile");
    const mLogoutEl = document.getElementById("mobile-nav-logout");
    [loginEl, signupEl, mLoginEl, mSignupEl].forEach((el) => {
      if (el) {
        el.style.display = loggedIn ? "none" : "";
      }
    });
    [profileEl, logoutEl, mProfileEl, mLogoutEl].forEach((el) => {
      if (el) {
        el.style.display = loggedIn ? "" : "none";
      }
    });
    if (typeof window.renderUserChip === "function") {
      window.renderUserChip();
    }
    const userName = document.getElementById("user-name");
    if (userName && authConfigMissing && !loggedIn) {
      userName.textContent = "Setup required";
    }
  }

  function getChapterMeta() {
    if (!window.chapters || !window.chapters[window.activeChapter]) {
      return null;
    }
    const chapter = window.chapters[window.activeChapter];
    return {
      novelId: "threadborn",
      volumeId: chapter.volume,
      chapterId: chapter.chapter,
      scrollPosition: Number(window.activePage || 0),
    };
  }

  async function syncProgressNow() {
    if (!authUser) {
      return;
    }
    const payload = getChapterMeta();
    if (!payload) {
      return;
    }
    try {
      await apiFetch("/api/reader/progress", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const saveSummary = document.getElementById("reader-save-summary");
      if (saveSummary) {
        saveSummary.textContent = "Synced to account";
      }
    } catch (error) {
      enqueue({ type: "progress", payload });
    }
  }

  function addAnalyticsTick() {
    if (!authUser || readerActiveSince === null) {
      return;
    }
    const payload = getChapterMeta();
    if (!payload) {
      return;
    }
    const now = Date.now();
    const seconds = Math.max(1, Math.round((now - readerActiveSince) / 1000));
    readerActiveSince = now;
    analyticsBuffer.push({
      novelId: payload.novelId,
      volumeId: payload.volumeId,
      chapterId: payload.chapterId,
      timeSpent: seconds,
    });
  }

  async function flushAnalytics() {
    if (!analyticsBuffer.length || !authUser) {
      return;
    }
    const events = analyticsBuffer.splice(0, analyticsBuffer.length);
    try {
      await apiFetch("/api/reader/analytics", {
        method: "POST",
        body: JSON.stringify({ events }),
      });
    } catch (error) {
      enqueue({ type: "analytics", payload: { events } });
    }
  }

  function renderBookmarkSelect() {
    if (typeof window.mergeServerBookmarks === "function") {
      window.mergeServerBookmarks(bookmarkCache);
      return;
    }
    const select = document.getElementById("bookmark-jump");
    if (!select) {
      return;
    }
    const options = [`<option value="">Select a bookmark</option>`];
    bookmarkCache.forEach((bookmark) => {
      const label =
        bookmark.label ||
        `${bookmark.volume_id} • ${bookmark.chapter_id} • p${Math.floor(bookmark.scroll_position) + 1}`;
      options.push(`<option value="${bookmark.id}">${label}</option>`);
    });
    select.innerHTML = options.join("");
  }

  async function loadBookmarks() {
    if (!authUser) {
      if (typeof window.renderBookmarks === "function") {
        window.renderBookmarks();
      } else {
        bookmarkCache = [];
        renderBookmarkSelect();
      }
      return;
    }
    try {
      const data = await apiFetch("/api/reader/bookmarks?novelId=threadborn");
      bookmarkCache = data.bookmarks || [];
      renderBookmarkSelect();
    } catch (error) {
      // ignore
    }
  }

  window.addBookmarkFromReader = async function addBookmarkFromReader() {
    if (typeof window.createBookmark === "function") {
      window.createBookmark();
      return;
    }
    if (!authUser) {
      return;
    }
    const payload = getChapterMeta();
    if (!payload) {
      return;
    }
    const label = window.prompt("Bookmark label (optional)", "");
    try {
      await apiFetch("/api/reader/bookmarks", {
        method: "POST",
        body: JSON.stringify(
          Object.assign({}, payload, { label: label || "" }),
        ),
      });
      loadBookmarks();
    } catch (error) {
      alert("Could not save bookmark.");
    }
  };

  window.checkUpdates = function () {
    const btn = document.getElementById("check-updates-btn");
    if (btn) btn.textContent = "Checking...";

    // Remember community tab
    sessionStorage.setItem("threadborn_active_view", "community");

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then(function (registrations) {
        for (let registration of registrations) {
          registration.update();
        }
      });
    }

    // Force a hard reload bypassing cache
    setTimeout(() => {
      window.location.reload(true);
    }, 500);
  };

  window.syncBookmarkToAccount = async function syncBookmarkToAccount(
    bookmark,
  ) {
    if (!authUser || !bookmark) {
      return;
    }
    const payload = {
      novelId: "threadborn",
      volumeId: bookmark.volumeId,
      chapterId: bookmark.chapterId,
      scrollPosition: Number(bookmark.pageIndex || 0),
      label: bookmark.label || "",
    };
    try {
      const data = await apiFetch("/api/reader/bookmarks", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (data.bookmark && typeof window.mergeServerBookmarks === "function") {
        window.mergeServerBookmarks([data.bookmark]);
      }
      const status = document.getElementById("bookmark-status");
      if (status) {
        status.textContent = "Bookmark saved and synced.";
      }
    } catch (error) {
      enqueue({ type: "bookmark", payload });
      const status = document.getElementById("bookmark-status");
      if (status) {
        status.textContent = "Bookmark saved locally. Sync queued.";
      }
    }
  };

  window.deleteBookmarkFromAccount = async function deleteBookmarkFromAccount(
    bookmark,
  ) {
    if (!authUser || !bookmark || !bookmark.serverId) {
      return;
    }
    const payload = { id: bookmark.serverId };
    try {
      await apiFetch("/api/reader/bookmarks", {
        method: "DELETE",
        body: JSON.stringify(payload),
      });
    } catch (error) {
      enqueue({ type: "bookmark_delete", payload });
    }
  };

  async function syncLocalBookmarks() {
    if (
      !authUser ||
      typeof window.readLocalBookmarks !== "function" ||
      typeof window.mergeServerBookmarks !== "function"
    ) {
      return;
    }
    const localBookmarks = window.readLocalBookmarks();
    for (const bookmark of localBookmarks) {
      if (bookmark.synced || bookmark.serverId) {
        continue;
      }
      const payload = {
        novelId: "threadborn",
        volumeId: bookmark.volumeId,
        chapterId: bookmark.chapterId,
        scrollPosition: Number(bookmark.pageIndex || 0),
        label: bookmark.label || "",
      };
      try {
        const data = await apiFetch("/api/reader/bookmarks", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (data.bookmark) {
          window.mergeServerBookmarks([data.bookmark]);
        }
      } catch (error) {
        enqueue({ type: "bookmark", payload });
      }
    }
  }

  window.jumpToBookmark = function jumpToBookmark(id) {
    if (!id) {
      return;
    }
    const bookmark = bookmarkCache.find((item) => item.id === id);
    if (!bookmark || !window.chapters) {
      return;
    }
    const idx = window.chapters.findIndex(
      (ch) =>
        ch.volume === bookmark.volume_id && ch.chapter === bookmark.chapter_id,
    );
    if (idx >= 0 && typeof window.openChapter === "function") {
      window.openChapter(idx, Number(bookmark.scroll_position || 0));
    }
  };

  window.logoutUser = async function logoutUser() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST", body: "{}" });
    } catch (error) {
      // ignore
    }
    authUser = null;
    csrfToken = "";
    localStorage.removeItem(APP_SESSION_KEY);
    localStorage.removeItem("threadborn_csrf_token");
    localStorage.removeItem("threadborn_user");
    toggleAuthNav();
  };

  async function hydrateAuth() {
    try {
      const data = await apiFetch("/api/auth/me", { method: "GET" });
      rememberAuthData(data);
      authConfigMissing = false;
    } catch (error) {
      const isAuthError = error.status === 401 || error.status === 403;
      if (isAuthError) {
        authUser = null;
        csrfToken = "";
        localStorage.removeItem("threadborn_user");
        localStorage.removeItem("threadborn_csrf_token");
        localStorage.removeItem(APP_SESSION_KEY);
      } else {
        try {
          const cachedUser = localStorage.getItem("threadborn_user");
          if (cachedUser) {
            authUser = JSON.parse(cachedUser);
            if (!authUser.username && authUser.displayName) {
              authUser.username = authUser.displayName;
            }
          }
        } catch (e) {}
      }
      authConfigMissing = String(error.message || "").includes(
        "Missing DATABASE_URL",
      );
    }
    toggleAuthNav();
    await syncLocalBookmarks();
    await loadBookmarks();
    // Inform the unified notification system of the resolved user
    if (window.TB_Notif) {
      window.TB_Notif.setUser(authUser);
      if (authUser) window.TB_Notif.loadServerNotifications();
    }
  }

  async function hydrateServerProgress() {
    if (!authUser || !window.chapters || !window.chapters.length) {
      return;
    }
    try {
      const data = await apiFetch("/api/reader/progress?novelId=threadborn", {
        method: "GET",
      });
      if (!data.progress) {
        return;
      }
      const chapterIndex = window.chapters.findIndex(
        (ch) =>
          ch.volume === data.progress.volume_id &&
          ch.chapter === data.progress.chapter_id,
      );
      if (chapterIndex >= 0) {
        window.activeChapter = chapterIndex;
        window.activePage = Math.max(
          0,
          Number(data.progress.scroll_position || 0),
        );
        if (typeof window.updateResumeButton === "function") {
          window.updateResumeButton();
        }
        const saved = {
          chapter: chapterIndex,
          page: window.activePage,
          size: window.readerSize || 18,
          theme: window.readerTheme || "night",
        };
        localStorage.setItem(FALLBACK_PROGRESS_KEY, JSON.stringify(saved));
      }
    } catch (error) {
      // ignore
    }
  }

  function monkeyPatchReaderHooks() {
    if (typeof window.renderPage === "function") {
      const originalRenderPage = window.renderPage;
      window.renderPage = function patchedRenderPage() {
        originalRenderPage.apply(this, arguments);
        syncProgressNow();
      };
    }
    if (typeof window.openChapter === "function") {
      const originalOpenChapter = window.openChapter;
      window.openChapter = function patchedOpenChapter() {
        readerActiveSince = Date.now();
        originalOpenChapter.apply(this, arguments);
      };
    }
    if (typeof window.closeReader === "function") {
      const originalCloseReader = window.closeReader;
      window.closeReader = function patchedCloseReader() {
        addAnalyticsTick();
        flushAnalytics();
        readerActiveSince = null;
        originalCloseReader.apply(this, arguments);
      };
    }
  }

  function startBackgroundSync() {
    if (syncTimer) {
      clearInterval(syncTimer);
    }
    syncTimer = setInterval(() => {
      drainQueue();
      syncProgressNow();
    }, 12_000);
    if (analyticsTimer) {
      clearInterval(analyticsTimer);
    }
    analyticsTimer = setInterval(() => {
      addAnalyticsTick();
      flushAnalytics();
    }, 45_000);
    window.addEventListener("online", drainQueue);
  }

  // Dashboard Logic
  window.getDashboardLang = function () {
    const isJp = window.location.pathname.indexOf("-jp") !== -1;
    let baseLang = isJp ? "ja" : "en";
    const select = document.getElementById("dashboard-target-lang");
    if (select) {
      baseLang = select.value;
    }
    return baseLang;
  };

  window.loadDashboardConfig = async function loadDashboardConfig() {
    try {
      const lang = window.getDashboardLang();
      const isJp = window.location.pathname.indexOf("-jp") !== -1;
      const displayLang = isJp ? "ja" : "en";

      const data = await apiFetch(
        `/api/dashboard?action=config&lang=${displayLang}`,
      );

      const notifBanner = document.getElementById("global-announcement-banner");
      let notifs = Array.isArray(data.notifications) ? data.notifications : [];
      if (data.notification && notifs.length === 0)
        notifs = [data.notification]; // fallback

      if (notifBanner) {
        if (notifs.length > 0) {
          notifBanner.innerHTML = notifs
            .map(
              (n) =>
                `<div style="margin-bottom:8px;"><strong>BiniFn:</strong> ${escapeHtml(n).replace(/\n/g, "<br>")}</div>`,
            )
            .join("");
          notifBanner.style.display = "";
        } else {
          notifBanner.style.display = "none";
        }
      }

      const cdBanner = document.getElementById("global-countdown-banner");
      let countdowns = Array.isArray(data.countdowns) ? data.countdowns : [];
      if (data.countdown && data.countdown.title && countdowns.length === 0)
        countdowns = [data.countdown]; // fallback

      if (window._cdIntervals) {
        window._cdIntervals.forEach(clearInterval);
      }
      window._cdIntervals = [];

      if (countdowns.length > 0 && cdBanner) {
        cdBanner.innerHTML = countdowns
          .map(
            (cd, idx) => `
          <div style="background:#222; color:#fff; padding:10px; text-align:center; margin-bottom:8px; border-radius:8px; border:1px solid rgba(255, 107, 107, 0.4);">
            <strong id="global-countdown-title-${idx}">${escapeHtml(cd.title)}</strong>
            <div id="global-countdown-timer-${idx}" style="font-size:1.2rem; font-weight:bold; margin-top:5px; color:#ff6b6b;">Loading timer...</div>
          </div>
        `,
          )
          .join("");
        cdBanner.style.display = "";

        countdowns.forEach((cd, idx) => {
          const interval = setInterval(() => {
            const dateStr = String(cd.target_date || "").replace(" ", "T");
            const target = new Date(dateStr).getTime();
            const now = new Date().getTime();
            const distance = target - now;
            const timerEl = document.getElementById(
              `global-countdown-timer-${idx}`,
            );
            if (!timerEl) return;

            if (isNaN(target)) {
              timerEl.textContent = "Timer Not Set";
              return;
            }

            if (distance < 0) {
              timerEl.textContent = "RELEASED";
              return;
            }
            const days = Math.floor(distance / (1000 * 60 * 60 * 24));
            const hours = Math.floor(
              (distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
            );
            const minutes = Math.floor(
              (distance % (1000 * 60 * 60)) / (1000 * 60),
            );
            const seconds = Math.floor((distance % (1000 * 60)) / 1000);
            timerEl.textContent = `${days}d ${hours}h ${minutes}m ${seconds}s`;
          }, 1000);
          window._cdIntervals.push(interval);
        });
      } else if (cdBanner) {
        cdBanner.style.display = "none";
      }

      // Populate owner dashboard inputs if dashboard elements exist
      if (document.getElementById("dashboard-announcements-list")) {
        const ownerData = await apiFetch(
          `/api/dashboard?action=config&lang=${lang}`,
        );
        const ownerNotifs = Array.isArray(ownerData.notifications)
          ? ownerData.notifications
          : ownerData.notification
            ? [ownerData.notification]
            : [];
        const notifContainer = document.getElementById(
          "dashboard-announcements-list",
        );
        if (notifContainer) {
          notifContainer.innerHTML = ownerNotifs
            .map(
              (n, idx) => `
            <div class="announcement-item" style="display:flex; gap:8px; margin-bottom:8px;">
              <textarea class="dashboard-announcement-input" style="flex:1; resize:vertical; min-height:72px; padding:8px; font-family:inherit; font-size:inherit;">${escapeHtml(n)}</textarea>
              <button class="ghost-btn" type="button" onclick="this.parentElement.remove(); saveDashboardConfig();">Remove</button>
            </div>
          `,
            )
            .join("");
        }

        const ownerCountdowns = Array.isArray(ownerData.countdowns)
          ? ownerData.countdowns
          : ownerData.countdown && ownerData.countdown.title
            ? [ownerData.countdown]
            : [];
        const cdContainer = document.getElementById(
          "dashboard-countdowns-list",
        );
        if (cdContainer) {
          cdContainer.innerHTML = ownerCountdowns
            .map(
              (cd, idx) => `
            <div class="countdown-item" style="display:flex; flex-direction:column; gap:8px; margin-bottom:12px; padding:12px; background:#2a2a35; border-radius:8px;">
              <input type="text" class="dashboard-cd-title" value="${escapeHtml(cd.title)}" placeholder="Title..." style="width:100%;" />
              <input type="text" class="dashboard-cd-date" value="${escapeHtml(cd.target_date)}" placeholder="Select Date & Time..." style="width:100%; padding:8px;" />
              <button class="ghost-btn" type="button" onclick="this.parentElement.remove(); saveDashboardConfig();" style="align-self:flex-end;">Remove</button>
            </div>
          `,
            )
            .join("");
          if (typeof flatpickr !== "undefined") {
            flatpickr(".dashboard-cd-date", {
              enableTime: true,
              dateFormat: "Y-m-d\\TH:i",
              time_24hr: false,
            });
          }
        }
      }

      loadPolls();
    } catch (e) {
      console.error("[Dashboard] loadDashboardConfig failed:", e);
    }
  };

  window.saveDashboardConfig = async function saveDashboardConfig() {
    try {
      const lang = window.getDashboardLang();
      const inputs = document.querySelectorAll(".dashboard-announcement-input");
      const notifications = Array.from(inputs)
        .map((inp) => inp.value.trim())
        .filter((v) => v !== "");

      const cdItems = document.querySelectorAll(".countdown-item");
      const countdowns = Array.from(cdItems).map((item) => ({
        title: item.querySelector(".dashboard-cd-title").value.trim(),
        target_date: item.querySelector(".dashboard-cd-date").value,
      }));

      await apiFetch(`/api/dashboard?action=config&lang=${lang}`, {
        method: "PUT",
        body: JSON.stringify({ notifications, countdowns }),
      });
      await loadDashboardConfig();
      alert("Dashboard config saved!");
    } catch (e) {
      alert("Failed to save config: " + e.message);
    }
  };

  function moderationLabel(type) {
    return String(type || "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function renderModerationPayload(request) {
    const payload = request.payload || {};
    if (request.type === "avatar_update") {
      const avatar = escapeHtml(payload.avatarUrl || "");
      return `
        <div class="moderation-preview-row">
          <img class="moderation-avatar-preview" src="${avatar}" alt="Pending avatar" loading="lazy" />
          <div>
            <strong>Profile picture update</strong>
            <p>Crop saved with the upload. Approving makes this avatar public.</p>
          </div>
        </div>`;
    }
    if (request.type === "profile_update") {
      return `<p><strong>New username:</strong> ${escapeHtml(payload.username || "")}</p>`;
    }
    if (request.type === "reader_reaction") {
      return `
        <p><strong>Target:</strong> ${escapeHtml(payload.volumeId || "")}${payload.chapterId ? ` • ${escapeHtml(payload.chapterId)}` : ""}</p>
        <p><strong>Type:</strong> ${escapeHtml(payload.category || "comment")} ${payload.rating ? `• ${escapeHtml(payload.rating)} stars` : ""}</p>
        <p>${escapeHtml(payload.content || "Rating only.")}</p>`;
    }
    if (request.type === "community_post") {
      return `
        <p><strong>${escapeHtml(payload.title || "(untitled)")}</strong> • ${escapeHtml(payload.category || "post")}</p>
        <p>${escapeHtml(payload.content || "")}</p>
        ${payload.imageUrl ? `<p><strong>Image:</strong> ${escapeHtml(payload.imageUrl)}</p>` : ""}`;
    }
    if (request.type === "community_comment") {
      return `<p><strong>Reply:</strong> ${escapeHtml(payload.content || "")}</p>`;
    }
    return `<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
  }

  window.loadModerationQueue = async function loadModerationQueue(status = "pending") {
    const queue = document.getElementById("moderation-queue");
    const statusEl = document.getElementById("moderation-status");
    if (!queue) return;
    queue.innerHTML = '<div class="muted">Loading review queue...</div>';
    try {
      const data = await apiFetch(
        `/api/dashboard?action=moderation&status=${encodeURIComponent(status)}`,
      );
      const requests = Array.isArray(data.requests) ? data.requests : [];
      if (statusEl) {
        statusEl.textContent = `${requests.length} ${status} request${requests.length === 1 ? "" : "s"}`;
      }
      if (!requests.length) {
        queue.innerHTML = '<div class="moderation-empty">Nothing waiting here.</div>';
        return;
      }
      queue.innerHTML = requests
        .map((request) => {
          const user = request.user || {};
          const reviewed = request.status !== "pending";
          return `
            <article class="moderation-item">
              <div class="moderation-item-head">
                <div>
                  <span class="pill-label">${escapeHtml(moderationLabel(request.type))}</span>
                  <h4>${escapeHtml(user.username || "Reader")}</h4>
                  <p>${escapeHtml(user.email || "")} • ${new Date(request.createdAt).toLocaleString()}</p>
                </div>
                <strong class="moderation-status moderation-${escapeHtml(request.status)}">${escapeHtml(request.status)}</strong>
              </div>
              <div class="moderation-payload">${renderModerationPayload(request)}</div>
              ${
                reviewed
                  ? `<p class="muted">Reviewed by ${escapeHtml(request.reviewer || "admin")}${request.reviewNote ? ` • ${escapeHtml(request.reviewNote)}` : ""}</p>`
                  : `<div class="moderation-actions">
                      <input id="moderation-note-${request.id}" class="input-field" maxlength="500" placeholder="Optional review note" />
                      <button class="btn btn-secondary" type="button" onclick="reviewModerationRequest('${request.id}', 'approved')">Approve</button>
                      <button class="ghost-btn danger" type="button" onclick="reviewModerationRequest('${request.id}', 'rejected')">Reject</button>
                    </div>`
              }
            </article>`;
        })
        .join("");
    } catch (error) {
      queue.innerHTML = `<div class="moderation-empty">Review queue unavailable: ${escapeHtml(error.message)}</div>`;
      if (statusEl) statusEl.textContent = "";
    }
  };

  window.reviewModerationRequest = async function reviewModerationRequest(requestId, decision) {
    const note = document.getElementById(`moderation-note-${requestId}`)?.value || "";
    try {
      await apiFetch("/api/dashboard?action=moderation", {
        method: "POST",
        body: JSON.stringify({ requestId, decision, note }),
      });
      await window.loadModerationQueue("pending");
    } catch (error) {
      alert("Could not review request: " + error.message);
    }
  };

  window.clearAllDashboardData = async function () {
    if (
      !confirm(
        "Are you sure you want to completely WIPE ALL announcements, timers, and polls? This cannot be undone.",
      )
    )
      return;
    try {
      await apiFetch(`/api/dashboard?action=clear_all`, { method: "POST" });
      alert("All data wiped successfully.");
      window.location.reload(true);
    } catch (e) {
      alert("Failed to wipe data: " + e.message);
    }
  };

  window.addDashboardAnnouncement = function () {
    const container = document.getElementById("dashboard-announcements-list");
    if (!container) return;
    const div = document.createElement("div");
    div.className = "announcement-item";
    div.style.display = "flex";
    div.style.gap = "8px";
    div.style.marginBottom = "8px";
    div.innerHTML = `
      <textarea class="dashboard-announcement-input" placeholder="New announcement..." style="flex:1; resize:vertical; min-height:72px; padding:8px; font-family:inherit; font-size:inherit;"></textarea>
      <button class="ghost-btn" type="button" onclick="this.parentElement.remove(); saveDashboardConfig();">Remove</button>
    `;
    container.appendChild(div);
  };

  window.addDashboardTimer = function () {
    const container = document.getElementById("dashboard-countdowns-list");
    if (!container) return;
    const div = document.createElement("div");
    div.className = "countdown-item";
    div.style.display = "flex";
    div.style.flexDirection = "column";
    div.style.gap = "8px";
    div.style.marginBottom = "12px";
    div.style.padding = "12px";
    div.style.background = "#2a2a35";
    div.style.borderRadius = "8px";
    div.innerHTML = `
      <input type="text" class="dashboard-cd-title" placeholder="Title..." style="width:100%;" />
      <input type="text" class="dashboard-cd-date" placeholder="Select Date & Time..." style="width:100%; padding:8px;" />
      <button class="ghost-btn" type="button" onclick="this.parentElement.remove(); saveDashboardConfig();" style="align-self:flex-end;">Remove</button>
    `;
    container.appendChild(div);
    if (typeof flatpickr !== "undefined") {
      flatpickr(div.querySelector(".dashboard-cd-date"), {
        enableTime: true,
        dateFormat: "Y-m-d\\TH:i",
        time_24hr: false,
      });
    }
  };

  // Polls Logic
  window.loadPolls = async function loadPolls() {
    try {
      const isJp = window.location.pathname.indexOf("-jp") !== -1;
      const displayLang = isJp ? "ja" : "en";
      const data = await apiFetch(
        `/api/dashboard?action=polls&lang=${displayLang}`,
      );

      const container = document.getElementById("global-polls-container");
      if (!container) return;

      let html = "";
      (data.polls || []).forEach((poll) => {
        let optsHtml = "";
        const totalVotes = poll.options.reduce(
          (sum, o) => sum + parseInt(o.votes || 0),
          0,
        );
        poll.options.forEach((opt) => {
          const votedKey = `voted_poll_${poll.id}`;
          const isVoted = localStorage.getItem(votedKey) === String(opt.id);
          const hasVotedAny = !!localStorage.getItem(votedKey);
          const votesCount = parseInt(opt.votes || 0);
          const percent =
            totalVotes > 0 ? Math.round((votesCount / totalVotes) * 100) : 0;

          optsHtml += `
            <div class="poll-option ${isVoted ? "voted" : ""}" onclick="votePoll('${poll.id}', '${opt.id}')" style="${hasVotedAny ? "cursor:default;" : ""}">
              <div class="poll-bg" style="width: ${hasVotedAny ? percent : 0}%;"></div>
              <span style="position:relative; z-index:1;">${opt.option_text}</span>
              <span class="votes" style="position:relative; z-index:1;">${votesCount} votes ${hasVotedAny ? `(${percent}%)` : ""}</span>
            </div>
          `;
        });
        html += `
          <div class="poll-card" id="poll-${poll.id}">
            <h3><strong>BiniFn:</strong> ${escapeHtml(poll.question)}</h3>
            <div class="poll-options">
              ${optsHtml}
            </div>
          </div>
        `;
      });
      container.innerHTML = html;

      // Populate dashboard active polls if owner
      const dashList = document.getElementById("dashboard-active-polls-list");
      if (dashList) {
        const lang = window.getDashboardLang();
        const ownerData = await apiFetch(
          `/api/dashboard?action=polls&lang=${lang}`,
        );
        let dashHtml = "";
        (ownerData.polls || []).forEach((poll) => {
          dashHtml += `
            <div style="background:#222; padding:10px; margin-bottom:10px; border-radius:4px; border:1px solid #444;">
              <strong>${escapeHtml(poll.question)}</strong>
              <div class="poll-admin-controls">
                <button class="btn-clear" onclick="deletePoll('${poll.id}')">Delete Poll</button>
              </div>
            </div>
          `;
        });
        dashList.innerHTML = dashHtml;
      }
    } catch (e) {
      console.error("[Dashboard] loadPolls failed:", e);
    }
  };

  window.votePoll = async function votePoll(pollId, optionId) {
    const votedKey = `voted_poll_${pollId}`;
    if (localStorage.getItem(votedKey)) return; // Already voted

    try {
      await apiFetch("/api/dashboard?action=polls", {
        method: "POST",
        body: JSON.stringify({ optionId }),
      });
      localStorage.setItem(votedKey, optionId);
      loadPolls();
    } catch (e) {
      console.error("Vote failed", e);
    }
  };

  window.createPoll = async function createPoll() {
    try {
      const lang = window.getDashboardLang();
      const question = document.getElementById("dashboard-poll-question").value;
      const optsNodes = document.querySelectorAll(".dashboard-poll-opt");
      const options = Array.from(optsNodes)
        .map((n) => n.value)
        .filter((v) => v.trim() !== "");

      if (!question || options.length < 2) {
        alert("Please enter a question and at least 2 options.");
        return;
      }

      await apiFetch("/api/dashboard?action=polls", {
        method: "PUT",
        body: JSON.stringify({ question, lang, options }),
      });

      document.getElementById("dashboard-poll-question").value = "";
      optsNodes.forEach((n) => (n.value = ""));
      await loadPolls();
      alert("Poll created!");
    } catch (e) {
      alert("Failed to create poll: " + e.message);
    }
  };

  window.deletePoll = async function deletePoll(pollId) {
    if (!confirm("Are you sure you want to delete this poll?")) return;
    try {
      await apiFetch("/api/dashboard?action=polls", {
        method: "DELETE",
        body: JSON.stringify({ id: pollId }),
      });
      await loadPolls();
      alert("Poll deleted.");
    } catch (e) {
      alert("Failed to delete poll: " + e.message);
    }
  };
  window.loadDashboardArt = async function loadDashboardArt() {
    try {
      const data = await apiFetch("/api/dashboard?action=art");
      const gallery = document.getElementById("dynamic-art-gallery");
      if (!gallery || !data.art) return;

      // Group by character
      const grouped = {};
      data.art.forEach((item) => {
        const char = item.character_name || "Unknown";
        if (!grouped[char]) grouped[char] = [];
        grouped[char].push(item);
      });

      let html = `
        <article class="card app-card">
          <div>
            <strong style="display:block;margin-bottom:10px;font-size:24px;font-family:'Cormorant Garamond',serif;">Character Gallery</strong>
            <p>Official character designs, concept art, and illustrations for the Threadborn cast.</p>
          </div>
        </article>
      `;

      for (const [char, items] of Object.entries(grouped)) {
        html += `
          <article class="card chapter-card">
            <div class="chapter-label">
              <span>${char}</span>
              <span>Art Slot</span>
            </div>
            <strong>${char}</strong>
            <div class="character-gallery" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 16px;">
        `;
        for (const item of items) {
          const deleteBtn =
            authUser && authUser.role === "owner"
              ? `<button onclick="deleteDashboardArt('${item.id}')" style="background:red;color:white;border:none;padding:2px 6px;margin-top:4px;cursor:pointer;">Delete</button>`
              : "";
          html += `
            <div>
              <img src="${item.url}" style="width: 100%; border-radius: 8px; cursor: pointer;" onclick="window.open('${item.url}', '_blank')" />
              ${deleteBtn}
            </div>
          `;
        }
        html += `</div></article>`;
      }
      gallery.innerHTML = html;
    } catch (e) {
      console.error("[Dashboard] loadDashboardArt failed:", e);
    }
  };

  window.uploadDashboardArt = async function uploadDashboardArt() {
    const char = document.getElementById("dashboard-art-char").value;
    const label = document.getElementById("dashboard-art-label").value;
    const fileInput = document.getElementById("dashboard-art-file");
    const status = document.getElementById("dashboard-art-status");

    if (!char || !fileInput.files.length) {
      alert("Character name and file are required.");
      return;
    }
    const file = fileInput.files[0];
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        status.textContent = "Uploading...";
        await apiFetch("/api/dashboard?action=art", {
          method: "POST",
          body: JSON.stringify({
            characterName: char,
            label: label,
            dataUrl: e.target.result,
          }),
        });
        await loadDashboardArt();
        status.textContent = "Upload complete!";
      } catch (error) {
        status.textContent = "Upload failed: " + error.message;
      }
    };
    reader.readAsDataURL(file);
  };

  window.deleteDashboardArt = async function deleteDashboardArt(id) {
    if (!confirm("Delete this art?")) return;
    try {
      await apiFetch("/api/dashboard?action=art", {
        method: "DELETE",
        body: JSON.stringify({ id }),
      });
      await loadDashboardArt();
    } catch (e) {
      alert("Failed to delete art.");
    }
  };

  window.deleteReaction = async function deleteReaction(reactionId) {
    if (!confirm("Delete this comment?")) return;
    try {
      await apiFetch("/api/reader/reactions", {
        method: "DELETE",
        body: JSON.stringify({ reactionId }),
      });
      // Try to remove element from DOM
      const el = document.getElementById(`reaction-${reactionId}`);
      if (el) el.remove();
    } catch (e) {
      alert("Delete failed: " + e.message);
    }
  };

  window.deleteCommunityPost = async function deleteCommunityPost(postId) {
    if (!confirm("Delete this post?")) return;
    try {
      await apiFetch("/api/reader/community", {
        method: "POST",
        body: JSON.stringify({ action: "delete_post", postId }),
      });
      alert("Post deleted.");
      location.reload();
    } catch (e) {
      alert("Delete failed.");
    }
  };

  window.deleteCommunityComment = async function deleteCommunityComment(
    commentId,
  ) {
    if (!confirm("Delete this comment?")) return;
    try {
      await apiFetch("/api/reader/community", {
        method: "POST",
        body: JSON.stringify({ action: "delete_comment", commentId }),
      });
      alert("Comment deleted.");
      location.reload();
    } catch (e) {
      alert("Delete failed.");
    }
  };

  window.addEventListener("load", async () => {
    monkeyPatchReaderHooks();
    await hydrateAuth();
    await hydrateServerProgress();
    loadDashboardConfig();
    loadDashboardArt();
    startBackgroundSync();
  });

  // Re-fetch dashboard config (announcements, countdowns) whenever the tab
  // becomes visible again — this ensures the banner never requires a hard
  // refresh to appear, even if the user had the tab open on an old SW.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadDashboardConfig();
    }
  });

  // ═══════════════════════════════════════════════════════
  //  SEARCH
  // ═══════════════════════════════════════════════════════
  let searchScope = "all";

  window.setSearchScope = function (scope, btn) {
    searchScope = scope;
    document
      .querySelectorAll(".search-filters .filter-chip")
      .forEach((b) => b.classList.remove("active"));
    if (btn) btn.classList.add("active");
    const q = document.getElementById("global-search-input")?.value || "";
    if (q.trim().length >= 2) window.handleSearch(q);
  };

  window.handleSearch = function (query) {
    const el = document.getElementById("search-results");
    if (!el) return;
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      el.innerHTML = "";
      return;
    }

    const results = { chapters: [], characters: [], powers: [], lore: [] };

    if (
      window.chapters &&
      (searchScope === "all" || searchScope === "chapters")
    ) {
      window.chapters.forEach((ch, i) => {
        if (
          (ch.title + ch.summary + ch.volume + ch.chapter)
            .toLowerCase()
            .includes(q)
        ) {
          results.chapters.push({
            icon: "📖",
            title: `${ch.volume} · ${ch.chapter}`,
            subtitle: ch.title,
            meta: ch.summary,
            action: () => openChapter(i),
          });
        }
      });
    }
    if (
      window.characters &&
      (searchScope === "all" || searchScope === "characters")
    ) {
      window.characters.forEach((c) => {
        if (
          (c.name + c.bio + c.role + (c.chips || []).join(" "))
            .toLowerCase()
            .includes(q)
        ) {
          results.characters.push({
            icon: "👤",
            title: c.name,
            subtitle: c.role,
            meta: c.bio,
            action: () => {
              switchView("characters");
            },
          });
        }
      });
    }
    if (window.powers && (searchScope === "all" || searchScope === "powers")) {
      window.powers.forEach((p) => {
        if ((p.name + p.text).toLowerCase().includes(q)) {
          results.powers.push({
            icon: "⚡",
            title: p.name,
            subtitle: "Power",
            meta: p.text,
            action: () => switchView("powers"),
          });
        }
      });
    }
    if (
      window.loreEntries &&
      (searchScope === "all" || searchScope === "lore")
    ) {
      window.loreEntries.forEach((l) => {
        if ((l.title + l.text).toLowerCase().includes(q)) {
          results.lore.push({
            icon: "📜",
            title: l.title,
            subtitle: "Lore Entry",
            meta: l.text,
            action: () => switchView("lore"),
          });
        }
      });
    }

    const total = Object.values(results).flat().length;
    if (!total) {
      el.innerHTML = `<div class="search-empty">No results for "${escapeHtml(query)}"</div>`;
      return;
    }

    const renderGroup = (label, items) =>
      items.length
        ? `
      <div class="search-result-group">
        <h3>${label} (${items.length})</h3>
        ${items
          .map(
            (item) => `
          <div class="search-result-item" onclick="(${item.action.toString()})()">
            <div class="search-result-icon">${item.icon}</div>
            <div>
              <div class="search-result-title">${escapeHtml(item.title)}</div>
              <div class="search-result-meta">${escapeHtml(item.subtitle)} · ${escapeHtml((item.meta || "").slice(0, 120))}…</div>
            </div>
          </div>`,
          )
          .join("")}
      </div>`
        : "";

    el.innerHTML =
      renderGroup("Chapters", results.chapters) +
      renderGroup("Characters", results.characters) +
      renderGroup("Powers", results.powers) +
      renderGroup("Lore", results.lore);
  };

  // ═══════════════════════════════════════════════════════
  //  CHAPTER TAG FILTER
  // ═══════════════════════════════════════════════════════
  window.filterChaptersByTag = function (tag) {
    document
      .querySelectorAll("#chapter-tag-filters .filter-chip")
      .forEach((b) => {
        b.classList.toggle(
          "active",
          b.textContent.trim().toLowerCase() === tag.toLowerCase() ||
            (tag === "all" && b.textContent.trim() === "All"),
        );
      });
    if (typeof window.renderChapters === "function") {
      if (tag === "all") {
        window.renderChapters();
        return;
      }
      const filtered = (window.chapters || []).filter(
        (ch) =>
          (ch.tags || []).some((t) =>
            t.toLowerCase().includes(tag.toLowerCase()),
          ) || ch.volume.toLowerCase().includes(tag.toLowerCase()),
      );
      const grid = document.getElementById("chapters-grid");
      if (!grid) return;
      if (!filtered.length) {
        grid.innerHTML = `<p style="color:var(--mist)">No chapters match this filter.</p>`;
        return;
      }
      grid.innerHTML = filtered
        .map((ch, i) => {
          const idx = (window.chapters || []).indexOf(ch);
          return `<article class="card chapter-card" onclick="openChapter(${idx})">
          <div class="chapter-label"><span>${ch.volume}</span><span>${ch.chapter}</span></div>
          <strong>${escapeHtml(ch.title)}</strong>
          <p style="color:var(--mist);font-size:13px;margin:8px 0 0;">${escapeHtml(ch.summary || "")}</p>
          <div class="meta"><span>${(ch.tags || []).join(", ")}</span><span>Read →</span></div>
        </article>`;
        })
        .join("");
    }
  };

  // ═══════════════════════════════════════════════════════
  //  TIMELINE
  // ═══════════════════════════════════════════════════════
  window.renderTimeline = function () {
    const el = document.getElementById("timeline-content");
    if (!el || el.dataset.rendered === "1") return;
    el.dataset.rendered = "1";
    const chs = window.chapters || [];
    const volumes = [...new Set(chs.map((c) => c.volume))];
    let html = "";
    volumes.forEach((vol) => {
      html += `<h3 class="timeline-vol-header">📚 ${escapeHtml(vol)}</h3><div class="timeline">`;
      chs
        .filter((c) => c.volume === vol)
        .forEach((ch, i) => {
          html += `<div class="timeline-item">
          <div class="timeline-vol-label">${escapeHtml(ch.chapter)}</div>
          <h4>${escapeHtml(ch.title)}</h4>
          <p>${escapeHtml(ch.summary || "")}</p>
        </div>`;
        });
      html += "</div>";
    });
    el.innerHTML = html;
  };

  // ═══════════════════════════════════════════════════════
  //  LORE CODEX
  // ═══════════════════════════════════════════════════════
  // Keep the Codex page as an empty placeholder until public, author-approved
  // material is released through the manuscript archive.

  let codexCategory = "all";

  window.renderCodex = function () {
    window.filterCodex("");
  };

  window.setCodexCategory = function (cat, btn) {
    codexCategory = cat;
    document
      .querySelectorAll("#codex-category-filters .filter-chip")
      .forEach((b) => b.classList.remove("active"));
    if (btn) btn.classList.add("active");
    window.filterCodex(
      document.getElementById("codex-search-input")?.value || "",
    );
  };

  window.filterCodex = function (query) {
    const grid = document.getElementById("codex-grid");
    if (!grid) return;
    grid.innerHTML = `<p style="color:var(--mist)">Nothing recovered yet.</p>`;
  };

  window.openCodexDetail = function (entry) {
    const overlay = document.getElementById("codex-detail-overlay");
    const content = document.getElementById("codex-detail-content");
    if (!overlay || !content) return;
    content.innerHTML = `
      <div class="codex-card-tag" style="margin-bottom:8px;">${entry.category}</div>
      <h2 style="font-family:'Cormorant Garamond',serif;font-size:28px;margin:0 0 16px;">${entry.icon} ${escapeHtml(entry.title)}</h2>
      <p style="color:var(--mist);line-height:1.8;">${escapeHtml(entry.text)}</p>`;
    overlay.style.display = "flex";
  };

  window.closeCodexDetail = function (event) {
    const overlay = document.getElementById("codex-detail-overlay");
    const panel = document.getElementById("codex-detail-panel");
    if (!overlay) return;
    if (!event || !panel.contains(event.target) || event.target === overlay) {
      overlay.style.display = "none";
    }
  };

  // ═══════════════════════════════════════════════════════
  //  READING STATS + BADGES
  // ═══════════════════════════════════════════════════════
  window.loadReadingStats = async function () {
    const statsGrid = document.getElementById("stats-grid");
    const badgesGrid = document.getElementById("badges-grid");
    const streakNum = document.getElementById("streak-num");
    const streakSub = document.getElementById("streak-label-sub");

    try {
      const [analyticsData, bookmarksData, badgesData] =
        await Promise.allSettled([
          apiFetch("/api/reader/analytics"),
          apiFetch("/api/reader/bookmarks?novelId=threadborn"),
          apiFetch("/api/reader/analytics?action=badges"),
        ]);

      const volumes =
        analyticsData.status === "fulfilled"
          ? analyticsData.value.volumes || []
          : [];
      const bookmarks =
        bookmarksData.status === "fulfilled"
          ? bookmarksData.value.bookmarks || []
          : [];
      const badgeData =
        badgesData.status === "fulfilled" ? badgesData.value : null;

      const totalTime = volumes.reduce((s, v) => s + (v.total_time || 0), 0);
      const mins = Math.floor(totalTime / 60);
      const chaptersRead = volumes.length;

      if (statsGrid) {
        statsGrid.innerHTML = `
          <div class="stat-card"><div class="stat-value">${mins}</div><div class="stat-label">Minutes Read</div></div>
          <div class="stat-card"><div class="stat-value">${volumes.length}</div><div class="stat-label">Volumes Touched</div></div>
          <div class="stat-card"><div class="stat-value">${bookmarks.length}</div><div class="stat-label">Bookmarks</div></div>
          <div class="stat-card"><div class="stat-value">${badgeData ? badgeData.badges.filter((b) => b.earned).length : "—"}</div><div class="stat-label">Badges Earned</div></div>`;
      }

      if (badgeData) {
        if (streakNum)
          streakNum.textContent = badgeData.streak.current_streak || 0;
        if (streakSub)
          streakSub.textContent = `Longest: ${badgeData.streak.longest_streak || 0} days · ${badgeData.streak.total_days_read || 0} total`;

        if (badgesGrid) {
          badgesGrid.innerHTML = badgeData.badges
            .map(
              (b) => `
            <div class="badge-card ${b.earned ? "earned" : "locked"}">
              <div class="badge-icon">${b.icon}</div>
              <div class="badge-label">${escapeHtml(b.label)}</div>
              <div class="badge-desc">${escapeHtml(b.desc)}</div>
            </div>`,
            )
            .join("");
        }
      }

      // Recommendations
      const recEl = document.getElementById("stats-recommendations");
      if (recEl && volumes.length) {
        const chs = window.chapters || [];
        const nextVol = volumes.find((v) => v.volume_id === "Volume 2")
          ? "EX Novel Vol 1"
          : "Volume 2";
        const rec = chs.filter((c) => c.volume === nextVol)[0];
        if (rec) {
          const idx = chs.indexOf(rec);
          recEl.innerHTML = `
            <h3 style="font-family:'Cormorant Garamond',serif;font-size:22px;margin:0 0 16px;">Next Up For You</h3>
            <div class="rec-card" onclick="openChapter(${idx})">
              <span style="font-size:28px;">📖</span>
              <div>
                <div class="rec-reason">RECOMMENDED NEXT</div>
                <strong>${escapeHtml(rec.title)}</strong>
                <p style="margin:4px 0 0;font-size:13px;color:var(--mist);">${escapeHtml(rec.summary || "")}</p>
              </div>
            </div>`;
        }
      }
    } catch (e) {
      if (statsGrid)
        statsGrid.innerHTML = `<p style="color:var(--mist)">Log in to see your reading stats.</p>`;
    }
  };

  // ═══════════════════════════════════════════════════════
  //  SPOILER TOGGLE
  // ═══════════════════════════════════════════════════════
  const SPOILER_KEY = "threadborn_spoilers_revealed";

  function applySpoilerState() {
    const revealed = localStorage.getItem(SPOILER_KEY) === "1";
    document.querySelectorAll(".spoiler-toggle").forEach((btn) => {
      btn.classList.toggle("on", revealed);
      btn.setAttribute("aria-pressed", String(revealed));
    });
    document
      .querySelectorAll("#view-leaks .power-card, #view-leaks .spoiler-note")
      .forEach((el) => {
        el.classList.add("spoiler-hidden");
      });
    document
      .querySelectorAll(".spoiler-body, .spoiler-hidden")
      .forEach((el) => {
        el.classList.toggle("revealed", revealed);
      });
  }

  window.toggleSpoilerReveal = function () {
    const current = localStorage.getItem(SPOILER_KEY) === "1";
    localStorage.setItem(SPOILER_KEY, current ? "0" : "1");
    applySpoilerState();
  };

  // ═══════════════════════════════════════════════════════
  //  FEEDBACK
  // ═══════════════════════════════════════════════════════
  let feedbackType = "suggestion";

  window.openFeedbackModal = function () {
    const overlay = document.getElementById("feedback-modal-overlay");
    if (overlay) overlay.style.display = "flex";
  };

  window.closeFeedbackModal = function (event) {
    const overlay = document.getElementById("feedback-modal-overlay");
    const modal = overlay?.querySelector(".feedback-modal");
    if (!overlay) return;
    if (!event || !modal?.contains(event.target) || event.target === overlay) {
      overlay.style.display = "none";
    }
  };

  window.setFeedbackType = function (btn) {
    feedbackType = btn.dataset.type || "other";
    document
      .querySelectorAll(".feedback-type-btn")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  };

  window.submitFeedback = async function () {
    const statusEl = document.getElementById("feedback-status");
    const textEl = document.getElementById("feedback-text");
    const message = (textEl?.value || "").trim();
    if (!message || message.length < 5) {
      if (statusEl)
        statusEl.textContent = "Please write at least 5 characters.";
      return;
    }
    try {
      if (statusEl) statusEl.textContent = "Sending…";
      await apiFetch("/api/user/profile?action=feedback", {
        method: "POST",
        body: JSON.stringify({
          type: feedbackType,
          message,
          page: window.location.pathname,
        }),
      });
      if (statusEl) statusEl.textContent = "✓ Thank you for your feedback!";
      if (textEl) textEl.value = "";
      setTimeout(() => window.closeFeedbackModal(), 1800);
    } catch (e) {
      if (statusEl) statusEl.textContent = "Could not send — please try again.";
    }
  };

  // ═══════════════════════════════════════════════════════
  //  FOLLOW SYSTEM
  // ═══════════════════════════════════════════════════════
  let followsCache = new Set();

  window.loadFollows = async function () {
    try {
      const data = await apiFetch("/api/reader/bookmarks?action=follows");
      followsCache = new Set(
        (data.follows || []).map((f) => `${f.follow_type}:${f.follow_key}`),
      );
      document
        .querySelectorAll(".follow-btn[data-follow-type]")
        .forEach((btn) => {
          const key = `${btn.dataset.followType}:${btn.dataset.followKey}`;
          btn.classList.toggle("following", followsCache.has(key));
          btn.textContent = followsCache.has(key) ? "✓ Following" : "+ Follow";
        });
    } catch (e) {
      /* not logged in */
    }
  };

  window.toggleFollow = async function (type, key, btn) {
    const cacheKey = `${type}:${key}`;
    const isFollowing = followsCache.has(cacheKey);
    try {
      if (isFollowing) {
        await apiFetch("/api/reader/bookmarks?action=follows", {
          method: "DELETE",
          body: JSON.stringify({ follow_type: type, follow_key: key }),
        });
        followsCache.delete(cacheKey);
      } else {
        await apiFetch("/api/reader/bookmarks?action=follows", {
          method: "POST",
          body: JSON.stringify({ follow_type: type, follow_key: key }),
        });
        followsCache.add(cacheKey);
      }
      if (btn) {
        btn.classList.toggle("following", !isFollowing);
        btn.textContent = !isFollowing ? "✓ Following" : "+ Follow";
      }
    } catch (e) {
      console.error("Follow failed:", e);
    }
  };

  // ═══════════════════════════════════════════════════════
  //  NOTIFICATIONS — delegated to assets/notifications.js
  // ═══════════════════════════════════════════════════════
  // notifications.js is loaded before this script and exposes window.TB_Notif.
  // The shims below keep backwards-compat for any inline onclick handlers.
  window.loadNotifications      = function () { window.TB_Notif?.loadServerNotifications(); };
  window.toggleNotifPanel       = function () { window.TB_Notif?.toggleNotifPanel(); };
  window.markNotifRead          = function (id) { window.TB_Notif?.markRead(id); };
  window.requestPushPermission  = function () { window.TB_Notif?.requestPushPermission(); };
  window.disablePushNotifications = function () { window.TB_Notif?.disablePushNotifications(); };

  // Record chapter read for badge/streak then ping notifications module
  const _origOpen = window.openChapter;
  if (typeof _origOpen === "function") {
    window.openChapter = function (index, page) {
      _origOpen.call(this, index, page);
      if (authUser) {
        let activities = ["chapter_read"];
        if (typeof chapters !== "undefined" && chapters[index]) {
          const chap = chapters[index];
          if (chap.volume && chap.volume.includes("1") && chap.chapter && chap.chapter.includes("15")) activities.push("volume1_complete");
          if (chap.volume && chap.volume.includes("2") && chap.chapter && chap.chapter.includes("1")) activities.push("volume2_started");
          if (chap.volume && chap.volume.includes("EX")) activities.push("ex_read");
          if (index === chapters.length - 1) activities.push("all_volumes");
        }
        activities.forEach(act => {
          apiFetch("/api/reader/analytics?action=badges", {
            method: "POST",
            body: JSON.stringify({ activity: act }),
          }).catch(() => {});
        });
      }
      // Re-check content counts so notifications.js detects chapter progress
      window.TB_Notif?.pollContent();
    };
  }

  // Close notification panel when clicking outside
  document.addEventListener("click", (e) => {
    const panel = document.getElementById("notif-panel");
    const bell  = document.getElementById("notif-bell");
    if (panel && bell && !bell.contains(e.target) && !panel.contains(e.target)) {
      panel.style.display = "none";
    }
  });

  // ═══════════════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════════════
  const _originalLoad = window.addEventListener;
  document.addEventListener("visibilitychange", () => {
    applySpoilerState();
  });

  window.addEventListener("load", () => {
    applySpoilerState();
    if (authUser) {
      loadFollows();
    }

    // Background service worker update check — runs every 10 minutes
    if ("serviceWorker" in navigator) {
      setInterval(
        () => {
          navigator.serviceWorker.getRegistration().then((reg) => {
            if (reg) reg.update();
          });
        },
        10 * 60 * 1000,
      );

      // Register periodic background sync if supported
      navigator.serviceWorker.ready.then((reg) => {
        if ("periodicSync" in reg) {
          reg.periodicSync
            .register("sw-update-check", { minInterval: 10 * 60 * 1000 })
            .catch(() => {});
        }
      });
    }
  });
})();
