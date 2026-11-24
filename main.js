// 直接使用Obsidian提供的API
const { Plugin, PluginSettingTab, TFile, Notice, Modal, Setting, MarkdownView } = require('obsidian');

// 搜索按时间片让出主线程，取消后禁止继续扫描或更新界面。
class SearchCancelledError extends Error {}
function checkSearchTask(plugin, task) {
	if (plugin.unloaded || (task && task.cancelled)) throw new SearchCancelledError();
}
function createSearchBudget(plugin, task) {
	let lastYield = performance.now();
	return () => {
		checkSearchTask(plugin, task);
		if (performance.now() - lastYield < 8) return null;
		return new Promise(resolve => setTimeout(resolve, 0)).then(() => {
			checkSearchTask(plugin, task);
			lastYield = performance.now();
		});
	};
}
function addSuggestion(results, suggestion) {
	// 只保存得分最高的十条，避免高频关键词占用大量内存和排序时间。
	results.push(suggestion);
	results.sort((a, b) => b.score - a.score);
	if (results.length > 10) results.pop();
}
function isPathInFolder(path, folder) {
	const normalized = String(folder).replace(/\\/g, '/').replace(/\/+$/, '');
	return !normalized || normalized === '/' || path === normalized || path.startsWith(normalized + '/');
}


/**
 * 智能补全建议类
 * 管理补全建议的显示和交互
 */
class AutoCompleteSuggester {
	constructor(app, plugin) {
		this.app = app;
		this.plugin = plugin;
		this.isActive = false;
		this.suggestions = [];
		this.selectedIndex = 0; // 默认选中第一个
		this.triggerInfo = null; // 存储触发信息
		this.suggestionEl = null;
	}

	/**
	 * 显示补全建议
	 * @param {EditorPosition} cursorPos - 光标位置
	 * @param {string} trigger - 触发符
	 * @param {string} query - 查询字符串
	 * @param {Array} suggestions - 建议列表
	 */
	showSuggestions(cursorPos, trigger, query, suggestions) {
		this.hideSuggestions();
		
		if (!suggestions || suggestions.length === 0) return;

		this.isActive = true;
		this.suggestions = suggestions;
		this.selectedIndex = 0; // 默认选中第一个
		this.triggerInfo = { cursorPos, trigger, query };

		// 创建建议容器
		this.suggestionEl = document.createElement('div');
		this.suggestionEl.className = 'yuhanbo-autocomplete-suggestions';

		// 添加建议项
		suggestions.forEach((suggestion, index) => {
			const item = document.createElement('div');
			item.className = 'yuhanbo-suggestion-item';

			// 所有来自笔记和文件名的内容均通过 textContent/createTextNode 渲染，
			// 避免把用户数据解释为 HTML。
			const title = document.createElement('div');
			title.className = suggestion.type === 'heading'
				? 'yuhanbo-suggestion-title is-heading'
				: 'yuhanbo-suggestion-title';
			const prefix = suggestion.type === 'heading' ? '📝 ' : suggestion.type === 'block' ? '🔗 ' : '';
			title.appendChild(document.createTextNode(prefix));
			this.appendHighlightedText(
				title,
				suggestion.type === 'heading' ? suggestion.text : suggestion.preview,
				query
			);
			item.appendChild(title);

			const file = document.createElement('div');
			file.className = 'yuhanbo-suggestion-file';
			file.textContent = suggestion.file;
			item.appendChild(file);

			item.addEventListener('click', () => this.selectSuggestion(index));
			item.addEventListener('mouseenter', () => this.setSelectedIndex(index));
			
			this.suggestionEl.appendChild(item);
		});

		// 定位建议框
		this.positionSuggestions(cursorPos);
		
		// 添加到DOM
		document.body.appendChild(this.suggestionEl);
		
		// 默认选中第一个
		this.setSelectedIndex(0);
	}

	/**
	 * 高亮匹配的文本
	 * @param {string} text - 原文本
	 * @param {string} query - 查询字符串
	 * @param {HTMLElement} container - 承载高亮文本的容器
	 */
	appendHighlightedText(container, text, query) {
		const safeText = String(text ?? '');
		const keywords = String(query ?? '')
			.split(/\s+/)
			.filter(Boolean)
			.sort((a, b) => b.length - a.length)
			.map(keyword => keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

		if (keywords.length === 0) {
			container.appendChild(document.createTextNode(safeText));
			return;
		}

		const matcher = new RegExp(`(${keywords.join('|')})`, 'gi');
		for (const part of safeText.split(matcher)) {
			if (!part) continue;
			if (matcher.test(part)) {
				const mark = document.createElement('mark');
				mark.textContent = part;
				container.appendChild(mark);
			} else {
				container.appendChild(document.createTextNode(part));
			}
			matcher.lastIndex = 0;
		}
	}

	/**
	 * 定位建议框位置
	 * @param {EditorPosition} cursorPos - 光标位置
	 */
	positionSuggestions(cursorPos) {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return;

		const editor = activeView.editor;
		const coords = editor.coordsAtPos(cursorPos);

		if (coords) {
			this.suggestionEl.setCssProps({
				'--yuhanbo-suggestion-left': `${coords.left}px`,
				'--yuhanbo-suggestion-top': `${coords.bottom + 5}px`
			});
		}
	}

	/**
	 * 隐藏建议
	 */
	hideSuggestions() {
		if (this.suggestionEl) {
			this.suggestionEl.remove();
			this.suggestionEl = null;
		}
		this.isActive = false;
		this.suggestions = [];
		this.selectedIndex = 0;
		this.triggerInfo = null;
	}

	/**
	 * 设置选中的建议索引
	 * @param {number} index - 索引
	 */
	setSelectedIndex(index) {
		if (index < 0 || index >= this.suggestions.length) return;

		// 移除之前的选中状态
		if (this.selectedIndex >= 0) {
			const prevItem = this.suggestionEl.children[this.selectedIndex];
			if (prevItem) {
				prevItem.classList.remove('is-selected');
			}
		}

		// 设置新的选中状态
		this.selectedIndex = index;
		const currentItem = this.suggestionEl.children[this.selectedIndex];
		if (currentItem) {
			currentItem.classList.add('is-selected');
			currentItem.scrollIntoView({ block: 'nearest' });
		}
	}

	/**
	 * 选择建议并插入
	 * @param {number} index - 建议索引
	 */
	selectSuggestion(index) {
		if (index < 0 || index >= this.suggestions.length || !this.triggerInfo) {
			return;
		}

		const suggestion = this.suggestions[index];
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			return;
		}

		const editor = activeView.editor;
		const currentCursor = editor.getCursor();

		// 计算替换范围 - 从触发符开始到当前光标位置
		const triggerStart = {
			line: this.triggerInfo.cursorPos.line,
			ch: this.triggerInfo.cursorPos.ch - this.triggerInfo.trigger.length
		};

		// 根据建议类型和触发符生成插入内容
		let insertText = '';
		
		if (suggestion.type === 'content') {
			// 块快捷输入 (@@) - 直接插入内容，不带链接
			insertText = suggestion.content;
		} else if (suggestion.type === 'heading') {
			// 标题引用 (@@#) - 插入可跳转的链接格式
			insertText = `[[${suggestion.file}#${suggestion.text}|${suggestion.text}]]`;
		} else if (suggestion.type === 'block') {
			// 块引用 (@@@) - 插入可跳转的链接格式，使用完整内容而不是预览
			insertText = `[[${suggestion.file}#^${suggestion.blockId}|${suggestion.content}]]`;
		}

		// 替换文本 - 使用当前光标位置而不是保存的位置
		editor.replaceRange(insertText, triggerStart, currentCursor);

		// 隐藏建议
		this.hideSuggestions();
	}

