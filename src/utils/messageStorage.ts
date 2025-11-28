/**
 * 基于run_id的消息持久化存储管理器
 * 使用VSCode的全局状态(Memento)来持久化消息历史
 */

import { AgentMessage } from '../client';

export interface StoredMessage extends AgentMessage {
    runId: string;
    groupId?: string;        // 分组ID
    groupPosition?: number;  // 在分组中的位置
    isGroupComplete?: boolean; // 分组是否完成
}

export interface ActiveGroup {
    id: string;
    startTime: number;
    messages: StoredMessage[];
    isComplete: boolean;
}

export interface MessageHistory {
    [runId: string]: {
        messages: StoredMessage[];
        lastUpdated: number;
        title?: string;
        agentName?: string;  // 智能体名称
        firstMessageTime?: number;  // 第一条消息时间
        taskDescription?: string;  // 任务描述
        activeGroup?: ActiveGroup;  // 当前活跃分组状态
    };
}

export class MessageStorage {
    private readonly STORAGE_KEY = 'aiat.messageHistory';
    private readonly MAX_HISTORY_PER_RUN = 1000; // 每个run最多保存1000条消息
    private readonly MAX_HISTORY_RUNS = 50; // 最多保存50个run的历史
    private readonly MAX_HISTORY_AGE = 7 * 24 * 60 * 60 * 1000; // 7天过期时间

    constructor(private globalState: { get: (key: string) => any; update: (key: string, value: any) => Thenable<void> }) {}

    /**
     * 保存消息到持久化存储
     */
    async saveMessage(runId: string, message: AgentMessage): Promise<void> {
        if (!runId) {
            return;
        }

        try {
            const history = await this.loadHistory();

            // 如果run不存在，创建新的条目
            if (!history[runId]) {
                history[runId] = {
                    messages: [],
                    lastUpdated: Date.now(),
                    firstMessageTime: message.timestamp
                };
            }

            // 首次保存时，提取可读性信息
            if (message.type === 'start') {
                this.extractReadableInfo(history[runId], message);
            }

            // 添加runId到消息中
            const storedMessage: StoredMessage = {
                ...message,
                runId
            };

            // 添加消息到对应run的历史记录
            history[runId].messages.push(storedMessage);
            history[runId].lastUpdated = Date.now();

            // 限制每个run的消息数量
            if (history[runId].messages.length > this.MAX_HISTORY_PER_RUN) {
                history[runId].messages = history[runId].messages.slice(-this.MAX_HISTORY_PER_RUN);
            }

            // 清理过期和过多的历史记录
            this.cleanupHistory(history);

            // 保存到全局状态
            await this.globalState.update(this.STORAGE_KEY, history);

            console.log(`[MessageStorage] Saved message for run ${runId}, total messages: ${history[runId].messages.length}`);
        } catch (error) {
            console.error('[MessageStorage] Failed to save message:', error);
        }
    }

    /**
     * 获取指定run的消息历史
     */
    async getMessagesForRun(runId: string): Promise<AgentMessage[]> {
        if (!runId) {
            return [];
        }

        try {
            const history = await this.loadHistory();
            const runHistory = history[runId];

            if (!runHistory) {
                return [];
            }

            // 移除runId字段，返回原始AgentMessage格式
            return runHistory.messages.map(({ runId: _, ...message }) => message);
        } catch (error) {
            console.error('[MessageStorage] Failed to load messages for run:', error);
            return [];
        }
    }

    /**
     * 获取所有历史run的基本信息
     */
    async getHistoryList(): Promise<Array<{
        runId: string;
        lastUpdated: number;
        title?: string;
        agentName?: string;
        firstMessageTime?: number;
        taskDescription?: string;
        messageCount: number
    }>> {
        try {
            const history = await this.loadHistory();

            return Object.entries(history).map(([runId, data]) => ({
                runId,
                lastUpdated: data.lastUpdated,
                title: data.title,
                agentName: data.agentName,
                firstMessageTime: data.firstMessageTime,
                taskDescription: data.taskDescription,
                messageCount: data.messages.length
            })).sort((a, b) => b.lastUpdated - a.lastUpdated);
        } catch (error) {
            console.error('[MessageStorage] Failed to load history list:', error);
            return [];
        }
    }

