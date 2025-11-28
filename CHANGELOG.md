# Change Log

All notable changes to the "AIAT" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.2] - 2025-11-28

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