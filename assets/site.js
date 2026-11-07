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
    if (themeColor) themeColor.content = isDark ? '#1d231e' : '#fafbf8';
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
  document.querySelectorAll('[data-year]').forEach(element => {
    element.textContent = String(new Date().getFullYear());
  });
})();
