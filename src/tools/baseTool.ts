import { ToolDefinition, ToolHandler } from '../types';

/**
 * 工具基类
 */
export abstract class BaseTool implements ToolHandler {
    abstract definition: ToolDefinition;
    abstract execute(params: Record<string, unknown>): Promise<unknown>;

    /**
     * 验证参数
     */
    protected validateParams(params: Record<string, unknown>): void {
        const { required = [] } = this.definition.inputSchema;
        for (const param of required) {
            if (!(param in params)) {
                throw new Error(`缺少必需参数: ${param}`);
            }
        }
    }

    /**
     * 获取工具名称
     */
    get name(): string {
        return this.definition.name;
    }

    /**
     * 获取工具描述
     */
    get description(): string {
        return this.definition.description;
    }
}
