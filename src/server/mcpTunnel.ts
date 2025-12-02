import * as vscode from 'vscode';
import WebSocket from 'ws';
import { ToolRegistry } from '../tools';
import {
    JsonRpcRequest,
    JsonRpcResponse,
    McpInitializeParams,
    McpInitializeResult,
    McpServerCapabilities,
    McpTool,
    McpToolCallParams,
    McpToolCallResult,
    McpContent,
    McpErrorCodes
} from '../types';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'vscode-aiat';
const SERVER_VERSION = '1.0.0';

/**
 * MCP 隧道连接状态
 */
export type TunnelState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * MCP Tunnel 客户端
 * 通过 WebSocket 主动连接到公网服务器，接收并处理 MCP 请求
 * 解决局域网内 MCP 服务无法被公网访问的问题
 */
export class McpTunnel {
    private ws: WebSocket | null = null;
    private toolRegistry: ToolRegistry;
    private outputChannel: vscode.OutputChannel;
    private initialized: boolean = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;
    private reconnectDelay = 1000;
    private _state: TunnelState = 'disconnected';
    private runId: string = '';

    private _onStateChange = new vscode.EventEmitter<TunnelState>();
    readonly onStateChange = this._onStateChange.event;

    constructor(toolRegistry: ToolRegistry, outputChannel: vscode.OutputChannel) {
        this.toolRegistry = toolRegistry;
        this.outputChannel = outputChannel;
    }

    /**
     * 获取当前隧道状态
     */
    get state(): TunnelState {
        return this._state;
    }

    /**
     * 更新隧道状态
     */
    private updateState(state: TunnelState): void {
        this._state = state;
        this._onStateChange.fire(state);
    }

