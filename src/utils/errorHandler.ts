import * as vscode from 'vscode';

/**
 * 错误类型枚举
 */
export enum ErrorType {
    // 连接相关错误
    WEBSOCKET_CONNECTION_ERROR = 'WEBSOCKET_CONNECTION_ERROR',
    WEBSOCKET_TIMEOUT_ERROR = 'WEBSOCKET_TIMEOUT_ERROR',
    WEBSOCKET_AUTHENTICATION_ERROR = 'WEBSOCKET_AUTHENTICATION_ERROR',
    WEBSOCKET_SERVER_ERROR = 'WEBSOCKET_SERVER_ERROR',

    // 任务相关错误
    TASK_START_ERROR = 'TASK_START_ERROR',
    TASK_STOP_ERROR = 'TASK_STOP_ERROR',
    TASK_EXECUTION_ERROR = 'TASK_EXECUTION_ERROR',
    TASK_INPUT_ERROR = 'TASK_INPUT_ERROR',

    // MCP服务器相关错误
    MCP_SERVER_START_ERROR = 'MCP_SERVER_START_ERROR',
    MCP_SERVER_STOP_ERROR = 'MCP_SERVER_STOP_ERROR',
    MCP_PROTOCOL_ERROR = 'MCP_PROTOCOL_ERROR',
    MCP_TOOL_ERROR = 'MCP_TOOL_ERROR',

    // 系统相关错误
    CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
    NETWORK_ERROR = 'NETWORK_ERROR',
    UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

/**
 * 错误严重程度
 */
export enum ErrorSeverity {
    LOW = 'low',
    MEDIUM = 'medium',
    HIGH = 'high',
    CRITICAL = 'critical'
}

/**
 * 扩展错误接口
 */
export interface ExtendedError extends Error {
    type: ErrorType;
    severity: ErrorSeverity;
    retryable: boolean;
    context?: Record<string, any>;
    timestamp: number;
    userId?: string;
}

/**
 * 错误处理选项
 */
export interface ErrorHandlingOptions {
    maxRetries?: number;
    retryDelay?: number;
    enableLogging?: boolean;
    enableUserNotification?: boolean;
    customHandler?: (error: ExtendedError) => void;
}

/**
 * 重试配置
 */
export interface RetryConfig {
    maxAttempts: number;
    baseDelay: number;
    maxDelay: number;
    backoffFactor: number;
    retryableErrors: ErrorType[];
}

/**
 * 错误处理器类
 */
export class ErrorHandler {
    private static instance: ErrorHandler;
    private errorListeners = new Set<(error: ExtendedError) => void>();
    private retryConfigs = new Map<ErrorType, RetryConfig>();
    private retryAttempts = new Map<string, number>();

    private constructor() {
        this.initializeRetryConfigs();
    }

    /**
     * 获取单例实例
     */
    static getInstance(): ErrorHandler {
        if (!ErrorHandler.instance) {
            ErrorHandler.instance = new ErrorHandler();
        }
        return ErrorHandler.instance;
    }

    /**
     * 初始化重试配置
     */
    private initializeRetryConfigs(): void {
        // 网络相关错误的重试配置
        const networkRetryConfig: RetryConfig = {
            maxAttempts: 3,
            baseDelay: 1000,
            maxDelay: 10000,
            backoffFactor: 2,
            retryableErrors: [
                ErrorType.WEBSOCKET_CONNECTION_ERROR,
                ErrorType.WEBSOCKET_TIMEOUT_ERROR,
                ErrorType.NETWORK_ERROR
            ]
        };

        // 任务相关错误的重试配置
        const taskRetryConfig: RetryConfig = {
            maxAttempts: 2,
            baseDelay: 500,
            maxDelay: 5000,
            backoffFactor: 1.5,
            retryableErrors: [
                ErrorType.TASK_START_ERROR,
                ErrorType.TASK_STOP_ERROR
            ]
        };

        // MCP服务器错误的重试配置
        const mcpRetryConfig: RetryConfig = {
            maxAttempts: 3,
            baseDelay: 2000,
            maxDelay: 15000,
            backoffFactor: 2,
            retryableErrors: [
                ErrorType.MCP_SERVER_START_ERROR,
                ErrorType.MCP_TOOL_ERROR
            ]
        };

        this.retryConfigs.set(ErrorType.WEBSOCKET_CONNECTION_ERROR, networkRetryConfig);
        this.retryConfigs.set(ErrorType.WEBSOCKET_TIMEOUT_ERROR, networkRetryConfig);
        this.retryConfigs.set(ErrorType.NETWORK_ERROR, networkRetryConfig);

        this.retryConfigs.set(ErrorType.TASK_START_ERROR, taskRetryConfig);
        this.retryConfigs.set(ErrorType.TASK_STOP_ERROR, taskRetryConfig);

        this.retryConfigs.set(ErrorType.MCP_SERVER_START_ERROR, mcpRetryConfig);
        this.retryConfigs.set(ErrorType.MCP_TOOL_ERROR, mcpRetryConfig);
    }

