import * as vscode from 'vscode';
import { ToolRegistry } from './tools';
import { McpServer } from './server';
import { StatusViewProvider, ToolsViewProvider, ConfigViewProvider, ChatViewProvider, HistoryViewProvider, copyServerInfo, openSettings } from './views';
import { AgentClient } from './client';

let mcpServer: McpServer | null = null;
let toolRegistry: ToolRegistry | null = null;
let agentClient: AgentClient | null = null;
let outputChannel: vscode.OutputChannel | null = null;
let statusViewProvider: StatusViewProvider | null = null;
let toolsViewProvider: ToolsViewProvider | null = null;
let configViewProvider: ConfigViewProvider | null = null;
let historyViewProvider: HistoryViewProvider | null = null;
let chatViewProvider: ChatViewProvider | null = null;

/**
 * 扩展激活入口
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('AIAT 扩展已激活');

    // 创建输出通道
    outputChannel = vscode.window.createOutputChannel('AIAT');
    
    // 创建工具注册表
    toolRegistry = new ToolRegistry();
    
    // 创建 MCP 服务器
    mcpServer = new McpServer(toolRegistry, outputChannel);

    // 创建 WebSocket 客户端
    agentClient = new AgentClient(outputChannel, context);

    // 创建视图提供器
    statusViewProvider = new StatusViewProvider();
    toolsViewProvider = new ToolsViewProvider();
    configViewProvider = new ConfigViewProvider();
    historyViewProvider = new HistoryViewProvider(context.extensionUri, agentClient);
    chatViewProvider = new ChatViewProvider(context.extensionUri, agentClient, context);

    // 注册视图
    vscode.window.registerTreeDataProvider('aiat.status', statusViewProvider);
    vscode.window.registerTreeDataProvider('aiat.tools', toolsViewProvider);
    vscode.window.registerTreeDataProvider('aiat.config', configViewProvider);
    vscode.window.registerTreeDataProvider('aiat.history', historyViewProvider);
    
    // 注册 Webview 视图
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider)
    );

    // 更新工具列表视图
    toolsViewProvider.updateTools(toolRegistry.getToolDefinitions());

    // 注册命令：启动服务器
    const startServerCmd = vscode.commands.registerCommand('aiat.startServer', async () => {
        try {
            await mcpServer?.start();
            // 无论启动成功还是发现已在运行，都要更新状态视图
            updateStatusView();
            configViewProvider?.refresh();
        } catch (error: any) {
            const message = error instanceof Error ? error.message : String(error);

            // 特殊处理端口占用错误
            if (message.includes('已被占用') || error?.code === 'EADDRINUSE') {
                // 端口占用错误已经在服务器级别处理了，这里只记录日志
                outputChannel?.appendLine(`[启动服务器] ${message}`);
                // 即使端口被占用，也要更新状态视图，因为可能有服务器在运行
                updateStatusView();
                configViewProvider?.refresh();
                return; // 不显示错误消息，因为已经在服务器级别处理了
            }

            vscode.window.showErrorMessage(`启动 MCP 服务器失败: ${message}`);
        }
    });

    // 注册命令：停止服务器
    const stopServerCmd = vscode.commands.registerCommand('aiat.stopServer', async () => {
        try {
            await mcpServer?.stop();
            updateStatusView();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`停止 MCP 服务器失败: ${message}`);
        }
    });

    // 注册命令：显示状态
    const showStatusCmd = vscode.commands.registerCommand('aiat.showStatus', () => {
        const status = mcpServer?.getStatus();
        if (status) {
            const statusText = [
                `服务状态: ${status.running ? '运行中' : '已停止'}`,
                `协议: MCP (${status.protocolVersion})`,
                `监听端口: ${status.port}`,
                `连接客户端: ${status.connectedClients}`,
                `可用工具: ${status.tools.length} 个`
            ].join('\n');
            
            vscode.window.showInformationMessage(statusText, { modal: true });
        }
    });

    // 注册命令：打开设置
    const openSettingsCmd = vscode.commands.registerCommand('aiat.openSettings', () => {
        openSettings();
    });

    // 注册命令：复制服务器配置信息
    const copyServerInfoCmd = vscode.commands.registerCommand('aiat.copyServerInfo', () => {
        if (configViewProvider) {
            copyServerInfo(configViewProvider);
        }
    });

    // 注册命令：连接智能体服务
    const connectAgentCmd = vscode.commands.registerCommand('aiat.connectAgent', async () => {
        try {
            if (agentClient) {
                await agentClient.connect(true); // 自动启动 MCP 服务器

                // 使用短延迟确保连接状态已完全更新
                setTimeout(() => {
                    // 连接后强制更新所有视图，确保状态同步
                    updateStatusView();
                    configViewProvider?.refresh();

                    // 重要：再次确保聊天视图也更新（双重保险）
                    if (chatViewProvider && agentClient) {
                        const state = agentClient.state;
                        const runId = agentClient.currentRunId;
                        const taskState = agentClient.taskState;
                        console.log('[Extension] Force sync chat view after connect - state:', state, 'runId:', runId, 'taskState:', taskState);
                        chatViewProvider.updateConnectionState(state, runId, taskState);

                        // 再次确保状态同步
                        setTimeout(() => {
                            if (chatViewProvider) {
                                chatViewProvider.ensureStateSync();
                            }
                        }, 200);
                    }
                }, 100);
            }
        } catch (error: any) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`连接智能体服务失败: ${message}`);
            // 即使出错也更新状态视图，确保界面显示正确
            updateStatusView();
            configViewProvider?.refresh();
            if (chatViewProvider) {
                chatViewProvider.updateConnectionState('error');
            }
        }
    });

    // 注册命令：断开智能体服务
    const disconnectAgentCmd = vscode.commands.registerCommand('aiat.disconnectAgent', () => {
        if (agentClient) {
            agentClient.disconnect();

            // 使用短延迟确保断开状态已完全更新
            setTimeout(() => {
                // 断开后强制更新所有视图，确保状态同步
                updateStatusView();
                configViewProvider?.refresh();

                // 重要：再次确保聊天视图也更新（双重保险）
                if (chatViewProvider && agentClient) {
                    const state = agentClient.state;
                    const taskState = agentClient.taskState;
                    console.log('[Extension] Force sync chat view after disconnect - state:', state, 'taskState:', taskState);
                    chatViewProvider.updateConnectionState(state, null, taskState);

                    // 再次确保状态同步
                    setTimeout(() => {
                        if (chatViewProvider) {
                            chatViewProvider.ensureStateSync();
                        }
                    }, 200);
                }
            }, 100);
        }
    });

    // 注册命令：打开聊天面板
    const openChatCmd = vscode.commands.registerCommand('aiat.openChat', () => {
        vscode.commands.executeCommand('aiat.chat.focus');
    });

    // 注册历史消息相关命令
    const switchToRunCmd = vscode.commands.registerCommand('aiat.switchToRun', async (runId: string) => {
        if (agentClient && runId) {
            try {
                // 切换到指定的run
                await agentClient.loadHistoryForRun(runId);

                // 刷新历史视图
                if (historyViewProvider) {
                    await historyViewProvider.refresh();
                }

                // 切换到聊天视图
                vscode.commands.executeCommand('aiat.chat.focus');

                vscode.window.showInformationMessage(`已切换到 Run: ${runId}`);
            } catch (error) {
                vscode.window.showErrorMessage(`切换到 Run ${runId} 失败: ${error}`);
            }
        }
    });

    const refreshHistoryCmd = vscode.commands.registerCommand('aiat.refreshHistory', async () => {
        if (historyViewProvider) {
            await historyViewProvider.refresh();
            vscode.window.showInformationMessage('历史消息已刷新');
        }
    });

    const clearHistoryCmd = vscode.commands.registerCommand('aiat.clearHistory', async () => {
        if (historyViewProvider) {
            await historyViewProvider.clearAllHistory();
        }
    });

    const deleteHistoryCmd = vscode.commands.registerCommand('aiat.deleteHistory', async (historyItem: any) => {
        if (historyViewProvider && historyItem && historyItem.runId) {
            await historyViewProvider.deleteHistory(historyItem.runId);
        }
    });

    const showStorageStatsCmd = vscode.commands.registerCommand('aiat.showStorageStats', async () => {
        if (historyViewProvider) {
            await historyViewProvider.showStorageStats();
        }
    });

    // 注册命令：调试状态信息
    const debugStateCmd = vscode.commands.registerCommand('aiat.debugState', () => {
        if (agentClient) {
            const stateSummary = agentClient.stateManager.getStateSummary();
            console.log('=== Agent Client State Debug ===');
            console.log(JSON.stringify(stateSummary, null, 2));
            console.log('=== Message History ===');
            console.log(`Total messages: ${agentClient.messages.length}`);
            agentClient.messages.slice(-5).forEach((msg, index) => {
                console.log(`[${index}] ${msg.direction} - ${msg.type}: ${msg.content?.substring(0, 100)}...`);
            });

            // 显示状态信息
            const stateInfo = [
                `连接状态: ${stateSummary.connection}`,
                `任务状态: ${stateSummary.task}`,
                `Run ID: ${stateSummary.runId || 'None'}`,
                `是否连接: ${stateSummary.isConnected}`,
                `任务运行中: ${stateSummary.isTaskRunning}`,
                `可启动任务: ${stateSummary.canStartTask}`,
                `可停止任务: ${stateSummary.canStopTask}`,
                `最后错误: ${stateSummary.lastError || 'None'}`,
                `消息数量: ${agentClient.messages.length}`
            ].join('\n');

            vscode.window.showInformationMessage(stateInfo, { modal: true });
        } else {
            vscode.window.showErrorMessage('Agent client not initialized');
        }
    });

    // 监听配置变化
    const configChangeListener = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('aiat')) {
            configViewProvider?.refresh();
            updateStatusView();
        }
    });

    // 添加到订阅列表
    context.subscriptions.push(
        startServerCmd,
        stopServerCmd,
        showStatusCmd,
        openSettingsCmd,
        copyServerInfoCmd,
        connectAgentCmd,
        disconnectAgentCmd,
        openChatCmd,
        switchToRunCmd,
        refreshHistoryCmd,
        clearHistoryCmd,
        deleteHistoryCmd,
        showStorageStatsCmd,
        debugStateCmd,
        configChangeListener,
        outputChannel
    );

    // 初始更新状态视图
    updateStatusView();

    // 自动启动服务器（可选）
    const autoStart = vscode.workspace.getConfiguration('aiat').get('autoStart', false);
    if (autoStart) {
        mcpServer.start().catch(err => {
            outputChannel?.appendLine(`自动启动失败: ${err.message}`);
        });
    }

    // 自动连接智能体服务（增强用户体验）
    const autoConnect = vscode.workspace.getConfiguration('aiat').get('agentServer.autoConnect', false);
    if (autoConnect) {
        // 延迟1秒后自动连接，确保扩展完全初始化
        setTimeout(async () => {
            try {
                await agentClient?.connect(true); // 自动连接并启动 MCP 服务器
                outputChannel?.appendLine('已自动连接到智能体服务');
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                outputChannel?.appendLine(`自动连接失败: ${message}`);
                // 静默失败，不显示错误通知，避免干扰用户体验
            }
        }, 1000);
    }

    outputChannel.appendLine('AIAT 扩展已就绪');
    outputChannel.appendLine(`协议: MCP (Model Context Protocol)`);
    outputChannel.appendLine(`可用工具: ${toolRegistry.getToolNames().join(', ')}`);
}

/**
 * 更新状态视图
 */