    /**
     * 获取服务器 URL
     */
    private getServerUrl(): string {
        const config = vscode.workspace.getConfiguration('aiat');
        let url = config.get<string>('agentServer.url', 'ws://agent-flow.dev.csst.lab.zverse.space:32080');
        
        if (url.startsWith('http://')) {
            url = url.replace('http://', 'ws://');
        } else if (url.startsWith('https://')) {
            url = url.replace('https://', 'wss://');
        } else if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
            url = 'ws://' + url;
        }
        return url;
    }

    /**
     * 连接到公网服务器的 MCP 隧道端点
     * @param runId 当前会话的 Run ID
     */
    async connect(runId: string): Promise<void> {
        if (this._state === 'connected' || this._state === 'connecting') {
            this.log('MCP 隧道已连接或正在连接中');
            return;
        }

        this.runId = runId;
        this.updateState('connecting');

        const serverUrl = this.getServerUrl();
        const config = vscode.workspace.getConfiguration('aiat');
        const authToken = config.get<string>('authToken', '');
        
        // 构建 MCP 隧道 WebSocket URL
        const tokenParam = authToken ? `?token=${authToken}` : '';
        const wsUrl = `${serverUrl}/ws/mcp/${runId}${tokenParam}`;

        this.log(`正在连接 MCP 隧道: ${wsUrl}`);

        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(wsUrl);

                const timeout = setTimeout(() => {
                    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
                        this.ws.close();
                        this.updateState('error');
                        reject(new Error('MCP 隧道连接超时'));
                    }
                }, 30000);

                this.ws.on('open', () => {
                    clearTimeout(timeout);
                    this.log('MCP 隧道已连接');
                    this.updateState('connected');
                    this.reconnectAttempts = 0;
                    this.startHeartbeat();

                    // 发送注册消息，告知服务器此隧道的能力
                    this.sendRegistration();

                    vscode.window.showInformationMessage(`MCP 隧道已建立 (Run ID: ${runId})`);
                    resolve();
                });

                this.ws.on('message', async (data: WebSocket.RawData) => {
                    try {
                        const message = JSON.parse(data.toString());
                        await this.handleMessage(message);
                    } catch (e) {
                        this.log(`收到无效消息: ${data.toString()}`);
                    }
                });

                this.ws.on('close', (code, reason) => {
                    clearTimeout(timeout);
                    this.log(`MCP 隧道已断开: ${code} - ${reason.toString()}`);
                    this.cleanup();
                    this.updateState('disconnected');

                    // 非正常关闭时尝试重连
                    if (code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.scheduleReconnect();
                    }
                });

                this.ws.on('error', (error) => {
                    clearTimeout(timeout);
                    this.log(`MCP 隧道错误: ${error.message}`);
                    this.updateState('error');
                    reject(error);
                });

                this.ws.on('pong', () => {
                    // 心跳响应正常
                });

            } catch (error) {
                this.updateState('error');
                reject(error);
            }
        });
    }

    /**
     * 断开隧道连接
     */
    disconnect(): void {
        if (this.ws) {
            this.log('正在断开 MCP 隧道...');
            this.ws.close(1000, 'User disconnect');
            this.cleanup();
            this.updateState('disconnected');
            vscode.window.showInformationMessage('MCP 隧道已断开');
        }
    }

    /**
     * 发送注册消息
     */
    private sendRegistration(): void {
        const tools = this.toolRegistry.getToolNames();
        const registration = {
            type: 'mcp_register',
            serverInfo: {
                name: SERVER_NAME,
                version: SERVER_VERSION,
                protocolVersion: MCP_PROTOCOL_VERSION
            },
            capabilities: {
                tools: tools,
                toolCount: tools.length
            }
        };

        this.send(registration);
        this.log(`已发送 MCP 注册信息，工具数量: ${tools.length}`);
    }

    /**
     * 处理收到的消息
     */
    private async handleMessage(message: unknown): Promise<void> {
        const msg = message as { type?: string; request?: JsonRpcRequest; id?: string };

        switch (msg.type) {
            case 'mcp_request':
                // 服务器转发的 MCP JSON-RPC 请求
                if (msg.request) {
                    const response = await this.handleMcpRequest(msg.request);
                    this.send({
                        type: 'mcp_response',
                        requestId: msg.id,
                        response: response
                    });
                }
                break;

            case 'ping':
                this.send({ type: 'pong' });
                break;

            case 'pong':
                // 心跳响应
                break;

            default:
                this.log(`收到未知消息类型: ${msg.type}`);
        }
    }

    /**
     * 处理 MCP JSON-RPC 请求
     */
    private async handleMcpRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
        const { method, params, id } = request;

        this.log(`处理 MCP 请求: ${method} (id: ${id})`);

        try {
            const result = await this.dispatchMethod(method, params);
            return {
                jsonrpc: '2.0',
                id: id,
                result: result
            };
        } catch (error) {
            const err = error as { code?: number; message?: string };
            return {
                jsonrpc: '2.0',
                id: id,
                error: {
                    code: err.code || McpErrorCodes.INTERNAL_ERROR,
                    message: err.message || 'Internal error'
                }
            };
        }
    }

    /**
     * 分发方法调用
     */
    private async dispatchMethod(method: string, params: unknown): Promise<unknown> {
        switch (method) {
            case 'initialize':
                return this.handleInitialize(params as McpInitializeParams);
            
            case 'initialized':
                this.initialized = true;
                return {};
            
            case 'ping':
                return {};

            case 'tools/list':
                return this.handleToolsList();
            
            case 'tools/call':
                return this.handleToolCall(params as McpToolCallParams);

            case 'resources/list':
                return this.handleResourcesList();
            
            case 'resources/read':
                return this.handleResourceRead(params as { uri: string });

            default: {
                const error = new Error(`Method not found: ${method}`);
                (error as any).code = McpErrorCodes.METHOD_NOT_FOUND;
                throw error;
            }
        }
    }

    /**
     * 处理 initialize 请求
     */
    private handleInitialize(params: McpInitializeParams): McpInitializeResult {
        this.log(`客户端初始化: ${params.clientInfo?.name} v${params.clientInfo?.version}`);

        const capabilities: McpServerCapabilities = {
            tools: { listChanged: true },
            resources: { subscribe: false, listChanged: false },
            logging: {}
        };

        return {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities,
            serverInfo: {
                name: SERVER_NAME,
                version: SERVER_VERSION
            },
            instructions: '这是一个 VS Code AIAT 服务器，通过隧道提供文件操作、代码搜索和终端操作等工具。'
        };
    }

    /**
     * 处理 tools/list 请求
     */
    private handleToolsList(): { tools: McpTool[] } {
        const toolDefinitions = this.toolRegistry.getToolDefinitions();
        const tools: McpTool[] = toolDefinitions.map(tool => {
            const properties: Record<string, { type: string; description: string; default?: unknown; enum?: string[] }> = {};
            
            for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
                properties[key] = {
                    type: prop.type,
                    description: prop.description
                };
                if (prop.default !== undefined) {
                    properties[key].default = prop.default;
                }
                if (prop.enum) {
                    properties[key].enum = prop.enum;
                }
            }

            return {
                name: tool.name,
                description: tool.description,
                inputSchema: {
                    type: 'object' as const,
                    properties,
                    required: tool.inputSchema.required || []
                }
            };
        });

        this.log(`返回工具列表: ${tools.length} 个工具`);
        return { tools };
    }

    /**
     * 处理 tools/call 请求
     */
    private async handleToolCall(params: McpToolCallParams): Promise<McpToolCallResult> {
        const { name, arguments: args = {} } = params;

        this.log(`调用工具: ${name}`);

        const tool = this.toolRegistry.get(name);
        if (!tool) {
            const error = new Error(`Tool not found: ${name}`);
            (error as any).code = McpErrorCodes.TOOL_NOT_FOUND;
            throw error;
        }

        try {
            const result = await tool.execute(args);
            
            const content: McpContent[] = [{
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
            }];

            this.log(`工具 ${name} 执行成功`);
            return { content, isError: false };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.log(`工具 ${name} 执行失败: ${errorMessage}`);
            
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${errorMessage}`
                }],
                isError: true
            };
        }
    }

    /**
     * 处理 resources/list 请求
     */
    private handleResourcesList(): { resources: unknown[] } {
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        const resources = workspaceFolders.map(folder => ({
            uri: folder.uri.toString(),
            name: folder.name,
            description: `工作区: ${folder.name}`,
            mimeType: 'inode/directory'
        }));

        return { resources };
    }

    /**
     * 处理 resources/read 请求
     */
    private async handleResourceRead(params: { uri: string }): Promise<{ contents: McpContent[] }> {
        const { uri } = params;
        
        try {
            const fileUri = vscode.Uri.parse(uri);
            const content = await vscode.workspace.fs.readFile(fileUri);
            const text = Buffer.from(content).toString('utf8');

            return {
                contents: [{
                    type: 'text',
                    text
                }]
            };
        } catch {
            const error = new Error(`Resource not found: ${uri}`);
            (error as any).code = McpErrorCodes.RESOURCE_NOT_FOUND;
            throw error;
        }
    }

    /**
     * 发送消息
     */
    private send(data: object): boolean {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.log('隧道未连接，无法发送消息');
            return false;
        }

        try {
            this.ws.send(JSON.stringify(data));
            return true;
        } catch (error) {
            this.log(`发送消息失败: ${error}`);
            return false;
        }
    }

    /**
     * 启动心跳
     */
    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, 30000);
    }

    /**
     * 停止心跳
     */
    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * 计划重连
     */
    private scheduleReconnect(): void {
        if (this.reconnectTimer) {
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);

        this.log(`将在 ${delay}ms 后尝试重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect(this.runId);
            } catch (error) {
                this.log(`重连失败: ${error}`);
                if (this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.scheduleReconnect();
                }
            }
        }, delay);
    }

    /**
     * 清理资源
     */
    private cleanup(): void {
        this.stopHeartbeat();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.ws = null;
        this.initialized = false;
    }

    /**
     * 销毁隧道
     */
    dispose(): void {
        this.disconnect();
        this._onStateChange.dispose();
    }

    /**
     * 输出日志
     */
    private log(message: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] [McpTunnel] ${message}`);
    }
}