	/**
	 * 处理键盘事件
	 * @param {KeyboardEvent} event - 键盘事件
	 * @returns {boolean} - 是否处理了事件
	 */
	handleKeyDown(event) {
		if (!this.isActive) return false;

		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				this.setSelectedIndex((this.selectedIndex + 1) % this.suggestions.length);
				return true;
				
			case 'ArrowUp':
				event.preventDefault();
				this.setSelectedIndex((this.selectedIndex - 1 + this.suggestions.length) % this.suggestions.length);
				return true;
				
			case 'Enter':
				event.preventDefault();
				this.selectSuggestion(this.selectedIndex);
				return true;
				
			case 'Escape':
				event.preventDefault();
				this.hideSuggestions();
				return true;
				
			default:
				return false;
		}
	}
}

// 默认设置
const DEFAULT_SETTINGS = {
	fileNameWeight: 10,
	directoryWeight: 9,
	tagWeight: 8,
	heading1Weight: 7,
	heading2Weight: 6,
	heading3Weight: 5,
	heading4Weight: 4,
	contentWeight: 3,
	quoteWeight: 2,
	excludedFolders: '',
	cacheUpdateInterval: 60,
	autoUpdateCache: true,
	// 智能补全相关设置
	enableAutoComplete: true,
	autoCompleteFolders: '', // 智能补全搜索的文件夹范围
	minChineseLength: 2, // 中文最小搜索长度
	minEnglishLength: 4, // 英文最小搜索长度
}

// 主插件类
class YuhanboSearchPlugin extends Plugin {
	
	async onload() {
		this.unloaded = false;
		// 初始化索引和时间戳
		this.searchIndex = {};
		this.lastIndexTime = 0;
		
		// 加载设置
		await this.loadSettings();

		// 初始化智能补全建议器
		this.autoComplete = new AutoCompleteSuggester(this.app, this);

		// 添加左侧栏图标
		const ribbonIconEl = this.addRibbonIcon('search', '自定义加权搜索', (evt) => {
			new SearchModal(this.app, this).open();
		});
		ribbonIconEl.addClass('yuhanbo-search-ribbon-class');

		// 添加状态栏项目
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('加权搜索已加载');

		// 添加命令
		this.addCommand({
			id: 'open-yuhanbo-search-modal',
			name: '打开加权搜索',
			callback: () => {
				const searchModal = new SearchModal(this.app, this);
				searchModal.open();
				// 聚焦逻辑已移至 onOpen 方法中，无需在这里重复
			}
		});

		// 添加设置选项卡
		this.addSettingTab(new YuhanboSearchSettingTab(this.app, this));

		// 注册编辑器监听器（智能补全功能）
		this.registerEditorExtension();

		// 根据设置决定是否注册定期更新索引的计时器
		if (this.settings.autoUpdateCache) {
			this.registerInterval(
				window.setInterval(() => this.updateSearchIndex(false), this.settings.cacheUpdateInterval * 60 * 1000)
			);

			this.app.workspace.onLayoutReady(() => this.updateSearchIndex(false));
		} else {
			this.app.workspace.onLayoutReady(() => this.updateSearchIndex(false));
		}
	}

