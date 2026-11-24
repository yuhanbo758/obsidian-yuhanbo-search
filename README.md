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

Results initially show the top 100 files. Select **加载更多结果** to continue through the ranked list. The displayed previews are limited, but every match still contributes to the score. Changing the search or closing the dialog cancels the previous scan.

## Installation

### Community plugins

Install **Yuhanbo Search** from **Settings → Community plugins → Browse**.

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

Edit `src/yuhanbo-search.js`, then run `npm run build` to check its syntax and regenerate the root `main.js` byte for byte. Run `npm test` against the generated file. Commit the source and generated entry together. A push to `main` that changes release files runs GitHub Actions. If the manifest version has already been released, the workflow increments the patch version; otherwise it releases the current version. Each release attaches the files required by Obsidian and includes build-provenance attestations.

## License

[MIT](LICENSE) © Yuhanbo Yu

<!-- sanrenjz-promotion:start -->

## 👨‍💻 作者信息

**余汉波** - 编程爱好者-量化交易和效率工具开发

- **GitHub**: [@yuhanbo758](https://github.com/yuhanbo758)

- **Email**: yuhanbo@sanrenjz.com

- **Website**: [三人聚智](https://www.sanrenjz.com)

## 🌐 相关链接

- 🏠 [项目主页](https://www.sanrenjz.com)

- 📚 [在线文档](https://docs.sanrenjz.com)（财经、代码和库文档等）

- 🛒 [插件商店](https://shop.sanrenjz.com)（所有程序，包括开源和不开源）


## 联系我们

[联系我们 - 三人聚智-余汉波](https://www.sanrenjz.com/contact_us/)

证券开户（+V：yuhanbo758）：[证券开户免5万0.854，无门槛开量化QMT，送框架策略，支持VIP快速通道，也可开Ptrade | 余汉波 文档](https://docs.sanrenjz.com/article/%E8%AF%81%E5%88%B8%E5%BC%80%E6%88%B7%E5%85%8D5%20%E4%B8%870.854%EF%BC%8C%E6%97%A0%E9%97%A8%E6%A7%9B%E5%BC%80%E9%87%8F%E5%8C%96QMT%EF%BC%8C%E9%80%81%E6%A1%86%E6%9E%B6%E7%AD%96%E7%95%A5%EF%BC%8C%E6%94%AF%E6%8C%81VIP%E5%BF%AB%E9%80%9F%E9%80%9A%E9%81%93%EF%BC%8C%E4%B9%9F%E5%8F%AF%E5%BC%80Ptrade)

三人聚智下载：[sanrenjz - 三人聚智](https://www.sanrenjz.com/sanrenjz/)

codebot 下载：[sanrenjz-codebot - 三人聚智-余汉波](https://www.sanrenjz.com/sanrenjz-codebot/)

![三码合一](https://gdsx.sanrenjz.com/image/sanrenjz_yuhanbolh_yuhanbo758.png?imageSlim&t=1ab9b82c-e220-8022-beff-e265a194292a)

![余汉波打赏码](https://gdsx.sanrenjz.com/image/%E6%89%93%E8%B5%8F%E7%A0%81%E5%90%88%E4%B8%80.png?imageSlim)

## 🙏 致谢

感谢所有为本项目贡献代码和想法的开发者们！

---
**⭐ 如果这个项目对您有帮助，请给它一个 Star！**
<!-- sanrenjz-promotion:end -->
