import * as vscode from 'vscode';
import { ServerStatus } from '../types';

/**
 * 状态视图提供器
 */
export class StatusViewProvider implements vscode.TreeDataProvider<StatusItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<StatusItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private status: ServerStatus | null = null;

    updateStatus(status: ServerStatus): void {
        this.status = status;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: StatusItem): vscode.TreeItem {
        return element;
    }

    getChildren(): StatusItem[] {
        if (!this.status) {
            return [new StatusItem('未初始化', '', vscode.TreeItemCollapsibleState.None)];
        }

        return [
            new StatusItem(
                '服务状态',
                this.status.running ? '运行中 ✅' : '已停止 ⏹️',
                vscode.TreeItemCollapsibleState.None
            ),
            new StatusItem(
                '协议',
                `MCP (${this.status.protocolVersion})`,
                vscode.TreeItemCollapsibleState.None
            ),
            new StatusItem(
                '监听端口',
                String(this.status.port),
                vscode.TreeItemCollapsibleState.None
            ),
            new StatusItem(
                '连接客户端',
                String(this.status.connectedClients),
                vscode.TreeItemCollapsibleState.None
            ),
            new StatusItem(
                '可用工具数',
                String(this.status.tools.length),
                vscode.TreeItemCollapsibleState.None
            )
        ];
    }
}

/**
 * 工具列表视图提供器
 */
export class ToolsViewProvider implements vscode.TreeDataProvider<ToolItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ToolItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private tools: Array<{ name: string; description: string }> = [];

    updateTools(tools: Array<{ name: string; description: string }>): void {
        this.tools = tools;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: ToolItem): vscode.TreeItem {
        return element;
    }

    getChildren(): ToolItem[] {
        if (this.tools.length === 0) {
            return [new ToolItem('暂无工具', '', vscode.TreeItemCollapsibleState.None)];
        }

        return this.tools.map(tool => 
            new ToolItem(tool.name, tool.description, vscode.TreeItemCollapsibleState.None)
        );
    }
}

/**
 * 状态项
 */
class StatusItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly value: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.description = value;
        this.contextValue = 'statusItem';
    }
}

/**
 * 工具项
 */
class ToolItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly toolDescription: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.tooltip = toolDescription;
        this.description = toolDescription.substring(0, 30) + (toolDescription.length > 30 ? '...' : '');
        this.iconPath = new vscode.ThemeIcon('tools');
        this.contextValue = 'toolItem';
    }
}
