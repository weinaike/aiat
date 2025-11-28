import * as vscode from 'vscode';
import { AgentClient } from '../client';
import { logger } from '../utils/logger';

/**
 * 历史消息条目
 */
export interface HistoryItem {
    runId: string;
    title?: string;
    agentName?: string;
    taskDescription?: string;
    firstMessageTime?: number;
    firstMessageTimeStr?: string;
    messageCount: number;
    lastUpdated: number;
    lastUpdatedStr: string;
}

/**
 * 历史消息管理视图 - TreeDataProvider
 */
export class HistoryViewProvider implements vscode.TreeDataProvider<HistoryItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<HistoryItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _historyItems: HistoryItem[] = [];

    constructor(
        _extensionUri: vscode.Uri,
        private _agentClient: AgentClient
    ) {
        // 监听消息变化，更新历史列表
        this._agentClient.onMessage(() => {
            this.refresh();
        });

        // 定期刷新历史列表
        this.startAutoRefresh();
    }

    /**
     * 刷新历史列表
     */
    async refresh(): Promise<void> {
        try {
            const historyList = await this._agentClient.messageStorage.getHistoryList();

            this._historyItems = historyList
                .filter(item => item.messageCount > 2)  // 过滤掉消息条数<=2的记录
                .map(item => ({
                    runId: item.runId,
                    title: item.title,
                    agentName: item.agentName,
                    taskDescription: item.taskDescription,
                    firstMessageTime: item.firstMessageTime,
                    firstMessageTimeStr: item.firstMessageTime ? this.formatDate(item.firstMessageTime) : undefined,
                    messageCount: item.messageCount,
                    lastUpdated: item.lastUpdated,
                    lastUpdatedStr: this.formatDate(item.lastUpdated)
                }));

            this._onDidChangeTreeData.fire();
        } catch (error) {
            logger.error('Failed to refresh history', error);
        }
    }

    /**
     * TreeDataProvider 实现
     */
    getTreeItem(element: HistoryItem): vscode.TreeItem {
        // 构建更具可读性的标签
        let label = element.title || '智能体任务';
        if (element.agentName) {
            label = `${element.agentName}: ${label}`;
        }

        const treeItem = new vscode.TreeItem(
            label,
            vscode.TreeItemCollapsibleState.None
        );

        // 根据智能体状态设置图标
        if (element.agentName) {
            treeItem.iconPath = new vscode.ThemeIcon('account');
        } else {
            treeItem.iconPath = new vscode.ThemeIcon('history');
        }

        // 设置描述：显示消息数量和时间范围
        let description = `${element.messageCount} 条消息`;
        if (element.firstMessageTimeStr && element.firstMessageTimeStr !== element.lastUpdatedStr) {
            description += ` • ${element.firstMessageTimeStr} - ${element.lastUpdatedStr}`;
        } else {
            description += ` • ${element.lastUpdatedStr}`;
        }
        treeItem.description = description;

        // 构建详细的工具提示
        let tooltip = `**任务**: ${element.title || '智能体任务'}\n`;
        if (element.agentName) {
            tooltip += `**智能体**: ${element.agentName}\n`;
        }
        if (element.taskDescription) {
            tooltip += `**描述**: ${element.taskDescription}\n`;
        }
        tooltip += `**消息数量**: ${element.messageCount}\n`;
        tooltip += `**开始时间**: ${element.firstMessageTimeStr || element.lastUpdatedStr}\n`;
        tooltip += `**最后更新**: ${element.lastUpdatedStr}\n`;
        tooltip += `**Run ID**: \`${element.runId}\``;

        treeItem.tooltip = tooltip;

        // 设置上下文菜单
        treeItem.contextValue = 'historyItem';

        // 设置命令：点击时切换到该run的消息
        treeItem.command = {
            command: 'aiat.switchToRun',
            title: '显示消息',
            arguments: [element.runId]
        };

        return treeItem;
    }

    getChildren(element?: HistoryItem): Thenable<HistoryItem[]> {
        if (!element) {
            // 返回根级项目（所有历史记录）
            return Promise.resolve(this._historyItems);
        }
        return Promise.resolve([]);
    }

    /**
     * 删除指定run的历史记录
     */
    async deleteHistory(runId: string): Promise<void> {
        try {
            await this._agentClient.messageStorage.deleteRunHistory(runId);
            await this.refresh();
            vscode.window.showInformationMessage(`已删除 Run ${runId} 的历史记录`);
        } catch (error) {
            logger.error('Failed to delete history', error);
            vscode.window.showErrorMessage(`删除历史记录失败: ${error}`);
        }
    }

    /**
     * 清空所有历史记录
     */
    async clearAllHistory(): Promise<void> {
        const result = await vscode.window.showWarningMessage(
            '确定要清空所有历史记录吗？此操作不可撤销。',
            { modal: true },
            '确定'
        );

        if (result === '确定') {
            try {
                await this._agentClient.messageStorage.clearAllHistory();
                await this.refresh();
                vscode.window.showInformationMessage('已清空所有历史记录');
            } catch (error) {
                logger.error('Failed to clear history', error);
                vscode.window.showErrorMessage(`清空历史记录失败: ${error}`);
            }
        }
    }

    /**
     * 显示存储统计信息
     */
    async showStorageStats(): Promise<void> {
        try {
            const stats = await this._agentClient.messageStorage.getStorageStats();

            const message = `
历史消息存储统计:
• 总Run数: ${stats.totalRuns}
• 总消息数: ${stats.totalMessages}
${stats.oldestRun ? `• 最早Run: ${new Date(stats.oldestRun).toLocaleString()}` : ''}
${stats.newestRun ? `• 最新Run: ${new Date(stats.newestRun).toLocaleString()}` : ''}
            `.trim();

            vscode.window.showInformationMessage(message, '确定');
        } catch (error) {
            logger.error('Failed to get storage stats', error);
            vscode.window.showErrorMessage(`获取存储统计失败: ${error}`);
        }
    }

    /**
     * 格式化日期
     */
    private formatDate(timestamp: number): string {
        const date = new Date(timestamp);
        const now = new Date();

        // 如果是今天
        if (date.toDateString() === now.toDateString()) {
            return date.toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit'
            });
        }

        // 如果是昨天
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (date.toDateString() === yesterday.toDateString()) {
            return '昨天 ' + date.toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit'
            });
        }

        // 其他日期
        return date.toLocaleDateString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    /**
     * 启动自动刷新
     */
    private startAutoRefresh(): void {
        // 立即刷新一次
        this.refresh();

        // 每30秒自动刷新一次
        setInterval(() => {
            this.refresh();
        }, 30000);
    }
}