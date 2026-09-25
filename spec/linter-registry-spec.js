const path = require("path");
const Helpers = require("../lib/helpers");
const LinterRegistry = require("../lib/linter-registry");

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createMessage(file) {
  return {
    severity: "error",
    excerpt: `Message for ${file}`,
    location: {
      file,
      position: [
        [0, 0],
        [0, 1],
      ],
    },
  };
}

describe("LinterRegistry", () => {
  let registry;
  let editors;

  beforeEach(() => {
    atom.config.set("linter-bundle.lintOnChange", true);
    atom.config.set("linter-bundle.ignoreGlob", "**/*.min.{js,css}");
    atom.config.set("linter-bundle.lintPreviewTabs", true);
    atom.config.set("linter-bundle.disabledProviders", []);
    spyOn(Helpers, "isPathIgnored").andReturn(Promise.resolve(false));
    registry = new LinterRegistry();
    editors = [];
  });

  afterEach(() => {
    registry.dispose();
    for (const editor of editors) {
      editor.destroy();
    }
  });

  function createEditor(name) {
    const editor = atom.workspace.buildTextEditor();
    editor.getBuffer().setPath(path.join(process.cwd(), name));
    editors.push(editor);
    return editor;
  }

  it("keeps out-of-order results for different buffers and emits their request numbers", async () => {
    const requests = new Map();
    const linter = {
      name: "Test",
      scope: "file",
      lintsOnChange: true,
      grammarScopes: ["*"],
      lint(editor) {
        const request = deferred();
        requests.set(editor, request);
        return request.promise;
      },
    };
    const firstEditor = createEditor("first.js");
    const secondEditor = createEditor("second.js");
    const updates = [];
    registry.addLinter(linter);
    registry.onDidUpdateMessages((event) => updates.push(event));

    const firstLint = registry.lint({ onChange: false, editor: firstEditor });
    const secondLint = registry.lint({ onChange: false, editor: secondEditor });
    await Promise.resolve();

    requests.get(secondEditor).resolve([createMessage(secondEditor.getPath())]);
    await secondLint;
    requests.get(firstEditor).resolve([createMessage(firstEditor.getPath())]);
    await firstLint;

    expect(updates.length).toBe(2);
    expect(updates.map(({ number }) => number)).toEqual([2, 1]);
    expect(updates.map(({ buffer }) => buffer)).toEqual([
      secondEditor.getBuffer(),
      firstEditor.getBuffer(),
    ]);
  });

  it("still rejects an older result for the same buffer", async () => {
    const requests = [];
    const linter = {
      name: "Test",
      scope: "file",
      lintsOnChange: true,
      grammarScopes: ["*"],
      lint() {
        const request = deferred();
        requests.push(request);
        return request.promise;
      },
    };
    const editor = createEditor("same.js");
    const updates = [];
    registry.addLinter(linter);
    registry.onDidUpdateMessages((event) => updates.push(event));

    const firstLint = registry.lint({ onChange: false, editor });
    const secondLint = registry.lint({ onChange: false, editor });
    await Promise.resolve();

    requests[1].resolve([createMessage(editor.getPath())]);
    await secondLint;
    requests[0].resolve([createMessage(editor.getPath())]);
    await firstLint;

    expect(updates.length).toBe(1);
    expect(updates[0].number).toBe(2);
  });
});
