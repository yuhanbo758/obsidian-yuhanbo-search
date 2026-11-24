const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

// 直接加载发布入口；模拟 API 和 DOM，不启动或改写用户的 Obsidian 笔记。
class Element {
    constructor(tag = 'div', text = '') {
        this.tag = tag; this._text = text; this.children = []; this.listeners = new Map();
        this.dataset = {}; this.style = {}; this.classList = { add() {} };
    }
    createEl(tag, options = {}) { const node = new Element(tag, options.text || ''); this.appendChild(node); return node; }
    createDiv() { return this.createEl('div'); }
    appendChild(node) { this.children.push(node); return node; }
    empty() { this.children = []; }
    remove() { this.removed = true; }
    addEventListener(event, callback) { this.listeners.set(event, callback); }
    setText(text) { this.textContent = text; }
    set textContent(value) { this._text = value; this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(_) { throw new Error('禁止把笔记内容写入 innerHTML'); }
    removeClass() {}
    addClass() {}
}
class TFile {
    constructor(filePath) {
        this.path = filePath; this.name = filePath.split('/').pop(); this.basename = this.name.replace(/\.md$/, '');
        this.extension = 'md'; this.stat = { mtime: Date.now() }; this.parent = { path: path.posix.dirname(filePath) };
    }
}
class Base {}
const document = {
    createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text),
    createDocumentFragment: () => new Element('#fragment'),
};
const errors = [];
const sandbox = {
    module: { exports: {} }, document, console: { log() {}, error: (...args) => errors.push(args) },
    performance, setTimeout, clearTimeout, window: { setTimeout, clearTimeout },
    require(id) {
        if (id === 'obsidian') return { Plugin: Base, PluginSettingTab: Base, Modal: Base, TFile, TFolder: Base, Notice: Base, MarkdownView: Base };
        throw new Error('隔离可选的其他插件依赖');
    },
};
vm.createContext(sandbox);
const pluginPath = path.join(__dirname, '..', 'main.js');
vm.runInContext(fs.readFileSync(pluginPath, 'utf8') + '\nmodule.exports.testApi = { SearchModal, AutoCompleteSuggester, DEFAULT_SETTINGS, SearchCancelledError };', sandbox, { filename: pluginPath });
const Plugin = sandbox.module.exports;
const { SearchModal, AutoCompleteSuggester, DEFAULT_SETTINGS, SearchCancelledError } = Plugin.testApi;
function fixture(entries = { 'fixture.md': 'target text' }) {
    const plugin = new Plugin();
    const files = Object.keys(entries).map(p => new TFile(p));
    plugin.settings = { ...DEFAULT_SETTINGS, contentWeight: 1, enableTimeDecay: false, enableTagPriority: false };
    plugin.searchIndex = {};
    plugin.bm25DocMeta = new Map();
    plugin.app = {
        vault: {
            getMarkdownFiles: () => files, getFiles: () => files,
            getAbstractFileByPath: p => files.find(f => f.path === p), cachedRead: async f => entries[f.path],
        },
        metadataCache: { getFileCache: () => ({ headings: [] }) },
        workspace: { getActiveViewOfType: () => null },
    };
    for (const file of files) plugin.searchIndex[file.path] = {
        fileName: file.name, directory: file.parent.path, content: entries[file.path], tags: [], headings: { h1: [], h2: [], h3: [], h4: [] }, quotes: [],
    };
    return plugin;
}
const onlyContent = { fileName: false, directory: false, tags: false, headings: false, content: true, quotes: false };
function modal(plugin) {
    const value = Object.create(SearchModal.prototype);
    Object.assign(value, { plugin, options: onlyContent, selectedFolders: new Set(), searchResultsEl: new Element(), searchResults: [], allSearchResults: [], closed: false });
    return value;
}
function result(name) { return { file: { name, path: name + '.md' }, score: 1, matches: [{ type: 'content', context: 'target', line: 0 }] }; }
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }

