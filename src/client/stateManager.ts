/**
 * 统一状态管理器 - 解决状态不一致问题
 */

// 连接状态：纯粹的WebSocket连接状态
export type ConnectionState = 'connecting' | 'connected' | 'error' | 'closed';

// 任务状态
export type TaskState = 'idle' | 'starting' | 'running' | 'awaiting_input' | 'stopping' | 'completed' | 'error';

// 综合状态
export interface AppState {
    connection: ConnectionState;
    task: TaskState;
    runId: string | null;
    lastError: string | null;
    lastMessage: any | null;
}

export class StateManager {
    private _state: AppState = {
        connection: 'closed',
        task: 'idle',
        runId: null,
        lastError: null,
        lastMessage: null
    };

    private _listeners = new Set<(state: AppState) => void>();
    private _connectionListeners = new Set<(state: ConnectionState) => void>();
    private _taskListeners = new Set<(state: TaskState) => void>();

    // 状态锁机制，防止并发更新
    private _updatingConnection = false;
    private _updatingTask = false;
    private _pendingConnectionUpdate: { state: ConnectionState; error?: string } | null = null;
    private _pendingTaskUpdate: { state: TaskState; error?: string } | null = null;

    // 停止状态超时处理
    private _stopTimeout: NodeJS.Timeout | null = null;
    private readonly STOP_TIMEOUT_MS = 5000; // 5秒超时

    /**
     * 获取当前状态
     */
    get state(): AppState {
        return { ...this._state };
    }

    /**
     * 获取连接状态
     */
    get connectionState(): ConnectionState {
        return this._state.connection;
    }

    /**
     * 获取任务状态
     */
    get taskState(): TaskState {
        return this._state.task;
    }

    /**
     * 是否已连接
     */
    get isConnected(): boolean {
        return this._state.connection === 'connected';
    }

    /**
     * 是否有任务运行中
     */
    get isTaskRunning(): boolean {
        return ['starting', 'running', 'awaiting_input'].includes(this._state.task);
    }

    /**
     * 是否可以启动新任务
     */
    get canStartTask(): boolean {
        return this.isConnected && ['idle', 'completed', 'error'].includes(this._state.task);
    }

    /**
     * 是否可以停止任务
     */
    get canStopTask(): boolean {
        return this.isTaskRunning;
    }