    /**
     * 创建扩展错误对象
     */
    createError(
        message: string,
        type: ErrorType = ErrorType.UNKNOWN_ERROR,
        severity: ErrorSeverity = ErrorSeverity.MEDIUM,
        retryable: boolean = false,
        context?: Record<string, any>
    ): ExtendedError {
        const error = new Error(message) as ExtendedError;
        error.type = type;
        error.severity = severity;
        error.retryable = retryable;
        error.context = context;
        error.timestamp = Date.now();
        error.userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

        return error;
    }

    /**
     * 包装现有错误
     */
    wrapError(
        originalError: Error | string,
        type: ErrorType = ErrorType.UNKNOWN_ERROR,
        severity: ErrorSeverity = ErrorSeverity.MEDIUM,
        retryable: boolean = false,
        context?: Record<string, any>
    ): ExtendedError {
        const message = originalError instanceof Error ? originalError.message : originalError;
        const error = this.createError(message, type, severity, retryable, context);

        if (originalError instanceof Error) {
            error.stack = originalError.stack;
        }

        return error;
    }

    /**
     * 处理错误
     */
    handleError(error: ExtendedError, options: ErrorHandlingOptions = {}): void {
        const {
            enableLogging = true,
            enableUserNotification = true,
            customHandler
        } = options;

        // 记录错误
        if (enableLogging) {
            this.logError(error);
        }

        // 通知监听器
        this.errorListeners.forEach(listener => {
            try {
                listener(error);
            } catch (listenerError) {
                console.error('Error in error listener:', listenerError);
            }
        });

        // 用户通知
        if (enableUserNotification) {
            this.notifyUser(error);
        }

        // 自定义处理
        if (customHandler) {
            try {
                customHandler(error);
            } catch (customError) {
                console.error('Error in custom handler:', customError);
            }
        }
    }

    /**
     * 执行带重试的操作
     */
    async executeWithRetry<T>(
        operation: () => Promise<T>,
        errorType: ErrorType,
        context?: Record<string, any>,
        options: ErrorHandlingOptions & { customRetryConfig?: RetryConfig } = {}
    ): Promise<T> {
        const config = options.customRetryConfig || this.retryConfigs.get(errorType);
        const maxAttempts = config?.maxAttempts || 1;

        let lastError: ExtendedError | null = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const result = await operation();
                // 成功时重置重试计数
                const errorKey = this.getErrorKey(errorType, context);
                this.retryAttempts.delete(errorKey);
                return result;
            } catch (error) {
                lastError = this.wrapError(
                    error instanceof Error ? error : new Error(String(error)),
                    errorType,
                    ErrorSeverity.MEDIUM,
                    true,
                    context
                );

                if (attempt < maxAttempts && lastError.retryable) {
                    const delay = this.calculateRetryDelay(attempt, config);
                    await this.delay(delay);
                } else {
                    // 最后一次尝试失败，处理错误
                    this.handleError(lastError, options);
                    throw lastError;
                }
            }
        }

