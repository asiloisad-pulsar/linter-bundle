const { Emitter, CompositeDisposable } = require("atom");
const Helpers = require("./helpers");
const Validate = require("./validate");
const { $version, $activated, $requestLatest, $requestLastReceived } = require("./helpers");

// Default timeout for linter execution (30 seconds)
const LINTER_TIMEOUT_MS = 30000;

// Helper to create a timeout promise
function createTimeoutPromise(ms, linterName) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Linter '${linterName}' timed out after ${ms}ms`));
    }, ms);
  });
}

class LinterRegistry {
  constructor() {
    this.emitter = new Emitter();
    this.linters = new Set();
    this.lintOnChange = true;
    this.ignoreVCS = true;
    this.ignoreGlob = "**/*.min.{js,css}";
    this.lintPreviewTabs = true;
    this.subscriptions = new CompositeDisposable();
    this.disabledProviders = [];
    this.activeNotifications = new Set();
    this.subscriptions.add(
      this.emitter,
      atom.config.observe("linter-bundle.lintOnChange", (lintOnChange) => {
        this.lintOnChange = lintOnChange;
      }),
      atom.config.observe("core.excludeVcsIgnoredPaths", (ignoreVCS) => {
        this.ignoreVCS = ignoreVCS;
      }),
      atom.config.observe("linter-bundle.ignoreGlob", (ignoreGlob) => {
        this.ignoreGlob = ignoreGlob;
      }),
      atom.config.observe("linter-bundle.lintPreviewTabs", (lintPreviewTabs) => {
        this.lintPreviewTabs = lintPreviewTabs;
      }),
      atom.config.observe("linter-bundle.disabledProviders", (disabledProviders) => {
        if (disabledProviders.length !== 0) {
          console.warn(`Linter package: disabled linter providers: ${disabledProviders}`);
        }
        this.disabledProviders = disabledProviders;
      }),
    );
  }

  hasLinter(linter) {
    return this.linters.has(linter);
  }

  addLinter(linter) {
    if (!Validate.linter(linter)) {
      return false;
    }
    linter[$activated] = true;
    if (typeof linter[$requestLatest] === "undefined") {
      linter[$requestLatest] = 0;
    }
    if (linter.scope === "file") {
      // A file-scoped provider can lint multiple buffers concurrently. Track
      // accepted results per buffer so a fast result for one editor does not
      // make an older request for another editor look stale.
      if (!(linter[$requestLastReceived] instanceof WeakMap)) {
        linter[$requestLastReceived] = new WeakMap();
      }
    } else if (typeof linter[$requestLastReceived] !== "number") {
      linter[$requestLastReceived] = 0;
    }
    linter[$version] = 2;
    // Convert grammarScopes array to Set for O(1) lookup in shouldTriggerLinter
    if (Array.isArray(linter.grammarScopes) && !(linter.grammarScopes instanceof Set)) {
      linter._grammarScopesSet = new Set(linter.grammarScopes);
    }
    this.linters.add(linter);
    return true;
  }

  getProviders() {
    return Array.from(this.linters);
  }

  deleteLinter(linter) {
    if (!this.linters.has(linter)) {
      return;
    }
    linter[$activated] = false;
    this.linters.delete(linter);
  }

  async lint({ onChange, editor }) {
    const filePath = editor.getPath();
    if (
      (onChange && !this.lintOnChange) ||
      (!this.lintPreviewTabs && atom.workspace.getActivePane().getPendingItem() === editor) ||
      (await Helpers.isPathIgnored(editor.getPath(), this.ignoreGlob, this.ignoreVCS))
    ) {
      return false;
    }
    const scopes = Helpers.getEditorCursorScopes(editor);
    const promises = [];
    for (const linter of this.linters) {
      if (!Helpers.shouldTriggerLinter(linter, onChange, scopes)) {
        continue;
      }
      if (this.disabledProviders.includes(linter.name)) {
        continue;
      }
      const number = ++linter[$requestLatest];
      const statusBuffer = linter.scope === "file" ? editor.getBuffer() : null;
      const statusFilePath = linter.scope === "file" ? filePath : null;
      this.emitter.emit("did-begin-linting", {
        number,
        linter,
        filePath: statusFilePath,
      });
      promises.push(
        Promise.race([
          new Promise(function (resolve) {
            resolve(linter.lint(editor));
          }),
          createTimeoutPromise(LINTER_TIMEOUT_MS, linter.name),
        ]).then(
          (messages) => {
            this.emitter.emit("did-finish-linting", {
              number,
              linter,
              filePath: statusFilePath,
            });
            const requestLastReceived = statusBuffer
              ? linter[$requestLastReceived].get(statusBuffer) || 0
              : linter[$requestLastReceived];
            if (
              requestLastReceived >= number ||
              !linter[$activated] ||
              (statusBuffer && !statusBuffer.isAlive())
            ) {
              return;
            }
            if (statusBuffer) {
              linter[$requestLastReceived].set(statusBuffer, number);
            } else {
              linter[$requestLastReceived] = number;
            }
            if (statusBuffer && !statusBuffer.isAlive()) {
              return;
            }
            if (messages === null || messages === undefined) {
              return;
            }
            let validity = true;
            if (atom.inDevMode() || !Array.isArray(messages)) {
              validity = Validate.messages(linter.name, messages);
            }
            if (!validity) {
              return;
            }
            Helpers.normalizeMessages(linter.name, messages);
            this.emitter.emit("did-update-messages", {
              number,
              messages,
              linter,
              buffer: statusBuffer,
            });
          },
          (error) => {
            this.emitter.emit("did-finish-linting", {
              number,
              linter,
              filePath: statusFilePath,
            });
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[Linter] Error running ${linter.name}:`, errorMessage, error);

            // Use linter name as the key to prevent duplicate notifications
            const notificationKey = `linter-error:${linter.name}`;

            // Check if we already have an active notification for this linter
            if (this.activeNotifications.has(notificationKey)) {
              return;
            }

            const notification = atom.notifications.addError(
              `[Linter] Error running ${linter.name}`,
              {
                detail: `${errorMessage}\n\nSee Console for more info.`,
                dismissable: true,
                buttons: [
                  {
                    text: "Open Console",
                    onDidClick: () => {
                      atom.openDevTools();
                      notification.dismiss();
                    },
                  },
                  {
                    text: "Cancel",
                    onDidClick: () => {
                      notification.dismiss();
                    },
                  },
                ],
              },
            );
            // Track notification by linter name and remove when dismissed
            this.activeNotifications.add(notificationKey);
            notification.onDidDismiss(() => {
              this.activeNotifications.delete(notificationKey);
            });
          },
        ),
      );
    }
    await Promise.all(promises);
    return true;
  }

  onDidUpdateMessages(callback) {
    return this.emitter.on("did-update-messages", callback);
  }

  onDidBeginLinting(callback) {
    return this.emitter.on("did-begin-linting", callback);
  }

  onDidFinishLinting(callback) {
    return this.emitter.on("did-finish-linting", callback);
  }

  dispose() {
    this.activeNotifications.clear();
    this.linters.clear();
    this.subscriptions.dispose();
  }
}

module.exports = LinterRegistry;
