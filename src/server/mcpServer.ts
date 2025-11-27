import * as vscode from 'vscode';
import * as http from 'http';
import { ToolRegistry } from '../tools';
import {
    JsonRpcRequest,
    JsonRpcResponse,
    JsonRpcError,
    McpInitializeParams,
    McpInitializeResult,
    McpServerCapabilities,
    McpTool,
    McpToolCallParams,
    McpToolCallResult,
    McpContent,
    McpErrorCodes,
    ServerStatus
} from '../types';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'vscode-ai-agent-tools';
const SERVER_VERSION = '1.0.0';

/**
 * MCP 协议服务器
 * 实现 Model Context Protocol (MCP) 规范
 * 基于 JSON-RPC 2.0
 */
export class McpServer {
    private server: http.Server | null = null;
    private toolRegistry: ToolRegistry;
    private port: number;
    private outputChannel: vscode.OutputChannel;
    private initialized: boolean = false;
    private authToken: string = '';
    private connectedClients: number = 0;

    constructor(toolRegistry: ToolRegistry, outputChannel: vscode.OutputChannel) {
        this.toolRegistry = toolRegistry;
        this.outputChannel = outputChannel;
        this.port = vscode.workspace.getConfiguration('aiAgentTools').get('serverPort', 9527);
        this.authToken = vscode.workspace.getConfiguration('aiAgentTools').get('authToken', '');
    }

