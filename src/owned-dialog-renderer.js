window.ownedDialog.ready((options, themeId) => {
  window.MarkalooDialogs.applyTheme(themeId);
  const buttons = options.buttons.map((label, index) => ({
    id: String(index), label,
    style: index === options.cancelId ? "secondary" : "primary",
  }));
  let answer;
  const observer = new MutationObserver(() => {
    if (!document.querySelector("dialog[open]")) return;
    observer.disconnect();
    window.ownedDialog.displayed();
  });
  observer.observe(document.body, { attributes: true, childList: true, subtree: true });
  try {
    answer = window.MarkalooDialogs.show({
      title: options.title, message: options.message, detail: options.detail,
      buttons, defaultId: String(options.defaultId), cancelId: String(options.cancelId),
    });
  } catch {
    observer.disconnect();
    window.ownedDialog.failed();
    return;
  }
  answer.then(result => {
    observer.disconnect();
    const response = buttons.findIndex(button => button.id === result?.choice);
    if (response < 0 || !["choice", "cancel", "stale", "aborted", "pagehide", "blocked"].includes(result?.cause)) {
      window.ownedDialog.failed();
      return;
    }
    window.ownedDialog.respond(response, result.cause);
  }).catch(() => {
    observer.disconnect();
    window.ownedDialog.failed();
  });
}, themeId => window.MarkalooDialogs.applyTheme(themeId));
