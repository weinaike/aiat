import { ToolHandler, ToolDefinition } from '../types';
import { ReadFileTool, WriteFileTool, ListDirectoryTool, DeleteFileTool } from './fileTools';
import { TextSearchTool, FileSearchTool, SymbolSearchTool } from './searchTools';
import { RunCommandTool, GetDiagnosticsTool, OpenFileTool } from './terminalTools';

/**
 * 工具注册表
 */
export class ToolRegistry {
    private tools: Map<string, ToolHandler> = new Map();

    constructor() {
        this.registerDefaultTools();
    }

    /**
     * 注册默认工具
     */
    private registerDefaultTools(): void {
        // 文件操作工具
        this.register(new ReadFileTool());
        this.register(new WriteFileTool());
        this.register(new ListDirectoryTool());
        this.register(new DeleteFileTool());

        // 搜索工具
        this.register(new TextSearchTool());
        this.register(new FileSearchTool());
        this.register(new SymbolSearchTool());

        // 终端和编辑器工具
        this.register(new RunCommandTool());
        this.register(new GetDiagnosticsTool());
        this.register(new OpenFileTool());
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
export { TextSearchTool, FileSearchTool, SymbolSearchTool } from './searchTools';
export { RunCommandTool, GetDiagnosticsTool, OpenFileTool } from './terminalTools';
export { BaseTool } from './baseTool';
