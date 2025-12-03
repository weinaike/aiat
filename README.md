# AIAT (AI Assistant Toolkit)

AI 智能体开发工具包 - VS Code 扩展，通过 MCP 隧道为后端智能体提供本地工具服务。

## 功能特性

### 🌐 MCP 隧道

通过 WebSocket 主动连接公网服务器，解决局域网内服务无法被公网访问的问题：

- 连接后端 AgentFlow 服务
- 自动注册本地工具到后端
- 接收并执行后端转发的 MCP 请求
- 支持自动重连和心跳保活

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

| `aiat.agentServer.url` | string | ws://agent-flow... | 后端智能体服务地址 |
| `aiat.agentServer.autoConnect` | boolean | true | 自动连接智能体服务 |
| `aiat.toolSource` | string | local | 工具来源：local/builtin-mcp/none |
| `aiat.mcpServers.custom` | array | [] | 自定义 MCP 服务器配置列表 |

## 工具来源配置

AIAT 支持三种工具来源，通过 `aiat.toolSource` 配置切换：

| 值 | 说明 |
|----|------|
| `builtin-mcp` | **默认推荐**。使用内置的 DesktopCommanderMCP，功能强大 |
| `local` | 使用插件内置的轻量工具 |
| `none` | 不启用任何内置工具，仅使用自定义 MCP 服务器 |

### builtin-mcp（推荐）

默认使用 [DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP)，提供：

| 工具类型 | 功能 |
|----------|------|
| **终端控制** | 启动进程、交互式输入、读取输出、终止进程 |
| **文件操作** | 读取/写入文件、创建目录、移动文件、获取文件信息 |
| **代码编辑** | 精确的搜索替换（edit_block）、模糊匹配 |
| **搜索** | 基于 ripgrep 的高速文件内容搜索 |
| **进程管理** | 列出进程、终止进程 |

### local

使用插件内置的轻量工具：
- `read_file`, `write_file`, `list_directory`, `delete_file`
- `text_search`, `glob_search`, `symbol_search`
- `run_command`, `get_diagnostics`, `open_file`

## 添加自定义 MCP 服务器

除了内置服务器，你还可以添加其他第三方 MCP 服务器。

### 配置示例

在 VS Code 设置（settings.json）中添加：

```json
{
  "aiat.mcpServers.custom": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"],
      "enabled": true
    },
    {
      "name": "my-custom-mcp",
      "command": "node",
      "args": ["/path/to/my-mcp-server/index.js"],
      "env": {
        "MY_API_KEY": "xxx"
      },
      "cwd": "/path/to/my-mcp-server",
      "enabled": true
    }
  ]
}
```

### 配置字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 服务器名称，用于工具前缀（如 `desktop-commander__read_file`） |
| `command` | string | ✅ | 启动命令（如 `npx`, `node`, `python` 等） |
| `args` | string[] | ❌ | 命令参数 |
| `env` | object | ❌ | 环境变量 |
| `cwd` | string | ❌ | 工作目录 |
| `enabled` | boolean | ❌ | 是否启用（默认 true） |

### 工作原理

1. **启动外部 MCP 服务器** - AIAT 启动时会通过 stdio 启动配置的 MCP 服务器
2. **发现工具** - 通过 MCP 协议的 `tools/list` 方法获取服务器提供的工具
3. **注册工具** - 将外部工具注册到 AIAT 的工具注册表，添加服务器名称前缀
4. **代理请求** - 后端智能体调用工具时，AIAT 将请求转发到对应的 MCP 服务器

### 支持的 MCP 服务器

理论上支持任何遵循 [MCP 协议](https://modelcontextprotocol.io/) 的服务器：

- **[DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP)** - 终端控制、文件编辑、进程管理
- **自定义 MCP 服务器** - 基于 [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) 开发

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
├── mcp/                  # 外部 MCP 服务器集成
│   ├── mcpClient.ts      # MCP 客户端（stdio 通信）
│   └── mcpServerManager.ts # MCP 服务器管理器
├── client/
│   └── agentClient.ts    # WebSocket 客户端（集成 MCP 隧道）
└── views/                # UI 视图组件
```

## 许可证

MIT
