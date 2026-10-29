'use strict';

window.FoliaReloadRequest = Object.freeze({
  create({ state, session, document, readSnapshot, requestReload, i18n, console, setTimeout }) {
    function showNotification(message, duration = 3000) {
      const toast = document.getElementById('notificationToast');
      const messageEl = document.getElementById('notificationMessage');
      messageEl.textContent = message;
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
      }, duration);
    }

    function showFileUpdateNotification() {
      if (state.promptShown) return;
      const toast = document.getElementById('fileUpdateToast');
      if (!toast) {
        console.error('File update toast element not found');
        return;
      }
      toast.classList.add('show');
      state.promptShown = true;
    }

    function dismissFileUpdateNotification() {
      const toast = document.getElementById('fileUpdateToast');
      if (toast) toast.classList.remove('show');
      state.promptShown = false;
    }

    function dispatch(context) {
      const { requestPath } = context;
      const sequence = ++state.sequence;
      const snapshot = readSnapshot();
      const previousSequence = state.latestByPath.get(requestPath);
      state.latestByPath.set(requestPath, sequence);
      try {
        requestReload({
          filePath: context.filePath,
          reloadRequestSequence: sequence,
          reloadRequestPath: requestPath,
          reloadRequestSnapshot: snapshot,
          reloadRequestSession: session,
          reloadRequestTabId: context.tabId,
          reloadRequestDocumentGeneration: context.documentGeneration,
          reloadRequestDocumentPathKey: context.documentPathKey,
          reloadRequestDocumentRef: context.documentRef,
          reloadRequestRendererGeneration: context.rendererGeneration,
          reloadRequestSelectionGeneration: context.selectionGeneration,
        });
      } catch (error) {
        // An unsent request must not supersede an earlier or reentrant reload.
        if (state.latestByPath.get(requestPath) === sequence) {
          if (previousSequence === undefined) state.latestByPath.delete(requestPath);
          else state.latestByPath.set(requestPath, previousSequence);
        }
        console.error('Reload request delivery failed:', error);
        showNotification(i18n('notif.reloadFailed') + error.message, 4000);
        return false;
      }
      dismissFileUpdateNotification();
      return true;
    }

    return Object.freeze({
      dispatch, showNotification, showFileUpdateNotification, dismissFileUpdateNotification,
    });
  },
});
