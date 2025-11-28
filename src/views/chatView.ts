import * as vscode from 'vscode';
import { AgentClient, AgentMessage, ConnectionState, TaskState, HistoryLoadedEvent } from '../client';
import { ActiveGroup } from '../utils/messageStorage';

/**
 * 聊天视图 - 显示智能体消息的 Webview
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'aiat.chat';

    private _view?: vscode.WebviewView;
    private _agentClient: AgentClient;
    private _context: vscode.ExtensionContext;

    // 分组状态管理
    private _currentProcessGroup: any[] = [];
    private _currentGroupStartTime: number = 0;
    private _lastMessageTime: number = 0;
    private _currentGroupId: string | null = null; // 当前分组ID

    constructor(
        private readonly _extensionUri: vscode.Uri,
        agentClient: AgentClient,
        context: vscode.ExtensionContext
    ) {
        this._agentClient = agentClient;
        this._context = context;
        
        // 监听消息变化
        this._agentClient.onMessage((message) => {
            this.addMessage(message);

            // 特殊处理 input_request 消息
            if (message.type === 'input_request' && message.data) {
                const msgData = message.data as { prompt?: string };
                this.showInputRequest(msgData.prompt);
            }

            // 特殊处理 result 消息 - 当任务完成时隐藏输入请求并结束分组
            // 注意：任务状态更新由StateManager的inferStateFromMessage处理
            if (message.type === 'result' && message.data) {
                const resultData = message.data as { status?: string };
                if (resultData.status === 'complete') {
                    this.hideInputRequest();
                    // 确保结束当前分组
                    this.sendProcessGroupComplete();
                    // 保存完成状态
                    this.saveCurrentState();
                }
            }

            // 特殊处理 stop 消息 - 当任务停止时隐藏输入请求并结束分组
            if (message.type === 'stop') {
                this.hideInputRequest();
                // 确保结束当前分组
                this.sendProcessGroupComplete();
                // 保存停止状态
                this.saveCurrentState();
            }

            // 特殊处理 completion 消息 - 当任务完成或取消时隐藏输入请求并结束分组
            if (message.type === 'completion' && message.data) {
                const completionData = message.data as { status?: string };
                if (completionData.status === 'cancelled' || completionData.status === 'complete') {
                    this.hideInputRequest();
                    // 确保结束当前分组
                    this.sendProcessGroupComplete();
                    // 保存完成/取消状态
                    this.saveCurrentState();
                }
            }
        });

        // 监听历史加载完成事件
        this._agentClient.onHistoryLoaded((event: HistoryLoadedEvent) => {
            console.log(`[ChatView] History loaded for run ${event.runId}, ${event.messages.length} messages`);
            // 直接同步所有历史消息到UI，不通过addMessage避免重新分组处理
            this.syncMessages();
            // 恢复活跃分组状态（如果有）
            this.restoreActiveGroupState();
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

        // 监听runId变化，自动加载历史消息
        this._agentClient.stateManager.onChange((appState) => {
            const currentRunId = this._agentClient.currentRunId;
            if (currentRunId && appState.runId !== currentRunId) {
                console.log(`[ChatView] RunId changed to: ${currentRunId}, loading history`);
                this.loadHistoryForRun(currentRunId);
            }
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

        // 监听webview可见性变化，在隐藏时保存状态
        webviewView.onDidChangeVisibility(() => {
            if (!webviewView.visible) {
                // 侧边栏即将关闭，保存当前状态
                this.saveCurrentState();
            } else {
                // 侧边栏重新打开，恢复状态（resolveWebviewView已处理）
                console.log('[ChatView] Webview became visible, state restored in resolveWebviewView');
            }
        });

        // 处理来自 Webview 的消息
        webviewView.webview.onDidReceiveMessage((data) => {
            switch (data.type) {
                case 'connect':
                    // 立即更新UI到connecting状态，提供即时反馈
                    this.updateConnectionState('connecting');
                    vscode.commands.executeCommand('aiat.connectAgent').then(() => {
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
                    vscode.commands.executeCommand('aiat.disconnectAgent').then(() => {
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

        // 初始化显示已有消息 - 增强版恢复机制
        setTimeout(async () => {
            const currentRunId = this._agentClient.currentRunId;

            // 1. 优先从持久化存储恢复完整状态
            if (currentRunId) {
                console.log(`[ChatView] resolveWebviewView: Loading history for current run ${currentRunId}`);
                await this.loadHistoryForRun(currentRunId);

                // 2. 恢复活跃分组状态
                await this.restoreActiveGroupState();

                // 3. 强制重新渲染所有消息
                this.forceRefreshAllMessages();
            } else {
                // 4. 没有runId时，尝试从webview状态恢复
                await this.restoreFromWebviewState();

                // 5. 同步内存中的消息
                this.syncMessages();
            }

            // 6. 更新连接状态
            this.updateConnectionState(this._agentClient.state);

            // 7. 延迟检查连接状态，解决自动连接后状态不更新的问题
            this.ensureStateSync();
        }, 50);

        // 强制立即同步当前状态
        setTimeout(() => {
            console.log('[ChatView] Force immediate state sync after webview ready');
            this.updateConnectionState(this._agentClient.state);
            this.updateTaskState(this._agentClient.taskState);
        }, 500);
    }

    /**
     * 添加消息到视图 - 支持智能实时分组
     */
    private addMessage(message: AgentMessage): void {
        if (this._view) {
            const formattedMessage = this.formatMessage(message);
            if (formattedMessage) {
                const currentTime = new Date(message.timestamp).getTime();

                // 检查是否是需要分组的消息
                if (this.isProcessMessage(formattedMessage)) {
                    // 判断是否需要开始新分组
                    const shouldStartNewGroup = this.shouldStartNewGroup(
                        formattedMessage,
                        this._currentProcessGroup,
                        this._lastMessageTime,
                        currentTime
                    );

                    if (shouldStartNewGroup && this._currentProcessGroup.length > 0) {
                        // 完成当前分组，开始新分组
                        this.sendProcessGroupComplete();
                    }

                    // 添加到当前分组（新的或已存在的）
                    if (this._currentProcessGroup.length === 0) {
                        this._currentGroupStartTime = currentTime;
                        // 生成新的分组ID
                        this._currentGroupId = this.generateGroupId(formattedMessage, currentTime);
                    }
                    this._currentProcessGroup.push(formattedMessage);
                    this._lastMessageTime = currentTime;

                    // 立即发送分组更新
                    this.sendProcessGroupUpdate();
                } else {
                    // 非分组消息，先结束当前分组（如果有）
                    if (this._currentProcessGroup.length > 0) {
                        this.sendProcessGroupComplete();
                    }

                    // 发送非分组消息
                    this._view.webview.postMessage({
                        type: 'addMessage',
                        message: formattedMessage
                    });

                    // 重置时间跟踪
                    this._lastMessageTime = 0;
                }
            }
        }
    }

    /**
     * 发送当前分组的更新
     */
    private sendProcessGroupUpdate(): void {
        if (this._currentProcessGroup.length > 0 && this._view) {
            const groupMessage = this.createProcessMessageGroup(
                this._currentProcessGroup,
                this._currentGroupStartTime
            );

            // 保存活跃分组状态
            this.saveActiveGroupState();

            this._view.webview.postMessage({
                type: 'updateProcessGroup',
                group: groupMessage,
                isComplete: false // 表示分组还在进行中
            });
        }
    }

    /**
     * 完成当前分组并发送最终版本
     */
    private sendProcessGroupComplete(): void {
        if (this._currentProcessGroup.length > 0 && this._view) {
            const groupMessage = this.createProcessMessageGroup(
                this._currentProcessGroup,
                this._currentGroupStartTime
            );

            this._view.webview.postMessage({
                type: 'updateProcessGroup',
                group: groupMessage,
                isComplete: true // 表示分组完成
            });

            // 清空当前分组
            this._currentProcessGroup = [];
            this._currentGroupStartTime = 0;
            this._lastMessageTime = 0;
            this._currentGroupId = null;

            // 清除持久化的活跃分组状态
            this.clearActiveGroupState();
        }
    }

    /**
     * 同步所有消息 - 实现消息分组折叠功能
     */
    private syncMessages(): void {
        if (this._view) {
            const formattedMessages = this._agentClient.messages
                .map(m => this.formatMessage(m))
                .filter(m => m !== null); // 过滤掉null消息

            // 对消息进行分组处理
            const groupedMessages = this.groupMessages(formattedMessages);

            this._view.webview.postMessage({
                type: 'syncMessages',
                messages: groupedMessages
            });
        }
    }

    /**
     * 消息分组处理 - 增强的多分组支持
     * 支持基于时间间隔、内容变化的智能分组边界识别
     */
    private groupMessages(messages: any[]): any[] {
        const result: any[] = [];
        let currentGroup: any[] = [];
        let groupStartTime = 0;
        let lastMessageTime = 0;

        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            const currentTime = message.timestamp || 0;

            // 检查是否是需要分组的消息
            if (this.isProcessMessage(message)) {
                // 判断是否需要开始新分组
                const shouldStartNewGroup = this.shouldStartNewGroup(
                    message,
                    currentGroup,
                    lastMessageTime,
                    currentTime
                );

                if (shouldStartNewGroup) {
                    // 如果当前已有分组，先完成它
                    if (currentGroup.length > 0) {
                        result.push(this.createProcessMessageGroup(currentGroup, groupStartTime));
                    }
                    // 开始新分组
                    currentGroup = [message];
                    groupStartTime = currentTime;
                } else {
                    // 添加到当前分组
                    if (currentGroup.length === 0) {
                        groupStartTime = currentTime;
                    }
                    currentGroup.push(message);
                }
                lastMessageTime = currentTime;
            } else {
                // 非分组消息，完成当前分组（如果有）
                if (currentGroup.length > 0) {
                    result.push(this.createProcessMessageGroup(currentGroup, groupStartTime));
                    currentGroup = [];
                    lastMessageTime = 0;
                }
                // 直接添加非分组消息
                result.push(message);
            }
        }

        // 处理最后剩余的分组
        if (currentGroup.length > 0) {
            result.push(this.createProcessMessageGroup(currentGroup, groupStartTime));
        }

        return result;
    }

    /**
     * 判断是否是需要折叠的过程消息
     */
    private isProcessMessage(message: any): boolean {
        // 只折叠任务进展类型的消息
        return message.type === '任务进展';
    }

    /**
     * 判断是否需要开始新的分组
     * 基于时间间隔、内容变化等因素智能判断
     */
    private shouldStartNewGroup(
        currentMessage: any,
        currentGroup: any[],
        lastMessageTime: number,
        currentTime: number
    ): boolean {
        // 如果当前没有分组，需要开始新分组
        if (currentGroup.length === 0) {
            return false; // 不需要新分组，直接使用当前消息开始第一个分组
        }

        // 1. 时间间隔判断 - 如果两条消息间隔超过2分钟，开始新分组
        const GROUP_TIME_GAP = 2 * 60 * 1000; // 2分钟
        if (lastMessageTime > 0 && (currentTime - lastMessageTime) > GROUP_TIME_GAP) {
            return true;
        }

        // 2. 内容主题变化判断 - 如果消息内容涉及不同阶段，开始新分组
        if (currentGroup.length > 0) {
            const lastMessage = currentGroup[currentGroup.length - 1];
            if (this.isDifferentPhase(lastMessage, currentMessage)) {
                return true;
            }
        }

        // 3. 分组大小限制 - 如果当前分组已经很大，开始新分组
        const MAX_GROUP_SIZE = 20;
        if (currentGroup.length >= MAX_GROUP_SIZE) {
            return true;
        }

        // 4. 分组总时长限制 - 如果分组跨度超过30分钟，开始新分组
        if (currentGroup.length > 0) {
            const groupDuration = currentTime - (currentGroup[0].timestamp || currentTime);
            const MAX_GROUP_DURATION = 30 * 60 * 1000; // 30分钟
            if (groupDuration > MAX_GROUP_DURATION) {
                return true;
            }
        }

        return false;
    }

    /**
     * 判断两个消息是否代表不同的处理阶段
     */
    private isDifferentPhase(message1: any, message2: any): boolean {
        // 基于消息内容的关键词判断阶段变化
        const phaseKeywords = {
            analysis: ['分析', 'analysis', 'investigate', '调研'],
            design: ['设计', 'design', 'plan', '规划'],
            implementation: ['实现', 'implement', 'code', '编码', '开发'],
            testing: ['测试', 'test', 'verify', '验证'],
            deployment: ['部署', 'deploy', 'release', '发布'],
            completion: ['完成', 'complete', 'finish', '结束', 'summary', '总结']
        };

        const getMessagePhase = (message: any): string | null => {
            const content = (message.content || '').toLowerCase();

            for (const [phase, keywords] of Object.entries(phaseKeywords)) {
                if (keywords.some(keyword => content.includes(keyword))) {
                    return phase;
                }
            }
            return null;
        };

        const phase1 = getMessagePhase(message1);
        const phase2 = getMessagePhase(message2);

        // 如果都能识别出阶段且阶段不同，则认为是不同阶段
        return !!(phase1 && phase2 && phase1 !== phase2);
    }

    /**
     * 创建过程消息分组
     */
    private createProcessMessageGroup(messages: any[], startTime: number): any {
        // 使用最后一条消息作为预览和最新时间戳
        const lastMessage = messages[messages.length - 1];
        const previewContent = this.truncateText(lastMessage.content, 100); // 控制预览字符数

        // 生成唯一的分组ID - 基于起始时间和第一条消息内容
        const groupId = this.generateGroupId(messages[0], startTime);

        return {
            id: groupId, // 添加唯一ID
            type: 'process_group',
            content: previewContent, // 使用最后一条消息作为预览
            messages: messages, // 完整的消息列表
            timestamp: lastMessage.timestamp || startTime, // 使用最新消息的时间戳
            direction: 'incoming',
            source: 'process_group',
            count: messages.length,
            previewTypes: this.getPreviewTypes(messages)
        };
    }

    /**
     * 生成分组的唯一ID
     */
    private generateGroupId(firstMessage: any, startTime: number): string {
        // 使用起始时间和消息内容的hash作为ID
        const content = firstMessage.content || '';
        const timestamp = startTime || Date.now();
        const hash = this.simpleHash(content + timestamp);
        return `group_${timestamp}_${hash}`;
    }

    /**
     * 保存活跃分组状态
     */
    private async saveActiveGroupState(): Promise<void> {
        if (this._currentProcessGroup.length > 0 && this._currentGroupId) {
            try {
                const activeGroup: ActiveGroup = {
                    id: this._currentGroupId,
                    startTime: this._currentGroupStartTime,
                    messages: this._currentProcessGroup,
                    isComplete: false
                };

                await this._agentClient.messageStorage.saveActiveGroup(
                    this._agentClient.currentRunId || '',
                    activeGroup
                );
            } catch (error) {
                console.error('[ChatView] Failed to save active group state:', error);
            }
        }
    }

    /**
     * 清除活跃分组状态
     */
    private async clearActiveGroupState(): Promise<void> {
        try {
            await this._agentClient.messageStorage.clearActiveGroup(
                this._agentClient.currentRunId || ''
            );
        } catch (error) {
            console.error('[ChatView] Failed to clear active group state:', error);
        }
    }

    /**
     * 强制重新渲染所有消息
     */
    private forceRefreshAllMessages(): void {
        if (this._view) {
            // 清空现有消息
            this._view.webview.postMessage({
                type: 'clearMessages'
            });

            // 延迟重新发送所有消息，确保清空操作完成
            setTimeout(() => {
                // 重新同步所有消息
                this.syncMessages();

                // 如果有活跃分组，再次发送分组更新
                if (this._currentProcessGroup.length > 0 && this._currentGroupId) {
                    const groupMessage = this.createProcessMessageGroup(
                        this._currentProcessGroup,
                        this._currentGroupStartTime
                    );

                    this._view?.webview.postMessage({
                        type: 'updateProcessGroup',
                        group: groupMessage,
                        isComplete: false
                    });
                }
            }, 100);
        }
    }

    /**
     * 保存当前状态（在侧边栏关闭前调用）
     */
    private saveCurrentState(): void {
        if (!this._agentClient.currentRunId) {
            return; // 没有runId时不保存临时状态
        }

        try {
            // 保存当前处理组状态到扩展的全局存储
            const stateToSave = {
                messages: this._currentProcessGroup,
                groupId: this._currentGroupId,
                groupStartTime: this._currentGroupStartTime,
                lastMessageTime: this._lastMessageTime,
                timestamp: Date.now()
            };

            const storageKey = `chatView.currentRun.${this._agentClient.currentRunId}`;
            this._context.globalState.update(storageKey, stateToSave);
            console.log('[ChatView] State saved to global storage:', {
                runId: this._agentClient.currentRunId,
                messageCount: this._currentProcessGroup.length,
                groupId: this._currentGroupId
            });
        } catch (error) {
            console.error('[ChatView] Failed to save current state:', error);
        }
    }

    /**
     * 从全局存储恢复状态（用于无runId的情况）
     */
    private async restoreFromWebviewState(): Promise<void> {
        const currentRunId = this._agentClient.currentRunId;
        if (!currentRunId) {
            return;
        }

        try {
            // 从扩展全局存储恢复状态
            const storageKey = `chatView.currentRun.${currentRunId}`;
            const savedState = this._context.globalState.get(storageKey) as {
                messages?: any[];
                groupId?: string | null;
                groupStartTime?: number;
                lastMessageTime?: number;
                timestamp?: number;
            } | undefined;

            if (savedState && savedState.messages) {
                console.log('[ChatView] Restoring messages from global storage:', savedState.messages.length);

                // 恢复消息到当前处理组
                this._currentProcessGroup = savedState.messages || [];
                this._currentGroupId = savedState.groupId || null;
                this._currentGroupStartTime = savedState.groupStartTime || Date.now();
                this._lastMessageTime = savedState.lastMessageTime || Date.now();
            }
        } catch (error) {
            console.error('[ChatView] Failed to restore from global storage:', error);
        }
    }

    /**
     * 恢复活跃分组状态
     */
    private async restoreActiveGroupState(): Promise<void> {
        try {
            const activeGroup = await this._agentClient.messageStorage.getActiveGroup(
                this._agentClient.currentRunId || ''
            );

            if (activeGroup && !activeGroup.isComplete) {
                console.log(`[ChatView] Restoring active group: ${activeGroup.id}, messages: ${activeGroup.messages.length}`);

                // 恢复分组状态
                this._currentGroupId = activeGroup.id;
                this._currentGroupStartTime = activeGroup.startTime;
                this._currentProcessGroup = activeGroup.messages;
                this._lastMessageTime = Date.now(); // 设置为当前时间避免新分组

                // 发送恢复的分组更新到UI
                if (this._view) {
                    const groupMessage = this.createProcessMessageGroup(
                        this._currentProcessGroup,
                        this._currentGroupStartTime
                    );

                    this._view.webview.postMessage({
                        type: 'updateProcessGroup',
                        group: groupMessage,
                        isComplete: false
                    });
                }
            }
        } catch (error) {
            console.error('[ChatView] Failed to restore active group state:', error);
        }
    }

    /**
     * 简单的字符串hash函数
     */
    private simpleHash(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 转换为32位整数
        }
        return Math.abs(hash);
    }

    /**
     * 截断文本到指定长度
     */
    private truncateText(text: string, maxLength: number): string {
        if (!text || text.length <= maxLength) {
            return text;
        }
        return text.substring(0, maxLength) + '...';
    }

    /**
     * 获取消息类型预览
     */
    private getPreviewTypes(messages: any[]): string[] {
        const types = messages.map(m => m.type);
        const uniqueTypes = [...new Set(types)];
        return uniqueTypes.slice(0, 3); // 最多显示3种类型
    }

    /**
     * 加载指定run的历史消息
     */
    private async loadHistoryForRun(runId: string): Promise<void> {
        if (!runId) {
            return;
        }

        try {
            console.log(`[ChatView] Loading history for run ${runId}`);
            await this._agentClient.loadHistoryForRun(runId);

            // 重新同步消息到UI
            this.syncMessages();
        } catch (error) {
            console.error(`[ChatView] Failed to load history for run ${runId}:`, error);
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
    private formatMessage(message: AgentMessage): object | null {
        // 过滤掉系统状态消息，专注任务相关内容
        if (message.type === 'system' || message.type === 'pong' || message.type === 'ping') {
            return null;
        }

        let displayContent = '';
        let messageType = message.type;
        let messageSource = '';

        switch (message.type) {
            case 'start':
                // 启动任务消息，从顶级字段获取内容
                // 尝试从不同位置获取任务内容
                let taskContent = (message as any).task;
                if (!taskContent && message.data && (message.data as any).task) {
                    taskContent = (message.data as any).task;
                }
                if (!taskContent && message.data && (message.data as any).content) {
                    taskContent = (message.data as any).content;
                }

                displayContent = taskContent || message.content || '开始任务';
                messageType = '启动任务';
                break;

            case 'input_response':
                // 用户输入消息，从顶级response字段获取内容
                displayContent = (message as any).response || message.content || '用户输入';
                messageType = '用户输入';
                break;

            case 'message':
                // 智能体消息，归类为任务进展
                const msgData = message.data as {
                    id?: string;
                    name?: string;
                    content?: string;
                    source?: string;
                    type?: string;
                } || {};

                // 使用message.data中的字段
                messageSource = msgData.source || '';
                displayContent = msgData.content || message.content || '';
                messageType = '任务进展'; // 所有智能体消息都归类为任务进展
                break;

            case 'result':
                const org_message: any = message.data;
                const resultStatus = org_message.status;  // 🎯 修复：从消息的顶级获取status

                if (resultStatus === 'complete') {
                    return null; // 任务完成的消息不显示
                }

                // 任务结果消息
                displayContent = message.content || '';
                messageType = '任务完成'; // result消息归类为任务完成
                break;

            case 'input_request':
                // 请求输入消息，从顶级prompt字段获取内容
                displayContent = (message as any).prompt || message.content || '请求输入';
                messageType = '请求输入';
                break;

            case 'completion':
                // 任务完成消息，根据状态决定是否显示
                const completionData = message.data as { status?: string };
                if (completionData.status === 'cancelled') {
                    return null; // 取消的任务不显示消息
                }
                // 其他状态的completion消息不显示
                return null;

            case 'error':
                // 错误消息，归类为任务取消，从顶级error字段获取内容
                displayContent = (message as any).error || message.content || '发生错误';
                messageType = '任务取消'; // 错误消息归类为任务取消
                break;

            default:
                // 其他类型消息，使用content
                displayContent = message.content || '';
                break;
        }

        // 如果没有内容，不显示
        console.log('[formatMessage] Final check - displayContent:', displayContent);
        console.log('[formatMessage] Trim check - displayContent.trim():', displayContent?.trim());

        if (!displayContent || displayContent.trim() === '') {
            console.log('[formatMessage] Returning null - no content to display');
            return null;
        }

        const result = {
            type: messageType,
            content: displayContent,
            timestamp: new Date(message.timestamp).toLocaleTimeString(),
            direction: message.direction,
            source: messageSource
        };

        console.log('[formatMessage] Returning formatted message:', result);
        return result;
    }

    /**
     * 刷新视图
     */
    refresh(): void {
        if (this._view) {
            // 重置HTML内容
            this._view.webview.html = this._getHtmlContent();

            // 延迟一下，等待webview加载完成再同步消息和状态
            setTimeout(async () => {
                // 如果有当前runId，先加载历史消息
                const currentRunId = this._agentClient.currentRunId;
                if (currentRunId) {
                    console.log(`[ChatView] Refresh: Loading history for current run ${currentRunId}`);
                    await this.loadHistoryForRun(currentRunId);
                } else {
                    // 没有runId时，同步内存中的消息
                    this.syncMessages();
                }

                // 更新状态
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
            padding: 10px 14px;
            border-radius: 8px;
            max-width: 95%;
            word-wrap: break-word;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
            transition: all 0.2s ease;
            position: relative;
        }

        .message:hover {
            transform: translateY(-1px);
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
        }

        .message.incoming {
            background: linear-gradient(135deg, var(--vscode-editor-inactiveSelectionBackground), var(--vscode-sideBar-background));
            align-self: flex-start;
            border-left: 4px solid var(--vscode-charts-blue);
            border-top-left-radius: 4px;
            border-bottom-left-radius: 4px;
        }

        .message.outgoing {
            background: linear-gradient(135deg, var(--vscode-button-background), var(--vscode-button-hoverBackground));
            color: var(--vscode-button-foreground);
            align-self: flex-end;
            border-right: 4px solid var(--vscode-charts-green);
            border-top-right-radius: 4px;
            border-bottom-right-radius: 4px;
        }

        /* 特殊消息类型的样式 */
        .message[data-type="任务完成"] {
            border-left-color: var(--vscode-charts-green) !important;
            background: linear-gradient(135deg, rgba(46, 160, 67, 0.1), var(--vscode-sideBar-background));
        }

        .message[data-type="任务进展"] {
            border-left-color: var(--vscode-charts-blue) !important;
            background: linear-gradient(135deg, rgba(0, 120, 212, 0.1), var(--vscode-sideBar-background));
        }

        .message[data-type="错误"] {
            border-left-color: var(--vscode-charts-red) !important;
            background: linear-gradient(135deg, rgba(255, 0, 0, 0.1), var(--vscode-sideBar-background));
        }

        .message[data-type="需要输入"] {
            border-left-color: var(--vscode-charts-orange) !important;
            background: linear-gradient(135deg, rgba(255, 140, 0, 0.1), var(--vscode-sideBar-background));
        }

        .message[data-type="任务取消"] {
            border-left-color: var(--vscode-charts-gray) !important;
            background: linear-gradient(135deg, rgba(128, 128, 128, 0.1), var(--vscode-sideBar-background));
        }

        .message-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 6px;
            font-size: 10px;
            opacity: 0.8;
            font-weight: 500;
        }

        .message-type {
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            padding: 2px 6px;
            border-radius: 3px;
            background: rgba(255, 255, 255, 0.1);
            display: inline-block;
        }

        .message.incoming .message-type {
            color: var(--vscode-charts-blue);
        }

        .message.outgoing .message-type {
            color: var(--vscode-button-foreground);
            background: rgba(255, 255, 255, 0.2);
        }

        .message-content {
            font-size: 14px;
            line-height: 1.5;
            white-space: pre-wrap;
            font-family: var(--vscode-editor-font-family);
            word-break: break-word;
            margin-top: 2px;
        }

        /* 代码块样式 */
        .message-content code {
            background: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            padding: 2px 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }

        .message-content pre {
            background: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 8px;
            margin: 4px 0;
            overflow-x: auto;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            line-height: 1.4;
        }

        /* 空状态优化 */
        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            padding: 40px 20px;
        }

        .empty-state .icon {
            font-size: 64px;
            margin-bottom: 20px;
            opacity: 0.6;
            animation: float 3s ease-in-out infinite;
        }

        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-10px); }
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
            min-width: 100px;
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
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
            margin-left: 8px;
        }

        .run-id span {
            font-weight: 600;
            color: var(--vscode-textLink-activeForeground);
        }

        /* 消息折叠功能样式 */
        .message.collapsible {
            cursor: pointer;
            position: relative;
        }

        .message.collapsible .collapse-toggle {
            position: absolute;
            top: 8px;
            right: 8px;
            width: 16px;
            height: 16px;
            background: rgba(128, 128, 128, 0.3);
            border-radius: 3px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            color: var(--vscode-foreground);
            transition: all 0.2s ease;
            opacity: 0.5;
        }

        .message.collapsible:hover .collapse-toggle {
            opacity: 1;
            background: rgba(128, 128, 128, 0.6);
            transform: scale(1.1);
        }

        .message.collapsible .collapse-toggle:hover {
            background: rgba(128, 128, 128, 0.8);
            transform: scale(1.2);
        }

        .message.collapsible .collapse-toggle:active {
            transform: scale(0.95);
        }

        .message.collapsible .collapse-toggle::before {
            content: '−';
            font-weight: bold;
        }

        .message.collapsible.collapsed .collapse-toggle::before {
            content: '+';
        }

        .message.collapsible .message-content {
            transition: max-height 0.3s ease, opacity 0.3s ease;
            max-height: none;
            overflow: visible;
        }

        .message.collapsible.collapsed .message-content {
            max-height: 40px;
            opacity: 0.7;
            overflow: hidden;
        }

        .message.collapsible.collapsed {
            opacity: 0.8;
        }

        /* 长内容的截断效果 - 仅在折叠时应用 */
        .message.collapsible.collapsed .message-content.collapsed-content {
            position: relative;
        }

        .message.collapsible.collapsed .message-content.collapsed-content::after {
            content: '';
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            height: 20px;
            background: linear-gradient(transparent, var(--vscode-sideBar-background));
        }

        /* 消息分组折叠样式 */
        .message[data-type="process_group"] {
            border-left-color: var(--vscode-charts-purple) !important;
            background: linear-gradient(135deg, rgba(138, 43, 226, 0.1), var(--vscode-sideBar-background));
            border: 1px solid var(--vscode-panel-border);
            box-shadow: 0 2px 8px rgba(138, 43, 226, 0.2);
        }

        .process-group-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            cursor: pointer;
            padding: 8px;
            background: rgba(138, 43, 226, 0.05);
            border-radius: 4px;
            transition: background-color 0.2s ease;
        }

        .process-group-header:hover {
            background: rgba(138, 43, 226, 0.1);
        }

        .process-group-title {
            display: flex;
            align-items: center;
            gap: 8px;
            font-weight: 600;
            color: var(--vscode-charts-purple);
        }

        .process-group-count {
            background: var(--vscode-charts-purple);
            color: white;
            padding: 2px 6px;
            border-radius: 10px;
            font-size: 10px;
            font-weight: 600;
        }

        .process-group-time {
            font-size: 9px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.8;
            margin-left: 8px;
        }

        .process-group-toggle {
            width: 20px;
            height: 20px;
            background: var(--vscode-charts-purple);
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: bold;
            transition: transform 0.3s ease;
            cursor: pointer;
        }

        .process-group-toggle.expanded {
            transform: rotate(180deg);
        }

        .process-group-content {
            transition: max-height 0.3s ease, opacity 0.3s ease;
            max-height: 0;
            opacity: 0;
            overflow: hidden;
        }

        .process-group-content.expanded {
            max-height: 2000px;
            opacity: 1;
            margin-top: 8px;
        }

        .process-group-message {
            margin: 8px 0;
            padding: 8px;
            background: rgba(138, 43, 226, 0.03);
            border-left: 3px solid var(--vscode-charts-purple);
            border-radius: 4px;
        }

        .process-group-message .message-header {
            font-size: 9px;
            opacity: 0.7;
            margin-bottom: 4px;
        }

        .process-group-preview {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            font-size: 12px;
            margin-top: 4px;
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
                <option value="2">代码理解</option>
                <option value="3">文档生成</option>
                <option value="4">环境构建</option>
                <option value="5">代码翻译</option>
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
            console.log('[updateButtonState] Called with:', {
                isConnected,
                taskState,
                awaitingInput,
                buttonExists: !!sendBtn
            });

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

                // 判断是否需要为输入请求添加折叠功能
                const shouldCollapse = prompt && prompt.length > 100;
                const collapseToggle = shouldCollapse ? '<div class="collapse-toggle" onclick="toggleSingleMessage(this)" title="点击折叠/展开"></div>' : '';
                const contentClass = shouldCollapse ? 'collapsed-content' : '';

                if (shouldCollapse) {
                    promptDiv.classList.add('collapsible');
                }

                promptDiv.innerHTML = \`
                    <div class="message-header">
                        <span class="message-type">INPUT REQUEST</span>
                        <span class="message-time">\${new Date().toLocaleTimeString()}</span>
                        \${collapseToggle}
                    </div>
                    <div class="message-content \${contentClass}">\${escapeHtml(prompt || '智能体请求输入:')}</div>
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

            // 添加data-type属性以支持特殊样式
            if (msg.type) {
                messageDiv.setAttribute('data-type', msg.type);
            }

            // 为分组消息添加唯一ID
            if (msg.type === 'process_group' && msg.id) {
                messageDiv.setAttribute('data-group-id', msg.id);
            }

            let contentHtml = \`\`;

            if (msg.type === 'process_group') {
                // 处理分组消息
                contentHtml = createProcessGroupHtml(msg);
            } else {
                // 处理普通消息
                // 智能格式化消息头显示，简化过长的source信息
                let typeDisplay = msg.type;
                if (msg.source && msg.source !== 'process_group') {
                    // 简化source显示：如果包含点号，取最后部分；否则直接使用
                    const shortSource = msg.source.includes('.')
                        ? msg.source.split('.').pop()
                        : msg.source;
                    typeDisplay = shortSource + ' - ' + msg.type;
                }

                // 判断是否需要为单条消息添加折叠功能
                const shouldCollapse = msg.content && msg.content.length > 200;
                const collapsibleClass = shouldCollapse ? 'collapsible' : '';
                const collapseToggle = shouldCollapse ? '<div class="collapse-toggle" onclick="toggleSingleMessage(this)" title="点击折叠/展开"></div>' : '';
                const contentClass = shouldCollapse ? 'collapsed-content' : '';

                contentHtml = \`
                    <div class="message-header">
                        <span class="message-type">\${typeDisplay}</span>
                        <span class="message-time">\${msg.timestamp}</span>
                        \${collapseToggle}
                    </div>
                    <div class="message-content \${contentClass}">\${escapeHtml(msg.content)}</div>
                \`;

                // 添加折叠类到消息容器
                if (shouldCollapse) {
                    messageDiv.classList.add('collapsible');
                }
            }

            messageDiv.innerHTML = contentHtml;

            // 如果是分组消息，添加展开/折叠事件
            if (msg.type === 'process_group') {
                setupProcessGroupEvents(messageDiv);
            }

            messagesContainer.appendChild(messageDiv);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        function createProcessGroupHtml(groupMsg) {
            // 预览内容已经在后端处理过，直接使用
            // 新创建的分组默认不展开，让用户自己决定是否展开
            return \`
                <div class="process-group-header" onclick="toggleProcessGroup(this)">
                    <div class="process-group-title">
                        <span>任务进展消息</span>
                        <span class="process-group-count">\${groupMsg.count}条</span>
                        <span class="process-group-time">\${groupMsg.timestamp}</span>
                    </div>
                    <div class="process-group-toggle">▼</div>
                </div>
                <div class="process-group-content">
                    \${groupMsg.messages.map(msg => \`
                        <div class="process-group-message">
                            <div class="message-header">
                                <span class="message-type">\${msg.type}</span>
                                <span class="message-time">\${msg.timestamp}</span>
                            </div>
                            <div class="message-content">\${escapeHtml(msg.content)}</div>
                        </div>
                    \`).join('')}
                </div>
                <div class="process-group-preview">预览: \${escapeHtml(groupMsg.content)}</div>
            \`;
        }

        function toggleProcessGroup(header) {
            const content = header.nextElementSibling;
            const toggle = header.querySelector('.process-group-toggle');

            if (content && content.classList.contains('process-group-content')) {
                const isExpanded = content.classList.contains('expanded');

                // 切换展开/折叠状态
                content.classList.toggle('expanded');
                toggle.classList.toggle('expanded');

                // 记录用户的选择状态 - 可以用于后续的状态恢复
                const groupElement = header.closest('[data-type="process_group"]');
                if (groupElement) {
                    const isNowExpanded = content.classList.contains('expanded');
                    console.log('Process group toggled:', { wasExpanded: isExpanded, isNowExpanded: isNowExpanded });
                    // 这里可以添加状态持久化逻辑，如果需要的话
                }
            }
        }

        function toggleSingleMessage(toggleElement) {
            const messageDiv = toggleElement.closest('.message');
            const content = messageDiv.querySelector('.message-content');
            const isCollapsed = messageDiv.classList.contains('collapsed');

            // 切换折叠状态
            messageDiv.classList.toggle('collapsed');

            // 调试输出
            if (isDebugMode) {
                console.log('Single message toggled:', { wasCollapsed: isCollapsed, isNowCollapsed: !isCollapsed });
            }
        }

        function setupProcessGroupEvents(messageDiv) {
            // 事件已经通过onclick处理，这里可以添加其他需要的处理逻辑
            console.log('Process group message created');
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
            console.log('[updateTaskState] Received state update:', state, 'current taskState:', taskState);
            taskState = state;
            console.log('[updateTaskState] Task state updated to:', taskState);

            // 使用统一的控制面板更新函数
            updateControlPanelState();

            // 根据特定状态执行额外操作
            switch (state) {
                case 'idle':
                case 'completed':
                case 'error':
                    console.log('[updateTaskState] Hiding input request for state:', state);
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

        // 分组状态跟踪 - 保持用户的折叠状态
        let processGroupStates = new Map(); // 存储 runId -> 折叠状态

        function updateProcessGroup(groupMsg, isComplete) {
            // 如果消息容器还没准备好，等待页面加载完成
            if (!messagesContainer) {
                console.log('Messages container not ready for process group update...');
                return;
            }

            // 查找现有的分组消息或创建新的
            let existingGroup = null;

            // 如果分组消息有ID，查找特定ID的分组
            if (groupMsg.id) {
                existingGroup = messagesContainer.querySelector('[data-group-id="' + groupMsg.id + '"]');
            }

            // 如果没有找到特定ID的分组，回退到查找第一个分组（向后兼容）
            if (!existingGroup) {
                existingGroup = messagesContainer.querySelector('[data-type="process_group"]');
            }

            if (existingGroup) {
                // 更新现有分组
                updateExistingProcessGroup(existingGroup, groupMsg, isComplete);
            } else {
                // 创建新的分组消息
                addMessage(groupMsg);
            }
        }

        function updateExistingProcessGroup(groupElement, groupMsg, isComplete) {
            // 获取内容区域和切换按钮
            const contentElement = groupElement.querySelector('.process-group-content');
            const toggle = groupElement.querySelector('.process-group-toggle');

            // 在更新前保存当前的展开/折叠状态
            const wasExpanded = contentElement && contentElement.classList.contains('expanded');

            // 更新分组标题
            const titleElement = groupElement.querySelector('.process-group-title span:first-child');
            if (titleElement) {
                titleElement.textContent = isComplete ? '任务进展消息' : '任务进展进行中...';
            }

            // 更新消息数量
            const countElement = groupElement.querySelector('.process-group-count');
            if (countElement) {
                countElement.textContent = groupMsg.count + '条';
            }

            // 更新时间戳
            const timeElement = groupElement.querySelector('.process-group-time');
            if (timeElement) {
                timeElement.textContent = groupMsg.timestamp;
            }

            // 更新内容区域
            if (contentElement) {
                var messagesHtml = '';
                groupMsg.messages.forEach(function(msg) {
                    messagesHtml += '<div class="process-group-message">' +
                        '<div class="message-header">' +
                        '<span class="message-type">' + escapeHtml(msg.type) + '</span>' +
                        '<span class="message-time">' + escapeHtml(msg.timestamp) + '</span>' +
                        '</div>' +
                        '<div class="message-content">' + escapeHtml(msg.content) + '</div>' +
                        '</div>';
                });
                contentElement.innerHTML = messagesHtml;

                // 智能状态管理：
                // 1. 如果是进行中的分组，且之前是展开的，保持展开
                // 2. 如果是进行中的分组，且之前是折叠的，保持折叠
                // 3. 如果是完成的分组，保持当前状态不变
                if (!isComplete && wasExpanded) {
                    // 进行中的分组，之前是展开的，保持展开
                    contentElement.classList.add('expanded');
                    if (toggle) {
                        toggle.classList.add('expanded');
                    }
                } else if (!isComplete && !wasExpanded) {
                    // 进行中的分组，之前是折叠的，保持折叠
                    contentElement.classList.remove('expanded');
                    if (toggle) {
                        toggle.classList.remove('expanded');
                    }
                }
                // 如果是完成的分组，不改变状态，保持用户之前的选择
            }

            // 更新预览（预览内容已经在后端处理过，直接使用）
            const previewElement = groupElement.querySelector('.process-group-preview');
            if (previewElement) {
                previewElement.textContent = '预览: ' + groupMsg.content;
            }
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
                case 'updateProcessGroup':
                    updateProcessGroup(data.group, data.isComplete);
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
