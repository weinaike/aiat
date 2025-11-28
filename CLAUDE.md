# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

这个VS Code插件实现了一个MCP（模型上下文协议）服务器，为后端AI代理提供文件操作、代码搜索和终端工具等功能。它还包括一个WebSocket客户端，用于与AgentFlow后端进行通信。

## 🚀 核心功能

### WebSocket 客户端
1. 连接到AgentFlow后端的WebSocket服务器， 管理连接状态
2. 处理来自后端的消息，包括任务开始、任务停止、心跳、输入请求和结果消息
3. 发送消息到后端，包括启动任务、停止任务、心跳和输入响应
4. 支持任务中断和恢复机制
5. 维护界面功能，显示连接状态和接收到的消息，更新UI、状态指示器、控件等

### 🔧 UI 改进
- **简化界面布局**：将启动/停止任务按钮合并到发送按钮中
- **智能按钮状态**：根据当前状态动态调整按钮功能和样式
- **输入请求处理**：在后端请求输入时，自动切换输入模式
- **状态同步**：实时反映连接和任务状态变化

## 📊 状态管理系统

### 连接状态 (ConnectionState)
纯粹的WebSocket连接状态，只反映连接本身的状态：

- `connecting` - 正在建立WebSocket连接
- `connected` - 成功连接，准备接收消息
- `error` - 连接或执行错误
- `closed` - 连接已关闭（包括主动断开和被动断开）

### 任务状态 (TaskState)
完整的任务生命周期状态，独立于连接状态：

- `idle` - 空闲状态，可以启动新任务
- `starting` - 任务正在启动
- `running` - 任务执行中
- `awaiting_input` - 等待用户输入响应
- `stopping` - 任务正在停止
- `completed` - 任务已完成
- `error` - 任务执行错误

### 🔄 状态依赖关系

**单向依赖关系**：
- **连接状态 → 影响任务状态**：连接中断时，所有任务自动回到 `idle` 状态
- **任务状态 → 不影响连接状态**：任务执行不会改变连接状态，一个连接可以承载多个任务

**实际效果**：
- 连接断开时：`connected` → `error/closed` 强制任务状态 `any` → `idle`
- 任务执行时：`idle` → `running` → `idle` 连接保持 `connected`
- UI控件：连接中断时禁用所有任务控件，连接恢复时根据任务状态启用相应控件

### 🎯 UI 状态逻辑

**发送按钮智能行为**：
- 未连接时：显示"发送"，按钮禁用
- 连接且空闲：显示"发送"，可启动新任务
- 任务运行中：显示"停止"，按钮变红，可停止任务
- 等待输入：显示"发送"，可发送输入响应
- 连接错误：显示"发送"，按钮禁用

**输入框动态行为**：
- 未连接：禁用，提示"请先连接智能体服务..."
- 空闲/启动任务：启用，提示"输入任务描述或消息..."
- 任务运行中：禁用，提示"任务执行中..."
- 等待输入：启用，提示"请输入响应..."

## Development Commands

### Building and Compilation

- `npm run compile` - Compile TypeScript to JavaScript using webpack
- `npm run watch` - Watch mode compilation (auto-rebuild on changes)
- `npm run package` - Production build with minification and source maps

### Testing and Quality

- `npm run lint` - Run ESLint on source files
- `npm run test` - Run VS Code tests
- `npm run pretest` - Full test preparation (compile tests, compile source, lint)

### Debugging

- Press `F5` in VS Code to launch extension development host
- Use `vscode.debug.startDebugging` API for custom debugging

## Architecture Overview

### Core Components

This VS Code extension implements an MCP (Model Context Protocol) server that provides tools to backend AI agents:

- **MCP Server** (`src/server/mcpServer.ts`) - JSON-RPC 2.0 server on port 9527 handling MCP protocol
- **Tool Registry** (`src/tools/`) - Extensible system for file operations, code search, and terminal tools
- **Agent Client** (`src/client/agentClient.ts`) - WebSocket client connecting to AgentFlow backend
- **UI Views** (`src/views/`) - Tree data providers and webview for status, config, tools, and chat

### Tool Protocol Implementation

- **MCP Protocol Version**: 2024-11-05
- **Transport**: HTTP POST on `/` and `/mcp` endpoints
- **Authentication**: Optional Bearer token support
- **Key Methods**: `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`

