(() => {
  'use strict';
  const root = document.documentElement;
  root.classList.add('js');
  const themeButton = document.querySelector('.theme-toggle');
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let savedTheme = null;
  try {
    savedTheme = localStorage.getItem('fanjinsong-theme');
  } catch {
    // Reading and filtering still work without persistent storage.
  }
  if (savedTheme !== 'dark' && savedTheme !== 'light') savedTheme = null;
  function applyTheme(theme) {
    root.dataset.theme = theme;
    const isDark = theme === 'dark';
    if (themeButton) {
      themeButton.setAttribute('aria-pressed', String(isDark));
      themeButton.setAttribute('aria-label', isDark ? '切换到浅色主题' : '切换到深色主题');
      themeButton.title = isDark ? '切换到浅色主题' : '切换到深色主题';
    }
    if (themeColor) themeColor.content = isDark ? '#1d231e' : '#f4f6f3';
  }
  applyTheme(savedTheme || (systemTheme.matches ? 'dark' : 'light'));
  themeButton?.addEventListener('click', () => {
    savedTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(savedTheme);
    try {
      localStorage.setItem('fanjinsong-theme', savedTheme);
    } catch {
      // Keep the selected theme for the current page.
    }
  });
  systemTheme.addEventListener('change', event => {
    if (!savedTheme) applyTheme(event.matches ? 'dark' : 'light');
  });
  const filters = [...document.querySelectorAll('[data-category-filter]')];
  const posts = [...document.querySelectorAll('[data-post]')];
  const heading = document.getElementById('posts-heading');
  const postCount = document.getElementById('post-count');
  const emptyState = document.getElementById('empty-state');
  const emptyMessage = document.getElementById('empty-message');
  const resetButton = document.querySelector('[data-reset-filter]');
  if (filters.length) {
    const postCategories = new Map(posts.map(post => [post, JSON.parse(post.dataset.categories)]));
    const categories = new Map(filters.map(button => [button.dataset.categoryFilter, button.querySelector('span').textContent]));
    document.querySelectorAll('[data-category-count]').forEach(element => {
      const category = element.dataset.categoryCount;
      element.textContent = String(posts.filter(post => category === '' || postCategories.get(post).includes(category)).length);
    });
    function selectCategory(category, updateUrl = false) {
      const selected = categories.has(category) ? category : '';
      let visibleCount = 0;
      posts.forEach(post => {
        post.hidden = selected !== '' && !postCategories.get(post).includes(selected);
        if (!post.hidden) visibleCount += 1;
      });
      filters.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.categoryFilter === selected)));
      if (heading) heading.textContent = categories.get(selected);
      if (postCount) postCount.textContent = String(visibleCount);
      if (emptyState) emptyState.hidden = visibleCount > 0;
      if (emptyMessage) emptyMessage.textContent = selected === '' ? '还没有发布的文章。' : '这个分类还没有文章。';
      if (updateUrl) {
        try {
          const url = new URL(window.location.href);
          if (selected === '') url.searchParams.delete('category');
          else url.searchParams.set('category', selected);
          history.replaceState(null, '', url);
        } catch {
          // Some browsers restrict history changes for directly opened files.
        }
      }
    }
    filters.forEach(button => {
      button.disabled = false;
      button.addEventListener('click', () => selectCategory(button.dataset.categoryFilter, true));
    });
    resetButton?.addEventListener('click', () => {
      selectCategory('', true);
      filters[0].focus();
    });
    selectCategory(new URLSearchParams(window.location.search).get('category') || '');
  }
  const tocCard = document.getElementById('article-toc');
  const toc = document.getElementById('toc');
  const article = document.querySelector('.article-body');
  if (tocCard && toc && article) {
    const headings = [...article.querySelectorAll('h2, h3, h4')].filter(element => element.textContent.trim());
    if (headings.length) {
      const usedIds = new Set([...document.querySelectorAll('[id]')].map(element => element.id));
      const list = document.createElement('ol');
      list.className = 'toc-list';
      const links = headings.map((element, index) => {
        if (!element.id || document.getElementById(element.id) !== element) {
          const base = `section-${index + 1}`;
          let id = base;
          let suffix = 2;
          while (usedIds.has(id)) id = `${base}-${suffix++}`;
          element.id = id;
        }
        usedIds.add(element.id);
        const level = element.tagName.slice(1);
        const item = document.createElement('li');
        item.className = `toc-item toc-level-${level}`;
        item.dataset.level = level;
        const link = document.createElement('a');
        link.className = 'toc-link';
        link.href = `#${encodeURIComponent(element.id)}`;
        link.textContent = element.textContent.trim();
        item.append(link);
        list.append(item);
        return link;
      });
      toc.append(list);
      const narrowScreen = window.matchMedia('(max-width: 900px)');
      function syncTocLayout() {
        tocCard.open = !narrowScreen.matches;
      }
      syncTocLayout();
      narrowScreen.addEventListener('change', syncTocLayout);
      tocCard.hidden = false;
      let currentLink = null;
      let updateScheduled = false;
      function updateCurrentSection() {
        updateScheduled = false;
        let selected = 0;
        headings.forEach((element, index) => {
          if (element.getBoundingClientRect().top <= 120) selected = index;
        });
        const link = links[selected];
        if (link === currentLink) return;
        currentLink?.removeAttribute('aria-current');
        link.setAttribute('aria-current', 'location');
        currentLink = link;
      }
      function scheduleTocUpdate() {
        if (updateScheduled) return;
        updateScheduled = true;
        window.requestAnimationFrame(updateCurrentSection);
      }
      window.addEventListener('scroll', scheduleTocUpdate, { passive: true });
      window.addEventListener('resize', scheduleTocUpdate);
      window.addEventListener('load', scheduleTocUpdate);
      updateCurrentSection();
      // A heading without a source ID may be the target of a bookmarked URL.
      if (window.location.hash) {
        const hashTarget = headings.find(element => `#${encodeURIComponent(element.id)}` === window.location.hash);
        hashTarget?.scrollIntoView();
      }
    }
  }
  document.querySelectorAll('[data-year]').forEach(element => {
    element.textContent = String(new Date().getFullYear());
  });
})();