	/**
	 * 注册编辑器扩展，监听用户输入
	 */
	registerEditorExtension() {
		// 监听编辑器变化事件
		this.registerEvent(
			this.app.workspace.on('editor-change', (editor) => {
				this.cancelAutoComplete();
				if (!this.settings.enableAutoComplete || this.unloaded) return;
				
				const cursor = editor.getCursor();
				const line = editor.getLine(cursor.line);
				const beforeCursor = line.substring(0, cursor.ch);
				
				// 输入期间做短暂防抖，避免大型仓库中每个按键都触发一次全量搜索。
				window.clearTimeout(this.autoCompleteTimer);
				this.autoCompleteTimer = window.setTimeout(() => {
					if (this.settings.enableAutoComplete && !this.unloaded) this.checkAutoCompleteTrigger(editor, cursor, beforeCursor);
				}, 200);
			})
		);
		this.register(() => window.clearTimeout(this.autoCompleteTimer));

		// 监听键盘事件 - 使用捕获阶段确保优先处理
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
			window.clearTimeout(this.autoCompleteTimer);
			this.cancelAutoComplete();
		}));
		this.registerDomEvent(document, 'keydown', (event) => {
			if (this.autoComplete.handleKeyDown(event)) {
				event.stopImmediatePropagation();
				event.preventDefault();
				return false;
			}
		}, true); // 使用捕获阶段
	}

	/**
	 * 检查是否触发智能补全
	 * @param {Editor} editor - 编辑器实例
	 * @param {EditorPosition} cursor - 光标位置
	 * @param {string} beforeCursor - 光标前的文本
	 */
	cancelAutoComplete() {
		if (this.autoCompleteTask) this.autoCompleteTask.cancelled = true;
		this.autoComplete.hideSuggestions();
	}

	checkAutoCompleteTrigger(editor, cursor, beforeCursor) {
		const match = beforeCursor.match(/(@{2,})([^@]*)$/);
		if (!match) return;
		const [, prefix, suffix] = match;
		let query = suffix;
		let search = this.searchContent;
		if (prefix === '@@@' && /^\s/.test(suffix)) {
			search = this.searchBlocks;
		} else if (prefix === '@@' && /^#\s/.test(suffix)) {
			search = this.searchHeadings;
			query = suffix.slice(1);
		} else if (prefix !== '@@' || suffix.startsWith('#')) {
			return;
		}
		query = query.trim();
		if (this.isValidQuery(query)) void this.runAutoCompleteSearch(search, editor, cursor, match[0], query);
	}

	/**
	 * 验证查询是否有效
	 * @param {string} query - 查询字符串
	 * @returns {boolean} - 是否有效
	 */
	isValidQuery(query) {
		if (!query) return false;

		// 检查中文字符
		const chineseChars = query.match(/[\u4e00-\u9fff]/g);
		if (chineseChars && chineseChars.length >= this.settings.minChineseLength) {
			return true;
		}

		// 检查英文字符
		const englishChars = query.match(/[a-zA-Z]/g);
		if (englishChars && englishChars.length >= this.settings.minEnglishLength) {
			return true;
		}

		return false;
	}

	async runAutoCompleteSearch(search, editor, cursor, trigger, query) {
		const task = { cancelled: false };
		this.autoCompleteTask = task;
		try {
			const suggestions = await search.call(this, query, task);
			checkSearchTask(this, task);
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!this.settings.enableAutoComplete || view?.editor !== editor) return;
			const current = editor.getCursor();
			if (current.line !== cursor.line || current.ch !== cursor.ch ||
				!editor.getLine(current.line).slice(0, current.ch).endsWith(trigger)) return;
			this.autoComplete.showSuggestions(cursor, trigger, query, suggestions);
		} catch (error) {
			if (!(error instanceof SearchCancelledError)) console.error('智能补全搜索失败', error);
		}
	}

	async searchContent(query, task = null) {
		const checkpoint = createSearchBudget(this, task);
		const results = [];
		const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 0);

		const searchFolders = this.getSearchFolders();
		const excludedFolders = this.getExcludedFolders();
		const files = this.app.vault.getMarkdownFiles();

		for (const file of files) {
			const pause = checkpoint();
			if (pause) await pause;

			if (!this.isFileInSearchScope(file, searchFolders) || excludedFolders.some(folder => isPathInFolder(file.path, folder))) continue;

			try {
				const content = await this.app.vault.cachedRead(file);
				checkSearchTask(this, task);
				const lines = content.split('\n');

				for (let i = 0; i < lines.length; i++) {
					if (i % 128 === 0) { const pause = checkpoint(); if (pause) await pause; }
					const line = lines[i];
					const lowerLine = line.toLowerCase();
					
					// 计算匹配分数
					let score = 0;
					let matchCount = 0;
					
					for (const keyword of keywords) {
						if (lowerLine.includes(keyword)) {
							matchCount++;
							// 完整单词匹配得分更高
							if (lowerLine.includes(' ' + keyword + ' ') || 
								lowerLine.startsWith(keyword + ' ') || 
								lowerLine.endsWith(' ' + keyword)) {
								score += 3;
							} else {
								score += 1;
							}
						}
					}

					// 只有所有关键词都匹配才加入结果
					if (matchCount === keywords.length && line.trim().length > 0) {
						addSuggestion(results, {
							type: 'content',
							content: line.trim(),
							preview: this.truncateText(line.trim(), 60),
							file: file.basename,
							filePath: file.path,
							line: i,
							score: score
						});
					}
				}
			} catch (error) {
				if (error instanceof SearchCancelledError) throw error;
				console.error(`读取文件 ${file.path} 失败:`, error);
			}
		}

		// 按分数排序并限制结果数量
		return results;
	}

	/**
	 * 搜索标题 - 使用加权搜索算法
	 * @param {string} query - 查询字符串
	 * @returns {Array} - 搜索结果
	 */
	async searchHeadings(query, task = null) {
		const checkpoint = createSearchBudget(this, task);
		const results = [];
		const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 0);

		const searchFolders = this.getSearchFolders();
		const excludedFolders = this.getExcludedFolders();
		const files = this.app.vault.getMarkdownFiles();

		for (const file of files) {
			const pause = checkpoint();
			if (pause) await pause;

			if (!this.isFileInSearchScope(file, searchFolders) || excludedFolders.some(folder => isPathInFolder(file.path, folder))) continue;

			const fileCache = this.app.metadataCache.getFileCache(file);
			if (fileCache && fileCache.headings) {
				let headingCount = 0;
				for (const heading of fileCache.headings) {
					if (headingCount++ % 128 === 0) { const pause = checkpoint(); if (pause) await pause; }
					const headingText = heading.heading.toLowerCase();
					
					// 计算匹配分数
					let score = 0;
					let matchCount = 0;
					
					for (const keyword of keywords) {
						if (headingText.includes(keyword)) {
							matchCount++;
							// 根据标题级别给予不同权重
							const levelWeight = Math.max(1, 5 - heading.level);
							score += levelWeight;
						}
					}

					// 只有所有关键词都匹配才加入结果
					if (matchCount === keywords.length) {
						addSuggestion(results, {
							type: 'heading',
							text: heading.heading,
							level: heading.level,
							file: file.basename,
							filePath: file.path,
							line: heading.position.start.line,
							score: score
						});
					}
				}
			}
		}

		// 按分数排序并限制结果数量
		return results;
	}

	/**
	 * 搜索块 - 使用加权搜索算法
	 * @param {string} query - 查询字符串
	 * @returns {Array} - 搜索结果
	 */
	async searchBlocks(query, task = null) {
		const checkpoint = createSearchBudget(this, task);
		const results = [];
		const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 0);

		const searchFolders = this.getSearchFolders();
		const excludedFolders = this.getExcludedFolders();
		const files = this.app.vault.getMarkdownFiles();

		for (const file of files) {
			const pause = checkpoint();
			if (pause) await pause;

			if (!this.isFileInSearchScope(file, searchFolders) || excludedFolders.some(folder => isPathInFolder(file.path, folder))) continue;

			try {
				const content = await this.app.vault.cachedRead(file);
				checkSearchTask(this, task);
				const lines = content.split('\n');

				for (let i = 0; i < lines.length; i++) {
					if (i % 128 === 0) { const pause = checkpoint(); if (pause) await pause; }
					const line = lines[i];
					const lowerLine = line.toLowerCase();
					
					// 计算匹配分数
					let score = 0;
					let matchCount = 0;
					
					for (const keyword of keywords) {
						if (lowerLine.includes(keyword)) {
							matchCount++;
							score += 1;
						}
					}

					// 只有所有关键词都匹配才加入结果
					if (matchCount === keywords.length && line.trim().length > 0) {
						const blockId = this.generateBlockId(line, i);
						
						addSuggestion(results, {
							type: 'block',
							content: line.trim(),
							preview: this.truncateText(line.trim(), 60),
							file: file.basename,
							filePath: file.path,
							line: i,
							blockId: blockId,
							score: score
						});
					}
				}
			} catch (error) {
				if (error instanceof SearchCancelledError) throw error;
				console.error(`读取文件 ${file.path} 失败:`, error);
			}
		}

		// 按分数排序并限制结果数量
		return results;
	}

	/**
	 * 获取搜索文件夹范围
	 * @returns {Array} - 文件夹路径数组
	 */
	getSearchFolders() {
		if (!this.settings.autoCompleteFolders) return [];
		return this.settings.autoCompleteFolders.split(',').map(f => f.trim()).filter(f => f);
	}

	/**
	 * 检查文件是否在搜索范围内
	 * @param {TFile} file - 文件对象
	 * @param {Array} searchFolders - 搜索文件夹数组
	 * @returns {boolean} - 是否在范围内
	 */
	isFileInSearchScope(file, searchFolders) {
		if (searchFolders.length === 0) return true;
		return searchFolders.some(folder => isPathInFolder(file.path, folder));
	}

	/**
	 * 截断文本
	 * @param {string} text - 原文本
	 * @param {number} maxLength - 最大长度
	 * @returns {string} - 截断后的文本
	 */
	truncateText(text, maxLength) {
		if (text.length <= maxLength) return text;
		return text.substring(0, maxLength) + '...';
	}

	/**
	 * 生成块ID
	 * @param {string} content - 块内容
	 * @param {number} lineNumber - 行号
	 * @returns {string} - 块ID
	 */
	generateBlockId(content, lineNumber) {
		const hash = content.replace(/\s+/g, '').substring(0, 6);
		return `${hash}-${lineNumber}`;
	}

	onunload() {
		this.unloaded = true;
		if (this.autoCompleteTask) this.autoCompleteTask.cancelled = true;
		if (this.autoComplete) {
			this.autoComplete.hideSuggestions();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * 更新搜索索引
	 */
	getExcludedFolders() {
		return this.settings.excludedFolders.split(',').map(folder => folder.trim()).filter(Boolean);
	}

	async updateSearchIndex(showNotice = false) {
		if (this.unloaded) return;
		if (!this.indexUpdatePromise) {
			this.indexUpdatePromise = this.buildSearchIndex().catch(error => {
				if (!(error instanceof SearchCancelledError)) console.error('搜索索引更新失败', error);
				return false;
			}).finally(() => { this.indexUpdatePromise = null; });
		}
		if (await this.indexUpdatePromise && showNotice && !this.unloaded) new Notice('搜索索引已更新');
	}

	async buildSearchIndex() {
		const checkpoint = createSearchBudget(this);
		const excludedFolders = this.getExcludedFolders();
		const nextIndex = Object.create(null);
		for (const file of this.app.vault.getMarkdownFiles()) {
			const pause = checkpoint();
			if (pause) await pause;
			if (excludedFolders.some(folder => isPathInFolder(file.path, folder))) continue;
			try {
				const content = await this.app.vault.cachedRead(file);
				checkSearchTask(this);
				const metadata = this.app.metadataCache.getFileCache(file);
				nextIndex[file.path] = {
					fileName: file.name,
					directory: file.parent ? file.parent.path : '/',
					content,
					tags: this.getAllTags(metadata),
					headings: this.extractHeadings(file),
					quotes: await this.extractQuotes(content, checkpoint)
				};
			} catch (error) {
				if (error instanceof SearchCancelledError) throw error;
				console.error(`索引文件 ${file.path} 时出错:`, error);
			}
		}
		// 避免索引刷新期间搜索读到一半的新数据。
		checkSearchTask(this);
		this.searchIndex = nextIndex;
		this.lastIndexTime = Date.now();
		return true;
	}

	/**
	 * 获取所有标签的辅助函数
	 * @param {Object} fileCache - 文件缓存对象
	 * @returns {Array} - 标签数组
	 */
	getAllTags(fileCache) {
		const tags = [];
		if (!fileCache) return tags;
		
		if (fileCache.frontmatter && fileCache.frontmatter.tags) {
			if (Array.isArray(fileCache.frontmatter.tags)) {
				tags.push(...fileCache.frontmatter.tags);
			} else if (typeof fileCache.frontmatter.tags === 'string') {
				tags.push(fileCache.frontmatter.tags);
			}
		}
		
		if (fileCache.tags) {
			for (const tag of fileCache.tags) {
				tags.push(tag.tag);
			}
		}
		
		return tags;
	}
	
	/**
	 * 提取标题
	 * @param {TFile} file - 文件对象
	 * @returns {Object} - 标题对象
	 */
	extractHeadings(file) {
		const headings = {
			h1: [],
			h2: [],
			h3: [],
			h4: []
		};
		
		const fileCache = this.app.metadataCache.getFileCache(file);
		if (fileCache && fileCache.headings) {
			for (const heading of fileCache.headings) {
				const headingObj = {
					text: heading.heading,
					position: heading.position.start.line
				};
				
				switch (heading.level) {
					case 1:
						headings.h1.push(headingObj);
						break;
					case 2:
						headings.h2.push(headingObj);
						break;
					case 3:
						headings.h3.push(headingObj);
						break;
					case 4:
					case 5:
					case 6:
						headings.h4.push(headingObj);
						break;
				}
			}
		}
		
		return headings;
	}
	
	/**
	 * 提取引用
	 * @param {string} content - 文件内容
	 * @returns {Array} - 引用数组
	 */
	async extractQuotes(content, checkpoint) {
		const quotes = [];
		const lines = content.split('\n');
		
		for (let i = 0; i < lines.length; i++) {
			if (i % 128 === 0) {
				const pause = checkpoint();
				if (pause) await pause;
			}
			if (lines[i].startsWith('>')) {
				quotes.push(lines[i]);
			}
		}
		
		return quotes;
	}
	
	/**
	 * 原有的搜索功能 - 使用加权搜索算法
	 * @param {string} query - 查询字符串
	 * @param {Object} options - 搜索选项
	 * @returns {Array} - 搜索结果
	 */
	async search(query, options = {}, task = null) {
		const checkpoint = createSearchBudget(this, task);
		const index = this.searchIndex;
		const results = [];
		const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 0);
		
		if (keywords.length === 0) return results;
		
		const defaultOptions = {
			fileName: true,
			directory: true,
			tags: true,
			headings: true,
			content: true,
			quotes: true
		};
		
		const searchOptions = {...defaultOptions, ...options};
		
		for (const filePath in index) {
			const pause = checkpoint();
			if (pause) await pause;
			const fileData = index[filePath];
			const file = this.app.vault.getAbstractFileByPath(filePath);
			
			if (!(file instanceof TFile)) continue;
			let fileScore = 0;
			const matches = [];
			let matchCount = 0;
			let firstLineMatch = null;
			const addMatch = match => {
				if (!firstLineMatch && match.line !== undefined) firstLineMatch = match;
				matchCount++;
				if (matches.length < 3) matches.push(match);
			};
			
			// 搜索文件名
			if (searchOptions.fileName) {
				const fileName = fileData.fileName.toLowerCase();
				for (const keyword of keywords) {
					if (fileName.includes(keyword)) {
						const matchScore = this.settings.fileNameWeight;
						fileScore += matchScore;
						addMatch({
							type: 'fileName',
							context: fileData.fileName
						});
					}
				}
			}
			
			// 搜索目录
			if (searchOptions.directory) {
				const directory = fileData.directory.toLowerCase();
				for (const keyword of keywords) {
					if (directory.includes(keyword)) {
						const matchScore = this.settings.directoryWeight;
						fileScore += matchScore;
						addMatch({
							type: 'directory',
							context: fileData.directory
						});
					}
				}
			}
			
			// 搜索标签
			if (searchOptions.tags && fileData.tags) {
				for (const tag of fileData.tags) {
					const pause = checkpoint(); if (pause) await pause;
					const tagText = String(tag ?? '').toLowerCase();
					for (const keyword of keywords) {
						if (tagText.includes(keyword)) {
							const matchScore = this.settings.tagWeight;
							fileScore += matchScore;
							addMatch({
								type: 'tag',
								context: tag
							});
						}
					}
				}
			}

			// 搜索标题
			if (searchOptions.headings) {
				for (const h1 of fileData.headings.h1) {
					const pause = checkpoint(); if (pause) await pause;
					const heading = h1.text.toLowerCase();
					for (const keyword of keywords) {
						if (heading.includes(keyword)) {
							const matchScore = this.settings.heading1Weight;
							fileScore += matchScore;
							addMatch({
								type: 'heading1',
								context: h1.text,
								line: h1.position
							});
						}
					}
				}
				
				for (const h2 of fileData.headings.h2) {
					const pause = checkpoint(); if (pause) await pause;
					const heading = h2.text.toLowerCase();
					for (const keyword of keywords) {
						if (heading.includes(keyword)) {
							const matchScore = this.settings.heading2Weight;
							fileScore += matchScore;
							addMatch({
								type: 'heading2',
								context: h2.text,
								line: h2.position
							});
						}
					}
				}
				
				for (const h3 of fileData.headings.h3) {
					const pause = checkpoint(); if (pause) await pause;
					const heading = h3.text.toLowerCase();
					for (const keyword of keywords) {
						if (heading.includes(keyword)) {
							const matchScore = this.settings.heading3Weight;
							fileScore += matchScore;
							addMatch({
								type: 'heading3',
								context: h3.text,
								line: h3.position
							});
						}
					}
				}
				
				for (const h4 of fileData.headings.h4) {
					const pause = checkpoint(); if (pause) await pause;
					const heading = h4.text.toLowerCase();
					for (const keyword of keywords) {
						if (heading.includes(keyword)) {
							const matchScore = this.settings.heading4Weight;
							fileScore += matchScore;
							addMatch({
								type: 'heading4',
								context: h4.text,
								line: h4.position
							});
						}
					}
				}
			}
			
			if (searchOptions.content && fileData.content) {
				const content = fileData.content;
				const lowerContent = content.toLowerCase();
				const lines = content.split('\n');
				for (const keyword of keywords) {
					let offset = 0;
					let line = 0;
					let nextLineEnd = lowerContent.indexOf('\n');
					let occurrences = 0;
					for (let match = lowerContent.indexOf(keyword); match !== -1; match = lowerContent.indexOf(keyword, offset)) {
						if (occurrences++ % 128 === 0) {
							const pause = checkpoint();
							if (pause) await pause;
						}
						// 用小写文本的换行位置定位，兼容转小写后长度变化的字符。
						while (nextLineEnd !== -1 && nextLineEnd < match && (matches.length < 3 || !firstLineMatch)) {
							line++;
							nextLineEnd = lowerContent.indexOf('\n', nextLineEnd + 1);
							if (line % 128 === 0) {
								const pause = checkpoint();
								if (pause) await pause;
							}
						}
						fileScore += this.settings.contentWeight;
						if (matches.length < 3 || !firstLineMatch) {
							addMatch({ type: 'content', context: lines[line], line });
						} else {
							matchCount++;
						}
						offset = match + keyword.length;
					}
				}
			}

			// 搜索引用
			if (searchOptions.quotes && fileData.quotes) {
				for (let i = 0; i < fileData.quotes.length; i++) {
					if (i % 128 === 0) { const pause = checkpoint(); if (pause) await pause; }
					const quote = fileData.quotes[i].toLowerCase();
					for (const keyword of keywords) {
						if (quote.includes(keyword)) {
							const matchScore = this.settings.quoteWeight;
							fileScore += matchScore;
							addMatch({
								type: 'quote',
								context: fileData.quotes[i]
							});
						}
					}
				}
			}
			
			if (fileScore > 0) {
				results.push({
					file: file,
					score: fileScore,
					matches: matches,
					matchCount: matchCount,
					firstLineMatch: firstLineMatch
				});
			}
		}
		
		results.sort((a, b) => b.score - a.score);
		
		return results;
	}

}

