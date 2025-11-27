import * as vscode from 'vscode';
import { AgentClient, AgentMessage, ConnectionState, TaskState } from '../client';

/**
 * 聊天视图 - 显示智能体消息的 Webview
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'aiAgentTools.chat';
    
    private _view?: vscode.WebviewView;
    private _agentClient: AgentClient;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        agentClient: AgentClient
    ) {
        this._agentClient = agentClient;
        
        // 监听消息变化
        this._agentClient.onMessage((message) => {
            this.addMessage(message);

            // 特殊处理 input_request 消息
            if (message.type === 'input_request' && message.data) {
                const msgData = message.data as { prompt?: string };
                this.showInputRequest(msgData.prompt);
            }

            // 特殊处理 result 消息 - 当任务完成时隐藏输入请求
            if (message.type === 'result' && message.data) {
                const resultData = message.data as { status?: string };
                if (resultData.status === 'complete') {
                    this.hideInputRequest();
                }
            }

            // 特殊处理 stop 消息 - 当任务停止时隐藏输入请求
            if (message.type === 'stop') {
                this.hideInputRequest();
            }
        });

        // 监听连接状态变化 - 直接监听状态管理器，避免双重事件
        this._agentClient.stateManager.onConnectionChange((state) => {
            console.log(`[ChatView] Connection state changed to: ${state}`);
            this.updateConnectionState(state);
        });

        // 监听任务状态变化 - 直接监听状态管理器，避免双重事件
        this._agentClient.stateManager.onTaskChange((state) => {
            console.log(`[ChatView] Task state changed to: ${state}`);
            this.updateTaskState(state);
        });
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        // 注意：WebviewView 不支持 retainContextWhenHidden，需要手动管理状态
        // 每次视图显示时都会重新加载HTML，所以需要重新同步状态

        webviewView.webview.html = this._getHtmlContent();

        // 处理来自 Webview 的消息
        webviewView.webview.onDidReceiveMessage((data) => {
            switch (data.type) {
                case 'connect':
                    // 立即更新UI到connecting状态，提供即时反馈
                    this.updateConnectionState('connecting');
                    vscode.commands.executeCommand('aiAgentTools.connectAgent').then(() => {
                        // 命令执行完成后，再次同步状态确保准确性
                        setTimeout(() => {
                            this.updateConnectionState(this._agentClient.state);
                            this.updateTaskState(this._agentClient.taskState);
                        }, 100);
                    });
                    break;
                case 'disconnect':
                    // 立即更新UI到connecting状态，提供即时反馈
                    this.updateConnectionState('connecting'); // 使用connecting表示断开操作进行中
                    vscode.commands.executeCommand('aiAgentTools.disconnectAgent').then(() => {
                        // 命令执行完成后，再次同步状态确保准确性
                        setTimeout(() => {
                            this.updateConnectionState(this._agentClient.state);
                            this.updateTaskState(this._agentClient.taskState);
                        }, 100);
                    });
                    break;
                case 'start':
                    this._agentClient.startTask(data.agentId, data.task);
                    break;
                case 'stop':
                    this._agentClient.stopTask(data.reason);
                    break;
                case 'input_response':
                    this._agentClient.sendInputResponse(data.response);
                    break;
                case 'clear':
                    this._agentClient.clearMessages();
                    this.clearMessages();
                    break;
                case 'requestState':
                    // 响应webview的状态请求
                    this.updateConnectionState(this._agentClient.state);
                    this.updateTaskState(this._agentClient.taskState);
                    console.log('[ChatView] Responded to requestState - Connection:', this._agentClient.state, 'Task:', this._agentClient.taskState);
                    break;
            }
        });

        // 初始化显示已有消息
        this.syncMessages();
        this.updateConnectionState(this._agentClient.state);

        // 延迟检查连接状态，解决自动连接后状态不更新的问题
        this.ensureStateSync();

        // 强制立即同步当前状态
        setTimeout(() => {
            console.log('[ChatView] Force immediate state sync after webview ready');
            this.updateConnectionState(this._agentClient.state);
            this.updateTaskState(this._agentClient.taskState);
        }, 500);
    }

    /**
     * 添加消息到视图
     */
    private addMessage(message: AgentMessage): void {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'addMessage',
                message: this.formatMessage(message)
            });
        }
    }

    /**
     * 同步所有消息
     */
    private syncMessages(): void {
        if (this._view) {
            const messages = this._agentClient.messages.map(m => this.formatMessage(m));
            this._view.webview.postMessage({
                type: 'syncMessages',
                messages: messages
            });
        }
    }

    /**
     * 清空消息
     */
    private clearMessages(): void {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'clearMessages'
            });
        }
    }

    /**
     * 更新连接状态
     */
    public updateConnectionState(state: ConnectionState, runId?: string | null, taskState?: TaskState): void {
        if (this._view) {
            const message = {
                type: 'updateState',
                state: state,
                runId: runId !== undefined ? runId : this._agentClient.currentRunId,
                taskState: taskState !== undefined ? taskState : this._agentClient.taskState
            };
            this._view.webview.postMessage(message);
            console.log(`[ChatView] Sent updateState: ${state}, taskState: ${taskState || this._agentClient.taskState}, runId: ${runId || this._agentClient.currentRunId}`);
        }
    }

    /**
     * 更新任务状态
     */
    private updateTaskState(state: TaskState): void {
        if (this._view) {
            const message = {
                type: 'updateTaskState',
                taskState: state
            };
            this._view.webview.postMessage(message);
        }
    }

    /**
     * 显示输入请求
     */
    private showInputRequest(prompt?: string): void {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'showInputRequest',
                prompt: prompt || '智能体请求输入:'
            });
        }
    }

    /**
     * 隐藏输入请求
     */
    private hideInputRequest(): void {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'hideInputRequest'
            });
        }
    }

    /**
     * 格式化消息用于显示
     */
    private formatMessage(message: AgentMessage): object {
        return {
            type: message.type,
            content: message.content || JSON.stringify(message.data, null, 2),
            timestamp: new Date(message.timestamp).toLocaleTimeString(),
            direction: message.direction
        };
    }

    /**
     * 刷新视图
     */
    refresh(): void {
        if (this._view) {
            // 重置HTML内容
            this._view.webview.html = this._getHtmlContent();

            // 延迟一下，等待webview加载完成再同步消息和状态
            setTimeout(() => {
                this.syncMessages();
                this.updateConnectionState(this._agentClient.state, this._agentClient.currentRunId, this._agentClient.taskState);
            }, 100);
        }
    }

    /**
     * 确保状态同步 - 解决自动连接后状态不更新的问题
     */
    ensureStateSync(): void {
        if (this._view) {
            // 延迟一点时间确保webview完全加载
            setTimeout(() => {
                this.updateConnectionState(this._agentClient.state);

                // 如果已经连接，再次发送状态更新确保UI响应
                if (this._agentClient.state === 'connected') {
                    setTimeout(() => {
                        this.updateConnectionState(this._agentClient.state);
                        // 同时发送任务状态更新
                        this.updateTaskState(this._agentClient.taskState);
                    }, 200);
                }
            }, 100);
        }
    }

    /**
     * 生成 Webview HTML 内容
     */
    private _getHtmlContent(): string {
        const config = vscode.workspace.getConfiguration('aiAgentTools');
        const serverUrl = config.get<string>('agentServer.url', 'ws://agent-flow.dev.csst.lab.zverse.space:32080');

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>智能体消息</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        
        .header {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }
        
        .status {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
        }
        
        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: var(--vscode-errorForeground);
        }
        
        .status-dot.connected {
            background-color: var(--vscode-terminal-ansiGreen);
        }

        .status-dot.connecting {
            background-color: var(--vscode-terminal-ansiYellow);
            animation: pulse 1s infinite;
        }

        .status-dot.disconnected {
            background-color: var(--vscode-errorForeground);
        }

        .status-dot.error {
            background-color: var(--vscode-errorForeground);
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        .server-url {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 200px;
        }
        
        .connection-info {
            display: flex;
            flex-direction: column;
            gap: 2px;
            flex: 1;
            min-width: 0;
        }

        .header-buttons {
            display: flex;
            gap: 4px;
        }
        
        .header-buttons button {
            padding: 4px 8px;
            font-size: 11px;
            cursor: pointer;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 3px;
        }
        
        .header-buttons button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        
        .header-buttons button.primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .header-buttons button.primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        
        .message {
            padding: 8px 12px;
            border-radius: 6px;
            max-width: 90%;
            word-wrap: break-word;
        }
        
        .message.incoming {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            align-self: flex-start;
            border-left: 3px solid var(--vscode-terminal-ansiBlue);
        }
        
        .message.outgoing {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            align-self: flex-end;
            border-right: 3px solid var(--vscode-terminal-ansiGreen);
        }
        
        .message-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 4px;
            font-size: 11px;
            opacity: 0.7;
        }
        
        .message-type {
            font-weight: bold;
            text-transform: uppercase;
        }
        
        .message-content {
            font-size: 13px;
            line-height: 1.4;
            white-space: pre-wrap;
            font-family: var(--vscode-editor-font-family);
        }
        
        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            padding: 20px;
        }
        
        .empty-state .icon {
            font-size: 48px;
            margin-bottom: 16px;
        }

        .chat-area {
            padding: 8px 12px;
            border-top: 1px solid var(--vscode-panel-border);
            display: flex;
            gap: 8px;
            align-items: end;
            background-color: var(--vscode-editor-background);
        }

        .chat-area .control-group {
            display: flex;
            flex-direction: column;
            gap: 4px;
            min-width: 150px;
        }

        .chat-area .control-group label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            font-weight: 500;
        }

        .chat-area .control-group select {
            padding: 6px 10px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            font-size: 13px;
        }

        .chat-area .control-group select:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        .chat-area input {
            flex: 1;
            padding: 6px 10px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            font-size: 13px;
        }

        .chat-area input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        .chat-area button {
            padding: 6px 16px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            min-width: 80px;
            transition: background-color 0.2s;
        }

        .chat-area button:hover:not(:disabled) {
            background-color: var(--vscode-button-hoverBackground);
        }

        .chat-area button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .chat-area button.stop {
            background-color: var(--vscode-errorForeground);
            color: white;
        }

        .chat-area button.stop:hover:not(:disabled) {
            background-color: var(--vscode-inputValidation-errorBackground);
        }

        .run-id {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
        }

        .run-id span {
            font-weight: bold;
            color: var(--vscode-terminal-ansiCyan);
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="status">
            <span class="status-dot" id="statusDot"></span>
            <span id="statusText">未连接</span>
        </div>
        <div class="connection-info">
            <div class="server-url" title="${serverUrl}">${serverUrl}</div>
            <div class="run-id" id="runId" style="display: none;">Run ID: <span id="runIdValue"></span></div>
        </div>
        <div class="header-buttons">
            <button id="connectBtn" class="primary">连接</button>
            <button id="disconnectBtn" >断开</button>
            <button id="clearBtn">清空</button>
        </div>
    </div>
    
    <div class="messages" id="messages">
        <div class="empty-state" id="emptyState">
            <div class="icon">💬</div>
            <div>暂无消息</div>
            <div style="font-size: 12px; margin-top: 8px;">连接智能体服务后，消息将显示在这里</div>
        </div>
    </div>

    <div class="chat-area">
        <div class="control-group">
            <label for="agentSelect">智能体:</label>
            <select id="agentSelect">
                <option value="2">代码库理解智能体</option>
                <option value="3">开发文档生成智能体</option>
                <option value="4">环境构建智能体</option>
                <option value="5">代码翻译智能体</option>
            </select>
        </div>
        <input type="text" id="messageInput" placeholder="输入任务描述或消息..." disabled />
        <button id="sendBtn" disabled>发送</button>
    </div>
    
    <script>
        console.log('=== SCRIPT LOADING ===');

        const vscode = acquireVsCodeApi();

        // DOM 元素变量 - 将在页面加载完成后初始化
        let statusDot, statusText, connectBtn, disconnectBtn, clearBtn;
        let messagesContainer, emptyState, messageInput, sendBtn;
        let runIdElement, runIdValue;
        let agentSelect;

        let isConnected = false;
        let taskState = 'idle'; // 使用精确的任务状态
        let isInitialized = false; // 防止重复初始化
        let awaitingInput = false; // 是否等待输入响应

        // 初始化 DOM 元素
        function initializeDOMElements() {
            console.log('=== INITIALIZING DOM ELEMENTS ===');
            statusDot = document.getElementById('statusDot');
            statusText = document.getElementById('statusText');
            connectBtn = document.getElementById('connectBtn');
            disconnectBtn = document.getElementById('disconnectBtn');
            clearBtn = document.getElementById('clearBtn');
            messagesContainer = document.getElementById('messages');
            emptyState = document.getElementById('emptyState');
            messageInput = document.getElementById('messageInput');
            sendBtn = document.getElementById('sendBtn');

            // 连接信息元素
            runIdElement = document.getElementById('runId');
            runIdValue = document.getElementById('runIdValue');

            // 智能体选择器
            agentSelect = document.getElementById('agentSelect');

            console.log('DOM Elements initialized:', {
                statusDot: !!statusDot,
                statusText: !!statusText,
                connectBtn: !!connectBtn,
                disconnectBtn: !!disconnectBtn,
                messageInput: !!messageInput,
                sendBtn: !!sendBtn,
                agentSelect: !!agentSelect
            });
        }

        // 页面加载时的初始化（简化版本）
        function initializePage() {
            if (isInitialized) {
                console.log('Already initialized, skipping...');
                return;
            }

            console.log('=== INITIALIZING PAGE ===');

            // 首先初始化DOM元素
            initializeDOMElements();

            // 检查关键元素是否存在
            if (!statusDot || !statusText || !connectBtn || !disconnectBtn) {
                console.error('Critical DOM elements missing, initialization failed');
                return;
            }

            isInitialized = true;

            // 添加事件监听器
            addEventListeners();

            // 初始状态更新
            updateButtonState();

            // 请求当前状态
            console.log('Requesting current state from extension...');
            vscode.postMessage({ type: 'requestState' });

            console.log('=== PAGE INITIALIZATION COMPLETE ===');
        }

        // 添加所有事件监听器
        function addEventListeners() {
            console.log('=== ADDING EVENT LISTENERS ===');

            // 连接按钮
            if (connectBtn) {
                connectBtn.addEventListener('click', () => {
                    console.log('CONNECT BUTTON CLICKED');
                    connect();
                });
                console.log('✓ Connect button listener added');
            } else {
                console.log('✗ Connect button not found');
            }

            // 断开按钮
            if (disconnectBtn) {
                disconnectBtn.addEventListener('click', () => {
                    console.log('DISCONNECT BUTTON CLICKED');
                    disconnect();
                });
                console.log('✓ Disconnect button listener added');
            } else {
                console.log('✗ Disconnect button not found');
            }

            // 清空按钮
            if (clearBtn) {
                clearBtn.addEventListener('click', () => {
                    console.log('CLEAR BUTTON CLICKED');
                    clearMessages();
                });
                console.log('✓ Clear button listener added');
            } else {
                console.log('✗ Clear button not found');
            }

            // 发送按钮 - 多功能按钮
            if (sendBtn) {
                sendBtn.addEventListener('click', () => {
                    console.log('SEND BUTTON CLICKED');
                    handleSendButtonClick();
                });
                console.log('✓ Send button listener added');
            } else {
                console.log('✗ Send button not found');
            }

            // 输入框回车事件
            if (messageInput) {
                messageInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (!sendBtn.disabled) {
                            handleSendButtonClick();
                        }
                    }
                });
                console.log('✓ Message input enter listener added');
            }

            console.log('=== EVENT LISTENERS COMPLETE ===');
        }

        // 处理发送按钮点击 - 根据状态执行不同操作
        function handleSendButtonClick() {
            if (awaitingInput) {
                // 等待输入响应状态 - 发送输入响应
                sendInputResponse();
            } else if (isTaskRunning()) {
                // 任务运行中 - 停止任务
                stopTask();
            } else if (isConnected) {
                // 已连接且任务未运行 - 启动任务
                startTask();
            }
        }

        // 任务状态判断函数
        function isTaskRunning() {
            const result = ['starting', 'running', 'awaiting_input'].includes(taskState);
            console.log('isTaskRunning() - taskState:', taskState, 'result:', result);
            return result;
        }

        function canStartTask() {
            const result = isConnected && ['idle', 'completed', 'error'].includes(taskState);
            console.log('canStartTask() - isConnected:', isConnected, 'taskState:', taskState, 'result:', result);
            return result;
        }

        function canStopTask() {
            return isTaskRunning();
        }

        function connect() {
            vscode.postMessage({ type: 'connect' });
        }

        function disconnect() {
            vscode.postMessage({ type: 'disconnect' });
        }

        function clearMessages() {
            vscode.postMessage({ type: 'clear' });
        }

        async function startTask() {
            if (!agentSelect || !messageInput || !sendBtn) {
                console.error('Required DOM elements not found');
                return;
            }

            const agentId = parseInt(agentSelect.value);
            const task = messageInput.value.trim();

            if (!task) {
                alert('请输入任务描述');
                return;
            }

            // 检查是否可以启动任务
            if (!canStartTask()) {
                alert('当前状态不允许启动任务');
                return;
            }

            // 禁用按钮防止重复点击
            sendBtn.disabled = true;

            try {
                vscode.postMessage({
                    type: 'start',
                    agentId: agentId,
                    task: task
                });

                // 设置为启动中状态，等待后端确认
                setTaskState('starting');

                // 清空输入框
                messageInput.value = '';
            } catch (error) {
                console.error('启动任务失败:', error);
                sendBtn.disabled = false;
                alert('启动任务失败，请检查连接状态');
            }
        }

        async function stopTask() {
            if (!sendBtn) {
                console.error('Send button element not found');
                return;
            }

            const reason = 'User requested stop';

            // 检查是否可以停止任务
            if (!canStopTask()) {
                alert('当前没有正在运行的任务');
                return;
            }

            // 禁用按钮防止重复点击
            sendBtn.disabled = true;

            try {
                vscode.postMessage({
                    type: 'stop',
                    reason: reason
                });

                // 设置为停止中状态，等待后端确认
                setTaskState('stopping');
            } catch (error) {
                console.error('停止任务失败:', error);
                sendBtn.disabled = false;
                alert('停止任务失败，请检查连接状态');
            }
        }

        function sendInputResponse() {
            if (!messageInput) {
                return;
            }
            const response = messageInput.value.trim();
            if (!response) {
                return;
            }

            vscode.postMessage({
                type: 'input_response',
                response: response
            });

            // 清空输入框
            messageInput.value = '';

            // 重置等待输入状态
            awaitingInput = false;
            updateButtonState();
        }

        function setTaskState(state) {
            taskState = state;
            updateButtonState();
        }

        // 更新按钮状态和文本
        function updateButtonState() {
            if (!sendBtn || !messageInput || !agentSelect) {
                return;
            }

            // 根据不同状态设置按钮文本、样式和可用性
            if (!isConnected) {
                // 未连接状态
                sendBtn.textContent = '发送';
                sendBtn.className = '';
                sendBtn.disabled = true;
                messageInput.disabled = true;
                agentSelect.disabled = false;
                messageInput.placeholder = '请先连接智能体服务...';
            } else if (awaitingInput) {
                // 等待输入响应状态
                sendBtn.textContent = '发送';
                sendBtn.className = '';
                sendBtn.disabled = false;
                messageInput.disabled = false;
                agentSelect.disabled = true;
                messageInput.placeholder = '请输入响应...';
            } else if (isTaskRunning()) {
                // 任务运行中
                sendBtn.textContent = '停止';
                sendBtn.className = 'stop';
                sendBtn.disabled = false;
                messageInput.disabled = true;
                agentSelect.disabled = true;
                messageInput.placeholder = '任务执行中...';
            } else {
                // 空闲状态，可以启动新任务
                sendBtn.textContent = '发送';
                sendBtn.className = '';
                sendBtn.disabled = false;
                messageInput.disabled = false;
                agentSelect.disabled = false;
                messageInput.placeholder = '输入任务描述或消息...';
            }
        }

        function showInputRequest(prompt) {
            // 设置等待输入状态
            awaitingInput = true;

            // 在消息容器中显示输入请求提示
            if (messagesContainer) {
                const promptDiv = document.createElement('div');
                promptDiv.className = 'message incoming';
                promptDiv.innerHTML = \`
                    <div class="message-header">
                        <span class="message-type">INPUT REQUEST</span>
                        <span class="message-time">\${new Date().toLocaleTimeString()}</span>
                    </div>
                    <div class="message-content">\${escapeHtml(prompt || '智能体请求输入:')}</div>
                \`;
                messagesContainer.appendChild(promptDiv);
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }

            // 更新按钮和输入框状态
            updateButtonState();

            // 聚焦到输入框
            if (messageInput) {
                messageInput.focus();
            }
        }

        function hideInputRequest() {
            awaitingInput = false;
            updateButtonState();
        }

        // Removed old event listeners for taskInput and inputResponseInput since they no longer exist

        // 页面加载完成后初始化
        if (document.readyState === 'loading') {
            // 如果文档还在加载，等待DOMContentLoaded
            document.addEventListener('DOMContentLoaded', () => {
                console.log('=== DOM CONTENT LOADED ===');
                initializePage();
            });
        } else {
            // 如果文档已经加载完成，立即初始化
            console.log('=== DOM ALREADY READY ===');
            initializePage();
        }

        // 备用的load事件，确保初始化
        window.addEventListener('load', () => {
            console.log('=== WINDOW LOADED (FALLBACK) ===');
            if (!isInitialized) {
                initializePage();
            }
        });

        // 添加一个函数来强制刷新状态（用于调试）
        function forceRefreshState() {
            console.log('Force refreshing state...');
            console.log('Current JS state - isConnected:', isConnected, 'taskState:', taskState);

            // 强制更新UI状态
            updateButtonState();

            // 请求最新状态
            vscode.postMessage({ type: 'requestState' });
        }

        // 添加到全局以便在控制台调用
        window.forceRefreshState = forceRefreshState;

        // 每5秒自动检查状态一致性（仅在开发模式下）
        setInterval(() => {
            if (window.location.search.includes('debug=true')) {
                console.log('Periodic state check - isConnected:', isConnected, 'taskState:', taskState);
                updateButtonState();
            }
        }, 5000);

        function updateState(state, runId = null, taskStateParam = null) {
            console.log('=== UPDATE STATE CALLED ===');
            console.log('State:', state, 'RunId:', runId, 'TaskState:', taskStateParam);
            console.log('Elements:', {
                statusDot: !!statusDot,
                statusText: !!statusText,
                connectBtn: !!connectBtn,
                disconnectBtn: !!disconnectBtn
            });

            // 如果DOM元素还没初始化，等待页面加载完成
            if (!isInitialized) {
                console.log('Page not initialized yet, waiting for load event...');
                // 使用事件监听而不是无限重试
                window.addEventListener('load', () => {
                    updateState(state, runId, taskStateParam);
                }, { once: true });
                return;
            }

            // 如果DOM元素还没初始化，延迟处理（最多重试3次）
            if (!statusDot || !statusText || !connectBtn || !disconnectBtn || !messageInput || !sendBtn || !agentSelect) {
                console.log('DOM elements not ready, will retry once after initialization');
                // 等待下一个事件循环后重试一次
                setTimeout(() => {
                    // 重新获取元素引用
                    initializeDOMElements();
                    // 如果还是没有，就放弃
                    if (!statusDot || !statusText || !connectBtn || !disconnectBtn || !messageInput || !sendBtn || !agentSelect) {
                        console.error('Failed to initialize DOM elements after retry');
                        return;
                    }
                    // 重试更新
                    updateState(state, runId, taskStateParam);
                }, 200);
                return;
            }

            const oldIsConnected = isConnected;
            const oldTaskState = taskState;

            isConnected = state === 'connected';

            // 如果提供了任务状态，更新它
            if (taskStateParam !== null && taskStateParam !== undefined) {
                taskState = taskStateParam;
            }

            console.log('[updateState] ' + oldIsConnected + '->' + isConnected + ', ' + oldTaskState + '->' + taskState);

            // 更新状态点
            if (statusDot) {
                statusDot.className = 'status-dot ' + state;
                console.log('Updated statusDot className to:', statusDot.className);
            } else {
                console.log('statusDot element not found!');
            }

            // 更新 Run ID 显示
            if (runId && runIdValue && runIdElement) {
                runIdValue.textContent = runId;
                runIdElement.style.display = 'block';
            } else if (runIdElement) {
                runIdElement.style.display = 'none';
            }

            // 统一更新控制面板状态
            updateControlPanelState();

            // 更新状态文本和按钮显示
            if (statusText) {
                console.log('🟢 UPDATING STATUS TEXT TO:', state);
                console.log('🔍 ELEMENTS CHECK:', {
                    connectBtn: !!connectBtn,
                    disconnectBtn: !!disconnectBtn,
                    messageInput: !!messageInput,
                    sendBtn: !!sendBtn
                });

                switch (state) {
                    case 'connected':
                        statusText.textContent = '已连接';
                        console.log('🔧 SETTING CONNECTED STATE');
                        try {
                            if (connectBtn) {
                                connectBtn.style.display = 'none';
                                console.log('✅ connectBtn display set to none');
                            } else {
                                console.log('❌ connectBtn is null');
                            }
                            if (disconnectBtn) {
                                disconnectBtn.style.display = 'inline-block';
                                console.log('✅ disconnectBtn display set to inline-block');
                            } else {
                                console.log('❌ disconnectBtn is null');
                            }
                            // 更新按钮状态
                            updateButtonState();
                            console.log('✅ State updated to connected');
                        } catch (error) {
                            console.log('❌ ERROR IN CONNECTED STATE:', error.message);
                        }
                        break;
                    case 'connecting':
                        if (statusText) {
                            statusText.textContent = '连接中...';
                        }
                        if (connectBtn) {
                            connectBtn.style.display = 'none';
                        }
                        if (disconnectBtn) {
                            disconnectBtn.style.display = 'inline-block';
                        }
                        updateButtonState();
                        break;
                    case 'error':
                        if (statusText) {
                            statusText.textContent = '连接错误';
                        }
                        if (connectBtn) {
                            connectBtn.style.display = 'inline-block';
                        }
                        if (disconnectBtn) {
                            disconnectBtn.style.display = 'none';
                        }
                        updateButtonState();
                        break;
                    case 'disconnected':
                        if (statusText) {
                            statusText.textContent = '未连接';
                        }
                        if (connectBtn) {
                            connectBtn.style.display = 'inline-block';
                        }
                        if (disconnectBtn) {
                            disconnectBtn.style.display = 'none';
                        }
                        updateButtonState();
                        break;
                    case 'closed':
                        if (statusText) {
                            statusText.textContent = '连接已关闭';
                        }
                        if (connectBtn) {
                            connectBtn.style.display = 'inline-block';
                        }
                        if (disconnectBtn) {
                            disconnectBtn.style.display = 'none';
                        }
                        updateButtonState();
                        break;
                    default:
                        if (statusText) {
                            statusText.textContent = '未连接';
                        }
                        if (connectBtn) {
                            connectBtn.style.display = 'inline-block';
                        }
                        if (disconnectBtn) {
                            disconnectBtn.style.display = 'none';
                        }
                        updateButtonState();
                }
            } else {
                console.log('statusText element not found!');
            }
        }

        /**
         * 统一更新控制面板状态
         */
        function updateControlPanelState() {
            // 调用新的按钮状态更新函数
            updateButtonState();
        }
        
        function addMessage(msg) {
            // 如果消息容器还没准备好，等待页面加载完成
            if (!messagesContainer) {
                console.log('Messages container not ready, waiting for initialization...');
                // 使用事件监听而不是无限重试
                if (!isInitialized) {
                    window.addEventListener('load', () => {
                        addMessage(msg);
                    }, { once: true });
                } else {
                    // 尝试重新初始化一次
                    setTimeout(() => {
                        initializeDOMElements();
                        if (messagesContainer) {
                            addMessage(msg);
                        } else {
                            console.error('Failed to find messages container');
                        }
                    }, 200);
                }
                return;
            }

            if (emptyState) {
                emptyState.style.display = 'none';
            }

            const messageDiv = document.createElement('div');
            messageDiv.className = 'message ' + msg.direction;

            messageDiv.innerHTML = \`
                <div class="message-header">
                    <span class="message-type">\${msg.type}</span>
                    <span class="message-time">\${msg.timestamp}</span>
                </div>
                <div class="message-content">\${escapeHtml(msg.content)}</div>
            \`;

            messagesContainer.appendChild(messageDiv);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        function syncMessages(messages) {
            // 如果消息容器还没准备好，等待页面加载完成
            if (!messagesContainer) {
                console.log('Messages container not ready, waiting for initialization...');
                // 使用事件监听而不是无限重试
                if (!isInitialized) {
                    window.addEventListener('load', () => {
                        syncMessages(messages);
                    }, { once: true });
                } else {
                    // 尝试重新初始化一次
                    setTimeout(() => {
                        initializeDOMElements();
                        if (messagesContainer) {
                            syncMessages(messages);
                        } else {
                            console.error('Failed to find messages container');
                        }
                    }, 200);
                }
                return;
            }

            // 清空现有消息
            messagesContainer.innerHTML = '';

            if (messages.length === 0) {
                messagesContainer.innerHTML = \`
                    <div class="empty-state" id="emptyState">
                        <div class="icon">💬</div>
                        <div>暂无消息</div>
                        <div style="font-size: 12px; margin-top: 8px;">连接智能体服务后，消息将显示在这里</div>
                    </div>
                \`;
                // 重新获取 emptyState 引用
                emptyState = document.getElementById('emptyState');
            } else {
                messages.forEach(msg => addMessage(msg));
            }
        }
        
        function updateTaskState(state) {
            taskState = state;

            // 使用统一的控制面板更新函数
            updateControlPanelState();

            // 根据特定状态执行额外操作
            switch (state) {
                case 'idle':
                case 'completed':
                case 'error':
                    hideInputRequest();
                    break;
                case 'awaiting_input':
                    // 输入请求由其他消息处理
                    break;
            }
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        // 处理来自扩展的消息
        window.addEventListener('message', (event) => {
            const data = event.data;
            console.log('[Webview] Received message:', data.type, data);

            switch (data.type) {
                case 'addMessage':
                    addMessage(data.message);
                    break;
                case 'syncMessages':
                    syncMessages(data.messages);
                    break;
                case 'clearMessages':
                    syncMessages([]);
                    break;
                case 'updateState':
                    console.log('[Webview] Calling updateState with:', data.state, data.runId, data.taskState);
                    updateState(data.state, data.runId, data.taskState);
                    break;
                case 'updateTaskState':
                    console.log('[Webview] Calling updateTaskState with:', data.taskState);
                    updateTaskState(data.taskState);
                    break;
                case 'showInputRequest':
                    showInputRequest(data.prompt);
                    break;
                case 'hideInputRequest':
                    hideInputRequest();
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
