import * as vscode from 'vscode';
import * as http from 'http';
import { ToolRegistry } from '../tools';
import { JsonRpcRequest, JsonRpcResponse, ServerStatus, WSMessage } from '../types';

// 兼容旧的类型别名
type ToolRequest = JsonRpcRequest;
type ToolResponse = JsonRpcResponse;

// WebSocket 类型定义
interface WebSocketLike {
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
}

const OPEN = 1;
const LEGACY_PROTOCOL_VERSION = '1.0.0';

/**
 * 工具服务器 - 提供简单的 HTTP JSON-RPC 接口（旧版本兼容）
 */
export class ToolServer {
    private server: http.Server | null = null;
    private clients: Set<WebSocketLike> = new Set();
    private toolRegistry: ToolRegistry;
    private port: number;
    private outputChannel: vscode.OutputChannel;

    constructor(toolRegistry: ToolRegistry, outputChannel: vscode.OutputChannel) {
        this.toolRegistry = toolRegistry;
        this.outputChannel = outputChannel;
        this.port = vscode.workspace.getConfiguration('aiAgentTools').get('serverPort', 9527);
    }

    /**
     * 启动服务器 (HTTP JSON-RPC)
     */
    async start(): Promise<void> {
        if (this.server) {
            this.log('服务器已在运行中');
            return;
        }

        // 首先检查端口是否可用
        if (await this.isPortInUse(this.port)) {
            const message = `端口 ${this.port} 已被占用。可能已有服务器在运行，或其他程序正在使用此端口。`;
            this.log(message);
            vscode.window.showWarningMessage(message, '检查服务器状态').then(selection => {
                if (selection === '检查服务器状态') {
                    vscode.commands.executeCommand('aiAgentTools.showStatus');
                }
            });
            throw new Error(`端口 ${this.port} 已被占用`);
        }

        return new Promise((resolve, reject) => {
            try {
                this.server = http.createServer((req, res) => {
                    this.handleHttpRequest(req, res);
                });

                this.server.listen(this.port, () => {
                    this.log(`工具服务器已启动，监听端口: ${this.port}`);
                    vscode.window.showInformationMessage(`AI Agent Tools 服务器已启动，端口: ${this.port}`);
                    resolve();
                });

                this.server.on('error', (error: any) => {
                    this.log(`服务器错误: ${error.message}`);

                    // 特殊处理端口占用错误
                    if (error.code === 'EADDRINUSE') {
                        const message = `端口 ${this.port} 已被占用。请检查是否有其他程序正在使用此端口。`;
                        vscode.window.showWarningMessage(message, '停止占用端口的进程', '更改端口').then(selection => {
                            if (selection === '停止占用端口的进程') {
                                vscode.env.openExternal(vscode.Uri.parse(`https://stackoverflow.com/questions/53491587/how-to-kill-process-running-on-port-in-windows-macos-or-linux`));
                            } else if (selection === '更改端口') {
                                vscode.commands.executeCommand('aiAgentTools.openSettings');
                            }
                        });
                    }

                    reject(error);
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * 处理 HTTP 请求
     */
    private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        // 设置 CORS 头
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method === 'GET' && req.url === '/tools') {
            // 返回工具列表
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                tools: this.toolRegistry.getToolDefinitions()
            }));
            return;
        }

        if (req.method === 'GET' && req.url === '/status') {
            // 返回状态
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(this.getStatus()));
            return;
        }

        if (req.method === 'POST' && req.url === '/invoke') {
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });
            req.on('end', async () => {
                try {
                    const request: ToolRequest = JSON.parse(body);
                    const response = await this.executeToolRequest(request);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(response));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: {
                            code: -32700,
                            message: error instanceof Error ? error.message : '请求解析失败'
                        }
                    }));
                }
            });
            return;
        }

        // 404
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    }

    /**
     * 执行工具请求
     */
    private async executeToolRequest(request: ToolRequest): Promise<ToolResponse> {
        const { id, method, params } = request;
        
        this.log(`收到工具请求: ${method} (${id})`);

        try {
            // 特殊方法处理
            if (method === 'tools/list') {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        tools: this.toolRegistry.getToolDefinitions()
                    }
                };
            }

            // 执行工具
            const toolParams = (params as Record<string, unknown>) || {};
            const result = await this.toolRegistry.execute(method, toolParams);
            this.log(`工具执行成功: ${method}`);
            
            return { jsonrpc: '2.0', id, result };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.log(`工具执行失败: ${method} - ${errorMessage}`);
            
            return {
                jsonrpc: '2.0',
                id,
                error: {
                    code: -32000,
                    message: errorMessage
                }
            };
        }
    }

    /**
     * 停止服务器
     */
    async stop(): Promise<void> {
        if (!this.server) {
            this.log('服务器未运行');
            return;
        }

        return new Promise((resolve) => {
            // 关闭所有客户端连接
            for (const client of this.clients) {
                client.close(1000, '服务器关闭');
            }
            this.clients.clear();

            this.server!.close(() => {
                this.server = null;
                this.log('服务器已停止');
                vscode.window.showInformationMessage('AI Agent Tools 服务器已停止');
                resolve();
            });
        });
    }

    /**
     * 获取服务器状态
     */
    getStatus(): ServerStatus {
        return {
            running: this.server !== null,
            port: this.port,
            connectedClients: this.clients.size,
            tools: this.toolRegistry.getToolNames(),
            protocol: 'mcp',
            protocolVersion: LEGACY_PROTOCOL_VERSION
        };
    }

    /**
     * 发送消息
     */
    private send(ws: WebSocketLike, message: WSMessage): void {
        if (ws.readyState === OPEN) {
            ws.send(JSON.stringify(message));
        }
    }

    /**
     * 广播消息给所有客户端
     */
    broadcast(message: WSMessage): void {
        const data = JSON.stringify(message);
        for (const client of this.clients) {
            if (client.readyState === OPEN) {
                client.send(data);
            }
        }
    }

    /**
     * 检查端口是否被占用
     */
    private async isPortInUse(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const tester = require('http').createServer();

            tester.listen(port, () => {
                tester.once('close', () => {
                    resolve(false);
                }).close();
            });

            tester.on('error', () => {
                resolve(true);
            });
        });
    }

    /**
     * 输出日志
     */
    private log(message: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] ${message}`);
    }
}