// 搜索模态框类
class SearchModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
		this.options = {
			fileName: true,
			directory: true,
			tags: true,
			headings: true,
			content: false,
			quotes: false
		};
		this.selectedResultIndex = -1;
		this.searchResults = [];
		this.focusTimer = null;
		this.searchDebounceTimer = null;
		this.searchTask = null;
	}

	forceInputFocus() {
		if (!this.searchInput) return;
		
		// 使用多次尝试聚焦的方式，确保在不同情况下都能成功聚焦
		const attemptFocus = (attempts = 0) => {
			if (!this.searchInput) return;
			try {
				this.searchInput.focus();
				this.searchInput.select();
				
				// 如果聚焦失败且尝试次数小于3，则再次尝试
				if (document.activeElement !== this.searchInput && attempts < 3) {
					this.focusTimer = window.setTimeout(() => attemptFocus(attempts + 1), 50);
				}
			} catch (e) {
				console.error("聚焦失败:", e);
			}
		};
		
		// 立即尝试聚焦
		attemptFocus();
	}

	onOpen() {
		this.modalEl.addClass('yuhanbo-search-modal-container');
		
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('yuhanbo-search-modal');
		
		// 确保模态框完全打开后再设置焦点
		this.focusTimer = window.setTimeout(() => this.forceInputFocus(), 50);
		
		contentEl.createEl('div', {
			text: '搜索范围:',
			cls: 'search-scope-label'
		});
		
		const scopeButtonsContainer = contentEl.createDiv('search-scope-buttons');
		
		const options = [
			{ id: 'fileName', label: '文件名' },
			{ id: 'directory', label: '目录' },
			{ id: 'tags', label: '标签' },
			{ id: 'headings', label: '标题' },
			{ id: 'content', label: '内容' },
			{ id: 'quotes', label: '引用' }
		];
		
		options.forEach(option => {
			this.createScopeButton(scopeButtonsContainer, option.label, option.id);
		});
		
		const searchContainer = contentEl.createDiv('search-container');
		this.searchInput = searchContainer.createEl('input', {
			attr: {
				type: 'text',
				placeholder: '输入关键词进行搜索...',
				autofocus: 'autofocus',
				id: 'yuhanbo-search-input'
			},
			cls: 'search-input large yuhanbo-search-input-js'
		});
		
		this.searchResultsEl = contentEl.createDiv('search-results');
		
		
		this.searchInput.addEventListener('input', () => {
			window.clearTimeout(this.searchDebounceTimer);
			this.cancelSearch();
			this.clearSearchResults();
			const query = this.searchInput.value.trim();
			if (query.length >= 2) {
				this.searchDebounceTimer = window.setTimeout(() => this.performSearch(query), 300);
			}
		});

		this.searchInput.addEventListener('keydown', (e) => {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				e.stopPropagation();
			}
			
			if (this.searchResults.length === 0) {
				return;
			}
			
			if (e.key === 'ArrowDown') {
				this.selectNextResult();
			}
			
			if (e.key === 'ArrowUp') {
				this.selectPreviousResult();
			}
			
			if (e.key === 'Enter') {
				if (this.selectedResultIndex >= 0 && this.selectedResultIndex < this.searchResults.length) {
					e.preventDefault();
					this.openResult(this.searchResults[this.selectedResultIndex]);
				} 
				else if (this.searchInput.value.trim().length >= 2) {
					this.performSearch(this.searchInput.value.trim());
				}
			}
		});
		
	}
	
	selectNextResult() {
		if (this.searchResults.length === 0) return;
		
		this.removeSelectionHighlight();
		
		this.selectedResultIndex = (this.selectedResultIndex + 1) % this.searchResults.length;
		
		this.highlightSelectedResult();
	}
	
	selectPreviousResult() {
		if (this.searchResults.length === 0) return;
		
		this.removeSelectionHighlight();
		
		this.selectedResultIndex = (this.selectedResultIndex - 1 + this.searchResults.length) % this.searchResults.length;
		
		this.highlightSelectedResult();
	}
	
	removeSelectionHighlight() {
		if (this.highlightedResultEl) this.highlightedResultEl.removeClass('selected');
		this.highlightedResultEl = null;
	}
	
	highlightSelectedResult() {
		if (this.selectedResultIndex < 0) return;
		
		const allResults = this.resultsListEl ? this.resultsListEl.children : [];
		if (this.selectedResultIndex < allResults.length) {
			const selectedItem = allResults[this.selectedResultIndex];
			selectedItem.addClass('selected');
			this.highlightedResultEl = selectedItem;
			
			const containerRect = this.modalEl.getBoundingClientRect();
			const itemRect = selectedItem.getBoundingClientRect();
			
			if (itemRect.top < containerRect.top || itemRect.bottom > containerRect.bottom) {
				selectedItem.scrollIntoView({
					behavior: 'smooth',
					block: 'nearest'
				});
			}
		}
	}
	
	openResult(result) {
		if (!result || !result.file) return;
		
		const lineMatch = result.firstLineMatch || result.matches.find(m => m.line !== undefined);
		if (lineMatch && lineMatch.line !== undefined) {
			this.app.workspace.openLinkText(result.file.path, '', true, {
				eState: { line: lineMatch.line }
			});
		} else {
			this.app.workspace.openLinkText(result.file.path, '', true);
		}
		this.close();
	}
	
	createScopeButton(container, label, optionName) {
		const button = container.createEl('div', {
			text: label,
			cls: 'search-scope-button' + (this.options[optionName] ? ' active' : '')
		});
		
		button.addEventListener('click', () => {
			this.options[optionName] = !this.options[optionName];
			
			if (this.options[optionName]) {
				button.addClass('active');
			} else {
				button.removeClass('active');
			}
			
			const query = this.searchInput.value.trim();
			if (query.length >= 2) {
				this.performSearch(query);
			}
		});
		
		return button;
	}
	
	clearSearchResults() {
		this.searchResultsEl?.empty();
		this.searchResults = [];
		this.allSearchResults = [];
		this.resultsListEl = null;
		this.resultsCountEl = null;
		this.moreResultsButton = null;
		this.highlightedResultEl = null;
		this.selectedResultIndex = -1;
	}

	cancelSearch() {
		if (this.searchTask) this.searchTask.cancelled = true;
	}

	async performSearch(query = null) {
		if (!this.searchResultsEl) return;
		query = query || (this.searchInput && this.searchInput.value.trim());
		if (!query) return;
		clearTimeout(this.searchDebounceTimer);
		this.cancelSearch();
		const task = { cancelled: false };
		this.searchTask = task;
		this.clearSearchResults();
		const loadingEl = this.searchResultsEl.createEl('div', { text: '正在搜索...', cls: 'search-loading' });
		try {
			const results = await this.plugin.search(query, {...this.options}, task);
			checkSearchTask(this.plugin, task);
			if (this.searchTask !== task || !this.searchResultsEl) return;
			loadingEl.remove();
			if (!results.length) {
				this.searchResultsEl.createEl('div', { text: '没有找到匹配的结果', cls: 'no-results' });
				return;
			}
			this.allSearchResults = results;
			this.resultsCountEl = this.searchResultsEl.createEl('div', { cls: 'results-count' });
			this.resultsListEl = this.searchResultsEl.createDiv('results-list');
			this.moreResultsButton = this.searchResultsEl.createEl('button', { text: '加载更多结果' });
			this.moreResultsButton.addEventListener('click', () => this.renderNextResults());
			this.renderNextResults();
		} catch (error) {
			if (error instanceof SearchCancelledError || !this.searchResultsEl || this.searchTask !== task) return;
			loadingEl.remove();
			this.searchResultsEl.createEl('div', { text: '搜索失败，请查看开发者控制台', cls: 'no-results' });
			console.error('加权搜索失败', error);
		}
	}

	renderNextResults() {
		if (!this.resultsListEl) return;
		// 保留全部排序结果，每次按需显示一百条，避免一次创建整个库的 DOM。
		const start = this.searchResults.length;
		const batch = this.allSearchResults.slice(start, start + 100);
		this.searchResults.push(...batch);
		const resultsList = this.resultsListEl;
		batch.forEach((result, offset) => {
			const index = start + offset;
			const resultItem = resultsList.createDiv('result-item');
			
			resultItem.dataset.resultIndex = index;
			
			resultItem.createEl('div', {
				text: result.file.name,
				cls: 'result-title'
			});
			
			resultItem.addEventListener('click', () => {
				this.openResult(result);
			});
			
			resultItem.addEventListener('mouseenter', () => {
				this.removeSelectionHighlight();
				
				this.selectedResultIndex = index;
				this.highlightSelectedResult();
			});
			
			resultItem.createEl('div', {
				text: result.file.path,
				cls: 'result-path'
			});
			
			const matchesContainer = resultItem.createDiv('matches-container');
			
			const maxMatchesToShow = 3;
			const matchesToShow = result.matches.slice(0, maxMatchesToShow);
			
			for (const match of matchesToShow) {
				const matchItem = matchesContainer.createDiv('match-item');
				
				const matchTypeSpan = matchItem.createEl('span', {
					cls: 'match-type'
				});
				matchTypeSpan.setText(`[${this.getMatchTypeLabel(match.type)}] `);
				
				matchItem.createEl('span', {
					text: this.plugin.truncateText(String(match.context || ''), 500),
					cls: 'match-context'
				});
			}
			
			if ((result.matchCount || result.matches.length) > maxMatchesToShow) {
				matchesContainer.createEl('div', {
					text: `...以及其他 ${(result.matchCount || result.matches.length) - maxMatchesToShow} 个匹配项`,
					cls: 'more-matches'
				});
			}
			
			resultItem.createEl('div', {
				text: `得分: ${result.score}`,
				cls: 'result-score'
			});
		});
		this.resultsCountEl.setText(`找到 ${this.allSearchResults.length} 个匹配的结果，已显示 ${this.searchResults.length} 个`);
		this.moreResultsButton.hidden = this.searchResults.length >= this.allSearchResults.length;
	}

	getMatchTypeLabel(type) {
		switch(type) {
			case 'fileName': return '文件名';
			case 'directory': return '目录';
			case 'tag': return '标签';
			case 'heading1': return '一级标题';
			case 'heading2': return '二级标题';
			case 'heading3': return '三级标题';
			case 'heading4': return '标题';
			case 'content': return '内容';
			case 'quote': return '引用';
			default: return type;
		}
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
		window.clearTimeout(this.focusTimer);
		window.clearTimeout(this.searchDebounceTimer);
		
		this.cancelSearch();
		this.clearSearchResults();
		this.searchInput = null;
		this.searchResultsEl = null;
		
		this.modalEl.removeClass('yuhanbo-search-modal-container');
	}
}

