import * as vscode from 'vscode';
import WebSocket from 'ws';
import { StateManager, ConnectionState, TaskState } from './stateManager';
import { errorHandler, ErrorType, ErrorSeverity } from '../utils/errorHandler';
import { MessageStorage } from '../utils/messageStorage';
import { logger } from '../utils/logger';

/**
 * 消息类型
 */
export interface AgentMessage {
    type: string;
    content?: string;
    data?: unknown;
    source?: string;
    timestamp: number;
    direction: 'incoming' | 'outgoing';
}

/**
 * 历史加载完成事件数据
 */
export interface HistoryLoadedEvent {
    runId: string;
    messages: AgentMessage[];
}

/**
 * AgentFlow WebSocket 客户端
 */
export class AgentClient {
    private ws: WebSocket | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private connectionHealthTimer: NodeJS.Timeout | null = null;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private reconnectDelay = 1000; // 初始重连延迟1秒

    private _stateManager = new StateManager();
    private _messages: AgentMessage[] = [];
    private _messageStorage: MessageStorage;

    private _onStateChange = new vscode.EventEmitter<ConnectionState>();
    private _onTaskStateChange = new vscode.EventEmitter<TaskState>();
    private _onMessage = new vscode.EventEmitter<AgentMessage>();
    private _onError = new vscode.EventEmitter<Error>();
    private _onHistoryLoaded = new vscode.EventEmitter<HistoryLoadedEvent>();

    readonly onStateChange = this._onStateChange.event;
    readonly onTaskStateChange = this._onTaskStateChange.event;
    readonly onMessage = this._onMessage.event;
    readonly onError = this._onError.event;
    readonly onHistoryLoaded = this._onHistoryLoaded.event;

    constructor(
        private outputChannel: vscode.OutputChannel,
        private extensionContext: vscode.ExtensionContext
    ) {
        // 初始化消息存储
        this._messageStorage = new MessageStorage(extensionContext.globalState);
        // 监听状态管理器的变化
        this._stateManager.onConnectionChange((state) => {
            this._onStateChange.fire(state);
        });

        this._stateManager.onTaskChange((state) => {
            this._onTaskStateChange.fire(state);
        });

        // 注册错误监听器
        errorHandler.addErrorListener((error) => {
            this.handleExtendedError(error);
        });
    }

    /**
     * 获取当前 Run ID
     */
    get currentRunId(): string {
        return this._stateManager.state.runId || '';
    }

    /**
     * 获取当前连接状态
     */
    get state(): ConnectionState {
        return this._stateManager.connectionState;
    }

    /**
     * 获取任务状态
     */
    get taskState(): TaskState {
        return this._stateManager.taskState;
    }

    /**
     * 获取完整状态
     */
    get stateManager(): StateManager {
        return this._stateManager;
    }

    /**
     * 获取所有消息
     */
    get messages(): AgentMessage[] {
        return [...this._messages];
    }

