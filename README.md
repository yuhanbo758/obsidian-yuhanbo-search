# Yuhanbo Search

Yuhanbo Search is an Obsidian plugin for weighted vault search and quick insertion of matching content, heading links, and block links.

Yuhanbo Search 是一款 Obsidian 加权搜索与智能补全插件，可按文件名、目录、标签、标题、正文和引用分别设置搜索权重。

## Features

- Weighted search across file names, folders, tags, headings, content, and quotes.
- Configurable search scope, excluded folders, and per-field weights.
- `@@keyword`: insert matching text directly.
- `@@# keyword`: insert a link to a matching heading.
- `@@@ keyword`: insert a link to a matching block.
- Keyboard navigation for suggestions and search results.
- Works on desktop and mobile without Node.js-only APIs.

## Usage

Open **Yuhanbo Search: 打开加权搜索** from the command palette or select the ribbon icon. Choose the fields to search, enter at least two characters, and select a result.

Smart completion can be enabled in the plugin settings:

- Type `@@关键词` to insert matching content as plain text.
- Type `@@# 标题` to insert `[[文件#标题|标题]]`.
- Type `@@@ 内容` to insert a block link.

No default hotkey is assigned. You can add one under **Settings → Hotkeys**.

## Installation

### Community plugins

After the plugin is accepted into the Obsidian community directory, install **Yuhanbo Search** from **Settings → Community plugins → Browse**.

### Manual installation

Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release. Copy them into:

```text
<vault>/.obsidian/plugins/yuhanbo-search/
```

Reload Obsidian and enable **Yuhanbo Search**.

## Privacy and permissions

- The plugin reads Markdown files and Obsidian metadata only to build a local search index.
- Settings are stored locally through Obsidian's plugin data API.
- The plugin does not send vault content, telemetry, or personal data over the network.
- The plugin does not modify or delete vault files during search or indexing.

## Development and releases

`npm run build` validates the distributable `main.js`. A push to `main` that changes release files runs GitHub Actions. If the manifest version has already been released, the workflow increments the patch version; otherwise it releases the current version. Each release attaches the files required by Obsidian and includes build-provenance attestations.

## License

[MIT](LICENSE) © Yuhanbo Yu