    /**
     * 监听状态变化
     */
    onChange(callback: (state: AppState) => void): () => void {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    /**
     * 监听连接状态变化
     */
    onConnectionChange(callback: (state: ConnectionState) => void): () => void {
        this._connectionListeners.add(callback);
        return () => this._connectionListeners.delete(callback);
    }

    /**
     * 监听任务状态变化
     */
    onTaskChange(callback: (state: TaskState) => void): () => void {
        this._taskListeners.add(callback);
        return () => this._taskListeners.delete(callback);
    }

    /**
     * 更新连接状态（优化版本，减少延迟）
     */
    updateConnectionState(newState: ConnectionState, error?: string): void {
        // 避免重复状态更新
        if (this._state.connection === newState && !error) {
            return;
        }

        // 如果正在更新，保存为待处理更新（但简化处理）
        if (this._updatingConnection) {
            this._pendingConnectionUpdate = { state: newState, error };
            // 使用微任务确保下一个事件循环处理
            Promise.resolve().then(() => {
                if (this._pendingConnectionUpdate) {
                    const pending = this._pendingConnectionUpdate;
                    this._pendingConnectionUpdate = null;
                    if (pending.state !== this._state.connection || pending.error) {
                        this._performConnectionStateUpdate(pending.state, pending.error);
                    }
                }
            });
            return;
        }

        this._performConnectionStateUpdate(newState, error);
    }

    /**
     * 执行连接状态更新
     */
    private _performConnectionStateUpdate(newState: ConnectionState, error?: string): void {
        this._updatingConnection = true;

        const oldState = this._state.connection;
        this._state.connection = newState;

        if (error) {
            this._state.lastError = error;
        }

        this._notifyListeners();
        this._connectionListeners.forEach(cb => cb(newState));

        console.log(`[StateManager] Connection state changed: ${oldState} → ${newState}`);

        // 连接状态变化可能影响任务状态
        this.syncConnectionWithTaskState(oldState, newState);

        this._updatingConnection = false;

        // 处理待处理的更新
        if (this._pendingConnectionUpdate) {
            const pending = this._pendingConnectionUpdate;
            this._pendingConnectionUpdate = null;

            // 只有当待处理的状态与当前不同时才执行
            if (pending.state !== this._state.connection || pending.error) {
                this.updateConnectionState(pending.state, pending.error);
            }
        }
    }

    /**
     * 更新任务状态（优化版本，减少延迟）
     */
    updateTaskState(newState: TaskState, error?: string): void {
        // 避免重复状态更新
        if (this._state.task === newState && !error) {
            return;
        }

        // 如果正在更新，保存为待处理更新（但简化处理）
        if (this._updatingTask) {
            this._pendingTaskUpdate = { state: newState, error };
            // 使用微任务确保下一个事件循环处理
            Promise.resolve().then(() => {
                if (this._pendingTaskUpdate) {
                    const pending = this._pendingTaskUpdate;
                    this._pendingTaskUpdate = null;
                    if (pending.state !== this._state.task || pending.error) {
                        this._performTaskStateUpdate(pending.state, pending.error);
                    }
                }
            });
            return;
        }

        this._performTaskStateUpdate(newState, error);
    }

    /**
     * 执行任务状态更新
     */
    private _performTaskStateUpdate(newState: TaskState, error?: string): void {
        this._updatingTask = true;

        const oldState = this._state.task;
        this._state.task = newState;

        if (error) {
            this._state.lastError = error;
        }

        // 处理停止状态超时
        this._handleStopTimeout(oldState, newState);

        this._notifyListeners();
        this._taskListeners.forEach(cb => cb(newState));

        console.log(`[StateManager] Task state changed: ${oldState} → ${newState}`);

        this._updatingTask = false;

        // 处理待处理的更新
        if (this._pendingTaskUpdate) {
            const pending = this._pendingTaskUpdate;
            this._pendingTaskUpdate = null;

            // 只有当待处理的状态与当前不同时才执行
            if (pending.state !== this._state.task || pending.error) {
                this.updateTaskState(pending.state, pending.error);
            }
        }
    }

    /**
     * 设置运行ID
     */
    setRunId(runId: string | null): void {
        if (this._state.runId !== runId) {
            this._state.runId = runId;
            this._notifyListeners();
            console.log(`Run ID set to: ${runId}`);
        }
    }

    /**
     * 设置最后一条消息
     */
    setLastMessage(message: any): void {
        this._state.lastMessage = message;
        this._notifyListeners();
    }

    /**
     * 根据后端消息智能推断状态（优化版本，减少不必要的状态变化）
     */
    inferStateFromMessage(message: any): void {
        const messageType = message.type;
        let connectionState: ConnectionState | null = null;
        let taskState: TaskState | null = null;

        // 首先设置最后消息
        this.setLastMessage(message);

        switch (messageType) {
            case 'system':
                const systemStatus = message.status;
                if (systemStatus === 'connected') {
                    connectionState = 'connected';
                }
                break;

            case 'message':
                // 收到消息表示连接正常，如果有需要可以设置任务状态
                if (this._state.task === 'idle' && this._state.connection === 'connected') {
                    taskState = 'running';
                }
                break;

            case 'result':
                const resultData = message.data;
                const resultStatus = resultData?.status;

                if (resultStatus === 'complete') {
                    taskState = 'completed';
                } else if (this._state.task === 'stopping') {
                    // 任务被停止后收到结果，转换为 idle 状态
                    taskState = 'idle';
                }
                break;

            case 'completion':
                const completionStatus = message.status;

                if (completionStatus === 'cancelled' || completionStatus === 'completed') {
                    // 任务被取消或完成，设置为相应状态
                    if (completionStatus === 'cancelled') {
                        // 取消的任务转换为 idle，允许重新启动
                        taskState = 'idle';
                    } else if (completionStatus === 'completed') {
                        taskState = 'completed';
                    }
                }
                break;

            case 'input_request':
                taskState = 'awaiting_input';
                break;

            case 'stop':
                // 停止任务消息，将任务状态从 stopping 或其他状态设置为 idle
                if (this._state.task === 'stopping' || this._state.task === 'running' || this._state.task === 'starting' || this._state.task === 'completed') {
                    taskState = 'idle';
                }
                break;

            case 'error':
                taskState = 'error';
                break;

            case 'pong':
                // pong消息不影响状态，仅用于心跳
                return;

            default:
                // 未知消息类型不处理状态
                return;
        }

        // 批量更新状态，避免多次触发事件
        if (connectionState || taskState) {
            this.batchUpdateStates(connectionState, taskState);
        }
    }

    /**
     * 批量更新状态，减少事件触发次数
     */
    private batchUpdateStates(connectionState: ConnectionState | null, taskState: TaskState | null): void {
        let hasChanges = false;

        if (connectionState && connectionState !== this._state.connection) {
            this._state.connection = connectionState;
            hasChanges = true;
        }

        if (taskState && taskState !== this._state.task) {
            this._state.task = taskState;
            hasChanges = true;
        }

        if (hasChanges) {
            this._notifyListeners();

            if (connectionState) {
                this._connectionListeners.forEach(cb => cb(connectionState));
            }

            if (taskState) {
                this._taskListeners.forEach(cb => cb(taskState));
            }

            console.log(`Batch state update - Connection: ${this._state.connection}, Task: ${this._state.task}`);
        }
    }

    /**
     * 同步连接状态对任务状态的影响
     * 注意：只处理连接状态变化对任务状态的影响，任务状态变化不影响连接状态
     */
    private syncConnectionWithTaskState(oldConnectionState: ConnectionState, newConnectionState: ConnectionState): void {
        // 连接中断时，任务状态应该回到 idle
        if (newConnectionState === 'closed' || newConnectionState === 'error') {
            if (this._state.task !== 'idle') {
                console.log(`[StateManager] Connection ${newConnectionState}, resetting task state to idle`);
                this._state.task = 'idle';
                this._taskListeners.forEach(cb => cb('idle'));
            }
        }
    }

  /**
     * 处理停止状态超时
     */
    private _handleStopTimeout(oldState: TaskState, newState: TaskState): void {
        // 如果进入 stopping 状态，设置超时
        if (newState === 'stopping') {
            // 清除之前的超时
            if (this._stopTimeout) {
                clearTimeout(this._stopTimeout);
            }

            // 设置新的超时
            this._stopTimeout = setTimeout(() => {
                console.log('[StateManager] Stop timeout reached, forcing idle state');
                if (this._state.task === 'stopping') {
                    // 强制转换到 idle 状态
                    this.updateTaskState('idle', '停止操作超时，自动恢复');
                }
            }, this.STOP_TIMEOUT_MS);
        }
        // 如果离开 stopping 状态，清除超时
        else if (oldState === 'stopping') {
            if (this._stopTimeout) {
                clearTimeout(this._stopTimeout);
                this._stopTimeout = null;
            }
        }
    }

    /**
     * 重置状态
     */
    reset(): void {
        // 清理停止状态超时
        if (this._stopTimeout) {
            clearTimeout(this._stopTimeout);
            this._stopTimeout = null;
        }

        this._state = {
            connection: 'closed',
            task: 'idle',
            runId: null,
            lastError: null,
            lastMessage: null
        };
        this._notifyListeners();
    }

    /**
     * 通知所有监听器
     */
    private _notifyListeners(): void {
        this._listeners.forEach(cb => cb({ ...this._state }));
    }

    /**
     * 获取状态摘要（用于调试）
     */
    getStateSummary(): any {
        return {
            connection: this._state.connection,
            task: this._state.task,
            runId: this._state.runId,
            isConnected: this.isConnected,
            isTaskRunning: this.isTaskRunning,
            canStartTask: this.canStartTask,
            canStopTask: this.canStopTask,
            lastError: this._state.lastError
        };
    }
}