// 设置选项卡类
class YuhanboSearchSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const {containerEl} = this;

		containerEl.empty();

		// 智能补全设置
		new Setting(containerEl)
			.setName('智能补全')
			.setHeading();

		new Setting(containerEl)
			.setName('启用智能补全')
			.setDesc('开启后，在编辑器中输入@@、@@#、@@@等触发符时会显示智能补全建议')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableAutoComplete)
				.onChange(async (value) => {
					this.plugin.settings.enableAutoComplete = value;
					if (!value) this.plugin.cancelAutoComplete();
					await this.plugin.saveSettings();
					new Notice('设置已保存，请重启插件以使设置生效');
				}));

		new Setting(containerEl)
			.setName('智能补全搜索文件夹')
			.setDesc('逗号分隔的文件夹列表，限制智能补全的搜索范围。留空则搜索所有文件夹')
			.addText(text => text
				.setPlaceholder('文件夹1,文件夹2')
				.setValue(this.plugin.settings.autoCompleteFolders)
				.onChange(async (value) => {
					this.plugin.settings.autoCompleteFolders = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('中文最小搜索长度')
			.setDesc('触发智能补全所需的最少中文字符数')
			.addSlider(slider => slider
				.setLimits(1, 5, 1)
				.setValue(this.plugin.settings.minChineseLength)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.minChineseLength = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('英文最小搜索长度')
			.setDesc('触发智能补全所需的最少英文字符数')
			.addSlider(slider => slider
				.setLimits(2, 8, 1)
				.setValue(this.plugin.settings.minEnglishLength)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.minEnglishLength = value;
					await this.plugin.saveSettings();
				}));

		// 原有搜索设置
		new Setting(containerEl)
			.setName('搜索权重')
			.setHeading();

		new Setting(containerEl)
			.setName('文件名权重')
			.setDesc('文件名的搜索权重 (1-10)')
			.addSlider(slider => slider
				.setLimits(1, 10, 1)
				.setValue(this.plugin.settings.fileNameWeight)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.fileNameWeight = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('目录权重')
			.setDesc('文件目录的搜索权重 (1-10)')
			.addSlider(slider => slider
				.setLimits(1, 10, 1)
				.setValue(this.plugin.settings.directoryWeight)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.directoryWeight = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('标签权重')
			.setDesc('标签的搜索权重 (1-10)')
			.addSlider(slider => slider
				.setLimits(1, 10, 1)
				.setValue(this.plugin.settings.tagWeight)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.tagWeight = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('一级标题权重')
			.setDesc('一级标题的搜索权重 (1-10)')
			.addSlider(slider => slider
				.setLimits(1, 10, 1)
				.setValue(this.plugin.settings.heading1Weight)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.heading1Weight = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('二级标题权重')
			.setDesc('二级标题的搜索权重 (1-10)')
			.addSlider(slider => slider
				.setLimits(1, 10, 1)
				.setValue(this.plugin.settings.heading2Weight)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.heading2Weight = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('三级标题权重')
			.setDesc('三级标题的搜索权重 (1-10)')
			.addSlider(slider => slider
				.setLimits(1, 10, 1)
				.setValue(this.plugin.settings.heading3Weight)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.heading3Weight = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('四级及以下标题权重')
			.setDesc('四级及以下标题的搜索权重 (1-10)')
			.addSlider(slider => slider
				.setLimits(1, 10, 1)
				.setValue(this.plugin.settings.heading4Weight)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.heading4Weight = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('正文内容权重')
			.setDesc('正文内容的搜索权重 (1-10)')
			.addSlider(slider => slider
				.setLimits(1, 10, 1)
				.setValue(this.plugin.settings.contentWeight)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.contentWeight = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('引用权重')
			.setDesc('引用内容的搜索权重 (1-10)')
			.addSlider(slider => slider
				.setLimits(1, 10, 1)
				.setValue(this.plugin.settings.quoteWeight)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.quoteWeight = value;
					await this.plugin.saveSettings();
				}));

		// 其他设置
		new Setting(containerEl)
			.setName('其他')
			.setHeading();

		new Setting(containerEl)
			.setName('排除的文件夹')
			.setDesc('逗号分隔的要排除的文件夹列表')
			.addText(text => text
				.setPlaceholder('文件夹1,文件夹2')
				.setValue(this.plugin.settings.excludedFolders)
				.onChange(async (value) => {
					this.plugin.settings.excludedFolders = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('缓存更新间隔（分钟）')
			.setDesc('搜索索引缓存的更新间隔')
			.addText(text => text
				.setPlaceholder('60')
				.setValue(String(this.plugin.settings.cacheUpdateInterval))
				.onChange(async (value) => {
					const numValue = Number(value);
					if (!isNaN(numValue)) {
						this.plugin.settings.cacheUpdateInterval = numValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('自动更新缓存')
			.setDesc('开启后，插件加载5秒后会自动更新搜索缓存。关闭后可立即使用搜索功能，但需要手动更新缓存。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoUpdateCache)
				.onChange(async (value) => {
					this.plugin.settings.autoUpdateCache = value;
					await this.plugin.saveSettings();
					new Notice('设置已保存，请重启插件以使设置生效');
				}));
				
		new Setting(containerEl)
			.setName('手动更新索引')
			.setDesc('点击按钮手动更新搜索索引')
			.addButton(button => button
				.setButtonText('更新索引')
				.onClick(() => {
					this.plugin.updateSearchIndex(true);
				}));
	}
}

// 导出插件
module.exports = YuhanboSearchPlugin;
