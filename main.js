// 直接使用Obsidian提供的API
const { Plugin, PluginSettingTab, App, TFile, Notice, Modal, Setting } = require('obsidian');

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
	cacheUpdateInterval: 60, // 默认60分钟
}

// 主插件类
class YuhanboSearchPlugin extends Plugin {
	
	async onload() {
		// 初始化索引和时间戳
		this.searchIndex = {};
		this.lastIndexTime = 0;
		
		// 加载设置
		await this.loadSettings();

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
			hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'f' }],
			callback: () => {
				// 创建和打开模态窗口
				const searchModal = new SearchModal(this.app, this);
				searchModal.open();
				
				// 在命令触发后特别处理焦点问题
				setTimeout(() => {
					if (searchModal.searchInput) {
						searchModal.searchInput.focus();
						searchModal.forceInputFocus();
					}
				}, 100);
			}
		});

		// 添加设置选项卡
		this.addSettingTab(new YuhanboSearchSettingTab(this.app, this));

		// 注册定期更新索引的计时器
		this.registerInterval(
			window.setInterval(() => this.updateSearchIndex(), this.settings.cacheUpdateInterval * 60 * 1000)
		);

		// 初始化索引
		this.updateSearchIndex();
	}

	onunload() {
		console.log('卸载加权搜索插件');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async updateSearchIndex() {
		console.log('更新搜索索引...');
		this.lastIndexTime = Date.now();
		
		// 实现索引更新逻辑
		this.searchIndex = {};
		const excludedFolders = this.settings.excludedFolders.split(',').map(f => f.trim());
		
		// 索引所有文件
		const files = this.app.vault.getMarkdownFiles();
		for (const file of files) {
			// 检查文件是否在排除的文件夹中
			const shouldExclude = excludedFolders.some(folder => 
				folder && file.path.startsWith(folder)
			);
			
			if (shouldExclude) continue;
			
			try {
				// 获取文件内容
				const content = await this.app.vault.read(file);
				
				// 索引文件信息
				this.searchIndex[file.path] = {
					fileName: file.name,
					directory: file.parent ? file.parent.path : '/',
					content: content,
					tags: this.app.metadataCache.getFileCache(file) ? 
					      this.getAllTags(this.app.metadataCache.getFileCache(file)) : [],
					headings: this.extractHeadings(file),
					quotes: this.extractQuotes(content)
				};
			} catch (error) {
				console.error(`索引文件 ${file.path} 时出错:`, error);
			}
		}
		
		console.log('搜索索引已更新');
		new Notice('搜索索引已更新');
	}
	
	// 获取所有标签的辅助函数
	getAllTags(fileCache) {
		const tags = [];
		if (!fileCache) return tags;
		
		// 从frontmatter中获取标签
		if (fileCache.frontmatter && fileCache.frontmatter.tags) {
			if (Array.isArray(fileCache.frontmatter.tags)) {
				tags.push(...fileCache.frontmatter.tags);
			} else if (typeof fileCache.frontmatter.tags === 'string') {
				tags.push(fileCache.frontmatter.tags);
			}
		}
		
		// 从文档中获取标签
		if (fileCache.tags) {
			for (const tag of fileCache.tags) {
				tags.push(tag.tag);
			}
		}
		
		return tags;
	}
	
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
	
	extractQuotes(content) {
		const quotes = [];
		const lines = content.split('\n');
		
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].startsWith('>')) {
				quotes.push(lines[i]);
			}
		}
		
		return quotes;
	}
	
	search(query, options = {}) {
		const results = [];
		const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 0);
		
		if (keywords.length === 0) return results;
		
		// 默认所有选项都开启
		const defaultOptions = {
			fileName: true,
			directory: true,
			tags: true,
			headings: true,
			content: true,
			quotes: true
		};
		
		// 合并用户提供的选项和默认选项
		const searchOptions = {...defaultOptions, ...options};
		
		// 遍历索引中的所有文件
		for (const filePath in this.searchIndex) {
			const fileData = this.searchIndex[filePath];
			const file = this.app.vault.getAbstractFileByPath(filePath);
			
			if (!(file instanceof TFile)) continue;
			
			let fileScore = 0;
			const matches = [];
			
			// 搜索文件名
			if (searchOptions.fileName) {
				const fileName = fileData.fileName.toLowerCase();
				for (const keyword of keywords) {
					if (fileName.includes(keyword)) {
						const matchScore = this.settings.fileNameWeight;
						fileScore += matchScore;
						matches.push({
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
						matches.push({
							type: 'directory',
							context: fileData.directory
						});
					}
				}
			}
			
			// 搜索标签
			if (searchOptions.tags && fileData.tags) {
				for (const tag of fileData.tags) {
					const tagText = tag.toLowerCase();
					for (const keyword of keywords) {
						if (tagText.includes(keyword)) {
							const matchScore = this.settings.tagWeight;
							fileScore += matchScore;
							matches.push({
								type: 'tag',
								context: tag
							});
						}
					}
				}
			}
			
			// 搜索标题
			if (searchOptions.headings) {
				// 搜索一级标题
				for (const h1 of fileData.headings.h1) {
					const heading = h1.text.toLowerCase();
					for (const keyword of keywords) {
						if (heading.includes(keyword)) {
							const matchScore = this.settings.heading1Weight;
							fileScore += matchScore;
							matches.push({
								type: 'heading1',
								context: h1.text,
								line: h1.position
							});
						}
					}
				}
				
				// 搜索二级标题
				for (const h2 of fileData.headings.h2) {
					const heading = h2.text.toLowerCase();
					for (const keyword of keywords) {
						if (heading.includes(keyword)) {
							const matchScore = this.settings.heading2Weight;
							fileScore += matchScore;
							matches.push({
								type: 'heading2',
								context: h2.text,
								line: h2.position
							});
						}
					}
				}
				
				// 搜索三级标题
				for (const h3 of fileData.headings.h3) {
					const heading = h3.text.toLowerCase();
					for (const keyword of keywords) {
						if (heading.includes(keyword)) {
							const matchScore = this.settings.heading3Weight;
							fileScore += matchScore;
							matches.push({
								type: 'heading3',
								context: h3.text,
								line: h3.position
							});
						}
					}
				}
				
				// 搜索四级及以下标题
				for (const h4 of fileData.headings.h4) {
					const heading = h4.text.toLowerCase();
					for (const keyword of keywords) {
						if (heading.includes(keyword)) {
							const matchScore = this.settings.heading4Weight;
							fileScore += matchScore;
							matches.push({
								type: 'heading4',
								context: h4.text,
								line: h4.position
							});
						}
					}
				}
			}
			
			// 搜索内容
			if (searchOptions.content) {
				const content = fileData.content.toLowerCase();
				const lines = fileData.content.split('\n');
				
				for (const keyword of keywords) {
					let startIdx = 0;
					while (true) {
						const idx = content.indexOf(keyword, startIdx);
						if (idx === -1) break;
						
						const matchScore = this.settings.contentWeight;
						fileScore += matchScore;
						
						// 计算行号和上下文
						let lineNumber = 0;
						let charCount = 0;
						while (lineNumber < lines.length && charCount + lines[lineNumber].length + 1 <= idx) {
							charCount += lines[lineNumber].length + 1; // +1 为换行符
							lineNumber++;
						}
						
						const lineContent = lines[lineNumber] || '';
						
						matches.push({
							type: 'content',
							context: lineContent,
							line: lineNumber
						});
						
						startIdx = idx + keyword.length;
					}
				}
			}
			
			// 搜索引用
			if (searchOptions.quotes && fileData.quotes) {
				for (let i = 0; i < fileData.quotes.length; i++) {
					const quote = fileData.quotes[i].toLowerCase();
					for (const keyword of keywords) {
						if (quote.includes(keyword)) {
							const matchScore = this.settings.quoteWeight;
							fileScore += matchScore;
							matches.push({
								type: 'quote',
								context: fileData.quotes[i]
							});
						}
					}
				}
			}
			
			// 如果有匹配项，添加到结果中
			if (fileScore > 0) {
				results.push({
					file: file,
					score: fileScore,
					matches: matches
				});
			}
		}
		
		// 根据得分降序排序
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
			content: true,
			quotes: true
		};
		// 当前选中的结果索引
		this.selectedResultIndex = -1;
		// 搜索结果数组
		this.searchResults = [];
		// 添加标志以跟踪是否已尝试聚焦
		this.hasFocused = false;
	}

	// 添加一个专门的强制聚焦方法
	forceInputFocus() {
		if (!this.searchInput || this.hasFocused) return;
		
		// 设置标志，避免重复聚焦尝试
		this.hasFocused = true;
		
		// 尝试各种方法确保输入框获得焦点
		try {
			// 直接聚焦
			this.searchInput.focus();
			
			// 使用选择来加强聚焦
			this.searchInput.select();
			
			// 模拟用户点击
			this.searchInput.click();
			
			// 尝试使用 activeElement API
			if (document.activeElement !== this.searchInput) {
				// 如果当前活动元素不是搜索框，则重新聚焦
				setTimeout(() => {
					this.searchInput.focus();
					console.log("聚焦重试 - activeElement检查");
				}, 10);
			}
			
			console.log("已尝试聚焦到搜索框");
		} catch (e) {
			console.error("聚焦失败:", e);
		}
	}

	onOpen() {
		// 设置模态框为更宽的尺寸
		this.modalEl.style.width = '80vw';
		this.modalEl.style.maxWidth = '1000px';
		
		// 添加自定义类用于更好地控制焦点
		this.modalEl.addClass('yuhanbo-search-modal-container');
		
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('yuhanbo-search-modal');
		
		// 创建搜索范围标签
		contentEl.createEl('div', {
			text: '搜索范围:',
			cls: 'search-scope-label'
		});
		
		// 创建搜索范围按钮容器
		const scopeButtonsContainer = contentEl.createDiv('search-scope-buttons');
		
		// 定义搜索选项
		const options = [
			{ id: 'fileName', label: '文件名' },
			{ id: 'directory', label: '目录' },
			{ id: 'tags', label: '标签' },
			{ id: 'headings', label: '标题' },
			{ id: 'content', label: '内容' },
			{ id: 'quotes', label: '引用' }
		];
		
		// 创建按钮式的选项
		options.forEach(option => {
			this.createScopeButton(scopeButtonsContainer, option.label, option.id);
		});
		
		// 创建搜索框 - 增大尺寸 并添加autofocus属性
		const searchContainer = contentEl.createDiv('search-container');
		this.searchInput = searchContainer.createEl('input', {
			attr: {
				type: 'text',
				placeholder: '输入关键词进行搜索...',
				autofocus: 'autofocus',
				id: 'yuhanbo-search-input'  // 添加ID以便更容易定位
			},
			cls: 'search-input large yuhanbo-search-input-js'  // 添加额外类名便于样式和脚本定位
		});
		
		// 创建结果容器
		this.searchResultsEl = contentEl.createDiv('search-results');
		
		// 自适应调整模态框高度和宽度
		const adjustModalLayout = () => {
			// 设置模态框属性，让整体内容可滚动
			this.modalEl.style.height = 'auto';
			this.modalEl.style.maxHeight = '90vh';
			this.modalEl.style.overflowY = 'auto';
			
			// 确保内容区域有足够宽度
			contentEl.style.width = '100%';
			
			// 确保所有结果项目都能完整显示
			const resultItems = this.searchResultsEl.querySelectorAll('.result-item');
			resultItems.forEach(item => {
				item.style.width = '100%';
			});
		};
		
		// 绑定事件 - 输入时自动搜索
		let debounceTimeout = null;
		this.searchInput.addEventListener('input', () => {
			const value = this.searchInput.value.trim();
			
			// 清除之前的定时器
			if (debounceTimeout) clearTimeout(debounceTimeout);
			
			// 重置选中索引
			this.selectedResultIndex = -1;
			
			// 至少输入两个字符才开始搜索
			if (value.length >= 2) {
				// 设置300毫秒的防抖，避免每次按键都搜索
				debounceTimeout = setTimeout(() => {
					this.performSearch(value);
					adjustModalLayout(); // 调整布局
				}, 300);
			} else {
				// 清空结果
				this.searchResultsEl.empty();
				this.searchResults = [];
				adjustModalLayout(); // 调整布局
			}
		});
		
		// 按键导航处理
		this.searchInput.addEventListener('keydown', (e) => {
			// 预先阻止上下键的默认行为（无论是否有搜索结果）
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault(); // 防止光标移动和页面滚动
				e.stopPropagation(); // 防止事件传播
			}
			
			// 如果没有搜索结果，则不处理结果选择
			if (this.searchResults.length === 0) {
				return;
			}
			
			// 向下键 - 选择下一个结果
			if (e.key === 'ArrowDown') {
				this.selectNextResult();
			}
			
			// 向上键 - 选择上一个结果
			if (e.key === 'ArrowUp') {
				this.selectPreviousResult();
			}
			
			// 回车键 - 如果有选中结果，则打开该结果
			if (e.key === 'Enter') {
				// 如果已选中结果，则打开它
				if (this.selectedResultIndex >= 0 && this.selectedResultIndex < this.searchResults.length) {
					e.preventDefault(); // 防止触发普通搜索
					this.openResult(this.searchResults[this.selectedResultIndex]);
				} 
				// 如果未选中结果但有搜索内容，则执行搜索
				else if (this.searchInput.value.trim().length >= 2) {
					this.performSearch(this.searchInput.value.trim());
					adjustModalLayout();
				}
			}
		});
		
		// 窗口大小改变时调整布局
		this.registerDomEvent(window, 'resize', adjustModalLayout);
		
		// 为整个模态窗口添加键盘事件，确保上下键不会导致页面滚动
		this.registerDomEvent(this.modalEl, 'keydown', (e) => {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				e.stopPropagation();
			}
		});
		
		// 初始调整
		adjustModalLayout();
		
		// 自动聚焦到搜索框 - 使用专门的聚焦方法
		// 重置聚焦标志
		this.hasFocused = false;
		
		// 立即尝试聚焦
		this.forceInputFocus();
		
		// 延迟50ms再次尝试聚焦
		setTimeout(() => this.forceInputFocus(), 50);
		
		// 延迟200ms再次尝试，这是为了确保在模态框完全渲染和动画结束后聚焦
		setTimeout(() => this.forceInputFocus(), 200);
		
		// 最后一次尝试，在500ms后
		setTimeout(() => {
			this.forceInputFocus();
			
			// 检查是否成功聚焦，如果未成功则显示通知
			if (document.activeElement !== this.searchInput) {
				console.warn("自动聚焦失败 - 请尝试点击搜索框");
			}
		}, 500);
	}
	
	// 选择下一个搜索结果
	selectNextResult() {
		if (this.searchResults.length === 0) return;
		
		// 移除当前选中项的高亮
		this.removeSelectionHighlight();
		
		// 计算新的索引（循环到开头）
		this.selectedResultIndex = (this.selectedResultIndex + 1) % this.searchResults.length;
		
		// 高亮新选中的项
		this.highlightSelectedResult();
	}
	
	// 选择上一个搜索结果
	selectPreviousResult() {
		if (this.searchResults.length === 0) return;
		
		// 移除当前选中项的高亮
		this.removeSelectionHighlight();
		
		// 计算新的索引（循环到末尾）
		this.selectedResultIndex = (this.selectedResultIndex - 1 + this.searchResults.length) % this.searchResults.length;
		
		// 高亮新选中的项
		this.highlightSelectedResult();
	}
	
	// 移除所有结果的高亮
	removeSelectionHighlight() {
		const allResults = this.searchResultsEl.querySelectorAll('.result-item');
		allResults.forEach(item => {
			item.removeClass('selected');
		});
	}
	
	// 高亮当前选中的结果
	highlightSelectedResult() {
		if (this.selectedResultIndex < 0) return;
		
		const allResults = this.searchResultsEl.querySelectorAll('.result-item');
		if (this.selectedResultIndex < allResults.length) {
			const selectedItem = allResults[this.selectedResultIndex];
			selectedItem.addClass('selected');
			
			// 确保选中项可见 - 修改滚动行为，确保只在必要时滚动且只滚动模态框内部
			// 使用更精确的可见性检查，避免不必要的滚动
			const containerRect = this.modalEl.getBoundingClientRect();
			const itemRect = selectedItem.getBoundingClientRect();
			
			// 只有当元素不在可视区域内时才滚动
			if (itemRect.top < containerRect.top || itemRect.bottom > containerRect.bottom) {
				selectedItem.scrollIntoView({
					behavior: 'smooth',
					block: 'nearest'
				});
			}
		}
	}
	
	// 打开选中的结果
	openResult(result) {
		if (!result || !result.file) return;
		
		// 如果有匹配的行号，打开文件并跳转到该行
		const lineMatch = result.matches.find(m => m.line !== undefined);
		if (lineMatch && lineMatch.line !== undefined) {
			this.app.workspace.openLinkText(result.file.path, '', true, {
				eState: { line: lineMatch.line }
			});
		} else {
			// 否则仅打开文件
			this.app.workspace.openLinkText(result.file.path, '', true);
		}
		this.close();
	}
	
	// 创建搜索范围按钮
	createScopeButton(container, label, optionName) {
		// 创建按钮元素
		const button = container.createEl('div', {
			text: label,
			cls: 'search-scope-button' + (this.options[optionName] ? ' active' : '')
		});
		
		// 为按钮添加点击事件
		button.addEventListener('click', () => {
			// 切换选项状态
			this.options[optionName] = !this.options[optionName];
			
			// 更新按钮样式
			if (this.options[optionName]) {
				button.addClass('active');
			} else {
				button.removeClass('active');
			}
			
			// 如果已经有搜索内容，立即重新搜索
			const query = this.searchInput.value.trim();
			if (query.length >= 2) {
				this.performSearch(query);
			}
		});
		
		return button;
	}
	
	// 为了向下兼容保留的旧方法
	createImprovedCheckbox(container, label, optionName) {
		return this.createScopeButton(container, label, optionName);
	}
	
	// 为了向下兼容保留的旧方法
	createCheckbox(container, label, optionName) {
		return this.createScopeButton(container, label, optionName);
	}
	
	performSearch(query = null) {
		// 如果没有传入查询词，则从搜索框获取
		if (!query) {
			query = this.searchInput.value.trim();
		}
		
		if (!query) {
			new Notice('请输入搜索关键词');
			return;
		}
		
		// 清空之前的结果
		this.searchResultsEl.empty();
		this.selectedResultIndex = -1;  // 重置选中索引
		
		// 执行搜索
		this.searchResults = this.plugin.search(query, this.options);
		
		if (this.searchResults.length === 0) {
			this.searchResultsEl.createEl('div', {
				text: '没有找到匹配的结果',
				cls: 'no-results'
			});
			return;
		}
		
		// 显示结果数量，突出显示并使用紫色
		const resultsCount = this.searchResultsEl.createEl('div', {
			cls: 'results-count'
		});
		resultsCount.innerHTML = `找到 <span style="color: #9370DB;">${this.searchResults.length}</span> 个匹配的结果`;
		
		// 创建结果列表
		const resultsList = this.searchResultsEl.createEl('div', {
			cls: 'results-list'
		});
		
		// 显示每个结果
		this.searchResults.forEach((result, index) => {
			const resultItem = resultsList.createDiv('result-item');
			
			// 添加索引属性，便于后续选择
			resultItem.dataset.resultIndex = index;
			
			// 创建文件名标题并添加点击事件
			const fileTitle = resultItem.createEl('div', {
				text: result.file.name,
				cls: 'result-title'
			});
			
			// 为整个结果项添加点击事件
			resultItem.addEventListener('click', () => {
				this.openResult(result);
			});
			
			// 添加鼠标悬停事件，更新选中索引
			resultItem.addEventListener('mouseenter', () => {
				// 移除之前的高亮
				this.removeSelectionHighlight();
				
				// 更新索引并高亮
				this.selectedResultIndex = index;
				this.highlightSelectedResult();
			});
			
			// 显示文件路径
			resultItem.createEl('div', {
				text: result.file.path,
				cls: 'result-path'
			});
			
			// 显示匹配详情
			const matchesContainer = resultItem.createDiv('matches-container');
			
			// 限制显示的匹配项数量
			const maxMatchesToShow = 3;
			const matchesToShow = result.matches.slice(0, maxMatchesToShow);
			
			for (const match of matchesToShow) {
				const matchItem = matchesContainer.createDiv('match-item');
				
				// 创建匹配类型标签，使用紫色突出显示
				const matchTypeSpan = matchItem.createEl('span', {
					cls: 'match-type'
				});
				matchTypeSpan.innerHTML = `<span style="color: #9370DB;">[${this.getMatchTypeLabel(match.type)}]</span> `;
				
				// 显示匹配内容
				matchItem.createEl('span', {
					text: match.context,
					cls: 'match-context'
				});
			}
			
			// 如果有更多匹配项，显示数量
			if (result.matches.length > maxMatchesToShow) {
				matchesContainer.createEl('div', {
					text: `...以及其他 ${result.matches.length - maxMatchesToShow} 个匹配项`,
					cls: 'more-matches'
				});
			}
			
			// 显示得分
			resultItem.createEl('div', {
				text: `得分: ${result.score}`,
				cls: 'result-score'
			});
		});
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

		containerEl.createEl('h2', {text: '自定义加权搜索插件设置'});

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
				
		// 添加手动更新索引按钮
		new Setting(containerEl)
			.setName('手动更新索引')
			.setDesc('点击按钮手动更新搜索索引')
			.addButton(button => button
				.setButtonText('更新索引')
				.onClick(() => {
					this.plugin.updateSearchIndex();
				}));
	}
}

// 导出插件
module.exports = YuhanboSearchPlugin; 