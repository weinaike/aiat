# AIAT (AI Assistant Toolkit)

AI 智能体开发工具包 - VS Code 扩展，通过 MCP 隧道为后端智能体提供本地工具服务。

## 功能特性

### 🌐 MCP 隧道

通过 WebSocket 主动连接公网服务器，解决局域网内服务无法被公网访问的问题：

- 连接后端 AgentFlow 服务
- 自动注册本地工具到后端
- 接收并执行后端转发的 MCP 请求
- 支持自动重连和心跳保活

### 🛠️ 本地工具

**文件操作**
- `read_file` - 读取文件内容（支持行范围）
- `write_file` - 创建或覆盖文件
- `list_directory` - 列出目录内容（支持递归）
- `delete_file` - 删除文件或目录

**代码搜索**
- `text_search` - 在工作区中搜索文本（支持正则）
- `file_search` - 按文件名模式搜索
- `symbol_search` - 搜索代码符号（函数、类等）

**终端和编辑器**
- `run_command` - 在终端中执行命令
- `get_diagnostics` - 获取诊断信息（错误、警告）
- `open_file` - 在编辑器中打开文件

### 💬 消息面板

- 显示智能体发送的消息
- 支持发送任务到智能体
- 消息历史记录和持久化

## 快速开始

1. **安装扩展** - 在 VS Code 中安装 AIAT 扩展
2. **打开工作区** - 打开需要操作的项目目录
3. **连接服务** - 点击侧边栏 AIAT 图标，在消息面板点击连接按钮
4. **发送任务** - 在消息面板输入任务描述，发送给智能体

## 配置选项

在 VS Code 设置中配置（`Ctrl+,` 搜索 `aiat`）：

| 设置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `aiat.mcpTunnel.enabled` | boolean | true | 启用 MCP 隧道模式 |
| `aiat.agentServer.url` | string | ws://agent-flow... | 后端智能体服务地址 |
| `aiat.agentServer.autoConnect` | boolean | true | 自动连接智能体服务 |
| `aiat.enableFileOperations` | boolean | true | 启用文件操作工具 |
| `aiat.enableCodeSearch` | boolean | true | 启用代码搜索工具 |
| `aiat.enableTerminal` | boolean | true | 启用终端操作工具 |

## 可用命令

| 命令 | 说明 |
|------|------|
| `AIAT: 显示服务状态` | 显示 MCP 隧道连接状态 |
| `AIAT: 打开配置` | 打开设置页面 |
| `AIAT: 连接智能体服务` | 连接后端 WebSocket |
| `AIAT: 断开智能体服务` | 断开连接 |
| `AIAT: 打开消息面板` | 打开智能体消息视图 |

## 开发

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 监听模式
npm run watch

# 调试运行
按 F5 启动扩展调试
```

## 项目结构

```
src/
├── extension.ts          # 扩展入口
├── types/                # MCP 协议类型定义
├── tools/                # 本地工具实现
├── client/
│   └── agentClient.ts    # WebSocket 客户端（集成 MCP 隧道）
└── views/                # UI 视图组件
```

## 许可证

MIT
