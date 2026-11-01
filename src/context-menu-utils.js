(function () {
// ============================================
// context-menu-utils.js - Context Menu Helpers
// ============================================

const scrollProtectedMenus = new WeakSet();
const menuPresentations = new WeakMap();

/**
 * Position a context menu element at the given coordinates
 * Automatically adjusts position if menu would go off screen
 * @param {HTMLElement} menuElement - The context menu element
 * @param {number} x - X coordinate (clientX)
 * @param {number} y - Y coordinate (clientY)
 * @param {Object} [presentation] - Anchor, context nodes and a pure currentness check
 */
function positionContextMenu(menuElement, x, y, presentation) {
  if (presentation) menuPresentations.set(menuElement, presentation);
  else menuPresentations.delete(menuElement);
  if (!scrollProtectedMenus.has(menuElement)) {
    // The caller dismisses on document scroll in capture phase. Intercept only
    // this menu's scroll earlier so its commands stay reachable. Other scroll
    // events still reach the owner's anchor/context dismissal check.
    menuElement.ownerDocument.defaultView.addEventListener('scroll', (event) => {
      if (event.target.nodeType && menuElement.contains(event.target)) event.stopPropagation();
    }, true);
    scrollProtectedMenus.add(menuElement);
  }

  // A fixed auto-width box shrink-wraps against its left inset. Measure from
  // the viewport edge, not the click point, before choosing its final position.
  menuElement.style.left = '10px';
  menuElement.style.top = '10px';

  // Show the menu (needed to get accurate dimensions)
  menuElement.classList.add('visible');

  // Adjust position if menu goes off screen
  // Fade-in scales the painted rectangle; fitting that transient rectangle
  // leaves the final menu outside the viewport. Use untransformed layout size.
  const windowWidth = window.innerWidth;
  const windowHeight = window.innerHeight;
  const left = Math.max(10, Math.min(x, windowWidth - menuElement.offsetWidth - 10));
  const top = Math.max(10, Math.min(y, windowHeight - menuElement.offsetHeight - 10));
  menuElement.style.left = `${left}px`;
  menuElement.style.top = `${top}px`;
  menuElement.scrollTop = 0;
  menuElement.scrollLeft = 0;
}

/**
 * Hide a context menu element
 * @param {HTMLElement} menuElement - The context menu element
 */
function hideContextMenu(menuElement, event) {
  if (event?.type === 'scroll') {
    const presentation = menuPresentations.get(menuElement);
    const doc = menuElement.ownerDocument;
    const target = event.target;
    const nodes = presentation ? [presentation.anchor, ...(presentation.contextNodes ?? [])] : [];
    const current = presentation && nodes.every(node =>
      node?.isConnected && node.ownerDocument === doc) && presentation.isCurrent() === true;
    if (!presentation || current) {
      if (target?.nodeType && menuElement.contains(target)) return false;
      // A sibling scroller does not move this menu's captured anchor/context.
      if (current && target !== doc && target !== doc.documentElement &&
          target !== doc.body && target !== doc.defaultView &&
          typeof target?.contains === 'function' &&
          !nodes.some(node => target.contains(node))) return false;
    }
  }
  const visible = menuElement.classList.contains('visible');
  menuElement.classList.remove('visible');
  menuPresentations.delete(menuElement);
  return visible;
}

// Export for use in other modules
const contextMenuUtils = {
  positionContextMenu,
  hideContextMenu
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = contextMenuUtils;
}
if (typeof window !== 'undefined') {
  window.FoliaContextMenu = contextMenuUtils;
}
})();