    /**
     * 获取服务器 URL（WebSocket）
     */
    private getServerUrl(): string {
        const config = vscode.workspace.getConfiguration('aiat');
        let url = config.get<string>('agentServer.url', 'ws://agent-flow.dev.csst.lab.zverse.space:32080');
        // 确保是 ws:// 协议
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
     * 检查codebase目录是否有效
     */
    private async validateCodebase(codebase: string): Promise<boolean> {
        if (!codebase) {
            return false;
        }

        try {
            // 检查目录是否存在
            const fs = require('fs').promises;
            try {
                const stat = await fs.stat(codebase);
                if (!stat.isDirectory()) {
                    logger.debug(`Codebase path exists but is not a directory: ${codebase}`);
                    return false;
                }
            } catch (error) {
                logger.debug(`Codebase directory does not exist: ${codebase}`);
                return false;
            }

            // 检查目录是否可读
            try {
                await fs.access(codebase, fs.constants.R_OK);
            } catch (error) {
                logger.debug(`Codebase directory is not readable: ${codebase}`);
                return false;
            }

            // 可选：检查是否包含基本的项目文件（如package.json、.git等）
            const hasProjectFiles = await this.checkProjectFiles(codebase);
            if (!hasProjectFiles) {
                logger.debug(`Codebase directory may not be a valid project: ${codebase}`);
            }

            return true;
        } catch (error) {
            logger.error(`Error validating codebase: ${error}`, error);
            return false;
        }
    }

    /**
     * 检查目录是否包含项目文件
     */
    private async checkProjectFiles(codebase: string): Promise<boolean> {
        const fs = require('fs').promises;

        const projectFiles = [
            'package.json',
            '.git',
            'README.md',
            'README',
            'Cargo.toml',
            'pyproject.toml',
            'requirements.txt',
            'setup.py',
            'pom.xml',
            'build.gradle',
            'Makefile',
            'CMakeLists.txt'
        ];

        try {
            const files = await fs.readdir(codebase);
            return projectFiles.some(file => files.includes(file));
        } catch (error) {
            logger.debug(`Error checking project files: ${error}`);
            return false;
        }
    }

    /**
     * 获取 team_config
     */
    private getTeamConfig(agentId: number): object {
        const config = vscode.workspace.getConfiguration('aiat');
        const port = config.get<number>('serverPort', 9527);
        const teamId = agentId; // agentId is now required, no fallback to config

        // 始终使用workspace根目录作为codebase
        const codebase = this.getDefaultCodebase();

        const authToken = config.get<string>('authToken', '');

        const teamConfig: Record<string, unknown> = {
            id: teamId,
            codebase: codebase,
            flow_id: null,
            node_id: [],
            mcp_server: this.getLocalIP(),
            mcp_port: port
        };

        if (authToken) {
            teamConfig.mcp_token = authToken;
        }

        return teamConfig;
    }

    private getDefaultCodebase(): string {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const codebase = workspaceFolder?.uri.fsPath || '';
        logger.debug('getDefaultCodebase', { workspaceFolder, codebase });
        return codebase;
    }

    private getLocalIP(): string {
        const os = require('os');
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name] || []) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return iface.address;
                }
            }
        }
        return '127.0.0.1';
    }

    /**
     * 获取 HTTP API 地址（用于创建 run）
     */
    private getHttpUrl(): string {
        const wsUrl = this.getServerUrl();
        return wsUrl.replace('ws://', 'http://').replace('wss://', 'https://');
    }

    /**
     * 创建测试 Run（调用后端 API）
     */
    private async createTestRun(runId: number): Promise<boolean> {
        try {
            const httpUrl = this.getHttpUrl();
            const response = await fetch(`${httpUrl}/debug/create-test-run`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ run_id: runId })
            });
            
            const result = await response.json() as { status?: boolean };
            this.log(`创建 Run 结果: ${JSON.stringify(result)}`);
            return result.status === true;
        } catch (error) {
            this.log(`创建 Run 失败: ${error}`);
            return false;
        }
    }

    /**
     * 生成随机 run_id (1-2^31)
     */
    private generateRunId(): string {
        return Math.floor(Math.random() * Math.pow(2, 31) + 1).toString();
    }

    /**
     * 连接到后端服务（带重试机制）
     */
    async connect(autoStartMcpServer: boolean = false): Promise<void> {
        if (this._stateManager.isConnected || this._stateManager.connectionState === 'connecting') {
            this.log('已经连接或正在连接中');
            return;
        }

        const connectionOperation = async () => {
            // 自动生成 run_id
            const runId = this.generateRunId();
            this._stateManager.setRunId(runId);
            const runIdNum = parseInt(runId);

            this._stateManager.updateConnectionState('connecting');

            let serverUrl = '';
            let wsUrl = '';

            try {
                // 先创建测试 Run
                this.log(`正在创建 Run ID: ${runIdNum}...`);
                const created = await this.createTestRun(runIdNum);
                if (!created) {
                    this.log('Run 可能已存在，继续尝试连接...');
                }

                serverUrl = this.getServerUrl();

                // 获取认证令牌，作为 URL 参数传递
                const config = vscode.workspace.getConfiguration('aiat');
                const authToken = config.get<string>('authToken', '');

                // 构建 WebSocket URL: ws://host:port/ws/runs/{run_id}?token={token}
                const tokenParam = authToken ? `?token=${authToken}` : '';
                wsUrl = `${serverUrl}/ws/runs/${runId}${tokenParam}`;

                this.log(`正在连接到: ${wsUrl}`);

                await this.createWebSocketConnection(wsUrl, autoStartMcpServer);

            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.log(`连接失败: ${message}`);
                this._stateManager.updateConnectionState('error', message);

                // 创建包装错误
                const wrappedError = errorHandler.wrapError(
                    error instanceof Error ? error : new Error(String(error)),
                    ErrorType.WEBSOCKET_CONNECTION_ERROR,
                    ErrorSeverity.HIGH,
                    true,
                    { serverUrl, wsUrl, runId, autoStartMcpServer }
                );

                throw wrappedError;
            }
        };

        try {
            await errorHandler.executeWithRetry(
                connectionOperation,
                ErrorType.WEBSOCKET_CONNECTION_ERROR,
                { action: 'connect' },
                {
                    enableUserNotification: true,
                    maxRetries: 3,
                    retryDelay: 1000
                }
            );
        } catch (error) {
            errorHandler.handleError(error as any);
            throw error;
        }
    }

    /**
     * 创建WebSocket连接
     */
    private createWebSocketConnection(wsUrl: string, autoStartMcpServer: boolean): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(wsUrl);

            // 设置连接超时
            const timeout = setTimeout(() => {
                if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
                    this.ws.close();
                    const timeoutError = errorHandler.createError(
                        '连接超时',
                        ErrorType.WEBSOCKET_TIMEOUT_ERROR,
                        ErrorSeverity.HIGH,
                        true,
                        { wsUrl, timeout: 30000 }
                    );
                    reject(timeoutError);
                }
            }, 30000);

            this.ws.on('open', () => {
                clearTimeout(timeout);
                this.log('WebSocket 连接已建立');
                this._stateManager.updateConnectionState('connected');
                // 确保任务状态初始化为 idle
                this._stateManager.updateTaskState('idle');
                this.reconnectAttempts = 0; // 重置重连计数
                this.startHeartbeat();

                vscode.window.showInformationMessage(`已连接到智能体服务 (Run ID: ${this.currentRunId})`);

                // 连接成功后自动启动 MCP 服务器
                if (autoStartMcpServer) {
                    this.log('连接成功，准备启动 MCP 服务器');
                    vscode.commands.executeCommand('aiat.startServer');
                }

                resolve();
            });

            // 监听pong响应
            this.ws.on('pong', () => {
                // 重置ping计时器
                (this.ws as any)._lastPingTime = Date.now();
                this.reconnectAttempts = 0; // 重置重连计数，连接健康
            });

            this.ws.on('message', (data: WebSocket.RawData) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleMessage(message);
                } catch (e) {
                    this.log(`收到非 JSON 消息: ${data.toString()}`);
                    this.handleMessage({ type: 'raw', content: data.toString() });
                }
            });

            this.ws.on('close', (code, reason) => {
                clearTimeout(timeout);
                this.log(`连接已关闭: ${code} - ${reason.toString()}`);
                this.cleanup();
                this._stateManager.updateConnectionState('closed');
                this._stateManager.updateTaskState('idle'); // 重置任务状态

                if (code !== 1000) { // 非正常关闭
                    const closeError = errorHandler.createError(
                        `WebSocket连接意外关闭: ${code} - ${reason.toString()}`,
                        ErrorType.WEBSOCKET_CONNECTION_ERROR,
                        ErrorSeverity.MEDIUM,
                        code !== 1001, // 1001是 going away，可重试
                        { code, reason: reason.toString() }
                    );
                    this._onError.fire(closeError);
                }
            });

            this.ws.on('error', (error) => {
                clearTimeout(timeout);
                this.log(`连接错误: ${error.message}`);

                const wrappedError = errorHandler.wrapError(
                    error,
                    ErrorType.WEBSOCKET_CONNECTION_ERROR,
                    ErrorSeverity.HIGH,
                    true,
                    { wsUrl, originalError: error.message }
                );

                this._onError.fire(wrappedError);
                this._stateManager.updateConnectionState('error', error.message);
                reject(wrappedError);
            });
        });
    }

    /**
     * 断开连接
     */
    disconnect(): void {
        if (this.ws) {
            this.log('正在断开连接...');
            this.ws.close(1000, 'User disconnect');
            this.cleanup();
            // 使用状态管理器更新状态，确保事件被正确触发
            this._stateManager.updateConnectionState('closed');
            this._stateManager.updateTaskState('idle');
            vscode.window.showInformationMessage('已断开智能体服务连接');
        }
    }

    /**
     * 发送消息
     */
    sendMessage(data: object): boolean {
        if (!this._stateManager.isConnected || !this.ws) {
            this.log('未连接，无法发送消息');
            return false;
        }

        try {
            const message = JSON.stringify(data);
            this.ws.send(message);

            // 记录发送的消息
            const agentMessage: AgentMessage = {
                type: (data as { type?: string }).type || 'unknown',
                data: data,
                timestamp: Date.now(),
                direction: 'outgoing'
            };
            this._messages.push(agentMessage);

            // 异步保存到持久化存储
            this._messageStorage.saveMessage(this.currentRunId, agentMessage).catch(error => {
                logger.error('Failed to save outgoing message', error);
            });

            this._onMessage.fire(agentMessage);

            this.log(`发送消息: ${message}`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`发送消息失败: ${message}`);
            return false;
        }
    }

    /**
     * 发送消息（带错误处理）
     */
    async sendMessageWithErrorHandling(data: object, errorType: ErrorType): Promise<boolean> {
        const sendOperation = async (): Promise<boolean> => {
            return this.sendMessage(data);
        };

        try {
            return await errorHandler.executeWithRetry(
                sendOperation,
                errorType,
                { messageType: (data as any).type }
            );
        } catch (error) {
            // 错误已在executeWithRetry中处理，这里只需要返回false
            return false;
        }
    }

    /**
     * 处理扩展错误
     */
    private handleExtendedError(error: any): void {
        // 根据错误类型采取特定行动
        switch (error.type) {
            case ErrorType.WEBSOCKET_CONNECTION_ERROR:
                // WebSocket连接错误，可能需要重连
                if (error.retryable && this._stateManager.isConnected) {
                    this.log('检测到可重试的连接错误，准备重新连接');
                    setTimeout(() => {
                        this.handleConnectionLoss();
                    }, 1000);
                }
                break;

            case ErrorType.TASK_EXECUTION_ERROR:
                // 任务执行错误，更新任务状态
                this._stateManager.updateTaskState('error', error.message);
                break;

            case ErrorType.WEBSOCKET_TIMEOUT_ERROR:
                // 超时错误，强制断开连接
                this.disconnect();
                break;
        }
    }

    /**
     * 启动任务（带错误处理）
     */
    async startTask(agentId: number, task: string): Promise<boolean> {
        // 检查是否可以启动任务
        if (!this._stateManager.canStartTask) {
            const error = errorHandler.createError(
                '无法启动任务: 连接状态或任务状态不允许',
                ErrorType.TASK_START_ERROR,
                ErrorSeverity.MEDIUM,
                false,
                { agentId, task, connectionState: this._stateManager.connectionState, taskState: this._stateManager.taskState }
            );
            errorHandler.handleError(error, { enableUserNotification: true });
            return false;
        }

        // 设置任务状态为启动中
        this._stateManager.updateTaskState('starting');

        try {
            // 获取codebase并进行有效性检查
            const codebase = this.getDefaultCodebase();
            if (!codebase) {
                const error = errorHandler.createError(
                    '无法启动任务: 未找到VS Code工作区根目录',
                    ErrorType.TASK_START_ERROR,
                    ErrorSeverity.HIGH,
                    false,
                    { task }
                );
                errorHandler.handleError(error, { enableUserNotification: true });
                this._stateManager.updateTaskState('idle');
                return false;
            }

            // 检查codebase目录是否有效
            const isValidCodebase = await this.validateCodebase(codebase);
            if (!isValidCodebase) {
                const error = errorHandler.createError(
                    `无法启动任务: Codebase目录无效或不可访问\n\n目录路径: ${codebase}\n\n请确保:\n1. 目录存在且可访问\n2. 目录包含项目文件（如package.json、.git等）`,
                    ErrorType.TASK_START_ERROR,
                    ErrorSeverity.HIGH,
                    false,
                    { task, codebase }
                );
                errorHandler.handleError(error, { enableUserNotification: true });
                this._stateManager.updateTaskState('idle');
                return false;
            }

            logger.info(`Codebase validation passed: ${codebase}`);

            const teamConfig = this.getTeamConfig(agentId);

            const startMessage = {
                type: 'start',
                task: task,
                files: [],
                team_config: teamConfig
            };

  
            const success = await this.sendMessageWithErrorHandling(startMessage, ErrorType.TASK_START_ERROR);
            if (!success) {
                // 发送失败，重置状态
                this._stateManager.updateTaskState('idle', '发送启动消息失败');
                return false;
            }

            return true;
        } catch (error) {
            const wrappedError = errorHandler.wrapError(
                error instanceof Error ? error : new Error('Unknown error'),
                ErrorType.TASK_START_ERROR,
                ErrorSeverity.HIGH,
                true,
                { agentId, task }
            );

            errorHandler.handleError(wrappedError, { enableUserNotification: true });
            this._stateManager.updateTaskState('error', wrappedError.message);
            return false;
        }
    }

    /**
     * 停止任务（带错误处理）
     */
    async stopTask(reason: string = 'User requested stop'): Promise<boolean> {
        // 检查是否可以停止任务
        if (!this._stateManager.canStopTask) {
            const error = errorHandler.createError(
                '无法停止任务: 没有正在运行的任务',
                ErrorType.TASK_STOP_ERROR,
                ErrorSeverity.LOW,
                false,
                { reason, taskState: this._stateManager.taskState }
            );
            errorHandler.handleError(error, { enableUserNotification: false });
            return false;
        }

        // 设置任务状态为停止中
        this._stateManager.updateTaskState('stopping');

        try {
            const stopMessage = {
                type: 'stop',
                reason: reason
            };

            const success = await this.sendMessageWithErrorHandling(stopMessage, ErrorType.TASK_STOP_ERROR);
            if (!success) {
                // 发送失败，恢复之前的状态
                this._stateManager.updateTaskState('running', '发送停止消息失败');
                return false;
            }

            return true;
        } catch (error) {
            const wrappedError = errorHandler.wrapError(
                error instanceof Error ? error : new Error('Unknown error'),
                ErrorType.TASK_STOP_ERROR,
                ErrorSeverity.MEDIUM,
                true,
                { reason }
            );

            errorHandler.handleError(wrappedError, { enableUserNotification: true });
            this._stateManager.updateTaskState('error', wrappedError.message);
            return false;
        }
    }

    /**
     * 发送输入响应
     */
    sendInputResponse(response: string): boolean {
        const responseMessage = {
            type: 'input_response',
            response: response
        };

        return this.sendMessage(responseMessage);
    }

    /**
     * 发送ping消息检查连接状态
     */
    ping(): boolean {
        const pingMessage = {
            type: 'ping'
        };

        return this.sendMessage(pingMessage);
    }

    /**
     * 处理收到的消息
     */
    private handleMessage(data: unknown): void {
        const messageData = data as { type?: string; [key: string]: unknown };
        const messageType = messageData.type || 'unknown';

        // 使用状态管理器智能推断状态
        this._stateManager.inferStateFromMessage(data);

        // 对于pong消息，不需要进一步处理
        if (messageType === 'pong') {
            return;
        }

        let content: string | undefined;

        // 根据消息类型处理内容
        switch (messageType) {
            case 'system':
                content = `系统状态: ${messageData.status}`;
                break;
            case 'message':
                const msgData = messageData.data as {
                    id?: string;
                    name?: string;
                    content?: string;
                    type?: string;
                    source?: string;
                    created_at?: string;
                };
  
                content = msgData.name ?
                    `[${msgData.name}] ${msgData.content || ''}` :
                    (msgData.content || JSON.stringify(data));

                break;
            case 'result':
                const resultData = messageData.data as {
                    task_result?: {
                        messages?: Array<{
                            id?: string;
                            content?: string;
                            name?: string;
                            source?: string;
                            type?: string;
                            created_at?: string;
                        }>;
                        stop_reason?: string;
                    };
                    status?: string; // partial | complete
                    usage?: string;
                    duration?: number;
                };
                if (resultData.task_result?.messages) {
                    const messages = resultData.task_result.messages
                        .map(msg => {
                            const prefix = msg.name ? `[${msg.name}] ` : '';
                            return `${prefix}${msg.content || ''}`;
                        })
                        .join('\n\n');
                    const statusText = resultData.status === 'complete' ? '任务完成' : '任务进行中';
                    content = `${messages}`;
                } else {
                    content = `(${messageData.status}): ${JSON.stringify(data)}`;
                }
                break;
            case 'input_request':
                content = `请求输入: ${messageData.prompt || '请输入'}`;
                this.handleInputRequest(messageData.prompt as string);
                break;
            case 'error':
                content = `错误: ${messageData.error}`;
                break;
            case 'stop':
                // 停止消息，显示用户取消操作
                const stopData = messageData as any;
                content = stopData.reason || '用户请求停止任务';
                break;
            case 'completion':
                // 任务完成消息，根据状态决定内容
                const completionData = messageData.data as { status?: string; stop_reason?: string };
                if (completionData.status === 'cancelled') {
                    content = '任务已取消';
                } else if (completionData.status === 'complete') {
                    content = '任务已完成';
                } else {
                    content = `任务完成 (${completionData.status}): ${completionData.stop_reason || ''}`;
                }
                break;
            default:
                content = JSON.stringify(data, null, 2);
        }

        // 设置消息方向：stop消息是用户发送的，其他是服务器发送的
        const messageDirection = (messageType === 'stop') ? 'outgoing' : 'incoming';

        // 提取智能体source信息
        let source: string | undefined;
        if (messageType === 'message') {
            const msgData = messageData.data as { source?: string };
            source = msgData.source;
        } else if (messageType === 'start') {
            // start消息也可能包含team信息
            const teamConfig = (messageData as any).team_config;
            if (teamConfig && teamConfig.id) {
                source = `team_${teamConfig.id}`;
            }
        }

        const message: AgentMessage = {
            type: messageType,
            content: content,
            data: data,
            source: source,
            timestamp: Date.now(),
            direction: messageDirection
        };

        this._messages.push(message);

        // 异步保存到持久化存储
        this._messageStorage.saveMessage(this.currentRunId, message).catch(error => {
            logger.error('Failed to save incoming message', error);
        });

        this._onMessage.fire(message);

        this.log(`收到消息: ${JSON.stringify(data)}`);
    }

    /**
     * 处理输入请求
     */
    private handleInputRequest(prompt?: string): void {
        // 触发事件通知UI显示输入请求
        vscode.window.showInformationMessage(`智能体请求输入: ${prompt || '请输入'}`);
    }

    /**
     * 启动心跳
     */
    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this._stateManager.isConnected && this.ws) {
                this.ws.ping();
            }
        }, 30000); // 30秒心跳

        // 启动连接健康检查
        this.startConnectionHealthCheck();
    }

    /**
     * 停止心跳
     */
    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.stopConnectionHealthCheck();
    }

    /**
     * 启动连接健康检查
     */
    private startConnectionHealthCheck(): void {
        this.stopConnectionHealthCheck();
        this.connectionHealthTimer = setInterval(() => {
            this.checkConnectionHealth();
        }, 10000); // 每10秒检查一次连接健康状态
    }

    /**
     * 停止连接健康检查
     */
    private stopConnectionHealthCheck(): void {
        if (this.connectionHealthTimer) {
            clearInterval(this.connectionHealthTimer);
            this.connectionHealthTimer = null;
        }
    }

    /**
     * 检查连接健康状态
     */
    private checkConnectionHealth(): void {
        if (!this._stateManager.isConnected || !this.ws) {
            return;
        }

        // 检查WebSocket连接状态
        if (this.ws.readyState === WebSocket.CLOSED ||
            this.ws.readyState === WebSocket.CLOSING) {
            this.log('连接健康检查失败，尝试重新连接');
            this.handleConnectionLoss();
            return;
        }

        // 发送ping检查响应
        const pingStartTime = Date.now();
        const originalPing = this.ws.ping;

        this.ws.ping = () => {
            originalPing.call(this.ws);
            // 记录ping发送时间
            (this.ws as any)._lastPingTime = pingStartTime;
        };

        // 检查是否有超时的ping
        if ((this.ws as any)._lastPingTime) {
            const timeSinceLastPing = Date.now() - (this.ws as any)._lastPingTime;
            if (timeSinceLastPing > 60000) { // 60秒超时
                this.log('Ping响应超时，连接可能不健康');
                this.handleConnectionLoss();
            }
        } else {
            (this.ws as any)._lastPingTime = pingStartTime;
        }
    }

    /**
     * 处理连接丢失
     */
    private handleConnectionLoss(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.log('已达到最大重连次数，停止重连');
            this._stateManager.updateConnectionState('error', '连接丢失，达到最大重连次数');
            return;
        }

        this.reconnectAttempts++;
        this._stateManager.updateConnectionState('connecting');

        this.log(`尝试重新连接 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        // 使用指数退避算法计算延迟
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

        setTimeout(() => {
            this.connect(false).catch((error) => {
                this.log(`重连失败: ${error.message}`);
                this.handleConnectionLoss(); // 递归处理重连失败
            });
        }, Math.min(delay, 30000)); // 最大延迟30秒
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
        this.reconnectAttempts = 0; // 重置重连计数
        this.ws = null;
    }

    
    /**
     * 清空消息历史
     */
    clearMessages(): void {
        this._messages = [];
    }

    /**
     * 加载指定run的历史消息
     */
    async loadHistoryForRun(runId: string): Promise<void> {
        if (!runId) {
            return;
        }

        try {
            const historyMessages = await this._messageStorage.getMessagesForRun(runId);

            // 清空当前内存中的消息
            this._messages = [];

            // 加载历史消息到内存
            this._messages.push(...historyMessages);

            logger.info(`Loaded ${historyMessages.length} messages for run ${runId}`);

            // 触发历史加载完成事件，而不是逐个触发消息事件
            this._onHistoryLoaded.fire({
                runId,
                messages: historyMessages
            });
        } catch (error) {
            logger.error(`Failed to load history for run ${runId}`, error);
        }
    }

    /**
     * 获取消息存储实例
     */
    get messageStorage(): MessageStorage {
        return this._messageStorage;
    }

    /**
     * 设置当前run的标题
     */
    async setRunTitle(title: string): Promise<void> {
        await this._messageStorage.setRunTitle(this.currentRunId, title);
    }

    /**
     * 记录日志
     */
    private log(message: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] [AgentClient] ${message}`);
    }

    /**
     * 销毁客户端
     */
    dispose(): void {
        try {
            // 停止心跳和清理连接
            this.cleanup();

            // 关闭WebSocket连接（如果存在）
            if (this.ws) {
                try {
                    this.ws.removeAllListeners(); // 移除所有事件监听器
                    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                        this.ws.close(1000, 'Extension deactivating');
                    }
                } catch (error) {
                    this.log(`关闭WebSocket连接时出错: ${error instanceof Error ? error.message : String(error)}`);
                }
                this.ws = null;
            }

            // 更新状态
            this._stateManager.updateConnectionState('closed');
            this._stateManager.updateTaskState('idle');

            // 清理事件发射器
            try {
                this._onStateChange.dispose();
                this._onMessage.dispose();
                this._onError.dispose();
            } catch (error) {
                this.log(`清理事件发射器时出错: ${error instanceof Error ? error.message : String(error)}`);
            }

            this.log('AgentClient 已销毁');
        } catch (error) {
            this.log(`销毁AgentClient时出错: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
