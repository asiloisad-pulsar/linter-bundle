# linter-bundle

A unified linting package that combines linting infrastructure with an integrated UI.

![panel](https://github.com/asiloisad-pulsar/linter-bundle/blob/master/assets/panel.png?raw=true)

Fork of [linter](https://github.com/steelbrain/linter) and [linter-ui-default](https://github.com/steelbrain/linter-ui-default).

## Features

- **Unified Package**: Combines linter core functionality with UI in a single package.
- **Status Bar Integration**: Shows error, warning, and info counts in the status bar. Left-click toggles panel, middle-click toggles file/project mode, Ctrl+middle-click clears messages, right-click jumps to next, Ctrl+right-click jumps to previous.
- **Linter Panel**: Sortable table view of all linter messages with filtering. Supports keyboard navigation when focused.
- **Inline Bubbles**: Hover-style message display at cursor position.
- **Editor Highlighting**: Underline and highlight decorations for linted ranges.
- **Multiple Sort Methods**: Sort by severity, position, or provider. Cell index is used as a primary sort key for notebook messages.
- **Linter Management**: Enable/disable individual linter providers.
- **Jupyter Notebook support**: Works with `.ipynb` files via the `linter-adapter` service. Messages are mapped to individual cells and the panel shows `[cell]:line:col` position.
- **Scrollmap**: Shows linter markers in the scrollbar via [scrollmap](https://github.com/asiloisad-pulsar/scrollmap).
- **Reference links**: Clickable references in messages to open related files. See [latex-tools](https://github.com/asiloisad-pulsar/latex-tools) for usage example.
- **Markdown rendering**: Message excerpts support markdown formatting in tooltips and panel.
- **MCP Tool**: Provides `GetLinterMessages` tool via [pulsar-mcp](https://github.com/asiloisad-pulsar/pulsar-mcp).

## Installation

To install `linter-bundle` search for [linter-bundle](https://web.pulsar-edit.dev/packages/linter-bundle) in the Install pane of the Pulsar settings or run `ppm install linter-bundle`. Alternatively, you can run `ppm install asiloisad-pulsar/linter-bundle` to install a package directly from the GitHub repository.

## Commands

Commands available in `atom-workspace`:

- `linter-bundle:toggle-focus`: focus the panel (or return focus to the editor if already focused), opening the panel if needed,
- `linter-bundle:toggle-panel`: toggle the linter panel visibility,
- `linter-bundle:toggle-linter`: toggle a linter provider on/off,
- `linter-bundle:toggle-current-file`: toggle linting for the current file,
- `linter-bundle:lint`: manually trigger linting on the current file,
- `linter-bundle:debug`: show debug information about active linters,
- `linter-bundle:state`: toggle linting for the current file (legacy alias),
- `linter-bundle:inspect`: show message bubble at cursor position,
- `linter-bundle:next`: jump to next linter message,
- `linter-bundle:previous`: jump to previous linter message,
- `linter-bundle:clear`: clear linter messages for the current editor.

## Customization

The style can be adjusted according to user preferences in the `styles.less` file:

- e.g. solid underline instead of wavy:

```less
.linter-text {
  &.error {
    background-image: none;
    border-bottom: 1px solid @text-color-error;
  }
  &.warning {
    background-image: none;
    border-bottom: 1px solid @text-color-warning;
  }
  &.info {
    background-image: none;
    border-bottom: 1px solid @text-color-info;
  }
}
```

- e.g. change gutter dot size:

```less
:root {
  --linter-dot-size: 6px;
}
```

## Provided Service `linter-indie`

Indie linter delegate for custom integrations. Allows packages to push linter messages directly without implementing the full linter provider interface.

In your `package.json`:

```json
{
  "consumedServices": {
    "linter-indie": {
      "versions": { "2.0.0": "consumeIndie" }
    }
  }
}
```

In your main module:

```javascript
module.exports = {
  consumeIndie(registerIndie) {
    const indie = registerIndie({ name: "my-indie-linter" });

    // Set messages for a specific file
    indie.setMessages("/path/to/file.js", [
      {
        severity: "warning",
        location: {
          file: "/path/to/file.js",
          position: [
            [0, 0],
            [0, 1],
          ],
        },
        excerpt: "Warning message",
      },
    ]);

    // Or set all messages at once
    indie.setAllMessages([
      /* messages */
    ]);

    // Clear all messages
    indie.clearMessages();
  },
};
```

## Provided Service `mcp-tools`

Provides MCP tools for [pulsar-mcp](https://github.com/asiloisad-pulsar/pulsar-mcp). The service currently exposes `GetLinterMessages`, a read-only tool that returns diagnostics from the linter panel.

With no arguments the tool follows the current linter panel view mode:

- `file`: returns messages for the active editor,
- `project`: returns all known messages across the project.

The tool also accepts optional filters. When any of them is provided, the result is scoped from all known messages across the project, independent of UI focus or panel view mode (`mode` is `filter`). This lets callers target a file that is not the focused tab, or even a file that was never opened:

- `filePath`: only messages for this file. Matching mirrors the filesystem: on Windows it is case-insensitive and treats `/` and `\` as equal, on POSIX it is exact.
- `severity`: only messages with this severity (`error`, `warning` or `info`).
- `linterName`: only messages produced by this linter provider.

Filters combine with AND, e.g. `{ filePath, severity: "error" }` returns only the errors for that file.

Returned data has the shape:

```json
{
  "mode": "file",
  "path": "/path/to/current/file.js",
  "messages": [
    {
      "severity": "warning",
      "excerpt": "Warning message",
      "linterName": "my-linter",
      "file": "/path/to/current/file.js",
      "range": {
        "start": { "row": 0, "column": 0 },
        "end": { "row": 0, "column": 1 }
      },
      "url": null
    }
  ]
}
```

In `package.json` this service is provided as:

```json
{
  "providedServices": {
    "mcp-tools": {
      "versions": {
        "1.0.0": "provideMcpTools"
      }
    }
  }
}
```

## Consumed Service `linter-adapter`

Allows non-TextEditor pane items (such as Jupyter notebooks) to integrate with the linter panel. The adapter maps linter messages to the correct item, handles navigation, and provides cursor-aware message lookup.

In your `package.json`:

```json
{
  "providedServices": {
    "linter-adapter": {
      "versions": {
        "1.0.0": "provideLinterItemAdapter"
      }
    }
  }
}
```

In your main module:

```javascript
module.exports = {
  provideLinterItemAdapter() {
    return {
      // Return true if this adapter handles the given pane item
      handlesItem: (item) => item instanceof MyCustomEditor,

      // Return the TextEditor that linters should lint for this item (for grammar/path detection)
      getTextEditorForItem: (item) => item.getSourceEditor(),

      // Filter all linter messages down to those relevant for this item
      getMessagesForItem: (item, allMessages) =>
        allMessages.filter((m) => m.location?.file === item.getPath()),

      // Return the message at the current cursor position (or undefined)
      getCurrentMessage: (item, messages) => item.getMessageAtCursor(messages),

      // Return the next message after the current cursor position
      getNextMessage: (item, messages) => item.getNextMessage(messages),

      // Return the previous message before the current cursor position
      getPreviousMessage: (item, messages) => item.getPreviousMessage(messages),

      // Scroll the item to the given message
      revealMessage: (item, message) => item.revealMessage(message),
    };
  },
};
```

## Consumed Service `linter`

Standard linter provider interface. Packages like `linter-eslint`, `linter-ruff`, etc. provide this service to report diagnostics.

```javascript
// Provider example
module.exports = {
  provideLinter() {
    return {
      name: "my-linter",
      scope: "file", // or 'project'
      lintsOnChange: true,
      grammarScopes: ["source.js"],
      lint(editor) {
        return [
          {
            severity: "error", // 'error' | 'warning' | 'info'
            location: {
              file: editor.getPath(),
              position: [
                [0, 0],
                [0, 1],
              ],
            },
            excerpt: "Error message",
          },
        ];
      },
    };
  },
};
```

## Consumed Service `linter-ui`

External UI providers that want to display linter messages. Used by packages like scrollmap to show linter markers on the scrollbar.

```javascript
// UI provider example
module.exports = {
  provideLinterUI() {
    return {
      name: "my-ui",
      render({ added, removed, messages }) {
        // Handle message updates
      },
      didBeginLinting({ linter, filePath }) {},
      didFinishLinting({ linter, filePath }) {},
      dispose() {},
    };
  },
};
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
