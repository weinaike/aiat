import * as vscode from 'vscode';
import { McpClient, McpServerConfig } from './mcpClient';
import { ToolRegistry } from '../tools';
import { ToolHandler } from '../types';

/**
 * 内置 MCP 服务器配置
 * 使用 npx 运行，首次会下载包（后续会使用缓存）
 */
const BUILTIN_MCP_SERVERS: McpServerConfig[] = [
    {
        name: 'desktop-commander',
        command: 'npx',
        args: ['-y', '@wonderwhy-er/desktop-commander@latest'],
        enabled: true
    }
];

/**
 * 外部 MCP 服务器管理器
 * 负责管理多个外部 MCP 服务器的生命周期和工具注册
 */
export class McpServerManager {
    private clients: Map<string, McpClient> = new Map();
    private toolRegistry: ToolRegistry;
    private outputChannel: vscode.OutputChannel;
    private disposables: vscode.Disposable[] = [];

    constructor(toolRegistry: ToolRegistry, outputChannel: vscode.OutputChannel) {
        this.toolRegistry = toolRegistry;
        this.outputChannel = outputChannel;
        
        // 监听配置变化
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('aiat.mcpServers')) {
                    this.reloadServers();
                }
            })
        );
    }

    /**
     * 从配置加载并启动所有 MCP 服务器
     */
    async loadFromConfig(): Promise<void> {
        const config = vscode.workspace.getConfiguration('aiat');
        
        // 1. 检查工具来源，决定是否加载内置 MCP 服务器
        const toolSource = config.get<string>('toolSource', 'local');
        
        if (toolSource === 'builtin-mcp') {
            this.log(`工具来源: builtin-mcp，正在加载内置 MCP 服务器...`);
            this.log(`提示: 首次运行 npx 会下载 desktop-commander 包，请稍候...`);
            
            for (const builtinConfig of BUILTIN_MCP_SERVERS) {
                try {
                    this.log(`尝试启动内置 MCP 服务器: ${builtinConfig.name}`);
                    await this.startServer(builtinConfig, true); // isBuiltin = true
                    this.log(`内置 MCP 服务器 ${builtinConfig.name} 启动成功`);
                } catch (error) {
                    this.log(`启动内置 MCP 服务器失败: ${builtinConfig.name} - ${error}`);
                    vscode.window.showWarningMessage(
                        `内置 MCP 服务器 "${builtinConfig.name}" 启动失败: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
        } else {
            this.log(`工具来源: ${toolSource}，跳过内置 MCP 服务器`);
        }
        
        // 2. 加载用户自定义 MCP 服务器（始终加载）
        const servers = config.get<McpServerConfig[]>('mcpServers.custom', []);
        
        this.log(`从配置加载 ${servers.length} 个自定义 MCP 服务器`);
        
        for (const serverConfig of servers) {
            if (serverConfig.enabled !== false) {
                try {
                    await this.startServer(serverConfig, false); // isBuiltin = false
                } catch (error) {
                    this.log(`启动 MCP 服务器失败: ${serverConfig.name} - ${error}`);
                    vscode.window.showWarningMessage(
                        `MCP 服务器 "${serverConfig.name}" 启动失败: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
        }
    }

    /**
     * 启动单个 MCP 服务器
     */
    async startServer(config: McpServerConfig, isBuiltin: boolean = false): Promise<void> {
        if (this.clients.has(config.name)) {
            this.log(`MCP 服务器 "${config.name}" 已在运行`);
            return;
        }

        this.log(`正在启动 MCP 服务器: ${config.name} (内置: ${isBuiltin})`);

        const client = new McpClient(config, this.outputChannel, isBuiltin);
        
        try {
            await client.start();
            this.clients.set(config.name, client);

            // 注册工具到全局工具注册表
            const tools = client.getTools();
            for (const [name, tool] of tools) {
                this.toolRegistry.register(tool);
                this.log(`已注册工具: ${name}`);
            }

            this.log(`MCP 服务器 "${config.name}" 启动成功，注册了 ${tools.size} 个工具`);
            
            // 内置服务器静默启动，自定义服务器显示通知
            if (!isBuiltin) {
                vscode.window.showInformationMessage(
                    `MCP 服务器 "${config.name}" 已连接，${tools.size} 个工具可用`
                );
            }
        } catch (error) {
            this.log(`MCP 服务器 "${config.name}" 启动失败: ${error}`);
            throw error;
        }
    }

    /**
     * 停止单个 MCP 服务器
     */
    async stopServer(name: string): Promise<void> {
        const client = this.clients.get(name);
        if (!client) {
            return;
        }

        this.log(`正在停止 MCP 服务器: ${name}`);

        // 注销工具
        const tools = client.getTools();
        for (const [toolName] of tools) {
            this.toolRegistry.unregister(toolName);
        }

        await client.stop();
        this.clients.delete(name);

        this.log(`MCP 服务器 "${name}" 已停止`);
    }

    /**
     * 停止所有 MCP 服务器
     */
    async stopAll(): Promise<void> {
        const names = Array.from(this.clients.keys());
        for (const name of names) {
            await this.stopServer(name);
        }
    }

    /**
     * 重新加载所有服务器
     */
    async reloadServers(): Promise<void> {
        this.log('重新加载 MCP 服务器配置');
        await this.stopAll();
        await this.loadFromConfig();
    }

    /**
     * 获取所有服务器状态
     */
    getServerStatus(): Array<{ name: string; initialized: boolean; toolCount: number }> {
        return Array.from(this.clients.entries()).map(([name, client]) => ({
            name,
            initialized: client.isInitialized(),
            toolCount: client.getTools().size
        }));
    }

    /**
     * 获取指定服务器的工具
     */
    getServerTools(name: string): ToolHandler[] {
        const client = this.clients.get(name);
        if (!client) {
            return [];
        }
        return Array.from(client.getTools().values());
    }

    /**
     * 获取所有外部工具
     */
    getAllExternalTools(): Map<string, ToolHandler> {
        const allTools = new Map<string, ToolHandler>();
        for (const client of this.clients.values()) {
            const tools = client.getTools();
            for (const [name, tool] of tools) {
                allTools.set(name, tool);
            }
        }
        return allTools;
    }

    /**
     * 手动添加服务器配置
     */
    async addServer(config: McpServerConfig): Promise<void> {
        // 保存到配置
        const vsConfig = vscode.workspace.getConfiguration('aiat');
        const servers = vsConfig.get<McpServerConfig[]>('mcpServers.custom', []);
        
        // 检查是否已存在
        const existingIndex = servers.findIndex(s => s.name === config.name);
        if (existingIndex >= 0) {
            servers[existingIndex] = config;
        } else {
            servers.push(config);
        }

        await vsConfig.update('mcpServers.custom', servers, vscode.ConfigurationTarget.Global);

        // 启动服务器
        if (config.enabled !== false) {
            await this.startServer(config);
        }
    }

    /**
     * 移除服务器配置
     */
    async removeServer(name: string): Promise<void> {
        // 停止服务器
        await this.stopServer(name);

        // 从配置中移除
        const vsConfig = vscode.workspace.getConfiguration('aiat');
        const servers = vsConfig.get<McpServerConfig[]>('mcpServers.custom', []);
        const filteredServers = servers.filter(s => s.name !== name);
        
        await vsConfig.update('mcpServers.custom', filteredServers, vscode.ConfigurationTarget.Global);
    }

    /**
     * 获取内置服务器列表
     */
    getBuiltinServers(): McpServerConfig[] {
        return [...BUILTIN_MCP_SERVERS];
    }

    /**
     * 释放资源
     */
    dispose(): void {
        this.stopAll();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    /**
     * 日志输出
     */
    private log(message: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] [McpServerManager] ${message}`);
    }
}