function updateStatusView(): void {
    if (statusViewProvider && mcpServer) {
        statusViewProvider.updateStatus(mcpServer.getStatus());
    }

    // 同时更新连接状态到聊天视图
    if (agentClient) {
        // 触发聊天视图中的状态更新
        const connectionState = agentClient.state;
        const taskState = agentClient.taskState;
        const runId = agentClient.stateManager.state.runId;

        console.log(`[Extension] Forcing connection state update: ${connectionState}, task: ${taskState}, runId: ${runId}`);

        // 找到活动聊天视图并更新状态
        chatViewProvider?.updateConnectionState(connectionState, runId, taskState);
    }
}

/**
 * 扩展停用
 */
export async function deactivate(): Promise<void> {
    console.log('AIAT 扩展正在停用...');

    try {
        // 断开智能体连接
        if (agentClient) {
            try {
                agentClient.dispose();
            } catch (error) {
                console.warn('Error disposing agent client:', error);
            }
            agentClient = null;
        }

        // 停止 MCP 服务器
        if (mcpServer) {
            try {
                await mcpServer.stop();
            } catch (error) {
                console.warn('Error stopping MCP server:', error);
            }
            mcpServer = null;
        }

        // 清理输出通道
        if (outputChannel) {
            try {
                outputChannel.dispose();
            } catch (error) {
                console.warn('Error disposing output channel:', error);
            }
            outputChannel = null;
        }

        console.log('AIAT 扩展已停用');
    } catch (error) {
        console.warn('Error during extension deactivation:', error);
    }
}
