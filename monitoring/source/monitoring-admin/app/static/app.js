(function () {
  "use strict";

  const API = "/admin/api/v1";
  const gatewayMode = () => document.querySelector('meta[name="auth-mode"]')?.content === "gateway";
  let portalCsrf = "";

  async function initPortalSession() {
    if (!gatewayMode()) return true;
    const response = await fetch("/api/v1/session", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Не удалось проверить сессию Платформы");
    const session = await response.json();
    if (!session.authenticated) { window.location.assign("/"); return false; }
    if (session.user?.admin !== true) throw new Error("Нет доступа к управлению мониторингом");
    if (!session.csrf_token) throw new Error("Сессия Платформы не содержит CSRF token");
    portalCsrf = session.csrf_token;
    async function logoutFromPlatform() {
      try {
        const result = await fetch("/auth/logout", { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": portalCsrf } });
        if (!result.ok && result.status !== 401) throw new Error("Не удалось завершить сессию");
        portalCsrf = "";
        window.location.assign("/");
      } catch (error) { toast(error.message, "error"); }
    }
    window.plMonitoringPlatformLogout = logoutFromPlatform;
    window.plMonitoringShell?.setLogoutDisabled(false);
    byId("logout-form")?.addEventListener("submit", (event) => { event.preventDefault(); void logoutFromPlatform(); });
    return true;
  }
  const state = {
    containers: [], selectedId: null, restartId: null, operations: [],
    logRequestSequence: 0, logController: null, logError: false,
    loadedSections: new Set(), failedSections: new Set(), pendingSections: new Map()
  };
  const byId = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const icon = (name) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="${name === "delivery" ? "m22 2-7 20-4-9-9-4Zm0 0L11 13" : "M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5"}"/></svg>`;

  function initTheme() {
    if (document.querySelector('.pl-ui-shell')) return;
    if (window.PLTheme?.version === 1) {
      const button = byId("theme-toggle");
      if (button) window.PLTheme.mountMenu(button);
      return;
    }
    const sync = () => syncThemeIcons(document.documentElement.dataset.theme === "light");
    sync();
    window.addEventListener("pl-ui-theme-change", sync);
    byId("theme-toggle")?.addEventListener("click", () => {
      window.PLTheme.set(window.PLTheme.get() === "light" ? "dark" : "light");
    });
  }

  function syncThemeIcons(light) {
    document.querySelector(".icon-sun")?.toggleAttribute("hidden", light);
    document.querySelector(".icon-moon")?.toggleAttribute("hidden", !light);
    const label = light ? "Переключить на тёмную тему" : "Переключить на светлую тему";
    byId("theme-toggle")?.setAttribute("aria-label", label);
    byId("theme-toggle")?.setAttribute("title", label);
  }

  function setMobileMenu(open) {
    document.querySelector(".app-shell")?.classList.toggle("mobile-nav-open", open);
    byId("mobile-menu-toggle")?.setAttribute("aria-expanded", String(open));
    const close = byId("mobile-menu-close");
    if (close) close.hidden = !open;
    if (!open) byId("mobile-menu-toggle")?.focus({ preventScroll: true });
  }

  function initShell() {
    const shell = document.querySelector(".app-shell");
    if (shell?.dataset.plUi === '1') return;
    const collapse = byId("sidebar-collapse");
    const applyCollapsed = (collapsed) => {
      shell?.classList.toggle("sidebar-collapsed", collapsed);
      collapse?.setAttribute("aria-expanded", String(!collapsed));
      collapse?.setAttribute("aria-label", collapsed ? "Развернуть меню" : "Свернуть меню");
      window.requestAnimationFrame(syncContainerDetailHeight);
    };
    applyCollapsed(localStorage.getItem("monitoring-sidebar-collapsed") === "true");
    collapse?.addEventListener("click", () => {
      const collapsed = !shell?.classList.contains("sidebar-collapsed");
      localStorage.setItem("monitoring-sidebar-collapsed", String(collapsed));
      applyCollapsed(collapsed);
    });
    byId("mobile-menu-toggle")?.addEventListener("click", () => setMobileMenu(!shell?.classList.contains("mobile-nav-open")));
    byId("mobile-menu-close")?.addEventListener("click", () => setMobileMenu(false));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && shell?.classList.contains("mobile-nav-open")) setMobileMenu(false);
    });
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    const csrf = gatewayMode() ? portalCsrf : document.querySelector('meta[name="csrf-token"]')?.content;
    if (csrf && options.method && options.method !== "GET") headers.set("X-CSRF-Token", csrf);
    const response = await fetch(`${API}${path}`, { credentials: "same-origin", ...options, headers });
    if (response.status === 401) { window.location.assign(gatewayMode() ? "/" : "/admin/login"); throw new Error("Требуется вход"); }
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) throw new Error(payload?.detail || payload?.message || `HTTP ${response.status}`);
    return payload;
  }

  function listFrom(payload, ...keys) {
    if (Array.isArray(payload)) return payload;
    for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
    return [];
  }

  function statusClass(value) {
    const text = String(value ?? "").toLowerCase();
    if (["fail", "error", "down", "unhealthy", "dead"].some((v) => text.includes(v))) return "error";
    if (["ok", "up", "running", "healthy", "success", "succeeded", "completed", "sent", "delivered", "pass", "passed"].includes(text)) return "success";
    if (["warn", "starting", "pending", "retry", "queued", "unknown"].some((v) => text.includes(v))) return "warning";
    return "neutral";
  }

  function stateClass(container) {
    const health = String(effectiveHealth(container)).toLowerCase();
    const runtime = String(container.state ?? container.status ?? "").toLowerCase();
    if (health.includes("unhealthy") || runtime.includes("exited") || runtime.includes("dead") || runtime.includes("down")) return "state-down";
    if (health.includes("healthy")) return "state-healthy";
    if (runtime.includes("running") || runtime === "up") return "state-up";
    return "state-warning";
  }

  function runtimeLabel(container) {
    const runtime = container.state ?? container.status ?? "Неизвестно";
    const health = effectiveHealth(container);
    return health && String(health).toLowerCase() !== "none" ? `${runtime} · ${health}` : String(runtime);
  }

  function uptimeLabel(container) {
    if (container.uptime_human ?? container.uptime ?? container.running_for) return container.uptime_human ?? container.uptime ?? container.running_for;
    if (Number.isFinite(Number(container.uptime_seconds))) return formatUptime(Number(container.uptime_seconds));
    return container.started_at ?? "—";
  }

  function serviceId(container) { return String(container.service_id ?? container.id ?? container.name ?? ""); }
  function serviceName(container) { return container.display_name ?? container.name ?? container.service_id ?? "Контейнер"; }
  function effectiveHealth(container) {
    const dockerHealth = container.health_status ?? container.health;
    if (dockerHealth && !["none", "not_configured", "unknown"].includes(String(dockerHealth).toLowerCase())) return dockerHealth;
    const applicationHealth = container.application_health?.status;
    if (applicationHealth && applicationHealth !== "not_configured") return applicationHealth;
    return container.readiness ?? dockerHealth ?? "Не задан";
  }

  function syncContainerDetailHeight() {
    const list = byId("container-list");
    const detail = byId("container-detail");
    if (!list || !detail) return;
    if (!window.matchMedia("(min-width: 1081px)").matches) {
      detail.style.removeProperty("height");
      return;
    }
    detail.style.height = `${Math.round(list.getBoundingClientRect().height)}px`;
  }

  async function loadOverview() {
    const data = await api("/overview");
    const summary = data.summary || data;
    const services = listFrom(data, "services", "containers", "items");
    const running = services.filter((item) => item.running === true || String(item.status).toLowerCase() === "running").length;
    const healthy = services.filter((item) => ["healthy", "running"].includes(String(effectiveHealth(item)).toLowerCase())).length;
    const attention = services.filter((item) => ["unavailable", "unhealthy", "exited", "dead", "failed"].some((word) => `${item.status} ${effectiveHealth(item)} ${item.readiness}`.toLowerCase().includes(word))).length;
    setText("summary-running", summary.running ?? summary.containers_running ?? (services.length ? running : "—"));
    setText("summary-healthy", summary.healthy ?? summary.containers_healthy ?? (services.length ? healthy : "—"));
    setText("summary-attention", summary.attention ?? summary.unhealthy ?? summary.requires_attention ?? (services.length ? attention : "—"));
    const delivery = summary.last_delivery ?? data.last_delivery;
    if (delivery && typeof delivery === "object") {
      setText("summary-delivery", delivery.status_label ?? delivery.status ?? "—");
      setText("summary-delivery-meta", delivery.sent_at ?? delivery.created_at ?? delivery.type ?? "Telegram");
    } else if (delivery) setText("summary-delivery", delivery);
    setText("last-refresh", `Обновлено ${new Date().toLocaleTimeString("ru-RU", {hour:"2-digit", minute:"2-digit"})}`);
  }

  async function loadContainers(preserveSelection = true) {
    const data = await api("/containers");
    state.containers = listFrom(data, "containers", "items", "services");
    const list = byId("container-list");
    if (!list) return;
    const focused = document.activeElement;
    const focusedContainer = focused?.dataset.containerId;
    const focusedDetailId = byId("container-detail")?.contains(focused) ? focused.id : null;
    if (state.selectedId && !state.containers.some((item) => serviceId(item) === state.selectedId)) {
      state.logController?.abort();
      state.logRequestSequence += 1;
      state.logController = null;
      state.selectedId = null;
      state.restartId = null;
      state.logError = false;
      byId("restart-dialog")?.close();
      byId("container-detail").innerHTML = '<div class="empty-detail"><strong>Выберите контейнер</strong><p>Ранее выбранный контейнер больше не доступен в списке.</p></div>';
    }
    if (!state.containers.length) {
      list.innerHTML = '<div class="empty-state">Контейнеры не найдены.</div>';
      setText("containers-updated", "0 сервисов · обновлено сейчас");
      syncContainerDetailHeight();
      return;
    }
    list.innerHTML = state.containers.map((container) => {
      const id = serviceId(container), active = preserveSelection && id === state.selectedId;
      return `<button class="container-row ${stateClass(container)}${active ? " active" : ""}" type="button" aria-pressed="${active}" data-container-id="${escapeHtml(id)}">
        <span class="status-dot" aria-hidden="true"></span>
        <span class="container-copy"><strong>${escapeHtml(serviceName(container))}</strong><small>${escapeHtml(container.image ?? container.container_name ?? id)}</small></span>
        <span class="container-state"><strong>${escapeHtml(runtimeLabel(container))}</strong><small>${escapeHtml(uptimeLabel(container))}</small></span>
      </button>`;
    }).join("");
    list.querySelectorAll("[data-container-id]").forEach((button) => button.addEventListener("click", () => selectContainer(button.dataset.containerId)));
    setText("containers-updated", `${state.containers.length} сервисов · обновлено сейчас`);
    syncContainerDetailHeight();
    if (preserveSelection && state.selectedId) {
      const selected = state.containers.find((item) => serviceId(item) === state.selectedId);
      if (selected) {
        const output = byId("container-log-output");
        renderContainerDetail(selected, {
          loading: Boolean(state.logController),
          logText: output?.textContent || "",
          logScrollTop: output?.scrollTop || 0
        });
      }
    }
    if (!byId("restart-dialog")?.open) {
      if (focusedContainer) Array.from(list.querySelectorAll("[data-container-id]")).find((row) => row.dataset.containerId === focusedContainer)?.focus({ preventScroll: true });
      else if (focusedDetailId) byId(focusedDetailId)?.focus({ preventScroll: true });
    }
  }

  async function selectContainer(id) {
    state.selectedId = id;
    state.logError = false;
    document.querySelectorAll("[data-container-id]").forEach((row) => {
      const active = row.dataset.containerId === id;
      row.classList.toggle("active", active);
      row.setAttribute("aria-pressed", String(active));
    });
    const container = state.containers.find((item) => serviceId(item) === id);
    if (!container) return;
    renderContainerDetail(container, { loading: true });
    await loadContainerLogs(id);
  }

  async function loadContainerLogs(id) {
    state.logController?.abort();
    const controller = new AbortController();
    const sequence = ++state.logRequestSequence;
    let timedOut = false;
    state.logController = controller;
    state.logError = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    try {
      const logs = await api(`/containers/${encodeURIComponent(id)}/logs?tail=50`, { signal: controller.signal });
      if (sequence !== state.logRequestSequence || id !== state.selectedId) return;
      const content = Array.isArray(logs?.lines) ? logs.lines.join("\n") : (logs?.logs ?? logs?.content ?? logs);
      const output = byId("container-log-output");
      if (output) { output.textContent = content || "Лог пуст."; output.scrollTop = output.scrollHeight; }
    } catch (error) {
      if (sequence !== state.logRequestSequence || id !== state.selectedId) return;
      state.logError = true;
      const output = byId("container-log-output");
      if (output) output.textContent = timedOut ? "Не удалось загрузить лог: превышено время ожидания." : `Не удалось загрузить лог: ${error.message}`;
      const retry = byId("log-retry");
      if (retry) retry.hidden = false;
    } finally {
      window.clearTimeout(timeout);
      if (sequence === state.logRequestSequence) state.logController = null;
    }
  }

  function renderContainerDetail(container, options = {}) {
    const detail = byId("container-detail");
    if (!detail) return;
    const id = serviceId(container);
    const loadingLogs = Boolean(options.loading);
    const logText = loadingLogs ? "Загружаю лог…" : (options.logText || "");
    const allowed = container.restartable !== false && container.restart_allowed !== false && container.actions?.restart !== false;
    detail.className = `container-detail panel ${stateClass(container)}`;
    detail.innerHTML = `<div class="detail-head">
      <div class="detail-title"><span class="status-dot" aria-hidden="true"></span><div><h3>${escapeHtml(serviceName(container))}</h3><p>${escapeHtml(container.container_name ?? id)}</p></div></div>
      <button class="button button-danger" id="restart-button" type="button" ${allowed ? "" : "disabled"}>${icon("restart")}Перезапустить</button>
    </div>
    <div class="detail-metrics">
      <div class="detail-metric"><span>Runtime</span><strong>${escapeHtml(container.state ?? container.status ?? "—")}</strong></div>
      <div class="detail-metric"><span>Health</span><strong>${escapeHtml(effectiveHealth(container))}</strong></div>
      <div class="detail-metric"><span>Uptime</span><strong>${escapeHtml(uptimeLabel(container))}</strong></div>
    </div>
    <div class="log-head"><h3>Последние строки</h3><span>tail · 50</span><button class="log-retry" id="log-retry" type="button" ${state.logError ? "" : "hidden"}>Повторить</button></div>
    <pre class="log-output" id="container-log-output" tabindex="0">${escapeHtml(logText)}</pre>`;
    syncContainerDetailHeight();
    const output = byId("container-log-output");
    if (output && Number.isFinite(options.logScrollTop)) output.scrollTop = options.logScrollTop;
    byId("log-retry")?.addEventListener("click", () => {
      const retry = byId("log-retry");
      if (retry) retry.hidden = true;
      if (output) output.textContent = "Загружаю лог…";
      loadContainerLogs(id);
    });
    if (allowed) byId("restart-button")?.addEventListener("click", () => openRestartDialog(container));
  }

  function openRestartDialog(container) {
    state.restartId = serviceId(container);
    setText("restart-container-name", serviceName(container));
    byId("restart-dialog")?.showModal();
  }

  async function restartSelected() {
    const id = state.restartId;
    if (!id) return;
    const button = byId("restart-confirm");
    button.disabled = true; button.textContent = "Запускаю…";
    showProgress("Перезапускаю контейнер…");
    try {
      const idempotencyKey = (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const result = await api(`/containers/${encodeURIComponent(id)}/restart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotency_key: idempotencyKey })
      });
      const jobId = result.job_id ?? result.id;
      byId("restart-dialog")?.close();
      addOperation({ id: jobId, service_id: id, status: "running", operation: "restart", created_at: new Date().toISOString() });
      toast("Перезапуск принят в работу.");
      if (jobId) await pollJob(jobId);
      else await refreshAll();
    } catch (error) { toast(`Не удалось запустить перезапуск: ${error.message}`, "error"); }
    finally { hideProgress(); button.disabled = false; button.textContent = "Перезапустить"; }
  }

  async function pollJob(jobId) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const job = await api(`/jobs/${encodeURIComponent(jobId)}`);
      addOperation(job, true);
      const status = String(job.status ?? "").toLowerCase();
      if (["success", "succeeded", "completed", "failed", "error"].includes(status)) {
        toast(statusClass(status) === "success" ? "Контейнер перезапущен и проверен." : `Операция завершилась ошибкой: ${job.error_message || job.error || "см. результат"}`, statusClass(status));
        await Promise.all([refreshSection("overview"), refreshSection("containers"), refreshSection("diagnostics")]);
        if (state.selectedId) await selectContainer(state.selectedId);
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    toast("Операция выполняется дольше ожидаемого. Статус сохранён в истории.", "warning");
  }

  async function loadDiagnostics() {
    const payload = await api("/diagnostics");
    const checks = listFrom(payload, "checks", "items", "diagnostics");
    const target = byId("diagnostics-list"); if (!target) return;
    target.innerHTML = checks.length ? checks.map((check) => {
      const status = check.status ?? check.result ?? "unknown";
      return `<div class="check-row check-${statusClass(status) === "success" ? "ok" : statusClass(status)}"><span class="status-dot" aria-hidden="true"></span><span class="check-copy"><strong>${escapeHtml(check.name ?? check.title ?? check.label ?? "Проверка")}</strong><small>${escapeHtml(check.message ?? check.detail ?? check.description ?? check.error ?? "")}</small></span><span class="check-label">${escapeHtml(check.status_label ?? status)}</span></div>`;
    }).join("") : '<div class="empty-state">Диагностические проверки не возвращены.</div>';
  }

  async function loadDeliveries() {
    const payload = await api("/deliveries");
    const rows = listFrom(payload, "deliveries", "items", "history");
    setText("telegram-count", `${rows.length} последних`);
    if (rows.length) {
      const latest = rows[0];
      setText("summary-delivery", latest.status === "sent" ? "Доставлено" : (latest.status ?? "—"));
      setText("summary-delivery-meta", `${latest.report_type ?? "Telegram"} · ${formatDate(latest.sent_at ?? latest.created_at)}`);
    }
    const target = byId("telegram-list"); if (!target) return;
    target.innerHTML = rows.length ? rows.slice(0, 8).map((item) => {
      const status = item.status ?? item.result ?? item.outcome ?? "unknown";
      const detail = item.last_error || item.message || item.filename || item.detail || `${item.attempt_count ?? 1} попытка`;
      return `<div class="delivery-row"><span class="delivery-icon" aria-hidden="true">${icon("delivery")}</span><span class="delivery-copy"><strong>${escapeHtml(item.title ?? item.report_type ?? item.kind ?? "Telegram")}</strong><small>${escapeHtml(detail)}</small></span><time><span class="status-badge status-${statusClass(status)}">${escapeHtml(status)}</span> ${escapeHtml(formatDate(item.sent_at ?? item.created_at ?? item.timestamp))}</time></div>`;
    }).join("") : '<div class="empty-state">История доставки пока пуста.</div>';
  }

  async function loadAudit() {
    const payload = await api("/audit");
    const rows = listFrom(payload, "events", "items", "audit");
    state.operations = rows.slice(0, 10);
    renderOperations();
  }

  function addOperation(job, replace = false) {
    const id = job.id ?? job.job_id;
    const index = state.operations.findIndex((item) => (item.id ?? item.job_id) === id && id);
    if (index >= 0 && replace) state.operations[index] = job;
    else if (index < 0) state.operations.unshift(job);
    state.operations = state.operations.slice(0, 10); renderOperations();
  }

  function renderOperations() {
    const target = byId("operations-list"); if (!target) return;
    target.innerHTML = state.operations.length ? state.operations.map((item) => {
      const status = item.status ?? item.result ?? item.outcome ?? "unknown";
      return `<div class="operation-row"><span class="operation-icon" aria-hidden="true">${icon("restart")}</span><span class="operation-copy"><strong>${escapeHtml(item.operation ?? item.action ?? item.event_type ?? "Операция")} · ${escapeHtml(item.service_id ?? item.target ?? "")}</strong><small>${escapeHtml(item.message ?? item.error_message ?? item.error ?? item.detail ?? status)}</small></span><time><span class="status-badge status-${statusClass(status)}">${escapeHtml(status)}</span> ${escapeHtml(formatDate(item.finished_at ?? item.created_at ?? item.timestamp))}</time></div>`;
    }).join("") : '<div class="empty-state">Операций в этой сессии пока нет.</div>';
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value); if (Number.isNaN(date.valueOf())) return String(value);
    return date.toLocaleString("ru-RU", {day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit"});
  }
  function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60);
    if (days) return `${days}д ${hours}ч`;
    if (hours) return `${hours}ч ${minutes}м`;
    return `${minutes}м`;
  }
  function setText(id, value) { const node = byId(id); if (node) node.textContent = value ?? "—"; }
  function showProgress(label) { setText("page-progress-label", label); const p = byId("page-progress"); p?.classList.add("is-active"); p?.setAttribute("aria-hidden", "false"); }
  function hideProgress() { const p = byId("page-progress"); p?.classList.remove("is-active"); p?.setAttribute("aria-hidden", "true"); }
  function toast(message, type = "success") { const node = document.createElement("div"); node.className = `toast ${type}`; node.textContent = message; byId("toast-region")?.append(node); window.setTimeout(() => node.remove(), 5200); }

  const sectionLoaders = { overview: loadOverview, containers: loadContainers, diagnostics: loadDiagnostics, telegram: loadDeliveries, operations: loadAudit };
  const sectionTargets = { containers: "container-list", diagnostics: "diagnostics-list", telegram: "telegram-list", operations: "operations-list" };
  function refreshSection(id) {
    if (state.pendingSections.has(id)) return state.pendingSections.get(id);
    const task = (async () => {
      const view = byId(id);
      view?.setAttribute("aria-busy", "true");
      try {
        await sectionLoaders[id]();
        state.loadedSections.add(id);
        state.failedSections.delete(id);
        byId(`${id}-load-error`)?.remove();
        view?.removeAttribute("data-stale");
        return true;
      } catch (error) {
        state.failedSections.add(id);
        const stale = state.loadedSections.has(id);
        view?.setAttribute("data-stale", String(stale));
        if (!stale && sectionTargets[id]) byId(sectionTargets[id]).innerHTML = '<div class="empty-state">Данные недоступны.</div>';
        let notice = byId(`${id}-load-error`);
        if (!notice && view) {
          notice = document.createElement("div");
          notice.id = `${id}-load-error`;
          notice.className = "notice notice-error section-load-error";
          notice.setAttribute("role", "status");
          view.prepend(notice);
        }
        if (notice) {
          notice.replaceChildren();
          const message = document.createElement("span");
          message.textContent = `${stale ? "Не удалось обновить данные. Показано последнее успешное состояние." : "Не удалось загрузить данные."} ${error.message}`;
          const retry = document.createElement("button");
          retry.type = "button";
          retry.className = window.PLUI?.buttonClasses ? window.PLUI.buttonClasses({variant:"secondary"}) : "button button-secondary";
          retry.textContent = "Повторить";
          retry.addEventListener("click", () => refreshSection(id));
          notice.append(message, retry);
        }
        return false;
      } finally {
        view?.setAttribute("aria-busy", "false");
        state.pendingSections.delete(id);
        const available = state.failedSections.size === 0;
        document.querySelector(".live-dot")?.classList.toggle("is-up", available);
        setText("sidebar-status", available ? "Backend доступен" : "Данные обновлены не полностью");
      }
    })();
    state.pendingSections.set(id, task);
    return task;
  }

  async function refreshAll() {
    showProgress("Обновляю состояние…");
    const results = await Promise.all(Object.keys(sectionLoaders).map(refreshSection));
    const failures = results.filter((success) => !success);
    if (failures.length) toast(`Не удалось обновить ${failures.length} раздел(а).`, "error");
    hideProgress();
  }

  function initNavigation() {
    const links = document.querySelectorAll("[data-section-link]");
    const views = document.querySelectorAll("[data-view]");
    const allowed = new Set(Array.from(views, (view) => view.dataset.view));
    const activate = () => {
      const requested = location.hash.slice(1) || "overview";
      const id = allowed.has(requested) ? requested : "overview";
      if (requested !== id) history.replaceState(null, "", "#overview");
      links.forEach((link) => {
        const active = link.dataset.sectionLink === id;
        link.classList.toggle("active", active);
        if (active) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
      views.forEach((view) => { view.hidden = view.dataset.view !== id; });
      if (document.querySelector(".app-shell")?.classList.contains("mobile-nav-open")) setMobileMenu(false);
      window.requestAnimationFrame(() => {
        window.scrollTo(0, 0);
        if (id === "containers") syncContainerDetailHeight();
      });
    };
    links.forEach((link) => link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      const hash = `#${link.dataset.sectionLink}`;
      if (location.hash !== hash) history.pushState(null, "", hash);
      activate();
    }));
    window.addEventListener("hashchange", activate);
    window.addEventListener("popstate", activate);
    activate();
  }

  document.addEventListener("DOMContentLoaded", async () => {
    initTheme();
    initShell();
    document.querySelectorAll("[data-year]").forEach((node) => { node.textContent = new Date().getFullYear(); });
    if (!byId("container-list")) return;
    initNavigation();
    try { if (!await initPortalSession()) return; }
    catch (error) { setText("sidebar-status", "Нет подключения"); toast(error.message, "error"); return; }
    const containerList = byId("container-list");
    if (window.ResizeObserver && containerList) new ResizeObserver(syncContainerDetailHeight).observe(containerList);
    window.addEventListener("resize", syncContainerDetailHeight);
    syncContainerDetailHeight();
    byId("refresh-button")?.addEventListener("click", refreshAll);
    byId("diagnostics-refresh")?.addEventListener("click", async () => { showProgress("Запускаю диагностику…"); try { if (await refreshSection("diagnostics")) toast("Диагностика обновлена."); } finally { hideProgress(); } });
    byId("restart-confirm")?.addEventListener("click", restartSelected);
    byId("restart-dialog")?.addEventListener("close", () => {
      const target = document.querySelector("#restart-button:not(:disabled)") || byId("container-list")?.querySelector("button") || document.querySelector('.admin-view:not([hidden]) h1');
      target?.focus({ preventScroll: true });
    });
    refreshAll();
    window.setInterval(() => Promise.all(["overview", "containers", "telegram"].map(refreshSection)), 30000);
  });
})();
