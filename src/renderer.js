(() => {
  'use strict';

  const bridge = window.keryx || {
    platform: 'win32',
    versions: {},
    minimize() {},
    toggleMaximize() {},
    close() {},
    leaveFullscreen() {},
    isMaximized: async () => false,
    showAbout: async () => {},
    onWindowState: () => () => {},
    onShortcut: () => () => {},
    onOpenTab: () => () => {},
    onSearch: () => () => {},
    onDownload: () => () => {}
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PARTITION = 'persist:keryx';
  const MAX_CLOSED_TABS = 25;
  const MESSENGER_URL = new URL('messenger.html', window.location.href).href;
  const INTERNAL_URLS = new Map([[MESSENGER_URL, 'keryx://messenger']]);

  const $ = (id) => document.getElementById(id);

  const el = {
    app: $('app'),
    minimizeBtn: $('minimizeBtn'),
    maximizeBtn: $('maximizeBtn'),
    maximizeIcon: $('maximizeIcon'),
    closeBtn: $('closeBtn'),
    workspace: document.querySelector('.workspace'),
    tabList: $('tabList'),
    tabCount: $('tabCount'),
    newTabBtn: $('newTabBtn'),
    engineBtn: $('engineBtn'),
    engineMenu: $('engineMenu'),
    engineOptions: $('engineOptions'),
    engineMark: $('engineMark'),
    engineName: $('engineName'),
    startEngineLabel: $('startEngineLabel'),
    menuBtn: $('menuBtn'),
    appMenu: $('appMenu'),
    menuBackdrop: $('popoverBackdrop'),
    zoomValue: $('zoomValue'),
    backBtn: $('backBtn'),
    forwardBtn: $('forwardBtn'),
    reloadBtn: $('reloadBtn'),
    reloadIcon: $('reloadIcon'),
    homeBtn: $('homeBtn'),
    omniboxForm: $('omniboxForm'),
    omnibox: $('omnibox'),
    omniboxIcon: $('omniboxIcon'),
    omniboxBadge: $('omniboxBadge'),
    webviewHost: $('webviewHost'),
    viewport: $('viewport'),
    newtabView: $('newtabView'),
    startSearchForm: $('startSearchForm'),
    startSearch: $('startSearch'),
    quickLinks: $('quickLinks'),
    clock: $('clock'),
    date: $('date'),
    greeting: $('greeting'),
    errorView: $('errorView'),
    errorTitle: $('errorTitle'),
    errorMessage: $('errorMessage'),
    errorUrl: $('errorUrl'),
    retryBtn: $('retryBtn'),
    contentLoader: $('contentLoader'),
    progressLine: $('progressLine'),
    statusPill: $('statusPill'),
    statusText: $('statusText'),
    toastStack: $('toastStack')
  };

  const ENGINES = {
    google: {
      name: 'Google',
      mark: 'G',
      searchLabel: 'Поиск в Google',
      markClass: '',
      search: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=ru`
    },
    yandex: {
      name: 'Яндекс',
      mark: 'Я',
      searchLabel: 'Поиск в Яндексе',
      markClass: 'yandex',
      search: (query) => `https://yandex.ru/search/?text=${encodeURIComponent(query)}`
    }
  };

  const QUICK_LINKS = [
    { name: 'Messenger', url: MESSENGER_URL, icon: 'message', color: '#b9bbc0', internal: true }
  ];

  const ERROR_COPY = {
    '-105': {
      title: 'Сайт не найден',
      message: 'Не удалось найти адрес сайта. Проверьте написание адреса и попробуйте снова.'
    },
    '-106': {
      title: 'Нет подключения',
      message: 'Похоже, нет подключения к интернету. Проверьте сеть и попробуйте снова.'
    },
    '-102': {
      title: 'Соединение отклонено',
      message: 'Сайт отклонил подключение. Возможно, сервер временно недоступен.'
    },
    '-118': {
      title: 'Время ожидания истекло',
      message: 'Сайт слишком долго не отвечает. Проверьте подключение или повторите позже.'
    },
    '-7': {
      title: 'Время ожидания истекло',
      message: 'Сайт слишком долго не отвечает. Проверьте подключение или повторите позже.'
    },
    '-202': {
      title: 'Ошибка сертификата',
      message: 'Соединение с сайтом не защищено. Браузер не стал открывать страницу.'
    }
  };

  let tabs = new Map();
  let tabOrder = [];
  let activeTabId = null;
  let tabSerial = 0;
  let closedTabs = [];
  let currentEngineId = readSavedEngine();
  let openMenu = null;
  let openMenuTrigger = null;

  function readSavedEngine() {
    try {
      const saved = localStorage.getItem('keryx.engine');
      return ENGINES[saved] ? saved : 'google';
    } catch {
      return 'google';
    }
  }

  function saveEngine(engineId) {
    try {
      localStorage.setItem('keryx.engine', engineId);
    } catch {
      /* Storage can be unavailable; search still works for this session. */
    }
  }

  function makeIcon(name, className = 'icon') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.appendChild(use);
    return svg;
  }

  function setIconUse(svg, name) {
    const use = svg?.querySelector('use');
    if (use) use.setAttribute('href', `#icon-${name}`);
  }

  function currentEngine() {
    return ENGINES[currentEngineId] || ENGINES.google;
  }

  function activeTab() {
    return activeTabId ? tabs.get(activeTabId) || null : null;
  }

  /* ------------------------------------------------------------------ */
  /* Address parsing                                                     */
  /* ------------------------------------------------------------------ */

  function looksLikeUrl(value) {
    const input = String(value || '').trim();
    if (!input || /\s/.test(input)) return false;

    if (/^[a-z][a-z\d+.-]*:/i.test(input)) {
      try {
        const parsed = new URL(input);
        return /^https?:$/.test(parsed.protocol) && Boolean(parsed.hostname);
      } catch {
        return false;
      }
    }

    if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(input)) {
      return true;
    }

    const authority = input.split(/[/?#]/)[0];
    if (!authority || authority.includes('@')) return false;

    return /^[^\s.:]+(?:\.[^\s.:]+)+(?::\d+)?$/.test(authority);
  }

  function searchUrl(query) {
    return currentEngine().search(query);
  }

  function resolveNavigation(value) {
    const input = String(value || '').trim();
    if (!input) return null;

    if (/^keryx:\/\/messenger\/?$/i.test(input)) return MESSENGER_URL;

    if (!looksLikeUrl(input)) {
      return searchUrl(input);
    }

    let candidate = input;

    if (!/^[a-z][a-z\d+.-]*:/i.test(candidate)) {
      const authority = candidate.split(/[/?#]/)[0];
      const host = authority.replace(/:\d+$/, '').toLowerCase();
      const useHttp =
        host === 'localhost' ||
        host.endsWith('.local') ||
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
        /^\[[0-9a-f:]+\]$/.test(host);

      candidate = `${useHttp ? 'http' : 'https'}://${candidate}`;
    }

    try {
      const parsed = new URL(candidate);
      if (!/^https?:$/.test(parsed.protocol)) return null;
      return parsed.href;
    } catch {
      return searchUrl(input);
    }
  }

  function prettyUrl(value) {
    if (INTERNAL_URLS.has(value)) return INTERNAL_URLS.get(value);

    try {
      const parsed = new URL(value);
      if (!/^https?:$/.test(parsed.protocol)) return value;
      const host = parsed.host.replace(/^www\./i, '');
      const path = parsed.pathname === '/' ? '' : parsed.pathname;
      return `${host}${path}${parsed.search}${parsed.hash}`;
    } catch {
      return value || '';
    }
  }

  function hostFromUrl(value) {
    try {
      return new URL(value).hostname.replace(/^www\./i, '');
    } catch {
      return '';
    }
  }

  function hostInitial(tab) {
    const host = hostFromUrl(tab.url);
    if (host) return host.charAt(0).toUpperCase();
    if (tab.isNewTab) return '✦';
    return (tab.title || '•').trim().charAt(0).toUpperCase() || '•';
  }

  function faviconColors(seed) {
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
      hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
    }
    const lightness = 13 + (Math.abs(hash) % 7);
    return [
      `hsl(0 0% ${lightness + 4}%)`,
      `hsl(0 0% ${lightness}%)`
    ];
  }

  /* ------------------------------------------------------------------ */
  /* Tabs                                                                */
  /* ------------------------------------------------------------------ */

  function createTab({ url = null, activate = true, focusAddress = false, focusContent = false } = {}) {
    const tab = {
      id: `tab-${++tabSerial}`,
      title: 'Новая вкладка',
      url: '',
      favicon: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isNewTab: true,
      hasContent: false,
      ready: false,
      error: null,
      zoom: 0,
      focusOnReady: false,
      webview: null
    };

    tabs.set(tab.id, tab);
    tabOrder.push(tab.id);

    if (activate) {
      switchTab(tab.id);
    }

    if (url) {
      navigateTab(tab, url, { focusContent });
    }

    renderTabs({ scrollActive: true });

    if (activate) {
      if (focusAddress || !url) {
        window.setTimeout(focusOmnibox, 40);
      } else if (focusContent) {
        window.setTimeout(() => tab.webview?.focus(), 50);
      }
    }

    syncToolbar();
    return tab;
  }

  function switchTab(id, { focusAddress = false, focusContent = false, focusStart = false } = {}) {
    if (!tabs.has(id)) return;

    if (id !== activeTabId) {
      if (document.body.classList.contains('page-fullscreen')) {
        exitPageFullscreen(activeTab());
      }

      if (document.activeElement === el.omnibox) {
        el.omnibox.blur();
      }

      closePopover();
      activeTabId = id;
      el.statusPill.hidden = true;
    }

    updateSurfaces();
    renderTabs({ scrollActive: true });
    syncToolbar();

    const tab = tabs.get(id);

    if (focusAddress) {
      window.setTimeout(focusOmnibox, 30);
    } else if (focusContent && tab?.webview) {
      window.setTimeout(() => tab.webview.focus(), 30);
    } else if (focusStart && tab?.isNewTab) {
      window.setTimeout(() => el.startSearch.focus(), 30);
    }
  }

  function navigateTab(tab, url, { focusContent = false } = {}) {
    if (!tab) return;
    if (!/^https?:\/\//i.test(url) && !INTERNAL_URLS.has(url)) return;

    closePopover();
    const isFreshPage = !tab.webview;

    tab.isNewTab = false;
    tab.error = null;
    tab.loading = true;
    tab.url = url;

    if (isFreshPage) {
      tab.title = INTERNAL_URLS.get(url) || hostFromUrl(url) || 'Загрузка…';
      tab.favicon = null;
      tab.hasContent = false;
    }

    tab.focusOnReady = Boolean(focusContent);

    if (!tab.webview) {
      createWebview(tab, url);
    } else if (!tab.ready) {
      /* The guest is still attaching; loadURL would fail, but src is safe. */
      try {
        tab.webview.setAttribute('src', url);
      } catch {
        /* The guest is being torn down. */
      }
    } else {
      try {
        const navigation = tab.webview.loadURL(url);
        navigation?.catch?.(() => {});
      } catch {
        try {
          tab.webview.setAttribute('src', url);
        } catch {
          /* The guest is being torn down. */
        }
      }
    }

    renderTabs({ scrollActive: activeTabId === tab.id });

    if (activeTabId === tab.id) {
      updateSurfaces();
      syncToolbar();
    }

    if (focusContent) {
      window.setTimeout(() => tab.webview?.focus(), 60);
    }
  }

  function createWebview(tab, url) {
    const webview = document.createElement('webview');
    webview.className = 'page-view';
    webview.setAttribute('partition', PARTITION);
    webview.setAttribute('allowpopups', '');

    tab.webview = webview;
    tab.hasContent = false;
    tab.ready = false;

    bindWebviewEvents(tab, webview);
    el.webviewHost.appendChild(webview);
    webview.setAttribute('src', url);

    if (activeTabId === tab.id) {
      webview.classList.add('active');
    }
  }

  function bindWebviewEvents(tab, webview) {
    const isActive = () => tabs.has(tab.id) && activeTabId === tab.id;

    const updateTabs = () => {
      if (!tabs.has(tab.id)) return;
      renderTabs();
    };

    webview.addEventListener('did-start-loading', () => {
      if (!tabs.has(tab.id)) return;
      tab.loading = true;
      tab.error = null;
      updateTabs();
      if (isActive()) {
        updateSurfaces();
        syncToolbar();
      }
    });

    webview.addEventListener('did-stop-loading', () => {
      if (!tabs.has(tab.id)) return;
      tab.loading = false;
      updateNavigationState(tab);
      updateTabs();
      if (isActive()) {
        updateSurfaces();
        syncToolbar();
      }
    });

    webview.addEventListener('dom-ready', () => {
      if (!tabs.has(tab.id)) return;
      tab.ready = true;
      tab.hasContent = true;
      applyZoom(tab);
      if (isActive()) {
        updateSurfaces();
        syncToolbar();
        if (tab.focusOnReady) {
          tab.focusOnReady = false;
          window.setTimeout(() => {
            if (!tabs.has(tab.id) || activeTabId !== tab.id) return;
            try {
              webview.focus();
            } catch {
              /* The guest cannot accept focus yet. */
            }
          }, 0);
        }
      }
    });

    webview.addEventListener('did-finish-load', () => {
      if (!tabs.has(tab.id)) return;
      tab.hasContent = true;
      if (isActive()) updateSurfaces();
    });

    webview.addEventListener('did-start-navigation', (event) => {
      if (!tabs.has(tab.id) || !event.isMainFrame) return;
      if (event.url && /^https?:\/\//i.test(event.url)) {
        tab.url = event.url;
      }
      if (!event.isInPlace) tab.error = null;
      if (isActive()) syncOmniboxDisplay();
    });

    webview.addEventListener('did-navigate', (event) => {
      if (!tabs.has(tab.id)) return;
      tab.url = event.url;
      tab.error = null;
      updateNavigationState(tab);
      updateTabs();
      if (isActive()) {
        updateSurfaces();
        syncToolbar();
      }
    });

    webview.addEventListener('did-navigate-in-page', (event) => {
      if (!tabs.has(tab.id) || !event.isMainFrame) return;
      tab.url = event.url;
      updateNavigationState(tab);
      if (isActive()) {
        syncOmniboxDisplay();
        syncToolbar();
      }
    });

    webview.addEventListener('page-title-updated', (event) => {
      if (!tabs.has(tab.id)) return;
      const title = String(event.title || '').trim();
      if (!title) return;
      tab.title = title;
      updateTabs();
      if (isActive()) updateDocumentTitle();
    });

    webview.addEventListener('page-favicon-updated', (event) => {
      if (!tabs.has(tab.id)) return;
      const favicons = Array.isArray(event.favicons) ? event.favicons : [];
      const favicon = [...favicons].reverse().find((candidate) =>
        /^(https?:|data:image\/)/i.test(String(candidate))
      );
      if (!favicon) return;
      tab.favicon = favicon;
      updateTabs();
    });

    webview.addEventListener('did-fail-load', (event) => {
      if (!tabs.has(tab.id)) return;
      if (!event.isMainFrame || event.errorCode === -3) return;

      tab.loading = false;
      tab.error = {
        code: event.errorCode,
        description: event.errorDescription || 'Не удалось загрузить страницу',
        url: event.validatedURL || tab.url
      };
      updateNavigationState(tab);
      updateTabs();
      if (isActive()) {
        updateSurfaces();
        syncToolbar();
      }
    });

    webview.addEventListener('render-process-gone', (event) => {
      if (!tabs.has(tab.id)) return;
      if (event.details?.reason === 'clean-exit') return;

      tab.loading = false;
      tab.error = {
        code: null,
        description: 'Процесс страницы неожиданно завершился',
        url: tab.url
      };
      updateTabs();
      if (isActive()) {
        updateSurfaces();
        syncToolbar();
      }
    });

    webview.addEventListener('enter-html-full-screen', () => {
      if (!isActive()) return;
      document.body.classList.add('page-fullscreen');
    });

    webview.addEventListener('leave-html-full-screen', () => {
      document.body.classList.remove('page-fullscreen');
    });

    webview.addEventListener('update-target-url', (event) => {
      if (!isActive()) return;
      const target = String(event.url || '');
      if (!target) {
        el.statusPill.hidden = true;
        return;
      }
      el.statusText.textContent = target;
      el.statusPill.title = target;
      el.statusPill.hidden = false;
    });

    webview.addEventListener('focus', () => {
      closePopover();
    });

    webview.addEventListener('close', () => {
      if (tabs.has(tab.id)) closeTab(tab.id);
    });
  }

  function updateNavigationState(tab) {
    if (!tab?.webview) return;
    try {
      tab.canGoBack = Boolean(tab.webview.canGoBack());
      tab.canGoForward = Boolean(tab.webview.canGoForward());
    } catch {
      tab.canGoBack = false;
      tab.canGoForward = false;
    }
  }

  function closeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;

    const index = tabOrder.indexOf(id);
    if (index === -1) return;

    if (document.body.classList.contains('page-fullscreen') && activeTabId === id) {
      exitPageFullscreen(tab);
    }

    if (tab.url && /^https?:\/\//i.test(tab.url)) {
      closedTabs.push({ url: tab.url, title: tab.title });
      if (closedTabs.length > MAX_CLOSED_TABS) closedTabs.shift();
    }

    if (tab.webview) {
      try {
        tab.webview.stop();
      } catch {
        /* Already stopped. */
      }
      tab.webview.remove();
      tab.webview = null;
    }

    tabs.delete(id);
    tabOrder.splice(index, 1);

    if (tabs.size === 0) {
      activeTabId = null;
      createTab({ activate: true, focusAddress: true });
      return;
    }

    if (activeTabId === id) {
      const nextId = tabOrder[Math.min(index, tabOrder.length - 1)];
      activeTabId = null;
      switchTab(nextId, { focusContent: false });
    } else {
      renderTabs();
      syncToolbar();
    }
  }

  function closeActiveTab() {
    if (activeTabId) closeTab(activeTabId);
  }

  function cycleTab(direction) {
    if (tabOrder.length < 2) return;
    const index = tabOrder.indexOf(activeTabId);
    const nextIndex = (index + direction + tabOrder.length) % tabOrder.length;
    const tab = tabs.get(tabOrder[nextIndex]);
    switchTab(tabOrder[nextIndex], {
      focusContent: !tab?.isNewTab,
      focusStart: Boolean(tab?.isNewTab)
    });
  }

  function selectTabByIndex(index) {
    const id = tabOrder[index];
    if (!id) return;
    const tab = tabs.get(id);
    switchTab(id, {
      focusContent: Boolean(tab && !tab.isNewTab),
      focusStart: Boolean(tab?.isNewTab)
    });
  }

  function selectLastTab() {
    if (!tabOrder.length) return;
    chooseAndFocus(tabOrder[tabOrder.length - 1]);
  }

  function chooseAndFocus(id) {
    const tab = tabs.get(id);
    switchTab(id, {
      focusContent: Boolean(tab && !tab.isNewTab),
      focusStart: Boolean(tab?.isNewTab)
    });
  }

  function reopenClosedTab() {
    const entry = closedTabs.pop();
    if (!entry) return;
    createTab({ url: entry.url, activate: true, focusContent: true });
  }

  function goHome() {
    const tab = activeTab();
    if (!tab) return;

    if (document.body.classList.contains('page-fullscreen')) {
      exitPageFullscreen(tab);
    }

    if (tab.webview) {
      tab.webview.remove();
      tab.webview = null;
    }

    Object.assign(tab, {
      title: 'Новая вкладка',
      url: '',
      favicon: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isNewTab: true,
      hasContent: false,
      ready: false,
      error: null,
      zoom: 0
    });

    closePopover();
    updateSurfaces();
    renderTabs({ scrollActive: true });
    syncToolbar();
    window.setTimeout(() => el.startSearch.focus(), 40);
  }

  function navigateActive(value) {
    const target = resolveNavigation(value);
    if (!target) return;

    const tab = activeTab();
    if (!tab) {
      createTab({ url: target, activate: true, focusContent: true });
      return;
    }

    navigateTab(tab, target, { focusContent: true });
  }

  function reloadActive({ force = false } = {}) {
    const tab = activeTab();
    if (!tab?.webview || tab.isNewTab) return;

    if (tab.loading && !force) {
      try {
        tab.webview.stop();
      } catch {
        /* Already stopped. */
      }
      return;
    }

    tab.error = null;
    try {
      tab.webview.reload();
    } catch {
      /* The guest is unavailable. */
    }
    updateSurfaces();
    syncToolbar();
  }

  function hardReloadActive() {
    const tab = activeTab();
    if (!tab?.webview || tab.isNewTab) return;
    tab.error = null;
    try {
      tab.webview.reloadIgnoringCache();
    } catch {
      /* The guest is unavailable. */
    }
    updateSurfaces();
    syncToolbar();
  }

  function navigateHistory(direction) {
    const tab = activeTab();
    if (!tab?.webview || tab.isNewTab) return;

    tab.error = null;
    updateSurfaces();
    try {
      if (direction < 0) tab.webview.goBack();
      else tab.webview.goForward();
    } catch {
      /* The guest is unavailable. */
    }
  }

  function retryActive() {
    const tab = activeTab();
    if (!tab) return;

    const target = tab.url || tab.error?.url;
    tab.error = null;

    if (!target) {
      goHome();
      return;
    }

    navigateTab(tab, target, { focusContent: false });
  }

  /* ------------------------------------------------------------------ */
  /* Tab rendering                                                       */
  /* ------------------------------------------------------------------ */

  function renderTabs({ scrollActive = false } = {}) {
    const fragment = document.createDocumentFragment();
    let activeElement = null;

    for (const id of tabOrder) {
      const tab = tabs.get(id);
      if (!tab) continue;

      const isActive = id === activeTabId;
      const tabElement = document.createElement('div');
      tabElement.className = `tab${isActive ? ' active' : ''}${tab.loading ? ' loading' : ''}`;
      tabElement.dataset.tabId = tab.id;
      tabElement.setAttribute('role', 'tab');
      tabElement.setAttribute('aria-selected', String(isActive));
      tabElement.tabIndex = isActive ? 0 : -1;
      tabElement.title = tab.title || 'Новая вкладка';

      const favicon = document.createElement('span');
      favicon.className = 'tab-favicon';

      if (tab.loading && !tab.favicon) {
        const spinner = document.createElement('span');
        spinner.className = 'tab-spinner';
        favicon.appendChild(spinner);
      } else if (tab.favicon) {
        const image = document.createElement('img');
        image.src = tab.favicon;
        image.alt = '';
        image.draggable = false;
        image.addEventListener('error', () => {
          if (!tabs.has(tab.id)) return;
          tab.favicon = null;
          renderTabs();
        }, { once: true });
        favicon.appendChild(image);
      } else {
        const fallback = document.createElement('span');
        fallback.className = tab.isNewTab ? 'tab-fallback newtab' : 'tab-fallback';
        const colors = faviconColors(tab.url || tab.title || tab.id);
        fallback.style.setProperty('--fav-a', colors[0]);
        fallback.style.setProperty('--fav-b', colors[1]);
        fallback.textContent = hostInitial(tab);
        favicon.appendChild(fallback);
      }

      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = tab.title || 'Новая вкладка';

      const closeButton = document.createElement('button');
      closeButton.className = 'tab-close';
      closeButton.type = 'button';
      closeButton.title = 'Закрыть вкладку';
      closeButton.setAttribute('aria-label', `Закрыть вкладку «${tab.title || 'Новая вкладка'}»`);
      closeButton.appendChild(makeIcon('close'));
      closeButton.addEventListener('click', (event) => {
        event.stopPropagation();
        closeTab(tab.id);
      });

      tabElement.append(favicon, title, closeButton);
      tabElement.addEventListener('click', () => switchTab(tab.id));
      tabElement.addEventListener('auxclick', (event) => {
        if (event.button === 1) {
          event.preventDefault();
          closeTab(tab.id);
        }
      });
      tabElement.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          switchTab(tab.id);
        } else if (event.key === 'Delete') {
          event.preventDefault();
          closeTab(tab.id);
        }
      });

      fragment.appendChild(tabElement);
      if (isActive) activeElement = tabElement;
    }

    el.tabList.replaceChildren(fragment);
    el.tabCount.textContent = String(tabOrder.length);

    if (scrollActive && activeElement) {
      window.requestAnimationFrame(() => {
        activeElement.scrollIntoView({ block: 'nearest' });
      });
    }
  }

  function updateSurfaces() {
    const tab = activeTab();

    if (!tab) {
      el.newtabView.hidden = false;
      el.errorView.hidden = true;
      el.contentLoader.hidden = true;
      el.progressLine.classList.remove('visible');
      for (const candidate of tabs.values()) {
        candidate.webview?.classList.remove('active');
      }
      return;
    }

    for (const candidate of tabs.values()) {
      candidate.webview?.classList.toggle(
        'active',
        candidate.id === activeTabId && !candidate.isNewTab
      );
    }

    el.newtabView.hidden = !tab.isNewTab;

    const showError = !tab.isNewTab && Boolean(tab.error);
    el.errorView.hidden = !showError;

    if (showError) {
      renderError(tab);
    }

    const showLoader =
      !tab.isNewTab &&
      !showError &&
      Boolean(tab.loading) &&
      !tab.hasContent;

    el.contentLoader.hidden = !showLoader;
    el.progressLine.classList.toggle('visible', Boolean(tab.loading) && !tab.isNewTab);
  }

  function renderError(tab) {
    const copy = ERROR_COPY[String(tab.error.code)];
    el.errorTitle.textContent = copy?.title || (tab.error.code ? 'Не удалось открыть страницу' : 'Страница недоступна');
    el.errorMessage.textContent = copy?.message || tab.error.description || 'Проверьте подключение и попробуйте снова.';
    el.errorUrl.textContent = tab.error.url || tab.url || '';
  }

  /* ------------------------------------------------------------------ */
  /* Toolbar and address bar                                             */
  /* ------------------------------------------------------------------ */

  function syncToolbar() {
    const tab = activeTab();
    const canGoBack = Boolean(tab?.canGoBack);
    const canGoForward = Boolean(tab?.canGoForward);
    const loading = Boolean(tab?.loading && !tab?.isNewTab);

    el.backBtn.disabled = !canGoBack;
    el.forwardBtn.disabled = !canGoForward;

    setIconUse(el.reloadIcon, loading ? 'close' : 'reload');
    el.reloadBtn.title = loading ? 'Остановить загрузку' : 'Обновить (Ctrl+R)';
    el.reloadBtn.setAttribute('aria-label', loading ? 'Остановить загрузку' : 'Обновить страницу');

    el.progressLine.classList.toggle('visible', loading);
    syncOmniboxDisplay();
    updateDocumentTitle();
    updateZoomLabel();
  }

  function updateDocumentTitle() {
    const tab = activeTab();
    if (!tab || tab.isNewTab) {
      document.title = 'Keryx';
      return;
    }
    document.title = `${tab.title || hostFromUrl(tab.url) || 'Keryx'} — Keryx`;
  }

  function focusOmnibox() {
    const tab = activeTab();
    el.omnibox.value = tab && !tab.isNewTab ? (INTERNAL_URLS.get(tab.url) || tab.url) : '';
    el.omnibox.focus();
    window.requestAnimationFrame(() => {
      try {
        el.omnibox.select();
      } catch {
        /* Selection is best-effort. */
      }
    });
    updateOmniboxChrome();
  }

  function syncOmniboxDisplay(force = false) {
    if (!force && document.activeElement === el.omnibox) return;

    const tab = activeTab();
    el.omnibox.value = !tab || tab.isNewTab ? '' : prettyUrl(tab.url);
    updateOmniboxChrome();
  }

  function setOmniboxIcon(name, state = '', title = '') {
    setIconUse(el.omniboxIcon, name);
    el.omniboxIcon.className = `omnibox-icon${state ? ` ${state}` : ''}`;
    el.omniboxIcon.title = title;
  }

  function updateOmniboxChrome() {
    const focused = document.activeElement === el.omnibox;
    const value = el.omnibox.value.trim();

    if (focused) {
      if (!value) {
        setOmniboxIcon('search', '', currentEngine().searchLabel);
        el.omniboxBadge.hidden = true;
        return;
      }

      if (looksLikeUrl(value)) {
        setOmniboxIcon('globe', '', 'Перейти по адресу');
        el.omniboxBadge.textContent = 'Сайт';
      } else {
        setOmniboxIcon('search', '', currentEngine().searchLabel);
        el.omniboxBadge.textContent = currentEngine().name;
      }
      el.omniboxBadge.hidden = false;
      return;
    }

    el.omniboxBadge.hidden = true;
    const tab = activeTab();

    if (!tab || tab.isNewTab || !tab.url) {
      setOmniboxIcon('search', '', 'Поиск в интернете');
      return;
    }

    if (/^https:/i.test(tab.url)) {
      setOmniboxIcon('lock', 'secure', 'Защищённое соединение');
    } else if (/^http:/i.test(tab.url)) {
      setOmniboxIcon('alert', 'insecure', 'Соединение не защищено');
    } else {
      setOmniboxIcon('globe', '', prettyUrl(tab.url));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Zoom, fullscreen and developer tools                                */
  /* ------------------------------------------------------------------ */

  function applyZoom(tab) {
    if (!tab?.webview) return;
    try {
      tab.webview.setZoomLevel(tab.zoom);
    } catch {
      /* Zoom can only be applied after the guest is attached. */
    }
  }

  function zoomFactor(tab) {
    const zoom = tab?.zoom || 0;
    return Math.round(100 * 1.2 ** zoom);
  }

  function updateZoomLabel() {
    if (!el.zoomValue) return;
    const tab = activeTab();
    el.zoomValue.textContent = `${zoomFactor(tab)}%`;
  }

  function changeZoom(delta) {
    const tab = activeTab();
    if (!tab || tab.isNewTab || !tab.webview) return;

    tab.zoom = Math.max(-3, Math.min(5, tab.zoom + delta));
    applyZoom(tab);
    updateZoomLabel();
  }

  function resetZoom() {
    const tab = activeTab();
    if (!tab?.webview || tab.isNewTab) return;
    tab.zoom = 0;
    applyZoom(tab);
    updateZoomLabel();
  }

  function openDevTools() {
    const tab = activeTab();
    if (!tab?.webview || tab.isNewTab) return;
    try {
      tab.webview.openDevTools();
    } catch {
      /* DevTools may be unavailable. */
    }
  }

  function exitPageFullscreen(tab) {
    if (!document.body.classList.contains('page-fullscreen')) return;
    document.body.classList.remove('page-fullscreen');
    bridge.leaveFullscreen();

    if (tab?.webview) {
      try {
        const result = tab.webview.executeJavaScript(
          'if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); }',
          true
        );
        result?.catch?.(() => {});
      } catch {
        /* The guest is being torn down. */
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Popovers                                                            */
  /* ------------------------------------------------------------------ */

  function positionPopover(menu, trigger) {
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const margin = 8;

    let left = triggerRect.left;
    let top = triggerRect.top - menuRect.height - margin;

    if (menu === el.appMenu) {
      left = triggerRect.right - menuRect.width;
      top = triggerRect.bottom + margin;
    } else if (top < margin) {
      top = triggerRect.bottom + margin;
    }

    left = Math.min(Math.max(margin, left), window.innerWidth - menuRect.width - margin);
    top = Math.min(Math.max(margin, top), window.innerHeight - menuRect.height - margin);

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function openPopover(menu, trigger) {
    if (openMenu === menu) {
      closePopover();
      return;
    }

    closePopover();
    openMenu = menu;
    openMenuTrigger = trigger;

    if (menu === el.engineMenu) renderEngineOptions();
    updateZoomLabel();

    menu.hidden = false;
    menu.style.visibility = 'hidden';
    el.menuBackdrop.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');

    positionPopover(menu, trigger);
    menu.style.visibility = '';

    window.requestAnimationFrame(() => {
      menu.querySelector('button')?.focus();
    });
  }

  function closePopover() {
    if (!openMenu) return;

    const menu = openMenu;
    const trigger = openMenuTrigger;
    const focusWasInside = menu.contains(document.activeElement);

    menu.hidden = true;
    openMenu = null;
    openMenuTrigger = null;
    el.menuBackdrop.hidden = true;

    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (focusWasInside && trigger) trigger.focus();
  }

  /* ------------------------------------------------------------------ */
  /* Search engines                                                      */
  /* ------------------------------------------------------------------ */

  function renderEngineSelection() {
    const engine = currentEngine();

    el.engineMark.textContent = engine.mark;
    el.engineMark.className = `engine-mark${engine.markClass ? ` ${engine.markClass}` : ''}`;
    el.engineName.textContent = engine.name;
    el.startEngineLabel.textContent = engine.searchLabel;

    renderEngineOptions();
    updateOmniboxChrome();
  }

  function renderEngineOptions() {
    const fragment = document.createDocumentFragment();

    for (const [id, engine] of Object.entries(ENGINES)) {
      const button = document.createElement('button');
      button.className = `engine-option${id === currentEngineId ? ' active' : ''}`;
      button.type = 'button';
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String(id === currentEngineId));
      button.dataset.engine = id;

      const mark = document.createElement('span');
      mark.className = `engine-mark${engine.markClass ? ` ${engine.markClass}` : ''}`;
      mark.textContent = engine.mark;

      const label = document.createElement('span');
      label.className = 'engine-option-label';
      label.textContent = engine.name;

      const check = document.createElement('span');
      check.className = 'engine-check';
      check.appendChild(makeIcon('check'));

      button.append(mark, label, check);
      button.addEventListener('click', () => {
        setEngine(id);
        closePopover();
      });

      fragment.appendChild(button);
    }

    el.engineOptions.replaceChildren(fragment);
  }

  function setEngine(id) {
    if (!ENGINES[id] || id === currentEngineId) return;
    currentEngineId = id;
    saveEngine(id);
    renderEngineSelection();
  }

  /* ------------------------------------------------------------------ */
  /* New tab content                                                     */
  /* ------------------------------------------------------------------ */

  function buildQuickLinks() {
    const fragment = document.createDocumentFragment();

    for (const link of QUICK_LINKS) {
      const button = document.createElement('button');
      button.className = 'quick-link';
      button.type = 'button';
      button.title = `Открыть ${link.name}`;
      button.style.setProperty('--tile', link.color);

      const iconBox = document.createElement('span');
      iconBox.className = 'quick-icon';
      iconBox.appendChild(makeIcon(link.icon));

      const label = document.createElement('span');
      label.textContent = link.name;

      button.append(iconBox, label);
      button.addEventListener('click', () => {
        if (!link.internal) {
          navigateActive(link.url);
          return;
        }

        const tab = activeTab();
        if (tab?.isNewTab) {
          navigateTab(tab, link.url, { focusContent: true });
        } else {
          createTab({ url: link.url, activate: true, focusContent: true });
        }
      });
      fragment.appendChild(button);
    }

    el.quickLinks.replaceChildren(fragment);
  }

  function updateClock() {
    const now = new Date();
    const time = new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(now);
    const date = new Intl.DateTimeFormat('ru-RU', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    }).format(now);

    el.clock.textContent = time;
    el.date.textContent = date.charAt(0).toUpperCase() + date.slice(1);

    const hour = now.getHours();
    let greeting = 'Доброй ночи';
    if (hour >= 5 && hour < 12) greeting = 'Доброе утро';
    else if (hour >= 12 && hour < 18) greeting = 'Добрый день';
    else if (hour >= 18 && hour < 23) greeting = 'Добрый вечер';

    el.greeting.textContent = greeting;
  }

  /* ------------------------------------------------------------------ */
  /* Toasts                                                              */
  /* ------------------------------------------------------------------ */

  function dismissToast(toast) {
    if (!toast?.isConnected) return;
    toast.classList.add('removing');
    window.setTimeout(() => toast.remove(), 220);
  }

  function showToast(title, message = '', { tone = 'default', icon = 'info', timeout = 4200 } = {}) {
    if (!el.toastStack) return;

    while (el.toastStack.children.length >= 4) {
      el.toastStack.firstElementChild?.remove();
    }

    const toast = document.createElement('div');
    toast.className = `toast${tone === 'error' ? ' error' : ''}`;

    const iconBox = document.createElement('span');
    iconBox.className = 'toast-icon';
    iconBox.appendChild(makeIcon(icon));

    const copy = document.createElement('div');
    copy.className = 'toast-copy';
    const heading = document.createElement('strong');
    heading.textContent = title;
    copy.appendChild(heading);

    if (message) {
      const text = document.createElement('span');
      text.textContent = message;
      copy.appendChild(text);
    }

    toast.append(iconBox, copy);
    toast.addEventListener('click', () => dismissToast(toast));
    el.toastStack.appendChild(toast);

    window.setTimeout(() => dismissToast(toast), timeout);
  }

  /* ------------------------------------------------------------------ */
  /* Window controls                                                     */
  /* ------------------------------------------------------------------ */

  function updateMaximizeState(maximized) {
    setIconUse(el.maximizeIcon, maximized ? 'restore' : 'maximize');
    el.maximizeBtn.title = maximized ? 'Восстановить' : 'Развернуть';
    el.maximizeBtn.setAttribute('aria-label', maximized ? 'Восстановить окно' : 'Развернуть окно');
  }

  function initWindowControls() {
    el.minimizeBtn.addEventListener('click', () => bridge.minimize());
    el.maximizeBtn.addEventListener('click', () => bridge.toggleMaximize());
    el.closeBtn.addEventListener('click', () => bridge.close());

    bridge.onWindowState((state) => {
      updateMaximizeState(Boolean(state?.maximized));
      if (state && !state.fullscreen) {
        document.body.classList.remove('page-fullscreen');
      }
    });

    Promise.resolve(bridge.isMaximized())
      .then((maximized) => updateMaximizeState(Boolean(maximized)))
      .catch(() => {});
  }

  /* ------------------------------------------------------------------ */
  /* Core UI events                                                      */
  /* ------------------------------------------------------------------ */

  function handleMenuAction(action) {
    switch (action) {
      case 'new-tab':
        createTab({ activate: true, focusAddress: true });
        break;
      case 'reopen-tab':
        reopenClosedTab();
        break;
      case 'zoom-in':
        changeZoom(0.5);
        break;
      case 'zoom-out':
        changeZoom(-0.5);
        break;
      case 'zoom-reset':
        resetZoom();
        break;
      case 'devtools':
        openDevTools();
        break;
      case 'about':
        bridge.showAbout();
        break;
      default:
        break;
    }
  }

  function handleShortcut(payload) {
    const action = payload?.action;
    if (!action) return;

    switch (action) {
      case 'new-tab':
        createTab({ activate: true, focusAddress: true });
        break;
      case 'close-tab':
        closeActiveTab();
        break;
      case 'reopen-tab':
        reopenClosedTab();
        break;
      case 'focus-address':
        focusOmnibox();
        break;
      case 'reload':
        reloadActive({ force: true });
        break;
      case 'hard-reload':
        hardReloadActive();
        break;
      case 'back':
        navigateHistory(-1);
        break;
      case 'forward':
        navigateHistory(1);
        break;
      case 'home':
        goHome();
        break;
      case 'zoom-in':
        changeZoom(0.5);
        break;
      case 'zoom-out':
        changeZoom(-0.5);
        break;
      case 'zoom-reset':
        resetZoom();
        break;
      case 'next-tab':
        cycleTab(1);
        break;
      case 'previous-tab':
        cycleTab(-1);
        break;
      case 'select-tab':
        selectTabByIndex(Number(payload.index));
        break;
      case 'select-last-tab':
        selectLastTab();
        break;
      case 'devtools':
        openDevTools();
        break;
      default:
        break;
    }
  }

  function isTypingTarget(target) {
    return Boolean(
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    );
  }

  function handleGlobalKeyDown(event) {
    if (event.key === 'Escape') {
      if (openMenu) {
        event.preventDefault();
        closePopover();
        return;
      }

      if (document.activeElement === el.omnibox) {
        el.omnibox.blur();
        syncOmniboxDisplay(true);
        return;
      }

      if (document.activeElement === el.startSearch) {
        el.startSearch.blur();
      }
    }

    if (
      event.key === '/' &&
      !isTypingTarget(event.target) &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      activeTab()?.isNewTab
    ) {
      event.preventDefault();
      el.startSearch.focus();
    }
  }

  function bindEvents() {
    el.backBtn.addEventListener('click', () => navigateHistory(-1));
    el.forwardBtn.addEventListener('click', () => navigateHistory(1));
    el.reloadBtn.addEventListener('click', () => reloadActive());
    el.homeBtn.addEventListener('click', goHome);
    el.newTabBtn.addEventListener('click', () => createTab({ activate: true, focusAddress: true }));
    el.retryBtn.addEventListener('click', retryActive);

    el.omniboxForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = el.omnibox.value;
      if (!String(value).trim()) return;
      navigateActive(value);
      el.omnibox.blur();
    });

    el.omnibox.addEventListener('focus', () => {
      const tab = activeTab();
      el.omnibox.value = tab && !tab.isNewTab ? tab.url : '';
      window.requestAnimationFrame(() => {
        try {
          el.omnibox.select();
        } catch {
          /* Selection is best-effort. */
        }
      });
      updateOmniboxChrome();
    });

    el.omnibox.addEventListener('input', updateOmniboxChrome);
    el.omnibox.addEventListener('blur', () => {
      syncOmniboxDisplay(true);
    });

    el.startSearchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = el.startSearch.value;
      if (!String(value).trim()) return;
      el.startSearch.value = '';
      navigateActive(value);
    });

    el.engineBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openPopover(el.engineMenu, el.engineBtn);
    });

    el.menuBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openPopover(el.appMenu, el.menuBtn);
    });

    el.menuBackdrop.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      closePopover();
    });

    el.appMenu.addEventListener('click', (event) => {
      const action = event.target.closest('[data-menu-action]')?.dataset.menuAction;
      if (!action) return;
      closePopover();
      handleMenuAction(action);
    });

    document.addEventListener('keydown', handleGlobalKeyDown);
    window.addEventListener('resize', closePopover);
    window.addEventListener('blur', closePopover);

    initWindowControls();
  }

  function subscribeToBridge() {
    bridge.onShortcut(handleShortcut);

    bridge.onOpenTab(({ url, active = true } = {}) => {
      if (!url) return;
      const tab = createTab({
        url,
        activate: Boolean(active),
        focusContent: Boolean(active)
      });
      if (!active) renderTabs();
      return tab;
    });

    bridge.onSearch(({ query, active = true } = {}) => {
      if (!String(query || '').trim()) return;
      const url = searchUrl(query);
      createTab({
        url,
        activate: active !== false,
        focusContent: active !== false
      });
    });

    bridge.onDownload((payload) => {
      if (!payload || payload.phase !== 'finished') return;

      if (payload.state === 'completed') {
        showToast('Файл загружен', payload.fileName, {
          icon: 'download',
          timeout: 5200
        });
      } else if (payload.state === 'interrupted') {
        showToast('Не удалось скачать файл', payload.fileName, {
          tone: 'error',
          icon: 'alert',
          timeout: 5200
        });
      }
    });
  }

  function init() {
    renderEngineSelection();
    buildQuickLinks();
    updateClock();
    window.setInterval(updateClock, 30_000);

    bindEvents();
    subscribeToBridge();

    createTab({ activate: true, focusAddress: true });
  }

  init();
})();