    /**
     * 设置run的标题
     */
    async setRunTitle(runId: string, title: string): Promise<void> {
        if (!runId) {
            return;
        }

        try {
            const history = await this.loadHistory();

            if (history[runId]) {
                history[runId].title = title;
                history[runId].lastUpdated = Date.now();
                await this.globalState.update(this.STORAGE_KEY, history);
            }
        } catch (error) {
            console.error('[MessageStorage] Failed to set run title:', error);
        }
    }

    /**
     * 删除指定run的历史记录
     */
    async deleteRunHistory(runId: string): Promise<void> {
        if (!runId) {
            return;
        }

        try {
            const history = await this.loadHistory();

            if (history[runId]) {
                delete history[runId];
                await this.globalState.update(this.STORAGE_KEY, history);
                console.log(`[MessageStorage] Deleted history for run ${runId}`);
            }
        } catch (error) {
            console.error('[MessageStorage] Failed to delete run history:', error);
        }
    }

    /**
     * 清理所有历史记录
     */
    async clearAllHistory(): Promise<void> {
        try {
            await this.globalState.update(this.STORAGE_KEY, {});
            console.log('[MessageStorage] Cleared all message history');
        } catch (error) {
            console.error('[MessageStorage] Failed to clear history:', error);
        }
    }

    /**
     * 从持久化存储加载历史记录
     */
    private async loadHistory(): Promise<MessageHistory> {
        try {
            const history = this.globalState.get(this.STORAGE_KEY) as MessageHistory;
            return history || {};
        } catch (error) {
            console.error('[MessageStorage] Failed to load history:', error);
            return {};
        }
    }

    /**
     * 清理过期和过多的历史记录
     */
    private cleanupHistory(history: MessageHistory): void {
        const now = Date.now();
        const entries = Object.entries(history);

        // 1. 删除过期的记录
        entries.forEach(([runId, data]) => {
            if (now - data.lastUpdated > this.MAX_HISTORY_AGE) {
                delete history[runId];
            }
        });

        // 2. 如果run数量超过限制，删除最旧的记录
        const currentEntries = Object.entries(history);
        if (currentEntries.length > this.MAX_HISTORY_RUNS) {
            const sortedEntries = currentEntries.sort(([, a], [, b]) => a.lastUpdated - b.lastUpdated);
            const toDelete = sortedEntries.slice(0, currentEntries.length - this.MAX_HISTORY_RUNS);

            toDelete.forEach(([runId]) => {
                delete history[runId];
            });
        }
    }

    /**
     * 获取存储统计信息
     */
    async getStorageStats(): Promise<{
        totalRuns: number;
        totalMessages: number;
        oldestRun: number | null;
        newestRun: number | null;
    }> {
        try {
            const history = await this.loadHistory();
            const runs = Object.values(history);

            if (runs.length === 0) {
                return {
                    totalRuns: 0,
                    totalMessages: 0,
                    oldestRun: null,
                    newestRun: null
                };
            }

            const totalMessages = runs.reduce((sum, run) => sum + run.messages.length, 0);
            const timestamps = runs.map(run => run.lastUpdated);

            return {
                totalRuns: runs.length,
                totalMessages,
                oldestRun: Math.min(...timestamps),
                newestRun: Math.max(...timestamps)
            };
        } catch (error) {
            console.error('[MessageStorage] Failed to get storage stats:', error);
            return {
                totalRuns: 0,
                totalMessages: 0,
                oldestRun: null,
                newestRun: null
            };
        }
      }

    /**
     * 保存活跃分组状态
     */
    async saveActiveGroup(runId: string, activeGroup: ActiveGroup): Promise<void> {
        if (!runId) {
            return;
        }

        try {
            const history = await this.loadHistory();

            if (!history[runId]) {
                history[runId] = {
                    messages: [],
                    lastUpdated: Date.now()
                };
            }

            history[runId].activeGroup = activeGroup;
            history[runId].lastUpdated = Date.now();

            await this.globalState.update(this.STORAGE_KEY, history);
            console.log(`[MessageStorage] Saved active group for run ${runId}, messages: ${activeGroup.messages.length}`);
        } catch (error) {
            console.error('[MessageStorage] Failed to save active group:', error);
        }
    }

    /**
     * 获取活跃分组状态
     */
    async getActiveGroup(runId: string): Promise<ActiveGroup | null> {
        if (!runId) {
            return null;
        }

        try {
            const history = await this.loadHistory();
            const runHistory = history[runId];

            return runHistory?.activeGroup || null;
        } catch (error) {
            console.error('[MessageStorage] Failed to get active group:', error);
            return null;
        }
    }

