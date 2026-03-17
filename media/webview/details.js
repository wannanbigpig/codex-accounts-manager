(function () {
  const lang = document.documentElement.lang;

  function formatRelativeTime(epochSeconds) {
    if (!epochSeconds) {
      return lang === "zh" ? "重置时间未知" : "reset unknown";
    }

    const deltaMs = epochSeconds * 1000 - Date.now();
    const abs = Math.abs(deltaMs);
    const minutes = Math.round(abs / 60000);
    const future = deltaMs >= 0;

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

  function updateLiveTimes() {
    document.querySelectorAll(".live-reset").forEach((node) => {
      const value = Number(node.dataset.resetAt);
      const fallback = node.dataset.resetUnknown || (lang === "zh" ? "重置时间未知" : "reset unknown");
      node.textContent = value ? formatRelativeTime(value) : fallback;
    });
    document.querySelectorAll(".live-timestamp").forEach((node) => {
      const value = Number(node.dataset.epochMs);
      const fallback = node.dataset.never || (lang === "zh" ? "从未" : "never");
      node.textContent = value ? new Date(value).toLocaleString() : fallback;
    });
  }

  updateLiveTimes();
  setInterval(updateLiveTimes, 60000);
})();
