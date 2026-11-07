# fanjinsong · 技术笔记

使用 Markdown 写文章，由 Jekyll 生成页面，沿用 GitHub Pages 托管。首页的文章列表、分类和数量由文章信息自动生成。

## 写一篇文章

1. 复制 `_templates/post.md` 到 `_posts/`，按 `年-月-日-英文短名.md` 命名，例如 `2026-11-07-git-notes.md`。
2. 修改文件最上方两行 `---` 之间的信息，用 Markdown 编写正文。
3. 准备发布时，删除模板中的 `published: false`，或改为 `published: true`。

文件示例：

````markdown
---
title: "Git 使用笔记"
date: 2026-11-07 00:00:00 +0800
category: 开发工具
tags: [Git, 命令行]
description: "记录常用 Git 命令及使用场景。"
---

## 查看工作区

这里写正文，可以使用列表、链接、图片和代码块。

```sh
git status --short
```
````

- `title`：文章标题。
- `date`：文章日期，用于首页排序；建议与文件名日期一致，并保留 `+0800` 时区。
- `category`：分类名称，直接使用中文，例如“编程语言”“开发工具”“工程实践”。新分类会自动出现在侧边栏。需要多个分类时，可改写为 `categories: [开发工具, 工程实践]`，不要同时填写两个字段。
- `tags`：可选标签。
- `description`：可选摘要；未填写时首页会从正文提取摘要。

无需修改首页 HTML 或分类按钮。文章页面使用统一布局，访问地址为 `/notes/英文短名.html`，例如 `/notes/git-notes.html`。文件使用 UTF-8 编码保存，不要添加 BOM。

## 草稿与未来文章

保留 `published: false` 可以暂不发布文章。也可以把未完成的 Markdown 文件放入 `_drafts/`，使用不带日期的文件名，完成后再移入 `_posts/` 并补上日期。

未来日期的文章默认不会出现在正式站点中。需要立即发布时，请检查文件名和 `date`。

## 本地预览

安装 Ruby 和 Bundler 后，在仓库目录执行：

```sh
bundle install
bundle exec jekyll serve --host 127.0.0.1
```

浏览器访问 <http://127.0.0.1:4000>。预览草稿和标记为未发布的文章时，改用：

```sh
bundle exec jekyll serve --drafts --unpublished --host 127.0.0.1
```

源文件需要先经过 Jekyll 生成，不能再通过双击 `index.html` 或对仓库源目录运行 `python -m http.server` 预览。仅生成静态页面可运行 `bundle exec jekyll build`，结果在 `_site/`。

## 目录

- `_posts/`：正式文章的 Markdown 源文件。
- `_templates/post.md`：新文章模板，复制后再编辑。
- `_layouts/`：首页和文章共用的页面布局。
- `index.html`：个人介绍，以及自动生成文章和分类的模板。
- `assets/`：样式、脚本和图片等资源。
- `_config.yml`：站点信息与 Jekyll 配置。

图片可放入 `assets/images/`，正文使用 `![图片说明](/assets/images/实际文件名.png)` 引用，先保存图片再添加链接。

## 发布

沿用仓库已有的 GitHub Pages 发布设置。检查本地预览后，再提交并推送到发布来源对应的分支；本地编辑本身不会更新线上站点。

参考：[Jekyll 文章说明](https://jekyllrb.com/docs/posts/)、[GitHub Pages 与 Jekyll](https://docs.github.com/en/pages/setting-up-a-github-pages-site-with-jekyll/about-github-pages-and-jekyll)。