### Extension Structure

```text
src/
├── extension.ts          # Extension entry point and command registration
├── types/index.ts        # MCP protocol type definitions
├── tools/               # Tool implementations with base class abstraction
│   ├── baseTool.ts      # Abstract base tool class
│   ├── fileTools.ts     # File operations (read, write, list, delete)
│   ├── searchTools.ts   # Code search (text, file, symbol search)
│   └── terminalTools.ts # Terminal and editor operations
├── server/
│   └── mcpServer.ts     # MCP protocol server with HTTP transport
├── client/
│   ├── agentClient.ts   # WebSocket client for AgentFlow integration
│   └── stateManager.ts  # State management with ConnectionState and TaskState separation
└── views/               # UI components
    ├── statusView.ts    # Server status tree view
    ├── configView.ts    # Configuration tree view
    ├── toolsView.ts     # Available tools tree view
    └── chatView.ts      # Agent messages webview
```

### Configuration System

The extension uses VS Code settings under `aiat.*` namespace:

- **Server**: port 9527, auto-start option
- **Agent Selection**: Team ID is now selected via the chat interface dropdown (智能体选择器)
- **Codebase**: Automatically uses VS Code workspace root directory with validation
- **Agent Server**: WebSocket URL and auto-connect settings
- **Feature Flags**: Enable/disable file operations, code search, terminal tools

### Smart Configuration Features

- **Auto Codebase Detection**: Automatically detects and uses the current VS Code workspace root directory
- **Directory Validation**: Validates codebase directory exists, is readable, and contains project files
- **Agent Selection**: Team ID is determined by the selected agent in the chat interface dropdown
- **Error Prevention**: Blocks task start if codebase directory is invalid or inaccessible

## Development Notes

### Tool Development

When adding new tools:

1. Extend `BaseTool` class from `src/tools/baseTool.ts`
2. Implement the abstract methods with proper error handling
3. Register in `ToolRegistry` (`src/tools/index.ts`)
4. Follow MCP tool specification for schema definition

### MCP Protocol

- Server supports both `POST /` and `POST /mcp` endpoints
- JSON-RPC 2.0 compliance required for all responses
- Session initialization with `initialize` method is mandatory
- Tool names use snake_case convention (e.g., `read_file`, `text_search`)

### WebSocket Communication

- Uses standard WebSocket API with automatic reconnection
- Heartbeat mechanism for connection maintenance
- Message queue for handling disconnected state
- Run ID generation uses UUID v4 format

## 🔧 关键修复和改进

### 状态管理重构 (2025-11-27)

**问题**：之前连接状态和任务状态混合，逻辑混乱
**解决方案**：实现清晰的单向依赖关系

1. **ConnectionState 精简**：`connecting | connected | error | closed`
2. **TaskState 完整**：`idle | starting | running | awaiting_input | stopping | completed | error`
3. **单向依赖**：连接状态变化会影响任务状态，但任务状态变化不影响连接状态
4. **UI 智能化**：根据连接和任务状态动态调整界面控件

### UI 布局优化

**改进前**：多个独立按钮，状态分散
**改进后**：单一智能发送按钮

1. **合并功能**：启动/停止/输入响应都在一个按钮中
2. **状态驱动**：按钮文本和样式根据当前状态自动变化
3. **动态提示**：输入框占位符根据状态提供相应提示
4. **视觉反馈**：停止时按钮变红，提供明确的视觉指示

### 停止任务机制优化

**问题**：停止任务后状态卡在 'stopping'，无法启动新任务
**解决方案**：多层恢复机制

1. **消息处理**：正确处理后端的 `completion` 消息（status: 'cancelled'）
2. **超时保护**：5秒超时机制，防止状态卡死
3. **状态转换**：`stopping` → `idle` 的可靠转换
4. **连接保持**：停止任务不会断开WebSocket连接

## 🛠️ Backend Agent Protocol (AgentFlow WebSocket API Documentation)

### Overview

The AgentFlow WebSocket API provides real-time communication for task execution. It enables bidirectional communication between clients and the AutoGen agents system.

**Endpoint**: /ws/runs/{run_id}
**Protocol**: WebSocket (RFC 6455)
**Description**: Real-time communication for task execution

### Connection

Connect to the WebSocket endpoint using the following URL pattern:
```
ws://localhost:8084/ws/runs/{run_id}?token=your_auth_token
```

**Parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| run_id | integer | Yes | The ID of the run to connect to |
| token | string | No | Bearer authentication token (query parameter) |

### Client to Server Messages

Messages that clients can send to the server:

#### Start Task

Description: Start task execution

```json
{ "type": "start", "task": "What is the weather today?", "files": [], "team_config": { "id": 2, "codebase": "/root/project/xxx/", "flow_id":"flow1", "node_id": ["node1", "node2"], "mcp_port": 8080, "mcp_server": "127.0.0.1", "mcp_token": "your_token" } }
```

#### Stop Task

Description: Stop task execution

```json
{ "type": "stop", "reason": "User cancelled" }
```

#### Ping

Description: Ping server for connection check

```json
{
  "type": "ping"
}
```

#### Input Response

Description: Respond to input request from agent

```json
{ "type": "input_response", "response": "Yes, continue with the task" }
```

### Server to Client Messages

Messages that the server sends to clients:

#### System Status

Description: System status messages

```json
{ "type": "system", "status": "connected", "timestamp": "2024-01-01T12:00:00Z" }
```

#### Agent Message

Description: Agent messages during execution

```json
{
  "type": "message",
  "data": {
    "id": "9e6f9f2c-9766-4734-b65a-af149aa17874",
    "created_at": "2025-07-23T01:52:11.783630+00:00",
    "source": "flow1.node1.assistant",
    "name": "功能分析",
    "content": "Processing your request...",
    "type": "TextMessage"
  }
}
```

#### Task Result

Description: Final task result

```json
{ "type": "result", "status": "partial", "data": { "task_result": { "messages": [ { "id": "673349a2-ca2b-4da0-8fe7-a07518eda6e1", "source": "flow1.node1.summary_agent", "models_usage": { "prompt_tokens": 5428, "completion_tokens": 1049 }, "metadata": {}, "created_at": "2025-07-23T01:52:20.279239+00:00", "content": "# Codon项目业务分析文档\n\n## 项目总体介绍\n\n......", "type": "TextMessage", "name": "功能分析" } ], "stop_reason": "node completed" }, "usage": "flow1.node1.summary_agent", "duration": 27.859392881393433 } }
```

```json
{ "type": "result", "status": "complete", "data": { "task_result": { "messages": [ { "id": "558e96b2-b8c2-4efa-b7ec-a26be2d6c8a7", "source": "solution", "name": "solution", "content": "Solution execution completed.", "type": "TextMessage"} ], "stop_reason": "task completed" }, "usage": "solution", "duration": 28.52797770500183 } }
```

#### Input Request

Description: Request for user input

```json
{ "type": "input_request", "prompt": "Do you want to continue?", "data": {"source": "system", "content": "Waiting for user input"} }
```

#### Pong

Description: Response to ping

```json
{ "type": "pong", "timestamp": "2024-01-01T12:00:00Z" }
```

#### 手动取消任务 返回的消息
```json
{
  "type": "completion",
  "status": "cancelled",
  "data": {
    "task_result": {
      "messages": [
        {
          "id": "360ebe1a-85c4-4621-83d1-1880cf2cc00f",
          "source": "user",
          "models_usage": null,
          "metadata": {},
          "created_at": "2025-11-27T12:45:50.764136+00:00",
          "content": "User requested stop",
          "type": "TextMessage"
        }
      ],
      "stop_reason": "User requested stop"
    },
    "usage": "",
    "duration": 0
  },
  "timestamp": "2025-11-27T12:45:50.770383+00:00"
}
```
#### Error

Description: Error messages

```json
{ "type": "error", "error": "Error description", "timestamp": "2024-01-01T12:00:00Z" }
```

### Connection States

| State | Description |
|---|---|
| connecting | Establishing WebSocket connection |
| connected | Successfully connected, ready to receive messages |
| error | Connection or execution error occurred |
| closed | Connection closed |

### Task States

| State | Description |
|---|---|
| idle | Task idle, can start new tasks |
| starting | Task starting up |
| running | Task execution in progress |
| awaiting_input | Waiting for user input response |
| stopping | Task stopping |
| completed | Task completed successfully |
| error | Task execution error |

### Error Codes

- `4001`: Authentication failed
- `4003`: Not authorized to access this run or run not in valid state
- `4004`: Run not found
