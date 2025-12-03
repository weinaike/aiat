import { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';
import { ToolDefinition, ToolHandler } from '../types';
import { BaseTool } from '../tools/baseTool';

/**
 * MCP 服务器配置
 */
export interface McpServerConfig {
    /** 服务器名称 */
    name: string;
    /** 启动命令 */
    command: string;
    /** 命令参数 */
    args?: string[];
    /** 环境变量 */
    env?: Record<string, string>;
    /** 工作目录 */
    cwd?: string;
    /** 是否启用 */
    enabled?: boolean;
}

/**
 * MCP JSON-RPC 请求
 */
interface McpJsonRpcRequest {
    jsonrpc: '2.0';
    id: number | string;
    method: string;
    params?: Record<string, unknown>;
}

/**
 * MCP JSON-RPC 响应
 */
interface McpJsonRpcResponse {
    jsonrpc: '2.0';
    id: number | string | null;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}

/**
 * MCP 工具定义 (从 MCP 服务器返回)
 */
interface McpToolSchema {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, {
            type: string;
            description?: string;
            default?: unknown;
            enum?: string[];
        }>;
        required?: string[];
    };
}

/**
 * 外部 MCP 工具包装器
 * 将外部 MCP 服务器的工具包装为本地 ToolHandler
 */
class ExternalMcpTool extends BaseTool {
    definition: ToolDefinition;
    private client: McpClient;
    private originalName: string;

    constructor(mcpTool: McpToolSchema, client: McpClient, serverName: string, usePrefix: boolean = true) {
        super();
        this.client = client;
        this.originalName = mcpTool.name;
        
        // 根据配置决定是否使用服务器名称作为前缀
        const toolName = usePrefix ? `${serverName}__${mcpTool.name}` : mcpTool.name;
        
        // 转换 MCP 工具定义为本地格式
        const properties: Record<string, {
            type: string;
            description: string;
            required?: boolean;
            default?: unknown;
            enum?: string[];
        }> = {};

        for (const [key, prop] of Object.entries(mcpTool.inputSchema.properties)) {
            properties[key] = {
                type: prop.type,
                description: prop.description || '',
                default: prop.default,
                enum: prop.enum
            };
        }

        this.definition = {
            name: toolName,
            description: usePrefix ? `[${serverName}] ${mcpTool.description}` : mcpTool.description,
            inputSchema: {
                type: 'object',
                properties,
                required: mcpTool.inputSchema.required || []
            }
        };
    }

    async execute(params: Record<string, unknown>): Promise<unknown> {
        this.validateParams(params);
        return this.client.callTool(this.originalName, params);
    }
}

/**
 * MCP 客户端
 * 通过 stdio 与外部 MCP 服务器通信
 */
