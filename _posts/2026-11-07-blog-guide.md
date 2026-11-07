---
title: "用 Markdown 记录技术内容"
date: 2026-11-07 00:00:00 +0800
category: 站点记录
tags: [Markdown, Jekyll]
description: "文章用 Markdown 编写，首页和分类自动整理。这篇记录新增文章、放置图片和本地预览的方法。"
---

这个博客把写作内容和页面样式分开：正文放在 Markdown 文件里，Jekyll 根据统一布局生成文章页，并整理首页列表与分类。

## 文件放在哪里

```text
_posts/        正式文章的 Markdown 文件
_templates/    可复制的新文章模板
_layouts/      共用页面布局
assets/        样式、脚本与图片资源
```

## 添加一篇文章

复制 `_templates/post.md` 到 `_posts/`，命名为 `年-月-日-英文短名.md`，例如 `2026-11-07-git-notes.md`。

修改文件头部的标题、日期、分类、标签和摘要，再用 Markdown 写正文。准备发布时，删除模板中的 `published: false`。不需要手动修改首页或分类列表。

```yaml
title: "Git 使用笔记"
date: 2026-11-07 00:00:00 +0800
category: 开发工具
tags: [Git]
description: "记录常用命令及使用场景。"
```

正文可以使用小标题、列表、链接和代码块。图片放到 `assets/images/`，再引用实际文件路径。

## 分类与草稿

`category` 直接填写中文分类名，首页会自动归类和统计数量。暂时不发布的内容可保留 `published: false`，也可以放进 `_drafts/`。未来日期的文章默认不会发布。

## 本地查看

安装 Ruby 和 Bundler 后，在仓库目录运行：

```sh
bundle install
bundle exec jekyll serve --host 127.0.0.1
```

然后访问 `http://127.0.0.1:4000`。确认标题、分类、图片和代码排版后，再按仓库已有的 GitHub Pages 流程发布。
