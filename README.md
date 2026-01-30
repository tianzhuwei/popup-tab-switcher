# Popup Tab Switcher

> **原项目来源**: [dvdvdmt/popup-tab-switcher](https://github.com/dvdvdmt/popup-tab-switcher)  
> **原作者**: [dvdvdmt](https://github.com/dvdvdmt)  
> **Chrome 商店**: [Popup Tab Switcher](https://chrome.google.com/webstore/detail/popup-tab-switcher/cehdjppppegalmaffcdffkkpmoflfhkc)

![Popup tab switcher logo](./readme-assets/tab-switcher-logo.png)

## 简介

一个让标签页切换更便捷的浏览器扩展。它会记住标签页的访问顺序，让你无需使用鼠标就能在最近访问的标签页之间快速切换。

## 主要功能

- **快速切换**: 按 `Alt+Y` 向下选择标签，`Alt+Shift+Y` 向上选择
- **置顶标签**: 将常用标签置顶，保持在列表顶部不变
- **现代界面**: 玻璃态设计，支持深色/浅色主题
- **智能关闭**: 关闭标签时自动切换到上一个访问的标签

## 使用方法

1. 按 `Alt+Y` 打开标签切换弹窗
2. 继续按 `Alt+Y` 或 `Alt+Shift+Y` 选择标签
3. 松开 `Alt` 键切换到选中的标签
4. 按 `Escape` 或点击弹窗外部关闭

## 设置说明

点击扩展图标打开设置页面，可配置：

| 选项         | 说明                       |
| ------------ | -------------------------- |
| 深色主题     | 开启/关闭深色模式          |
| 弹窗宽度     | 设置弹窗宽度               |
| 最大标签数   | 显示的最近标签数量         |
| 字体大小     | 标签标题文字大小           |
| 自动切换超时 | 页面无焦点时的自动切换时间 |

## 限制

- Chrome 网上应用店页面无法使用
- 特殊 Chrome 页面（设置、新标签页等）无法显示弹窗
- 本地文件页面需要在扩展设置中开启"允许访问文件网址"

## 开发

```bash
npm install
npm run build:dev
```

然后在 `chrome://extensions/` 加载 `build-dev` 目录。

## 致谢

- 原作者: [dvdvdmt](https://github.com/dvdvdmt)
- 图标设计: [Alina Zaripova](https://www.behance.net/alicilinia)