test('正文保留非重叠命中次数、评分和行号，仅保存三条预览', async () => {
    const plugin = fixture({ 'f.md': 'TARGET target\nsecond target\nthird target\nlast target' });
    const [value] = await plugin.search('target', onlyContent);
    assert.equal(value.score, 5); assert.equal(value.matchCount, 5);
    assert.deepEqual(Array.from(value.matches, m => m.line), [0, 0, 1]);
    assert.equal(value.firstLineMatch.line, 0);
});
test('多关键词分别累计行号，重复关键词保留原有评分语义', async () => {
    const [value] = await fixture({ 'f.md': 'alpha\nbeta\nalpha beta' }).search('alpha beta alpha', onlyContent);
    assert.equal(value.matchCount, 6); assert.equal(value.score, 6);
    assert.deepEqual(Array.from(value.matches, m => m.line), [0, 2, 1]);
});
test('CRLF、空行和末尾行的定位正确', async () => {
    const [value] = await fixture({ 'f.md': '\r\n\r\ntarget\r\n\r\ntarget' }).search('target', onlyContent);
    assert.deepEqual(Array.from(value.matches, m => m.line), [2, 4]);
});
test('预览上限不会丢失正文跳转目标', async () => {
    const plugin = fixture({ 'target.md': 'target' }); plugin.settings.fileNameWeight = 10;
    const [value] = await plugin.search('target target target target', { ...onlyContent, fileName: true });
    assert.equal(value.matches.length, 3); assert.ok(value.matches.every(m => m.type === 'fileName'));
    assert.equal(value.firstLineMatch.line, 0);
    const view = modal(plugin); let state;
    view.app = { workspace: { openLinkText: (...args) => state = args[3] } }; view.close = () => {};
    view.openResult(value); assert.equal(state.eState.line, 0);
});
test('长文件扫描期间允许计时器运行，并保留完整计分', async () => {
    const plugin = fixture({ 'f.md': 'target\n'.repeat(300000) }); let heartbeat = false;
    const timer = setTimeout(() => heartbeat = true, 0);
    const [value] = await plugin.search('target', onlyContent);
    clearTimeout(timer); assert.equal(heartbeat, true); assert.equal(value.matchCount, 300000); assert.equal(value.matches.length, 3);
});
test('旧搜索较晚完成时不能覆盖新结果', async () => {
    const old = deferred(); const plugin = fixture();
    plugin.search = q => q === 'old' ? old.promise : Promise.resolve([result('new')]);
    const view = modal(plugin); const oldWork = view.performSearch('old'); await view.performSearch('new');
    old.resolve([result('old')]); await oldWork; assert.equal(view.searchResults[0].file.name, 'new');
});
test('5000 条搜索结果首次只显示100条，加载更多保留顺序与总数', async () => {
    const plugin = fixture(); plugin.search = async () => Array.from({ length: 5000 }, (_, i) => result(String(i)));
    const view = modal(plugin); await view.performSearch('target');
    assert.equal(view.searchResults.length, 100); assert.equal(view.resultsListEl.children.length, 100);
    assert.equal(view.allSearchResults.length, 5000); assert.match(view.resultsCountEl.textContent, /5000/);
    for (let i = 0; i < 49; i++) view.renderNextResults();
    assert.equal(view.searchResults.length, 5000); assert.equal(view.searchResults[4999].file.name, '4999');
    assert.equal(view.moreResultsButton, null);
    view.renderNextResults();
    assert.equal(view.searchResults.length, 5000);
});
test('所有正则元字符均按字面高亮，HTML 内容不进入 innerHTML', () => {
    for (const keyword of ['test[', '(a+)+$', '.*', 'a\\b', '${x}', '^end', 'a|b', 'x?']) {
        const text = 'prefix ' + keyword + ' <img src=x onerror=alert(1)> tail';
        const node = new Element();
        AutoCompleteSuggester.prototype.appendHighlightedText(node, text, keyword);
        assert.equal(node.textContent, text);
        assert.deepEqual(Array.from(node.children.filter(c => c.tag === 'mark'), c => c.textContent), [keyword]);
    }
});
test('大小写和重叠关键词高亮不破坏文本', () => {
    const node = new Element();
    AutoCompleteSuggester.prototype.appendHighlightedText(node, 'Test testing TEST', 'test testing');
    assert.equal(node.textContent, 'Test testing TEST');
    assert.deepEqual(Array.from(node.children.filter(c => c.tag === 'mark'), c => c.textContent), ['Test', 'testing', 'TEST']);
});
test('此前引起正则回溯的输入快速完成', () => {
    const text = 'a'.repeat(32) + '! test (a+)+$'; const start = performance.now();
    const node = new Element();
    AutoCompleteSuggester.prototype.appendHighlightedText(node, text, 'test (a+)+$');
    assert.equal(node.textContent, text); assert.ok(performance.now() - start < 100);
});
test('补全最多保留10条，完整内容仍可插入', async () => {
    const text = 'target '.repeat(40); const plugin = fixture({ 'f.md': (text + '\n').repeat(1000) });
    const values = await plugin.searchContent('target'); assert.equal(values.length, 10);
    assert.equal(values[0].content, text.trim()); assert.ok(values[0].preview.length < values[0].content.length);
});
test('补全扫描取消后立即退出', async () => {
    const plugin = fixture();
    await assert.rejects(plugin.searchContent('target', { cancelled: true }), SearchCancelledError);
    await assert.rejects(plugin.searchHeadings('target', { cancelled: true }), SearchCancelledError);
    await assert.rejects(plugin.searchBlocks('target', { cancelled: true }), SearchCancelledError);
});
test('并发索引更新只读取一次，完成前保留完整旧索引', async () => {
    const plugin = fixture(); const oldIndex = plugin.searchIndex; const work = deferred(); let reads = 0;
    plugin.app.vault.cachedRead = () => { reads++; return work.promise; };
    const first = plugin.updateSearchIndex(); const second = plugin.updateSearchIndex();
    assert.equal(plugin.searchIndex, oldIndex); assert.equal(reads, 1);
    work.resolve('target'); await Promise.all([first, second]);
    assert.notEqual(plugin.searchIndex, oldIndex); assert.equal(Object.keys(plugin.searchIndex).length, 1);
});
test('插件卸载后索引任务停止，不发布半成品索引', async () => {
    const plugin = fixture(); const oldIndex = plugin.searchIndex; const work = deferred();
    plugin.app.vault.cachedRead = () => work.promise;
    const pending = plugin.updateSearchIndex(); plugin.onunload(); work.resolve('target'); await pending;
    assert.equal(plugin.searchIndex, oldIndex); assert.equal(plugin.unloaded, true);
});
test('取消长文件扫描时，当前文件也会停止', async () => {
    const plugin = fixture({ 'f.md': 'target\n'.repeat(300000) }); const task = { cancelled: false };
    setTimeout(() => task.cancelled = true, 0);
    await assert.rejects(plugin.search('target', onlyContent, task), SearchCancelledError);
});
test('并发索引更新在卸载后都正常结束', async () => {
    const plugin = fixture(); const work = deferred(); plugin.app.vault.cachedRead = () => work.promise;
    const first = plugin.updateSearchIndex(); const second = plugin.updateSearchIndex();
    plugin.onunload(); work.resolve('target'); await Promise.all([first, second]);
});
test('关闭窗口取消防抖计时器和未完成搜索', async () => {
    const work = deferred(); const plugin = fixture(); plugin.search = () => work.promise;
    const view = modal(plugin); view.contentEl = new Element(); view.modalEl = new Element();
    const pending = view.performSearch('target');
    let fired = false; view.searchDebounceTimer = setTimeout(() => fired = true, 0);
    view.onClose(); work.resolve([]); await pending;
    await new Promise(r => setTimeout(r, 5));
    assert.equal(fired, false);
    assert.equal(view.searchTask.cancelled, true);
    assert.equal(view.searchResultsEl, null);
});
test('三种补全触发符按最长标记分流，排除文件夹适用于补全', async () => {
    const plugin = fixture({ 'notes/a.md': 'target', 'notes-other/b.md': 'target' });
    const calls = [];
    plugin.runAutoCompleteSearch = (...args) => calls.push([args[0].name, args[4]]);
    for (const line of ['@@target', '@@# target', '@@@ target']) plugin.checkAutoCompleteTrigger({}, {}, line);
    assert.deepEqual(calls, [['searchContent', 'target'], ['searchHeadings', 'target'], ['searchBlocks', 'target']]);
    plugin.settings.excludedFolders = 'notes/';
    const suggestions = await plugin.searchContent('target');
    assert.deepEqual(Array.from(suggestions, v => v.filePath), ['notes-other/b.md']);
});
test('切换编辑器后不显示先前补全结果', async () => {
    const plugin = fixture(); const work = deferred(); let shown = false;
    const editor = { getCursor: () => ({ line: 0, ch: 8 }), getLine: () => '@@target' };
    plugin.app.workspace.getActiveViewOfType = () => ({ editor });
    plugin.autoComplete = { showSuggestions: () => shown = true };
    const pending = plugin.runAutoCompleteSearch(() => work.promise, editor, { line: 0, ch: 8 }, '@@target', 'target');
    plugin.app.workspace.getActiveViewOfType = () => ({ editor: {} });
    work.resolve([result('old')]); await pending;
    assert.equal(shown, false);
});
test('Unicode 小写转换长度变化时，仍跳到正确行', async () => {
    const [value] = await fixture({ 'f.md': 'İİİİİtarget\ntarget' }).search('target', onlyContent);
    assert.deepEqual(Array.from(value.matches, m => m.line), [0, 1]);
});
test('上述异常路径没有非预期控制台错误', () => assert.equal(errors.length, 0));
