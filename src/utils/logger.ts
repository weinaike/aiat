import * as vscode from 'vscode';

/**
 * 日志管理工具类
 * 提供统一的日志输出接口，支持配置控制不同类型的日志输出
 */
export class Logger {
    private static instance: Logger;
    private outputChannel: vscode.OutputChannel;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('AIAT Debug');
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    /**
     * 获取配置值
     */
    private getConfig<T>(key: string, defaultValue: T): T {
        return vscode.workspace.getConfiguration('aiat').get<T>(key, defaultValue);
    }

  
    /**
     * 调试日志 - 用于开发调试信息
     */
    public debug(message: string, data?: any): void {
        if (this.getConfig('logging.enableDebugLogging', false)) {
            const timestamp = new Date().toISOString();
            const logMessage = data ? `${message} ${JSON.stringify(data, null, 2)}` : message;
            console.log(`[${timestamp}] [Debug] ${logMessage}`);
            this.outputChannel.appendLine(`[${timestamp}] [Debug] ${logMessage}`);
        }
    }

    /**
     * 信息日志 - 重要的信息，始终输出
     */
    public info(message: string, data?: any): void {
        const timestamp = new Date().toISOString();
        const logMessage = data ? `${message} ${JSON.stringify(data)}` : message;
        console.log(`[${timestamp}] [Info] ${logMessage}`);
        this.outputChannel.appendLine(`[${timestamp}] [Info] ${logMessage}`);
    }

    /**
     * 警告日志 - 始终输出
     */
    public warn(message: string, error?: Error | any): void {
        const timestamp = new Date().toISOString();
        if (error) {
            console.warn(`[${timestamp}] [Warn] ${message}`, error);
            this.outputChannel.appendLine(`[${timestamp}] [Warn] ${message} ${error instanceof Error ? error.stack : error}`);
        } else {
            console.warn(`[${timestamp}] [Warn] ${message}`);
            this.outputChannel.appendLine(`[${timestamp}] [Warn] ${message}`);
        }
    }

    /**
     * 错误日志 - 始终输出
     */
    public error(message: string, error?: Error | any): void {
        const timestamp = new Date().toISOString();
        if (error) {
            console.error(`[${timestamp}] [Error] ${message}`, error);
            this.outputChannel.appendLine(`[${timestamp}] [Error] ${message} ${error instanceof Error ? error.stack : error}`);
        } else {
            console.error(`[${timestamp}] [Error] ${message}`);
            this.outputChannel.appendLine(`[${timestamp}] [Error] ${message}`);
        }
    }

    /**
     * 状态变化日志 - 重要的状态变化
     */
    public stateChange(component: string, oldState: string, newState: string, extra?: any): void {
        const timestamp = new Date().toISOString();
        const extraInfo = extra ? ` ${JSON.stringify(extra)}` : '';
        console.log(`[${timestamp}] [State] ${component}: ${oldState} → ${newState}${extraInfo}`);
        this.outputChannel.appendLine(`[${timestamp}] [State] ${component}: ${oldState} → ${newState}${extraInfo}`);
    }

    /**
     * 显示日志输出面板
     */
    public showOutput(): void {
        this.outputChannel.show();
    }

    /**
     * 清空日志输出面板
     */
    public clearOutput(): void {
        this.outputChannel.clear();
    }

    /**
     * 销毁日志输出面板
     */
    public dispose(): void {
        this.outputChannel.dispose();
    }
}

// 导出单例实例
export const logger = Logger.getInstance();