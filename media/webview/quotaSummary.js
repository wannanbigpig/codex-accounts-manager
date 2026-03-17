(function () {
  const vscode = acquireVsCodeApi();
  const state = vscode.getState() || { settingsOpen: false, settingsScrollTop: 0 };
  const settingsState = readInitialSettingsState();
  let autoRefreshLastEnabledMinutes = settingsState.autoRefreshMinutes > 0 ? settingsState.autoRefreshMinutes : 15;

  function getSettingsBody() {
    return document.getElementById("settingsBody");
  }

  function getStateRoot() {
    return document.getElementById("quotaSummaryState");
  }

  function readInitialSettingsState() {
    const node = getStateRoot();
    const dataset = node?.dataset || {};
    return {
      codexAppRestartMode: dataset.codexAppRestartMode === "auto" ? "auto" : "manual",
      autoRefreshMinutes: Number(dataset.autoRefreshMinutes || 15),
      codexAppPath: dataset.codexAppPath || "",
      showCodeReviewQuota: dataset.showCodeReviewQuota === "true",
      quotaWarningEnabled: dataset.quotaWarningEnabled === "true",
      quotaWarningThreshold: Number(dataset.quotaWarningThreshold || 20),
      quotaGreenThreshold: Number(dataset.quotaGreenThreshold || 60),
      quotaYellowThreshold: Number(dataset.quotaYellowThreshold || 20),
      debugNetwork: dataset.debugNetwork === "true",
      displayLanguage: dataset.displayLanguage || "auto",
      appPathEmpty: dataset.appPathEmpty || "",
      colorThresholdRedNoteTemplate: dataset.thresholdRedNoteTemplate || "",
      colorThresholdYellowDescTemplate: dataset.thresholdYellowDescTemplate || "",
      colorThresholdGreenDescTemplate: dataset.thresholdGreenDescTemplate || ""
    };
  }

  function persistSettingsState() {
    const body = getSettingsBody();
    state.settingsScrollTop = body?.scrollTop ?? 0;
    vscode.setState(state);
  }

  function restoreSettingsState() {
    if (!state.settingsOpen) {
      return;
    }
    document.getElementById("settingsOverlay")?.classList.add("open");
    requestAnimationFrame(() => {
      const body = getSettingsBody();
      if (body) {
        body.scrollTop = state.settingsScrollTop || 0;
      }
    });
  }

  function post(type, value, accountId) {
    const message = { type };
    if (value !== undefined) {
      message.value = value;
    }
    if (accountId !== undefined) {
      message.accountId = accountId;
    }
    vscode.postMessage(message);
  }

  function updateText(id, value) {
    const node = document.getElementById(id);
    if (node) {
      node.textContent = value;
    }
  }

  function applyCopyState(copy) {
    if (!copy) {
      return;
    }

    if (copy.appPathEmpty) {
      settingsState.appPathEmpty = copy.appPathEmpty;
    }
    if (copy.colorThresholdRedNoteTemplate) {
      settingsState.colorThresholdRedNoteTemplate = copy.colorThresholdRedNoteTemplate;
    }
    if (copy.colorThresholdYellowDescTemplate) {
      settingsState.colorThresholdYellowDescTemplate = copy.colorThresholdYellowDescTemplate;
    }
    if (copy.colorThresholdGreenDescTemplate) {
      settingsState.colorThresholdGreenDescTemplate = copy.colorThresholdGreenDescTemplate;
    }

    const stateRoot = getStateRoot();
    if (stateRoot) {
      stateRoot.dataset.appPathEmpty = settingsState.appPathEmpty;
      stateRoot.dataset.thresholdRedNoteTemplate = settingsState.colorThresholdRedNoteTemplate;
      stateRoot.dataset.thresholdYellowDescTemplate = settingsState.colorThresholdYellowDescTemplate;
      stateRoot.dataset.thresholdGreenDescTemplate = settingsState.colorThresholdGreenDescTemplate;
    }
  }

  function formatTemplate(template, value) {
    return (template || "").replace("{value}", String(value));
  }

  function readQuotaPercent(rawValue) {
    if (rawValue === undefined || rawValue === "") {
      return undefined;
    }

    const numericValue = Number(rawValue);
    return Number.isFinite(numericValue) ? numericValue : undefined;
  }

  function resolveQuotaColor(value) {
    if (typeof value !== "number") {
      return "#7ddc7a";
    }
    if (value >= settingsState.quotaGreenThreshold) {
      return "#7ddc7a";
    }
    if (value >= settingsState.quotaYellowThreshold) {
      return "#fbbf24";
    }
    return "#ef4444";
  }

  function applyQuotaColors() {
    document.querySelectorAll("[data-quota-percent]").forEach((node) => {
      const colorVar = node.dataset.quotaColorVar || "--metric-color";
      node.style.setProperty(colorVar, resolveQuotaColor(readQuotaPercent(node.dataset.quotaPercent)));
    });
  }

  function setBooleanSegmentState(fnName, value) {
    document
      .querySelector(`button[onclick="${fnName}(true)"]`)
      ?.classList.toggle("active", value === true);
    document
      .querySelector(`button[onclick="${fnName}(false)"]`)
      ?.classList.toggle("active", value === false);
  }

  function setNumberSegmentState(fnName, value) {
    document.querySelectorAll(`button[onclick^="${fnName}("]`).forEach((node) => {
      node.classList.toggle("active", node.getAttribute("onclick") === `${fnName}(${value})`);
    });
  }

  function toggleBlockVisibility(id, visible) {
    document.getElementById(id)?.classList.toggle("is-hidden", !visible);
  }

  function toggleReviewMetrics(visible) {
    document.querySelectorAll(".review-metric").forEach((node) => {
      node.classList.toggle("is-hidden", !visible);
    });
  }

  function applyRestartModeState() {
    document.getElementById("restartMode-auto")?.classList.toggle("active", settingsState.codexAppRestartMode === "auto");
    document.getElementById("restartMode-manual")?.classList.toggle("active", settingsState.codexAppRestartMode === "manual");
  }

  function applyAutoRefreshState() {
    const enabled = settingsState.autoRefreshMinutes > 0;
    if (enabled) {
      autoRefreshLastEnabledMinutes = settingsState.autoRefreshMinutes;
    }
    setBooleanSegmentState("toggleAutoRefresh", enabled);
    toggleBlockVisibility("autoRefreshValues", enabled);
    setNumberSegmentState("updateAutoRefresh", settingsState.autoRefreshMinutes);
  }

  function applyCodeReviewVisibility() {
    setBooleanSegmentState("toggleCodeReview", settingsState.showCodeReviewQuota);
    toggleReviewMetrics(settingsState.showCodeReviewQuota);
  }

  function applyWarningState() {
    setBooleanSegmentState("toggleQuotaWarning", settingsState.quotaWarningEnabled);
    toggleBlockVisibility("quotaWarningValues", settingsState.quotaWarningEnabled);
    setNumberSegmentState("updateWarningThreshold", settingsState.quotaWarningThreshold);
  }

  function applyAppPathState() {
    const note = document.getElementById("codexAppPathNote");
    if (note) {
      note.dataset.emptyText = settingsState.appPathEmpty;
      note.textContent = settingsState.codexAppPath || settingsState.appPathEmpty;
    }

    const clearButton = document.getElementById("clearCodexAppPathButton");
    if (clearButton) {
      clearButton.disabled = !settingsState.codexAppPath;
    }
  }

  function applyDebugState() {
    setBooleanSegmentState("toggleDebugNetwork", settingsState.debugNetwork);
  }

  function applyDisplayLanguageState() {
    const select = document.getElementById("displayLanguageSelect");
    if (select) {
      select.value = settingsState.displayLanguage;
    }
  }

  function applyThresholdState() {
    const yellow = settingsState.quotaYellowThreshold;
    const green = settingsState.quotaGreenThreshold;
    const yellowRange = document.getElementById("quotaYellowRange");
    const greenRange = document.getElementById("quotaGreenRange");
    const redFill = document.getElementById("quotaThresholdFillRed");
    const yellowFill = document.getElementById("quotaThresholdFillYellow");
    const greenFill = document.getElementById("quotaThresholdFillGreen");
    const yellowBubble = document.getElementById("quotaYellowBubble");
    const greenBubble = document.getElementById("quotaGreenBubble");

    if (yellowRange) {
      yellowRange.value = String(yellow);
    }
    if (greenRange) {
      greenRange.value = String(green);
    }

    updateText("quotaYellowThresholdValue", yellow + "%");
    updateText("quotaGreenThresholdValue", green + "%");
    updateText("quotaYellowBubble", yellow + "%");
    updateText("quotaGreenBubble", green + "%");
    updateText("quotaRedThresholdNote", formatTemplate(settingsState.colorThresholdRedNoteTemplate, yellow));
    updateText("quotaYellowThresholdCopy", formatTemplate(settingsState.colorThresholdYellowDescTemplate, yellow));
    updateText("quotaGreenThresholdCopy", formatTemplate(settingsState.colorThresholdGreenDescTemplate, green));

    if (redFill) {
      redFill.style.width = yellow + "%";
    }
    if (yellowFill) {
      yellowFill.style.left = yellow + "%";
      yellowFill.style.width = Math.max(0, green - yellow) + "%";
    }
    if (greenFill) {
      greenFill.style.left = green + "%";
      greenFill.style.right = "0";
    }
    if (yellowBubble) {
      yellowBubble.style.left = yellow + "%";
    }
    if (greenBubble) {
      greenBubble.style.left = green + "%";
    }
  }

  function applySettingsState() {
    applyDisplayLanguageState();
    applyRestartModeState();
    applyAutoRefreshState();
    applyCodeReviewVisibility();
    applyWarningState();
    applyThresholdState();
    applyQuotaColors();
    applyAppPathState();
    applyDebugState();
  }

  function applyContentState(content) {
    const primary = document.getElementById("primarySectionContent");
    const savedSection = document.getElementById("savedAccountsSection");
    const savedContent = document.getElementById("savedAccountsContent");

    if (primary && typeof content.primaryHtml === "string") {
      primary.innerHTML = content.primaryHtml;
    }

    if (savedContent && typeof content.savedHtml === "string") {
      savedContent.innerHTML = content.savedHtml;
    }

    if (savedSection) {
      savedSection.classList.toggle("is-hidden", !content.showSavedSection);
    }

    applyCodeReviewVisibility();
    applyQuotaColors();
    updateLiveTimeLabels();
  }

  function applyLanguageState(message) {
    if (!message || !message.language) {
      return;
    }

    document.documentElement.lang = message.language.lang || document.documentElement.lang;
    updateText("brandSubText", message.language.brandSub || "");
    updateText("settingsModalTitle", message.language.settingsTitle || "");

    const settingsButton = document.getElementById("settingsOpenButton");
    if (settingsButton && message.language.settingsTitle) {
      settingsButton.title = message.language.settingsTitle;
      settingsButton.setAttribute("aria-label", message.language.settingsTitle);
    }

    const refreshButton = document.getElementById("refreshViewButton");
    if (refreshButton && message.language.refreshPage) {
      refreshButton.title = message.language.refreshPage;
      refreshButton.setAttribute("aria-label", message.language.refreshPage);
    }

    const settingsBody = getSettingsBody();
    if (settingsBody && typeof message.language.settingsBodyHtml === "string") {
      const scrollTop = state.settingsScrollTop || settingsBody.scrollTop || 0;
      settingsBody.innerHTML = message.language.settingsBodyHtml;
      requestAnimationFrame(() => {
        settingsBody.scrollTop = scrollTop;
      });
    }

    Object.assign(settingsState, message.settings || {});
    applyCopyState(message.copy);
    applyContentState(message.content || {});
    applySettingsState();
    restoreSettingsState();
  }

  function formatRelativeTime(epochSeconds) {
    if (!epochSeconds) {
      return document.documentElement.lang === "zh" ? "重置时间未知" : "reset unknown";
    }

    const deltaMs = epochSeconds * 1000 - Date.now();
    const abs = Math.abs(deltaMs);
    const minutes = Math.round(abs / 60000);
    const future = deltaMs >= 0;
    const lang = document.documentElement.lang;

    if (minutes < 60) {
      return lang === "zh"
        ? future ? "剩余" + minutes + "分钟" : minutes + "分钟前"
        : future ? minutes + "m left" : minutes + "m ago";
    }

    const hours = Math.round(minutes / 60);
    if (hours < 48) {
      return lang === "zh"
        ? future ? "剩余" + hours + "小时" : hours + "小时前"
        : future ? hours + "h left" : hours + "h ago";
    }

    const days = Math.round(hours / 24);
    return lang === "zh"
      ? future ? "剩余" + days + "天" : days + "天前"
      : future ? days + "d left" : days + "d ago";
  }

  function formatResetClock(epochSeconds) {
    const target = new Date(epochSeconds * 1000);
    const mm = String(target.getMonth() + 1).padStart(2, "0");
    const dd = String(target.getDate()).padStart(2, "0");
    const hh = String(target.getHours()).padStart(2, "0");
    const min = String(target.getMinutes()).padStart(2, "0");
    return mm + "/" + dd + " " + hh + ":" + min;
  }

  function updateLiveTimeLabels() {
    document.querySelectorAll(".live-reset").forEach((node) => {
      const value = Number(node.dataset.resetAt);
      const fallback = node.dataset.resetUnknown || (document.documentElement.lang === "zh" ? "重置时间未知" : "reset unknown");
      node.textContent = value ? formatRelativeTime(value) + " (" + formatResetClock(value) + ")" : fallback;
    });
    document.querySelectorAll(".live-timestamp").forEach((node) => {
      const value = Number(node.dataset.epochMs);
      const fallback = node.dataset.never || (document.documentElement.lang === "zh" ? "从未" : "never");
      node.textContent = value ? new Date(value).toLocaleString() : fallback;
    });
  }

  window.send = function (type, accountId) {
    post(type, undefined, accountId);
  };

  window.openSettings = function () {
    state.settingsOpen = true;
    persistSettingsState();
    restoreSettingsState();
  };

  window.closeSettings = function (event) {
    if (event) {
      event.stopPropagation();
    }
    state.settingsOpen = false;
    persistSettingsState();
    document.getElementById("settingsOverlay")?.classList.remove("open");
  };

  window.updateRestartMode = function (value) {
    persistSettingsState();
    settingsState.codexAppRestartMode = value;
    applyRestartModeState();
    post("updateCodexAppRestartMode", value);
  };

  window.updateAutoRefresh = function (value) {
    persistSettingsState();
    settingsState.autoRefreshMinutes = Number(value);
    applyAutoRefreshState();
    post("updateAutoRefreshMinutes", settingsState.autoRefreshMinutes);
  };

  window.toggleAutoRefresh = function (enabled) {
    persistSettingsState();
    settingsState.autoRefreshMinutes = enabled ? autoRefreshLastEnabledMinutes : 0;
    applyAutoRefreshState();
    post("updateAutoRefreshMinutes", settingsState.autoRefreshMinutes);
  };

  window.toggleCodeReview = function (value) {
    persistSettingsState();
    settingsState.showCodeReviewQuota = value;
    applyCodeReviewVisibility();
    post("updateShowCodeReviewQuota", value);
  };

  window.toggleQuotaWarning = function (value) {
    persistSettingsState();
    settingsState.quotaWarningEnabled = value;
    applyWarningState();
    post("updateQuotaWarningEnabled", value);
  };

  window.updateWarningThreshold = function (value) {
    persistSettingsState();
    settingsState.quotaWarningThreshold = Number(value);
    applyWarningState();
    post("updateQuotaWarningThreshold", settingsState.quotaWarningThreshold);
  };

  window.previewQuotaThreshold = function (kind, value) {
    const numericValue = Number(value);

    if (kind === "yellow") {
      settingsState.quotaYellowThreshold = Math.min(numericValue, settingsState.quotaGreenThreshold - 10);
    } else {
      settingsState.quotaGreenThreshold = Math.max(numericValue, settingsState.quotaYellowThreshold + 10);
    }

    applyThresholdState();
    applyQuotaColors();
  };

  window.commitQuotaThreshold = function (kind, value) {
    window.previewQuotaThreshold(kind, value);
    persistSettingsState();
    post("updateQuotaYellowThreshold", settingsState.quotaYellowThreshold);
    post("updateQuotaGreenThreshold", settingsState.quotaGreenThreshold);
    window.hideQuotaThresholdBubble(kind);
  };

  window.showQuotaThresholdBubble = function (kind) {
    document.getElementById(kind === "yellow" ? "quotaYellowBubble" : "quotaGreenBubble")?.classList.add("is-visible");
  };

  window.hideQuotaThresholdBubble = function (kind) {
    document.getElementById(kind === "yellow" ? "quotaYellowBubble" : "quotaGreenBubble")?.classList.remove("is-visible");
  };

  window.toggleDebugNetwork = function (value) {
    persistSettingsState();
    settingsState.debugNetwork = value;
    applyDebugState();
    post("updateDebugNetwork", value);
  };

  window.pickCodexAppPath = function () {
    persistSettingsState();
    post("pickCodexAppPath");
  };

  window.clearCodexAppPath = function () {
    persistSettingsState();
    settingsState.codexAppPath = "";
    applyAppPathState();
    post("clearCodexAppPath");
  };

  window.updateDisplayLanguage = function (value) {
    persistSettingsState();
    settingsState.displayLanguage = value;
    applyDisplayLanguageState();
    post("updateDisplayLanguage", value);
  };

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message) {
      return;
    }

    if (message.type === "settingsUpdated") {
      Object.assign(settingsState, message.settings || {});
      applyCopyState(message.copy);
      applySettingsState();
      return;
    }

    if (message.type === "languageUpdated") {
      applyLanguageState(message);
      return;
    }

    if (message.type === "contentUpdated" && message.content) {
      applyContentState(message.content);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.settingsOpen) {
      window.closeSettings();
    }
  });

  getSettingsBody()?.addEventListener("scroll", persistSettingsState, { passive: true });
  applySettingsState();
  updateLiveTimeLabels();
  setInterval(updateLiveTimeLabels, 60000);
  restoreSettingsState();
})();
