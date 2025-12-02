/**
 * MCP (Model Context Protocol) 类型定义
 * 基于 JSON-RPC 2.0 规范
 */

// ============ JSON-RPC 2.0 基础类型 ============

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: string | number;
    method: string;
    params?: Record<string, unknown> | unknown[];
}

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: unknown;
    error?: JsonRpcError;
}

export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}

export interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: Record<string, unknown>;
}

// ============ MCP 协议类型 ============

// MCP 初始化请求
export interface McpInitializeParams {
    protocolVersion: string;
    capabilities: McpClientCapabilities;
    clientInfo: {
        name: string;
        version: string;
    };
}

export interface McpClientCapabilities {
    roots?: {
        listChanged?: boolean;
    };
    sampling?: Record<string, unknown>;
    experimental?: Record<string, unknown>;
}

export interface McpServerCapabilities {
    tools?: {
        listChanged?: boolean;
    };
    resources?: {
        subscribe?: boolean;
        listChanged?: boolean;
    };
    prompts?: {
        listChanged?: boolean;
    };
    logging?: Record<string, unknown>;
    experimental?: Record<string, unknown>;
}

export interface McpInitializeResult {
    protocolVersion: string;
    capabilities: McpServerCapabilities;
    serverInfo: {
        name: string;
        version: string;
    };
    instructions?: string;
}

// MCP 工具相关类型
export interface McpTool {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, McpToolProperty>;
        required?: string[];
    };
}

export interface McpToolProperty {
    type: string;
    description: string;
    enum?: string[];
    default?: unknown;
    items?: McpToolProperty;
}

export interface McpToolCallParams {
    name: string;
    arguments?: Record<string, unknown>;
}

export interface McpToolCallResult {
    content: McpContent[];
    isError?: boolean;
}

export interface McpContent {
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
    resource?: {
        uri: string;
        mimeType?: string;
        text?: string;
    };
}

// MCP 资源相关类型
export interface McpResource {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}

export interface McpResourceTemplate {
    uriTemplate: string;
    name: string;
    description?: string;
    mimeType?: string;
}

// ============ 工具定义类型 ============

export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, {
            type: string;
            description: string;
            required?: boolean;
            default?: unknown;
            enum?: string[];
        }>;
        required?: string[];
    };
}

export interface ToolHandler {
    definition: ToolDefinition;
    execute(params: Record<string, unknown>): Promise<unknown>;
}

// ============ 服务器状态类型 ============

export interface ServerStatus {
    running: boolean;
    port: number;
    connectedClients: number;
    tools: string[];
    protocol: 'mcp' | 'mcp-tunnel';
    protocolVersion: string;
}

// ============ 文件操作相关类型 ============

export interface FileInfo {
    path: string;
    name: string;
    isDirectory: boolean;
    size?: number;
    modifiedTime?: string;
}

export interface SearchResult {
    file: string;
    line: number;
    column: number;
    content: string;
    preview: string;
}

export interface TerminalResult {
    exitCode: number | undefined;
    output: string;
}

// ============ WebSocket 消息类型 (兼容后端) ============

export type WSMessageType = 'request' | 'response' | 'notification' | 'ping' | 'pong';

export interface WSMessage {
    type: WSMessageType;
    payload: JsonRpcRequest | JsonRpcResponse | unknown;
}

// ============ MCP 错误码 ============

export const McpErrorCodes = {
    // JSON-RPC 标准错误码
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
    
    // MCP 自定义错误码
    TOOL_NOT_FOUND: -32001,
    TOOL_EXECUTION_ERROR: -32002,
    RESOURCE_NOT_FOUND: -32003,
    NOT_INITIALIZED: -32004,
} as const;
