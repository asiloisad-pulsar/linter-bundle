const path = require("path");
const { TextBuffer } = require("atom");
const main = require("../lib/main");
const Helpers = require("../lib/helpers");
const MessageRegistry = require("../lib/message-registry");

function createMessage(editor, excerpt = editor.getText()) {
  return {
    severity: "error",
    excerpt,
    location: {
      file: editor.getPath(),
      position: [[0, 0], [0, 1]],
    },
  };
}

describe("Programmatic linting", () => {
  let buffers;
  let editors;
  let providers;
  let getMessages;

  beforeEach(() => {
    buffers = [];
    editors = [];
    providers = [];
    atom.config.set("linter-bundle.lintOnOpen", false);
    atom.config.set("linter-bundle.lintOnChange", false);
    atom.config.set("linter-bundle.lintPreviewTabs", true);
    atom.config.set("linter-bundle.disabledProviders", []);
    spyOn(Helpers, "isPathIgnored").andReturn(Promise.resolve(false));
    main.activate();
    getMessages = main.provideMcpTools().find((tool) => tool.name === "GetLinterMessages");
  });

  afterEach(() => {
    for (const provider of providers) provider.dispose();
    main.deactivate();
    for (const editor of editors) editor.destroy();
    for (const buffer of buffers) buffer.destroy();
  });

  function createBuffer(text = "unsaved contents", name = "programmatic.txt") {
    const buffer = new TextBuffer({ text, filePath: path.join(process.cwd(), name) });
    buffers.push(buffer);
    return buffer;
  }

  function registerProvider(lint, scope = "file") {
    providers.push(
      main.consumeLinter({
        name: "Programmatic test",
        scope,
        lintsOnChange: true,
        grammarScopes: ["*"],
        lint,
      }),
    );
  }

  function messagesFor(buffer) {
    return getMessages.execute({ filePath: buffer.getPath() }).messages;
  }

  it("lints unsaved text without retaining or destroying an unopened buffer", async () => {
    const buffer = createBuffer();
    let temporaryEditor;
    registerProvider((editor) => {
      temporaryEditor = editor;
      return [createMessage(editor)];
    });

    expect(buffer.isRetained()).toBe(false);
    expect(await main.lintBuffer(buffer)).toBe(true);

    expect(temporaryEditor.getBuffer()).not.toBe(buffer);
    expect(temporaryEditor.isDestroyed()).toBe(true);
    expect(temporaryEditor.getBuffer().isDestroyed()).toBe(true);
    expect(buffer.isDestroyed()).toBe(false);
    expect(buffer.isRetained()).toBe(false);
    expect(buffer.getText()).toBe("unsaved contents");
    expect(messagesFor(buffer).map((message) => message.excerpt)).toEqual(["unsaved contents"]);
  });

  it("allows the caller to release its last retained buffer reference after linting", async () => {
    const buffer = createBuffer();
    buffer.retain();
    registerProvider(() => []);

    await main.lintBuffer(buffer);
    expect(buffer.isRetained()).toBe(true);
    expect(buffer.isDestroyed()).toBe(false);

    buffer.release();
    expect(buffer.isDestroyed()).toBe(true);
  });

  it("waits for Tree-sitter initialization before linting and cleans up its parser resources", async () => {
    await atom.packages.activatePackage("language-javascript");
    const grammar = atom.grammars.getGrammars({ includeTreeSitter: true }).find(
      (candidate) => candidate.scopeName === "source.js" && candidate.type === "modern-tree-sitter",
    );
    expect(grammar.type).toBe("modern-tree-sitter");
    spyOn(atom.grammars, "selectGrammar").andReturn(grammar);
    const getLanguage = grammar.getLanguage.bind(grammar);
    await getLanguage();
    let releaseLanguage;
    const languageGate = new Promise((resolve) => {
      releaseLanguage = resolve;
    });
    spyOn(grammar, "getLanguage").andCallFake(() => languageGate.then(getLanguage));
    const buildTextEditor = atom.workspace.buildTextEditor.bind(atom.workspace);
    let temporaryEditor;
    spyOn(atom.workspace, "buildTextEditor").andCallFake((params) => {
      temporaryEditor = buildTextEditor(params);
      return temporaryEditor;
    });
    const buffer = createBuffer("const value = 1;", "initializing.js");
    let providerCalls = 0;
    registerProvider(() => {
      providerCalls++;
      return [];
    });

    const pass = main.lintBuffer(buffer);
    const languageMode = temporaryEditor.getBuffer().getLanguageMode();
    expect(languageMode.grammar).toBe(grammar);
    await Promise.resolve();
    const callsBeforeInitialization = providerCalls;
    const destroyedBeforeInitialization = temporaryEditor.isDestroyed();
    releaseLanguage();
    expect(await pass).toBe(true);

    expect(callsBeforeInitialization).toBe(0);
    expect(destroyedBeforeInitialization).toBe(false);
    expect(providerCalls).toBe(1);
    expect(temporaryEditor.isDestroyed()).toBe(true);
    expect(temporaryEditor.getBuffer().isDestroyed()).toBe(true);
    expect(languageMode.rootLanguageLayer).toBe(null);
    expect(languageMode.parsersByLanguage.size).toBe(0);
    expect(buffer.isDestroyed()).toBe(false);
    expect(buffer.isRetained()).toBe(false);
  });

  it("destroys the temporary editor when the lint pass rejects", async () => {
    const buffer = createBuffer();
    const error = new Error("Unable to check ignored paths");
    const buildTextEditor = atom.workspace.buildTextEditor.bind(atom.workspace);
    let temporaryEditor;
    spyOn(atom.workspace, "buildTextEditor").andCallFake((params) => {
      temporaryEditor = buildTextEditor(params);
      return temporaryEditor;
    });
    Helpers.isPathIgnored.andReturn(Promise.reject(error));
    let caught;

    try {
      await main.lintBuffer(buffer);
    } catch (failure) {
      caught = failure;
    }

    expect(caught).toBe(error);
    expect(temporaryEditor.isDestroyed()).toBe(true);
    expect(temporaryEditor.getBuffer().isDestroyed()).toBe(true);
    expect(buffer.isDestroyed()).toBe(false);
    expect(buffer.isRetained()).toBe(false);
  });

  it("attributes results and buffer locations to the original buffer", async () => {
    const buffer = createBuffer();
    let message;
    spyOn(MessageRegistry.prototype, "set").andCallThrough();
    registerProvider((editor) => {
      message = createMessage(editor);
      message.location.buffer = editor.getBuffer();
      return [message];
    });

    await main.lintBuffer(buffer);

    expect(MessageRegistry.prototype.set.calls.length).toBe(1);
    expect(MessageRegistry.prototype.set.calls[0].args[0].buffer).toBe(buffer);
    expect(message.location.buffer).toBe(buffer);
    expect(messagesFor(buffer).length).toBe(1);
  });

  it("remaps project-scoped snapshot locations while preserving project registry scope", async () => {
    const buffer = createBuffer();
    let message;
    spyOn(MessageRegistry.prototype, "set").andCallThrough();
    registerProvider((editor) => {
      message = createMessage(editor);
      message.location.buffer = editor.getBuffer();
      return [message];
    }, "project");

    await main.lintBuffer(buffer);

    expect(MessageRegistry.prototype.set.calls.length).toBe(1);
    expect(MessageRegistry.prototype.set.calls[0].args[0].buffer).toBe(null);
    expect(message.location.buffer).toBe(buffer);
    expect(message.location.buffer.isDestroyed()).toBe(false);
    expect(messagesFor(buffer).map((result) => result.excerpt)).toEqual(["unsaved contents"]);
  });

  it("keeps newer results when concurrent passes for one unopened buffer finish out of order", async () => {
    const buffer = createBuffer("first version");
    const requests = [];
    registerProvider(
      (editor) => new Promise((resolve) => {
        requests.push({ editor, text: editor.getText(), resolve });
      }),
    );

    const firstLint = main.lintBuffer(buffer);
    buffer.setText("second version");
    const secondLint = main.lintBuffer(buffer);
    await Promise.resolve();

    expect(requests.length).toBe(2);
    expect(requests[0].editor).not.toBe(requests[1].editor);
    expect(requests.map((request) => request.text)).toEqual(["first version", "second version"]);
    requests[1].resolve([createMessage(requests[1].editor, requests[1].text)]);
    await secondLint;
    expect(requests[1].editor.isDestroyed()).toBe(true);
    expect(requests[0].editor.isDestroyed()).toBe(false);
    expect(messagesFor(buffer).map((message) => message.excerpt)).toEqual(["second version"]);

    requests[0].resolve([createMessage(requests[0].editor, requests[0].text)]);
    await firstLint;

    expect(requests[0].editor.isDestroyed()).toBe(true);
    expect(messagesFor(buffer).map((message) => message.excerpt)).toEqual(["second version"]);
    expect(buffer.isDestroyed()).toBe(false);
    expect(buffer.isRetained()).toBe(false);
  });

  it("reuses an open editor and leaves it alive", async () => {
    const buffer = createBuffer();
    const editor = atom.workspace.buildTextEditor({ buffer });
    editors.push(editor);
    atom.workspace.getActivePane().addItem(editor);
    let lintedEditor;
    registerProvider((currentEditor) => {
      lintedEditor = currentEditor;
      return [createMessage(currentEditor)];
    });

    await main.lintBuffer(buffer);

    expect(lintedEditor).toBe(editor);
    expect(editor.isDestroyed()).toBe(false);
    expect(buffer.isDestroyed()).toBe(false);
    expect(atom.workspace.getTextEditors()).toContain(editor);
    expect(messagesFor(buffer).length).toBe(1);
  });

  it("clears unopened-file diagnostics when the original buffer is destroyed", async () => {
    const buffer = createBuffer();
    registerProvider((editor) => [createMessage(editor)]);
    await main.lintBuffer(buffer);
    expect(messagesFor(buffer).length).toBe(1);

    buffer.destroy();

    expect(messagesFor(buffer)).toEqual([]);
  });

  it("flushes pending registry updates before an immediate MCP read", () => {
    const file = path.join(process.cwd(), "indie.txt");
    const indie = main.provideIndie()({ name: "Immediate indie" });
    indie.setAllMessages([
      {
        severity: "warning",
        excerpt: "Fresh indie message",
        location: { file, position: [[0, 0], [0, 1]] },
      },
    ]);

    expect(
      getMessages.execute({ filePath: file }).messages.map((message) => message.excerpt),
    ).toEqual(["Fresh indie message"]);
  });
});
