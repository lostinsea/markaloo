(function () {
  "use strict";

  const MAX_LOCATIONS = 10;

  function copyValue(value, ancestors = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || ancestors.has(value)) {
      throw new TypeError("Reading locations must contain finite, acyclic data values.");
    }
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new TypeError("Reading locations must contain plain data records.");
    }
    const copy = array ? [] : {};
    ancestors.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === "length") continue;
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !field.enumerable || !Object.hasOwn(field, "value")) {
        throw new TypeError("Reading locations cannot contain accessors or hidden fields.");
      }
      Object.defineProperty(copy, key, {
        value: copyValue(field.value, ancestors), enumerable: true,
      });
    }
    if (array) copy.length = value.length;
    ancestors.delete(value);
    return Object.freeze(copy);
  }

  function copyLocation(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("A reading location must be a data record.");
    }
    return copyValue(value);
  }

  function createReadingHistory() {
    let entries = [], index = -1, revision = 0, nextId = 1, pending = null;
    const issued = new WeakSet();
    const refused = reason => Object.freeze({ committed: false, reason });
    const entry = location => Object.freeze({ id: nextId++, location });
    const update = (previous, location) => Object.freeze({ id: previous.id, location });

    function snapshot() {
      return Object.freeze({
        entries: Object.freeze([...entries]), index, revision,
        canBack: index > 0, canForward: index >= 0 && index < entries.length - 1,
      });
    }

    function stage(kind, departure, targetIndex = index) {
      const target = kind === "traverse" ? entries[targetIndex] : null;
      const receipt = Object.freeze({
        kind, revision, fromId: entries[index]?.id ?? null,
        targetId: target?.id ?? (kind === "replace" ? entries[index].id : null),
        target: target?.location ?? null,
      });
      issued.add(receipt);
      pending = { receipt, departure, targetIndex };
      return receipt;
    }

    function stageJump(departure) {
      return stage("jump", copyLocation(departure));
    }

    function stageTraverse(direction, departure) {
      if (direction !== -1 && direction !== 1) {
        throw new TypeError("Reading-history direction must be -1 or 1.");
      }
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= entries.length) {
        return Object.freeze({ kind: "unavailable", reason: "boundary" });
      }
      return stage("traverse", copyLocation(departure), targetIndex);
    }

    function stageReplace(entryId) {
      if (!Number.isSafeInteger(entryId) || entryId < 1) {
        throw new TypeError("A reading-history entry ID must be a positive safe integer.");
      }
      if (index < 1 || entries[index].id !== entryId) {
        return Object.freeze({ kind: "unavailable", reason: "entry-changed" });
      }
      return stage("replace", null);
    }

    function requireReceipt(receipt) {
      if (!receipt || !issued.has(receipt)) {
        throw new TypeError("The reading-history transaction belongs to another owner.");
      }
    }

    // The viewport controller proves arrival and real travel before committing.
    function commit(receipt, destination, moved) {
      requireReceipt(receipt);
      if (typeof moved !== "boolean") throw new TypeError("A settled travel result is required.");
      if (pending?.receipt !== receipt || receipt.revision !== revision ||
          receipt.fromId !== (entries[index]?.id ?? null)) return refused("stale");
      if (!moved) {
        pending = null;
        return refused("no-travel");
      }
      const reached = copyLocation(destination);
      const transaction = pending;
      let next = [...entries], nextIndex = index;
      if (receipt.kind === "jump") {
        next = next.slice(0, index + 1);
        if (index < 0) next.push(entry(transaction.departure));
        else next[index] = update(next[index], transaction.departure);
        next.push(entry(reached));
        next = next.slice(-MAX_LOCATIONS);
        nextIndex = next.length - 1;
      } else if (receipt.kind === "replace") {
        if (next[index]?.id !== receipt.targetId) return refused("stale");
        next[index] = update(next[index], reached);
      } else {
        nextIndex = transaction.targetIndex;
        if (next[nextIndex]?.id !== receipt.targetId) return refused("stale");
        next[index] = update(next[index], transaction.departure);
        next[nextIndex] = update(next[nextIndex], reached);
      }
      entries = next;
      index = nextIndex;
      revision += 1;
      pending = null;
      return Object.freeze({ committed: true, entryId: entries[index].id, revision });
    }

    function cancel(receipt) {
      requireReceipt(receipt);
      if (pending?.receipt !== receipt) return false;
      pending = null;
      return true;
    }

    function clear() {
      entries = [];
      index = -1;
      revision += 1;
      pending = null;
    }

    return Object.freeze({ snapshot, stageJump, stageTraverse, stageReplace, commit, cancel, clear });
  }

  const readingHistory = Object.freeze({ createReadingHistory, MAX_LOCATIONS });
  if (typeof module !== "undefined" && module.exports) module.exports = readingHistory;
  if (typeof window !== "undefined") window.MarkalooReadingHistory = readingHistory;
})();
