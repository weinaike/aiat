import * as vscode from 'vscode';
import { ToolHandler, ToolDefinition } from '../types';
import { ReadFileTool, WriteFileTool, ListDirectoryTool, DeleteFileTool } from './fileTools';
import { TextSearchTool, FileSearchTool, SymbolSearchTool, GetEnvironmentTool } from './searchTools';
import { RunCommandTool, GetDiagnosticsTool, OpenFileTool } from './terminalTools';

/**
 * 工具注册表
 */
export class ToolRegistry {
    private tools: Map<string, ToolHandler> = new Map();
    private localToolsRegistered: boolean = false;

    constructor() {
        this.registerDefaultTools();
    }

    /**
     * 注册默认工具
     */
    private registerDefaultTools(): void {
        // 检查工具来源配置
        const config = vscode.workspace.getConfiguration('aiat');
        const toolSource = config.get<string>('toolSource', 'local');
        
        console.log(`[ToolRegistry] toolSource = ${toolSource}`);
        
        // 只有选择 local 时才注册本地工具
        if (toolSource !== 'local') {
            console.log('[ToolRegistry] 未选择本地工具，跳过注册');
            return;
        }

        this.registerLocalTools();
    }

    /**
     * 注册本地工具
     */
    private registerLocalTools(): void {
        if (this.localToolsRegistered) {
            return;
        }

        // 文件操作工具
        this.register(new ReadFileTool());
        this.register(new WriteFileTool());
        this.register(new ListDirectoryTool());
        this.register(new DeleteFileTool());

        // 搜索工具
        this.register(new TextSearchTool());
        this.register(new FileSearchTool());
        this.register(new SymbolSearchTool());
        this.register(new GetEnvironmentTool());

        // 终端和编辑器工具
        this.register(new RunCommandTool());
        this.register(new GetDiagnosticsTool());
        this.register(new OpenFileTool());

        this.localToolsRegistered = true;
        console.log(`[ToolRegistry] 已注册 ${this.tools.size} 个本地工具`);
    }

    /**
     * 注销所有本地工具
     */
    unregisterLocalTools(): void {
        if (!this.localToolsRegistered) {
            return; // 本地工具未注册，无需注销
        }
        
        const localToolNames = [
            'read_file', 'write_file', 'list_directory', 'delete_file',
            'text_search', 'glob_search', 'symbol_search', 'get_environment',
            'run_command', 'get_diagnostics', 'open_file'
        ];
        
        for (const name of localToolNames) {
            this.tools.delete(name);
        }
        this.localToolsRegistered = false;
        console.log('[ToolRegistry] 已注销所有本地工具');
    }

    /**
     * 根据配置重新加载本地工具
     */
    reloadLocalTools(): void {
        const config = vscode.workspace.getConfiguration('aiat');
        const toolSource = config.get<string>('toolSource', 'local');
        
        console.log(`[ToolRegistry] reloadLocalTools: toolSource=${toolSource}, localToolsRegistered=${this.localToolsRegistered}`);
        
        if (toolSource === 'local') {
            // 强制重新注册本地工具
            this.localToolsRegistered = false;
            this.registerLocalTools();
        }
    }

    /**
     * 注册工具
     */
    register(tool: ToolHandler): void {
        this.tools.set(tool.definition.name, tool);
    }

    /**
     * 注销工具
     */
    unregister(name: string): boolean {
        return this.tools.delete(name);
    }

    /**
     * 获取工具
     */
    get(name: string): ToolHandler | undefined {
        return this.tools.get(name);
    }

    /**
     * 获取所有工具名称
     */
    getToolNames(): string[] {
        return Array.from(this.tools.keys());
    }

    /**
     * 获取所有工具定义
     */
    getToolDefinitions(): ToolDefinition[] {
        return Array.from(this.tools.values()).map(tool => tool.definition);
    }

    /**
     * 执行工具
     */
    async execute(name: string, params: Record<string, unknown>): Promise<unknown> {
        const tool = this.tools.get(name);
        if (!tool) {
            throw new Error(`未找到工具: ${name}`);
        }
        return tool.execute(params);
    }
}

// 导出所有工具类
export { ReadFileTool, WriteFileTool, ListDirectoryTool, DeleteFileTool } from './fileTools';
export { TextSearchTool, FileSearchTool, SymbolSearchTool, GetEnvironmentTool } from './searchTools';
export { RunCommandTool, GetDiagnosticsTool, OpenFileTool } from './terminalTools';
export { BaseTool } from './baseTool';