    /**
     * 启动 MCP 服务器
     */
    async start(): Promise<void> {
        if (this.server) {
            this.log('MCP 服务器已在运行中');
            // 确保状态正确更新
            if (!this.initialized) {
                this.initialized = true;
                this.log('重新初始化服务器状态');
            }
            // 显示信息而不是直接返回，确保状态得到同步
            vscode.window.showInformationMessage('MCP 服务器已在运行中');
            return;
        }

        return new Promise((resolve, reject) => {
            try {
                this.server = http.createServer((req, res) => {
                    this.handleHttpRequest(req, res);
                });

                this.server.listen(this.port, () => {
                    this.log(`MCP 服务器已启动，监听端口: ${this.port}`);
                    this.log(`协议版本: ${MCP_PROTOCOL_VERSION}`);
                    vscode.window.showInformationMessage(
                        `AI Agent Tools MCP 服务器已启动，端口: ${this.port}`
                    );
                    resolve();
                });

                this.server.on('error', (error: Error) => {
                    this.log(`服务器错误: ${error.message}`);
                    reject(error);
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * 停止 MCP 服务器
     */
    async stop(): Promise<void> {
        if (!this.server) {
            this.log('服务器未运行');
            return;
        }

        return new Promise((resolve) => {
            this.server!.close(() => {
                this.server = null;
                this.initialized = false;
                this.connectedClients = 0;
                this.log('MCP 服务器已停止');
                vscode.window.showInformationMessage('AI Agent Tools MCP 服务器已停止');
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
            connectedClients: this.connectedClients,
            tools: this.toolRegistry.getToolNames(),
            protocol: 'mcp',
            protocolVersion: MCP_PROTOCOL_VERSION
        };
    }

    /**
     * 处理 HTTP 请求
     */
    private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        // 设置 CORS 头
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Content-Type', 'application/json');

        // 处理 OPTIONS 预检请求
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // 验证认证令牌
        if (this.authToken && !this.validateAuth(req)) {
            this.sendHttpError(res, 401, { 
                code: -32000, 
                message: 'Unauthorized' 
            });
            return;
        }

        // GET /status - 获取服务状态
        if (req.method === 'GET' && req.url === '/status') {
            res.writeHead(200);
            res.end(JSON.stringify(this.getStatus()));
            return;
        }

        // GET /health - 健康检查
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'ok', protocol: 'mcp' }));
            return;
        }

        // POST / - MCP JSON-RPC 请求
        if (req.method === 'POST' && (req.url === '/' || req.url === '/mcp')) {
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });
            req.on('end', async () => {
                await this.handleMcpRequest(body, res);
            });
            return;
        }

        // 404 未找到
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not Found' }));
    }

    /**
     * 验证认证
     */
    private validateAuth(req: http.IncomingMessage): boolean {
        const authHeader = req.headers['authorization'];
        if (!authHeader) {
            // 检查查询参数中的 token
            const url = new URL(req.url || '/', `http://${req.headers.host}`);
            const token = url.searchParams.get('token');
            return token === this.authToken;
        }
        
        const [type, token] = authHeader.split(' ');
        if (type.toLowerCase() === 'bearer') {
            return token === this.authToken;
        }
        return false;
    }

    /**
     * 处理 MCP 请求
     */
    private async handleMcpRequest(body: string, res: http.ServerResponse): Promise<void> {
        let request: JsonRpcRequest;
        
        try {
            request = JSON.parse(body);
        } catch {
            this.sendJsonRpcError(res, null, McpErrorCodes.PARSE_ERROR, 'Parse error');
            return;
        }

        // 验证 JSON-RPC 格式
        if (request.jsonrpc !== '2.0' || !request.method) {
            this.sendJsonRpcError(res, request.id ?? null, McpErrorCodes.INVALID_REQUEST, 'Invalid Request');
            return;
        }

        this.log(`收到请求: ${request.method} (id: ${request.id})`);

        try {
            const result = await this.dispatchMethod(request);
            this.sendJsonRpcResponse(res, request.id, result);
        } catch (error) {
            const err = error as { code?: number; message?: string };
            this.sendJsonRpcError(
                res, 
                request.id, 
                err.code || McpErrorCodes.INTERNAL_ERROR,
                err.message || 'Internal error'
            );
        }
    }

    /**
     * 分发方法调用
     */
    private async dispatchMethod(request: JsonRpcRequest): Promise<unknown> {
        const { method, params } = request;

        switch (method) {
            // MCP 生命周期方法
            case 'initialize':
                return this.handleInitialize(params as unknown as McpInitializeParams);
            
            case 'initialized':
                return this.handleInitialized();
            
            case 'ping':
                return {};

            // MCP 工具方法
            case 'tools/list':
                return this.handleToolsList();
            
            case 'tools/call':
                return this.handleToolCall(params as unknown as McpToolCallParams);

            // MCP 资源方法 (可选实现)
            case 'resources/list':
                return this.handleResourcesList();
            
            case 'resources/read':
                return this.handleResourceRead(params as unknown as { uri: string });

            default:
                throw { code: McpErrorCodes.METHOD_NOT_FOUND, message: `Method not found: ${method}` };
        }
    }

    /**
     * 处理 initialize 请求
     */
    private handleInitialize(params: McpInitializeParams): McpInitializeResult {
        this.log(`客户端初始化: ${params.clientInfo?.name} v${params.clientInfo?.version}`);
        this.log(`客户端协议版本: ${params.protocolVersion}`);
        
        this.connectedClients++;

        const capabilities: McpServerCapabilities = {
            tools: {
                listChanged: true
            },
            resources: {
                subscribe: false,
                listChanged: false
            },
            logging: {}
        };

        return {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities,
            serverInfo: {
                name: SERVER_NAME,
                version: SERVER_VERSION
            },
            instructions: '这是一个 VS Code AI Agent Tools 服务器，提供文件操作、代码搜索和终端操作等工具。'
        };
    }

    /**
     * 处理 initialized 通知
     */
    private handleInitialized(): Record<string, never> {
        this.initialized = true;
        this.log('MCP 会话已初始化');
        return {};
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
            throw { 
                code: McpErrorCodes.TOOL_NOT_FOUND, 
                message: `Tool not found: ${name}` 
            };
        }

        try {
            const result = await tool.execute(args);
            
            // 将结果转换为 MCP 内容格式
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
        // 返回工作区根目录作为资源
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
        } catch (error) {
            throw {
                code: McpErrorCodes.RESOURCE_NOT_FOUND,
                message: `Resource not found: ${uri}`
            };
        }
    }

    /**
     * 发送 JSON-RPC 响应
     */
    private sendJsonRpcResponse(res: http.ServerResponse, id: string | number, result: unknown): void {
        const response: JsonRpcResponse = {
            jsonrpc: '2.0',
            id,
            result
        };
        res.writeHead(200);
        res.end(JSON.stringify(response));
    }

    /**
     * 发送 JSON-RPC 错误
     */
    private sendJsonRpcError(
        res: http.ServerResponse, 
        id: string | number | null, 
        code: number, 
        message: string,
        data?: unknown
    ): void {
        const error: JsonRpcError = { code, message };
        if (data !== undefined) {
            error.data = data;
        }

        const response: JsonRpcResponse = {
            jsonrpc: '2.0',
            id,
            error
        };
        res.writeHead(200);
        res.end(JSON.stringify(response));
    }

    /**
     * 发送 HTTP 错误
     */
    private sendHttpError(res: http.ServerResponse, status: number, error: { code: number; message: string }): void {
        res.writeHead(status);
        res.end(JSON.stringify({ error }));
    }

    /**
     * 输出日志
     */
    private log(message: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] [MCP] ${message}`);
    }
}
