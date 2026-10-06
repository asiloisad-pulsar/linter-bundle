const arrayUnique = require("lodash/uniq");
const { Directory, Range, Point } = require("atom");

// Bookkeeping keys stored on each linter provider object. They are prefixed
// with this package's name so they do not collide with the same state kept by
// the original `linter` package when both are enabled: it uses the
// "__$sb_linter_*" names, and stores a number under request_last_received
// where this package keeps a WeakMap per buffer.
const $version = "__$linter_bundle_version";
const $activated = "__$linter_bundle_activated";
const $requestLatest = "__$linter_bundle_request_latest";
const $requestLastReceived = "__$linter_bundle_request_last_received";

function shouldTriggerLinter(linter, wasTriggeredOnChange, scopes) {
  if (wasTriggeredOnChange && !linter.lintsOnChange) {
    return false;
  }
  // Use pre-computed Set for O(1) lookup if available, otherwise fall back to includes
  const scopeSet = linter._grammarScopesSet;
  if (scopeSet) {
    return scopes.some((scope) => scopeSet.has(scope));
  }
  return scopes.some((scope) => linter.grammarScopes.includes(scope));
}

function getEditorCursorScopes(textEditor) {
  return arrayUnique(
    textEditor
      .getCursors()
      .reduce(
        (scopes, cursor) => scopes.concat(cursor.getScopeDescriptor().getScopesArray()),
        ["*"],
      ),
  );
}

let minimatchFn;
async function isPathIgnored(filePath, ignoredGlob, ignoredVCS) {
  if (!filePath) {
    return true;
  }
  if (ignoredVCS) {
    const directory = new Directory(filePath);
    const repository = await atom.project.repositoryForDirectory(directory);
    if (repository && repository.isPathIgnored(filePath)) {
      return true;
    }
  }
  const normalizedFilePath = process.platform === "win32" ? filePath.replace(/\\/g, "/") : filePath;
  if (!minimatchFn) {
    try {
      // minimatch v10+ exports as { minimatch } instead of default export
      const mod = require("minimatch");
      minimatchFn = mod.minimatch || mod;
    } catch (error) {
      console.error("[Linter] Failed to load minimatch module:", error);
      return false;
    }
  }
  return minimatchFn(normalizedFilePath, ignoredGlob);
}

function updateMessageKey(message) {
  const { reference, location } = message;
  const locationBufferId = location.buffer
    ? location.buffer.id || location.buffer.getId?.() || String(location.buffer)
    : null;
  message.key = [
    `$LINTER:${message.linterName}`,
    `$LOCATION:${location.file}$${location.position.start.row}$${location.position.start.column}$${location.position.end.row}$${location.position.end.column}`,
    location.cell != null ? `$CELL:${location.cell}` : "$CELL:null",
    locationBufferId ? `$BUFFER:${locationBufferId}` : "$BUFFER:null",
    reference
      ? `$REFERENCE:${reference.file}$${
          reference.position ? `${reference.position.row}$${reference.position.column}` : ""
        }`
      : "$REFERENCE:null",
    `$EXCERPT:${message.excerpt}`,
    `$SEVERITY:${message.severity}`,
    message.icon ? `$ICON:${message.icon}` : "$ICON:null",
    message.url ? `$URL:${message.url}` : "$URL:null",
    typeof message.description === "string"
      ? `$DESCRIPTION:${message.description}`
      : "$DESCRIPTION:null",
  ].join("");
}

function normalizeMessages(linterName, messages) {
  for (let i = 0, { length } = messages; i < length; ++i) {
    const message = messages[i];
    const { reference, solutions } = message;
    message.location.position = getRangeClass(message.location.position);
    if (reference !== undefined && reference.position !== undefined) {
      reference.position = getPointClass(reference.position);
    }
    if (Array.isArray(solutions)) {
      for (let j = 0, _length = solutions.length; j < _length; j++) {
        const solution = solutions[j];
        solution.position = getRangeClass(solution.position);
      }
    }
    message.version = 2;
    if (!message.linterName) {
      message.linterName = linterName;
    }
    updateMessageKey(message);
  }
}

function getPointClass(point) {
  if (!(point instanceof Point)) {
    return Point.fromObject(point);
  }
  return point;
}

function getRangeClass(range) {
  if (!(range instanceof Range)) {
    return Range.fromObject(range);
  }
  return range;
}

function updateKeys(messages) {
  messages.forEach((m) => {
    updateMessageKey(m);
  });
}

function createKeyMessageMap(messages) {
  const keyMessageMap = new Map();
  for (let i = 0, { length } = messages; i < length; ++i) {
    const message = messages[i];
    keyMessageMap.set(message.key, message);
  }
  return keyMessageMap;
}

function flagMessages(inputs, oldMessages) {
  if (inputs === undefined || oldMessages === undefined) {
    return null;
  }
  if (!oldMessages.length) {
    return { oldKept: [], oldRemoved: [], newAdded: inputs };
  }
  if (!inputs.length) {
    return { oldKept: [], oldRemoved: oldMessages, newAdded: [] };
  }
  const cache = createKeyMessageMap(oldMessages);
  const newAdded = [];
  const oldKept = [];
  const oldKeptKeys = new Set();
  for (let iInput = 0, len = inputs.length; iInput < len; iInput++) {
    const input = inputs[iInput];
    if (cache.has(input.key)) {
      oldKept.push(input);
      oldKeptKeys.add(input.key);
    } else {
      newAdded.push(input);
    }
  }
  // Use Set for O(1) lookup instead of Array.includes() which is O(n)
  const oldRemoved = [];
  for (const [key, message] of cache) {
    if (!oldKeptKeys.has(key)) {
      oldRemoved.push(message);
    }
  }
  return { oldKept, oldRemoved, newAdded };
}

function mergeArray(arr1, arr2) {
  if (!arr2.length) {
    return;
  }
  Array.prototype.push.apply(arr1, arr2);
}

function scrollToCursorWithMode(editor, scroll) {
  const [upper, lower] = scroll.split("-").map(Number);
  const editorView = atom.views.getView(editor);
  const cursorRow = editor.getCursorScreenPosition().row;
  const cursorPixel = editorView.component.pixelPositionAfterBlocksForRow(cursorRow);
  const viewHeight = editorView.component.getScrollContainerClientHeight();
  const margin = editorView.component.getVerticalAutoscrollMargin();
  const lineHeight = editorView.component.getLineHeight();
  const usable = viewHeight - 2 * margin - lineHeight;
  const toPixel = (pct) => margin + usable * (pct / 100);
  const upperPixel = toPixel(upper);
  if (lower === undefined) {
    editorView.setScrollTop(cursorPixel - upperPixel);
  } else {
    const currentScrollTop = editorView.getScrollTop();
    const cursorRelative = cursorPixel - currentScrollTop;
    const lowerPixel = toPixel(lower);
    if (cursorRelative < upperPixel) {
      editorView.setScrollTop(cursorPixel - upperPixel);
    } else if (cursorRelative > lowerPixel) {
      editorView.setScrollTop(cursorPixel - lowerPixel);
    }
  }
}

module.exports = {
  $version,
  $activated,
  $requestLatest,
  $requestLastReceived,
  shouldTriggerLinter,
  getEditorCursorScopes,
  isPathIgnored,
  updateMessageKey,
  normalizeMessages,
  updateKeys,
  createKeyMessageMap,
  flagMessages,
  mergeArray,
  scrollToCursorWithMode,
};