        throw lastError || this.createError('Max retry attempts exceeded', errorType);
    }

    /**
     * 获取错误的重试延迟
     */
    private calculateRetryDelay(attempt: number, config?: RetryConfig): number {
        if (!config) {
            return 1000;
        }

        const delay = config.baseDelay * Math.pow(config.backoffFactor, attempt - 1);
        return Math.min(delay, config.maxDelay);
    }

    /**
     * 生成错误键
     */
    private getErrorKey(errorType: ErrorType, context?: Record<string, any>): string {
        const contextStr = context ? JSON.stringify(context) : '';
        return `${errorType}_${contextStr}`;
    }

    /**
     * 延迟函数
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 记录错误日志
     */
    private logError(error: ExtendedError): void {
        const logEntry = {
            timestamp: new Date(error.timestamp).toISOString(),
            type: error.type,
            severity: error.severity,
            message: error.message,
            retryable: error.retryable,
            context: error.context,
            userId: error.userId,
            stack: error.stack
        };

        console.error('[ErrorHandler]', JSON.stringify(logEntry, null, 2));
    }

    /**
     * 通知用户
     */
    private notifyUser(error: ExtendedError): void {
        // 根据严重程度和类型决定通知方式
        const notificationMessage = this.formatUserMessage(error);
        const suggestions = this.getErrorSuggestions(error);

        // 同时显示控制台消息和VS Code通知
        switch (error.severity) {
            case ErrorSeverity.LOW:
                // 低严重性错误使用信息提示
                console.info(notificationMessage);
                if (suggestions.length > 0) {
                    vscode.window.showInformationMessage(notificationMessage, ...suggestions);
                } else {
                    vscode.window.showInformationMessage(notificationMessage);
                }
                break;

            case ErrorSeverity.MEDIUM:
                // 中等严重性错误使用警告提示
                console.warn(notificationMessage);
                if (suggestions.length > 0) {
                    vscode.window.showWarningMessage(notificationMessage, ...suggestions);
                } else {
                    vscode.window.showWarningMessage(notificationMessage);
                }
                break;

            case ErrorSeverity.HIGH:
            case ErrorSeverity.CRITICAL:
                // 高严重性错误使用错误提示
                console.error(notificationMessage);
                if (suggestions.length > 0) {
                    vscode.window.showErrorMessage(notificationMessage, ...suggestions);
                } else {
                    vscode.window.showErrorMessage(notificationMessage);
                }
                break;
        }
    }

    /**
     * 格式化用户消息
     */
    private formatUserMessage(error: ExtendedError): string {
        const baseMessage = `[${error.severity.toUpperCase()}] ${error.message}`;

        if (error.retryable) {
            return `${baseMessage} (系统将自动重试)`;
        }

        const suggestions = this.getErrorSuggestions(error);
        if (suggestions.length > 0) {
            return `${baseMessage}\n建议: ${suggestions.join(', ')}`;
        }

        return baseMessage;
    }

    /**
     * 获取错误建议
     */
    private getErrorSuggestions(error: ExtendedError): string[] {
        const suggestions: string[] = [];

        switch (error.type) {
            case ErrorType.WEBSOCKET_CONNECTION_ERROR:
                suggestions.push('检查网络连接', '确认服务器地址正确', '稍后重试');
                break;

            case ErrorType.WEBSOCKET_AUTHENTICATION_ERROR:
                suggestions.push('检查认证令牌', '联系管理员');
                break;

            case ErrorType.TASK_START_ERROR:
                suggestions.push('检查任务参数', '确认服务器状态正常');
                break;

            case ErrorType.MCP_SERVER_START_ERROR:
                suggestions.push('检查端口是否被占用', '确认权限设置');
                break;

            case ErrorType.CONFIGURATION_ERROR:
                suggestions.push('检查配置文件', '重置为默认配置');
                break;

            case ErrorType.NETWORK_ERROR:
                suggestions.push('检查网络连接', '稍后重试');
                break;
        }

        return suggestions;
    }

    /**
     * 添加错误监听器
     */
    addErrorListener(listener: (error: ExtendedError) => void): () => void {
        this.errorListeners.add(listener);
        return () => this.errorListeners.delete(listener);
    }

    /**
     * 获取错误统计
     */
    getErrorStats(): Record<string, any> {
        return {
            totalListeners: this.errorListeners.size,
            activeRetryAttempts: this.retryAttempts.size,
            configuredRetryTypes: Array.from(this.retryConfigs.keys())
        };
    }
}

/**
 * 全局错误处理器实例
 */
export const errorHandler = ErrorHandler.getInstance();