    /**
     * 清除活跃分组状态
     */
    async clearActiveGroup(runId: string): Promise<void> {
        if (!runId) {
            return;
        }

        try {
            const history = await this.loadHistory();

            if (history[runId]) {
                delete history[runId].activeGroup;
                history[runId].lastUpdated = Date.now();
                await this.globalState.update(this.STORAGE_KEY, history);
                console.log(`[MessageStorage] Cleared active group for run ${runId}`);
            }
        } catch (error) {
            console.error('[MessageStorage] Failed to clear active group:', error);
        }
    }

    /**
     * 从消息中提取可读性信息
     */
    private extractReadableInfo(runHistory: any, message: AgentMessage): void {
        try {
            console.log(`[MessageStorage] Extracting info from message:`, {
                type: message.type,
                content: message.content?.substring(0, 100),
                source: message.source,
                hasData: !!message.data
            });

            // 提取智能体名称
            if (message.source && typeof message.source === 'string') {
                // 从 source 中提取智能体名称（格式可能是 "flow.node.agent" 或直接是名称）
                const parts = message.source.split('.');
                runHistory.agentName = parts.length > 1 ? parts[parts.length - 1] : message.source;
            }

            // 尝试从多个地方提取任务内容
            let taskContent = '';

            // 1. 优先从 message.content 获取
            if (message.content) {
                taskContent = message.content;
            }
            // 2. 如果 content 为空，尝试从 message.data 获取
            else if (message.data && typeof message.data === 'object') {
                const data = message.data as any;
                if (data.task) {
                    taskContent = data.task;
                } else if (data.content) {
                    taskContent = data.content;
                } else if (data.name) {
                    taskContent = data.name;
                }
            }

            // 提取任务描述和标题
            if (taskContent) {
                runHistory.taskDescription = this.truncateText(taskContent, 100);
                runHistory.title = this.generateRunTitle(taskContent);
                console.log(`[MessageStorage] Extracted title: "${runHistory.title}" from content: "${taskContent.substring(0, 50)}..."`);
            } else {
                // 如果都没有内容，设置默认标题
                runHistory.title = message.type === 'start' ? '新任务' : '智能体任务';
                console.log(`[MessageStorage] No content found, using default title: "${runHistory.title}"`);
            }

            // 设置第一条消息时间
            runHistory.firstMessageTime = message.timestamp;

            console.log(`[MessageStorage] Final extracted info:`, {
                agentName: runHistory.agentName,
                title: runHistory.title,
                taskDescription: runHistory.taskDescription?.substring(0, 50) + '...',
                firstMessageTime: runHistory.firstMessageTime
            });
        } catch (error) {
            console.error('[MessageStorage] Failed to extract readable info:', error);
            // 设置默认值
            runHistory.title = '智能体任务';
        }
    }

    /**
     * 生成run标题
     */
    private generateRunTitle(content: string): string {
        if (!content) {
            return '新任务';
        }

        console.log(`[MessageStorage] Generating title from content: "${content}"`);

        // 移除常见的前缀
        const prefixes = [
            '分析', '设计', '实现', '测试', '调试', '优化', '重构', '部署',
            '请', '帮我', '我需要', '麻烦你', '能否', '可以', '帮我', '帮我看一下',
            '检查', '查看', '找出', '解决', '修复', '创建', '编写', '开发'
        ];

        let title = content.trim();

        // 移除前缀
        for (const prefix of prefixes) {
            if (title.startsWith(prefix)) {
                title = title.substring(prefix.length).trim();
                break;
            }
        }

        // 移除常见的标点符号前缀
        title = title.replace(/^[：:，,\s]+/, '');

        // 移除常见的问句结构
        const questionPatterns = [
            /^如何/i, /^怎么/i, /^怎样/i, /^什么/i, /^哪里/i,
            /^为什么/i, /^什么时候/i, /^多久/i
        ];

        for (const pattern of questionPatterns) {
            if (pattern.test(title)) {
                title = title.replace(pattern, '').trim();
                break;
            }
        }

        // 截断到合适长度
        title = this.truncateText(title, 50);

        // 如果为空，使用默认标题
        if (!title || title.length < 2) {
            const fallbackTitle = content.length > 20 ?
                this.truncateText(content, 20) :
                '智能体任务';
            console.log(`[MessageStorage] Title empty after processing, using fallback: "${fallbackTitle}"`);
            return fallbackTitle;
        }

        console.log(`[MessageStorage] Generated title: "${title}"`);
        return title;
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
}