export class McpClient {
    private process: ChildProcess | null = null;
    private requestId = 0;
    private pendingRequests: Map<number | string, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
    }> = new Map();
    private buffer = '';
    private initialized = false;
    private tools: Map<string, ToolHandler> = new Map();
    private outputChannel: vscode.OutputChannel;
    private config: McpServerConfig;
    private _isBuiltin: boolean;

    constructor(config: McpServerConfig, outputChannel: vscode.OutputChannel, isBuiltin: boolean = false) {
        this.config = config;
        this.outputChannel = outputChannel;
        this._isBuiltin = isBuiltin;
    }

    /**
     * 是否为内置服务器
     */
    get isBuiltin(): boolean {
        return this._isBuiltin;
    }

    /**
     * 启动 MCP 服务器并初始化
     */
    async start(): Promise<void> {
        if (this.process) {
            this.log('MCP 客户端已在运行');
            return;
        }

        this.log(`正在启动 MCP 服务器: ${this.config.name}`);
        this.log(`命令: ${this.config.command} ${(this.config.args || []).join(' ')}`);

        return new Promise((resolve, reject) => {
            try {
                // 启动子进程
                this.process = spawn(this.config.command, this.config.args || [], {
                    cwd: this.config.cwd,
                    env: { ...process.env, ...this.config.env },
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                // 处理 stdout (JSON-RPC 响应)
                this.process.stdout?.on('data', (data: Buffer) => {
                    this.handleStdout(data.toString());
                });

                // 处理 stderr (日志输出)
                this.process.stderr?.on('data', (data: Buffer) => {
                    this.log(`[${this.config.name} stderr] ${data.toString().trim()}`);
                });

                // 处理进程错误
                this.process.on('error', (error) => {
                    this.log(`MCP 进程错误: ${error.message}`);
                    reject(error);
                });

                // 处理进程退出
                this.process.on('exit', (code, signal) => {
                    this.log(`MCP 进程退出: code=${code}, signal=${signal}`);
                    this.cleanup();
                });

                // 初始化 MCP 协议
                // npx 首次下载包可能需要较长时间，延长等待时间
                const initDelay = this.config.command === 'npx' ? 5000 : 500;
                this.log(`等待 ${initDelay}ms 让进程启动...`);
                
                setTimeout(async () => {
                    try {
                        this.log('等待进程启动完成，开始初始化 MCP 协议...');
                        await this.initialize();
                        this.log('MCP 协议初始化成功，开始发现工具...');
                        await this.discoverTools();
                        this.log(`工具发现完成，共 ${this.tools.size} 个工具`);
                        resolve();
                    } catch (error) {
                        this.log(`初始化失败: ${error}`);
                        reject(error);
                    }
                }, initDelay);

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * 停止 MCP 服务器
     */
    async stop(): Promise<void> {
        if (!this.process) {
            return;
        }

        this.log(`正在停止 MCP 服务器: ${this.config.name}`);
        
        // 清理挂起的请求
        for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('MCP 客户端正在关闭'));
        }
        this.pendingRequests.clear();

        // 终止进程
        this.process.kill('SIGTERM');
        
        // 等待进程退出
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                if (this.process) {
                    this.process.kill('SIGKILL');
                }
                resolve();
            }, 5000);

            this.process?.on('exit', () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        this.cleanup();
    }

    /**
     * 发送 MCP 初始化请求
     */
    private async initialize(): Promise<void> {
        const result = await this.sendRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
                name: 'vscode-aiat',
                version: '1.0.0'
            }
        });

        this.log(`MCP 服务器初始化完成: ${JSON.stringify(result)}`);

        // 发送 initialized 通知
        this.sendNotification('notifications/initialized', {});
        this.initialized = true;
    }

    /**
     * 发现并注册工具
     */
    private async discoverTools(): Promise<void> {
        const result = await this.sendRequest('tools/list', {}) as { tools: McpToolSchema[] };
        
        this.log(`发现 ${result.tools.length} 个工具`);
        
        // 内置服务器不加前缀，自定义服务器加前缀
        const usePrefix = !this._isBuiltin;
        
        this.tools.clear();
        for (const mcpTool of result.tools) {
            const tool = new ExternalMcpTool(mcpTool, this, this.config.name, usePrefix);
            this.tools.set(tool.name, tool);
            this.log(`  - ${tool.name}: ${mcpTool.description.substring(0, 50)}...`);
        }
    }

    /**
     * 调用工具
     */
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        if (!this.initialized) {
            throw new Error('MCP 客户端未初始化');
        }

        const result = await this.sendRequest('tools/call', {
            name,
            arguments: args
        }) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

        if (result.isError) {
            const errorText = result.content
                .filter(c => c.type === 'text')
                .map(c => c.text)
                .join('\n');
            throw new Error(errorText || '工具执行失败');
        }

        // 提取文本内容
        const textContent = result.content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');

        return textContent || result;
    }

    /**
     * 获取所有已注册的工具
     */
    getTools(): Map<string, ToolHandler> {
        return this.tools;
    }

    /**
     * 获取服务器名称
     */
    getName(): string {
        return this.config.name;
    }

    /**
     * 检查是否已初始化
     */
    isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * 发送 JSON-RPC 请求
     */
    private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin) {
                reject(new Error('MCP 进程未启动'));
                return;
            }

            const id = ++this.requestId;
            const request: McpJsonRpcRequest = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };

            // 设置超时
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`请求超时: ${method}`));
            }, 30000);

            this.pendingRequests.set(id, { resolve, reject, timeout });

            const message = JSON.stringify(request) + '\n';
            this.process.stdin.write(message);
            this.log(`发送请求: ${method} (id=${id})`);
        });
    }

    /**
     * 发送 JSON-RPC 通知 (无需响应)
     */
    private sendNotification(method: string, params: Record<string, unknown>): void {
        if (!this.process?.stdin) {
            return;
        }

        const notification = {
            jsonrpc: '2.0',
            method,
            params
        };

        const message = JSON.stringify(notification) + '\n';
        this.process.stdin.write(message);
    }

    /**
     * 处理 stdout 数据
     */
    private handleStdout(data: string): void {
        this.buffer += data;
        
        // 按行分割处理
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.trim()) continue;
            
            try {
                const response = JSON.parse(line) as McpJsonRpcResponse;
                this.handleResponse(response);
            } catch {
                // 可能是非 JSON 输出，记录但不处理
                this.log(`[${this.config.name}] ${line}`);
            }
        }
    }

    /**
     * 处理 JSON-RPC 响应
     */
    private handleResponse(response: McpJsonRpcResponse): void {
        if (response.id === null || response.id === undefined) {
            // 这是通知，不是响应
            return;
        }

        const pending = this.pendingRequests.get(response.id);
        if (!pending) {
            this.log(`收到未知请求的响应: ${response.id}`);
            return;
        }

        this.pendingRequests.delete(response.id);
        clearTimeout(pending.timeout);

        if (response.error) {
            pending.reject(new Error(response.error.message));
        } else {
            pending.resolve(response.result);
        }
    }

    /**
     * 清理资源
     */
    private cleanup(): void {
        this.process = null;
        this.initialized = false;
        this.buffer = '';
        this.tools.clear();
    }

    /**
     * 日志输出
     */
    private log(message: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] [McpClient:${this.config.name}] ${message}`);
    }
}
