(function () {
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  const lang = document.documentElement.lang;
  const html = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const privacyButton = document.querySelector("[data-role='privacy-toggle']");
  const editTagsButton = document.querySelector("[data-role='details-edit-tags']");
  const toggleAutoSwitchLockButton = document.querySelector("[data-role='details-toggle-auto-switch-lock']");

  function resolveDashboardTheme() {
    const themePreference = html.dataset.themePreference || "auto";
    if (themePreference === "dark" || themePreference === "light") {
      return themePreference;
    }
    if (
      document.body.classList.contains("vscode-light") ||
      html.classList.contains("vscode-light")
    ) {
      return "light";
    }
    if (
      document.body.classList.contains("vscode-dark") ||
      document.body.classList.contains("vscode-high-contrast") ||
      html.classList.contains("vscode-dark") ||
      html.classList.contains("vscode-high-contrast")
    ) {
      return "dark";
    }
    return media.matches ? "light" : "dark";
  }

  function applyResolvedTheme() {
    html.dataset.theme = resolveDashboardTheme();
  }

  applyResolvedTheme();
  media.addEventListener("change", applyResolvedTheme);
  const themeObserver = new MutationObserver(applyResolvedTheme);
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  themeObserver.observe(html, { attributes: true, attributeFilter: ["class"] });

  function applyPrivacyMode(hidden) {
    document.body.classList.toggle("privacy-hidden", hidden);
    document.querySelectorAll("[data-private-project]").forEach(option => {
      option.textContent = hidden ? `••• (${option.value})` : option.dataset.privateProject;
    });

    if (!privacyButton) {
      return;
    }

    const nextLabel = hidden ? privacyButton.dataset.showLabel : privacyButton.dataset.hideLabel;
    if (!nextLabel) {
      return;
    }

    privacyButton.setAttribute("aria-pressed", String(hidden));
    privacyButton.setAttribute("aria-label", nextLabel);
    privacyButton.setAttribute("title", nextLabel);
  }

  function formatRelativeTime(epochSeconds) {
    if (!epochSeconds) {
      return isChinese() ? "重置时间未知" : "reset unknown";
    }

    const diffSeconds = epochSeconds - Math.floor(Date.now() / 1000);
    if (diffSeconds <= 0) {
      return isChinese() ? "已重置" : "reset";
    }

    const totalMinutes = Math.floor(diffSeconds / 60);
    if (totalMinutes <= 0) {
      return isChinese() ? "不到1分钟" : "<1m left";
    }

    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const minutes = totalMinutes % 60;
    const parts = [];

    if (days > 0) {
      parts.push(formatDurationPart(days, "d"));
    }
    if (hours > 0) {
      parts.push(formatDurationPart(hours, "h"));
    }
    if (minutes > 0) {
      parts.push(formatDurationPart(minutes, "m"));
    }

    return isChinese() ? parts.join(" ") : parts.join(" ") + " left";
  }

  function formatDurationPart(value, unit) {
    if (lang === "zh-hant") {
      return value + ({ d: "天", h: "小時", m: "分鐘" }[unit] || "");
    }
    if (lang === "zh") {
      return value + ({ d: "天", h: "小时", m: "分钟" }[unit] || "");
    }
    return value + unit;
  }

  function isChinese() {
    return lang === "zh" || lang === "zh-hant";
  }

  function updateLiveTimes() {
    document.querySelectorAll(".live-reset").forEach((node) => {
      const value = Number(node.dataset.resetAt);
      const fallback = node.dataset.resetUnknown || (isChinese() ? "重置时间未知" : "reset unknown");
      node.textContent = value ? formatRelativeTime(value) : fallback;
    });
    document.querySelectorAll(".live-timestamp").forEach((node) => {
      const value = Number(node.dataset.epochMs);
      const fallback = node.dataset.never || (isChinese() ? "从未" : "never");
      node.textContent = value ? new Date(value).toLocaleString() : fallback;
    });
  }

  updateLiveTimes();
  applyPrivacyMode(document.body.dataset.privacyHidden === "true");

  if (privacyButton) {
    privacyButton.addEventListener("click", () => {
      const hidden = !document.body.classList.contains("privacy-hidden");
      applyPrivacyMode(hidden);
    });
  }

  if (editTagsButton && vscode) {
    editTagsButton.addEventListener("click", () => {
      vscode.postMessage({ type: "details:edit-tags" });
    });
  }

  if (toggleAutoSwitchLockButton && vscode) {
    toggleAutoSwitchLockButton.addEventListener("click", () => {
      vscode.postMessage({ type: "details:toggle-auto-switch-lock" });
    });
  }

  const quotaRows = [...document.querySelectorAll("[data-quota-week]")];
  if (quotaRows.length) {
    const rangeButtons = [...document.querySelectorAll("[data-quota-range]")];
    const previous = document.querySelector("[data-quota-previous]");
    const next = document.querySelector("[data-quota-next]");
    let range = "30";
    let page = 0;
    function showQuotaPage() {
      const matching = quotaRows.filter(row => range === "30" || row.dataset.quotaWeek === "true");
      const visible = new Set(matching.slice(page * 12, (page + 1) * 12));
      quotaRows.forEach(row => { row.hidden = !visible.has(row); });
      rangeButtons.forEach(button => button.setAttribute("aria-pressed", String(button.dataset.quotaRange === range)));
      document.querySelectorAll("[data-quota-totals]").forEach(node => { node.hidden = node.dataset.quotaTotals !== range; });
      document.querySelector("[data-quota-empty]").hidden = matching.length > 0;
      const pages = Math.ceil(matching.length / 12);
      document.querySelector("[data-quota-page]").textContent = pages ? `${page + 1} / ${pages}` : "";
      previous.disabled = page === 0;
      next.disabled = page + 1 >= pages;
    }
    rangeButtons.forEach(button => button.addEventListener("click", () => {
      range = button.dataset.quotaRange;
      page = 0;
      showQuotaPage();
    }));
    previous.addEventListener("click", () => { page -= 1; showQuotaPage(); });
    next.addEventListener("click", () => { page += 1; showQuotaPage(); });
  }

  const localLoad = document.querySelector("[data-local-session-load]");
  if (localLoad && vscode) {
    localLoad.addEventListener("click", () => vscode.postMessage({ type: "details:load-local-sessions" }));
  }
  const localData = document.querySelector("[data-local-session-data]");
  if (localData) {
    const rows = JSON.parse(localData.value);
    const project = document.querySelector("[data-local-session-project]");
    const model = document.querySelector("[data-local-session-model]");
    const previous = document.querySelector("[data-local-session-previous]");
    const next = document.querySelector("[data-local-session-next]");
    const format = new Intl.NumberFormat(lang);
    function fillOptions(select, key) {
      const values = [...new Set(rows.map(row => row[key]))].sort();
      values.forEach((label, index) => {
        const option = new Option(label || "—", String(index));
        if (key === "project" && label) option.dataset.privateProject = label;
        select.add(option);
      });
      return values;
    }
    const projects = fillOptions(project, "project");
    const models = fillOptions(model, "model");
    applyPrivacyMode(document.body.classList.contains("privacy-hidden"));
    let page = 0;
    function showSessionPage() {
      const matching = rows.filter(row => (project.value === "*" || row.project === projects[Number(project.value)]) &&
        (model.value === "*" || row.model === models[Number(model.value)]));
      const tokens = matching.reduce((total, row) => total + row.input + row.output, 0);
      const body = document.querySelector("[data-local-session-rows]");
      body.replaceChildren();
      matching.slice(page * 20, (page + 1) * 20).forEach(row => {
        const tr = body.insertRow();
        tr.insertCell().textContent = new Date(row.timestamp).toLocaleString(lang);
        tr.insertCell().textContent = row.model || "—";
        const projectCell = tr.insertCell();
        const raw = document.createElement("span");
        raw.className = "privacy-sensitive-raw";
        raw.textContent = row.project || "—";
        const masked = document.createElement("span");
        masked.className = "privacy-sensitive-masked";
        masked.textContent = row.project ? "•••" : "—";
        projectCell.append(raw, masked);
        tr.insertCell().textContent = format.format(row.input + row.output);
      });
      document.querySelector("[data-local-session-totals]").textContent = `${format.format(tokens)} Token`;
      const pages = Math.ceil(matching.length / 20);
      document.querySelector("[data-local-session-page]").textContent = pages ? `${page + 1} / ${pages}` : "";
      previous.disabled = page === 0;
      next.disabled = page + 1 >= pages;
    }
    [project, model].forEach(select => select.addEventListener("change", () => { page = 0; showSessionPage(); }));
    previous.addEventListener("click", () => { page -= 1; showSessionPage(); });
    next.addEventListener("click", () => { page += 1; showSessionPage(); });
    showSessionPage();
  }

  setInterval(updateLiveTimes, 60000);
})();
