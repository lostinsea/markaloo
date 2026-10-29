"use strict";

// A path alone cannot distinguish saves from different document owners.
// Keep the host and injected-page test oracles on the same full identity.
// F22 fixtures require admission; this is not a legacy transport validator.
function saveResultEchoesRequest(request, result) {
  return !!(
    request && result &&
    request.requestId === request.saveRequest?.requestId &&
    request.saveRequestSession === request.saveRequest?.pageSession &&
    Number.isSafeInteger(request.saveRequest?.rendererGeneration) &&
    request.saveRequest.rendererGeneration > 0 &&
    Number.isSafeInteger(request.saveRequest?.tabId) &&
    Number.isSafeInteger(request.saveRequest?.documentGeneration) &&
    typeof request.saveRequest?.pathKey === "string" &&
    typeof request.saveRequest?.documentRef === "string" &&
    /^[a-f0-9]{64}$/.test(request.saveRequest.documentRef) &&
    Number.isSafeInteger(request.saveRequest?.selectionGeneration) &&
    request.saveRequest.selectionGeneration > 0 &&
    Number.isSafeInteger(request.saveRequest?.sequence) &&
    request.saveRequest.sequence > 0 &&
    result.requestId === request.requestId &&
    result.saveRequestSession === request.saveRequestSession &&
    result.saveRequest &&
    result.saveRequest.requestId === request.saveRequest.requestId &&
    result.saveRequest.sequence === request.saveRequest.sequence &&
    result.saveRequest.pageSession === request.saveRequest.pageSession &&
    result.saveRequest.rendererGeneration === request.saveRequest.rendererGeneration &&
    result.saveRequest.tabId === request.saveRequest.tabId &&
    result.saveRequest.documentGeneration === request.saveRequest.documentGeneration &&
    result.saveRequest.pathKey === request.saveRequest.pathKey &&
    result.saveRequest.documentRef === request.saveRequest.documentRef &&
    result.saveRequest.selectionGeneration === request.saveRequest.selectionGeneration
  );
}

module.exports = { saveResultEchoesRequest };
