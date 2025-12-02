# Change Log

All notable changes to the "AIAT" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.6] - 2025-12-02

更新文档

## [0.0.5] - 2025-12-02

### 重大变更

- **移除本地 MCP 服务器** - 不再需要开放本地端口
- **集成 MCP 隧道到 AgentClient** - MCP 功能现在通过 WebSocket 隧道提供，简化架构

### 新增功能

- MCP 隧道模式：通过 WebSocket 主动连接公网服务器，解决局域网穿透问题
- 自动发送 MCP 注册消息，注册本地工具到后端
- 支持后端转发的 MCP 请求（initialize、tools/list、tools/call）

### 移除功能

- 移除 `aiat.serverPort` 配置项（不再需要本地端口）
- 移除 `aiat.teamConfig.id` 和 `aiat.teamConfig.codebase` 配置项
- 移除 `aiat.autoStart` 和 `aiat.authToken` 配置项
- 移除 `AIAT: 启动工具服务器` 和 `AIAT: 停止工具服务器` 命令

### 技术改进

- 简化代码架构，MCP 隧道功能集成到 AgentClient
- 更新 README.md 文档

## [0.0.4] - 2025-11-28

### 新增功能

### 修复问题

### 技术细节

## [0.0.3] - 2025-11-28

### Added
- 初始版本发布
- MCP (Model Context Protocol) 服务器实现
- WebSocket 客户端连接 AgentFlow 后端
- 完整的文件操作工具（读取、写入、列表、删除）
- 代码搜索工具（文本、文件、符号搜索）
- 终端和编辑器操作工具
- 智能体消息面板和历史记录
- VS Code 侧边栏集成界面
- 配置管理和状态显示

### Features
- 支持 JSON-RPC 2.0 MCP 协议
- 自动代码库路径检测
- Bearer Token 认证支持
- 实时消息推送和显示
- 任务状态管理（连接状态、任务状态分离）
- 智能UI控件（根据状态动态调整）

### Technical Details
- TypeScript 开发，webpack 打包
- VS Code 扩展 API 集成
- WebSocket 实时通信
- 可扩展的工具注册系统

### Changed

- 优化扩展图标设计，调整字母A的横线位置
- 增强背景圆环的透明度，提升视觉效果
- 重新调整字母T的布局和尺寸，保持图标平衡