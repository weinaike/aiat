import * as vscode from 'vscode';

/**
 * 团队配置接口（简化版，不再包含本地 MCP 服务器信息）
 */
export interface TeamConfig {
    id: number;
    codebase: string;
}

/**
 * 配置视图提供器
 */
export class ConfigViewProvider implements vscode.TreeDataProvider<ConfigItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ConfigItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: ConfigItem): vscode.TreeItem {
        return element;
    }

    getChildren(): ConfigItem[] {
        const config = vscode.workspace.getConfiguration('aiat');
        const agentServerUrl = config.get<string>('agentServer.url', 'ws://agent-flow.dev.csst.lab.zverse.space:32080');
        const mcpTunnelEnabled = config.get<boolean>('mcpTunnel.enabled', true);
        const workspaceRoot = this.getDefaultCodebase();

        // 获取workspace名称
        const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name || '未知项目';

        return [
            // 服务器配置组
            new ConfigItem('智能体服务', agentServerUrl, 'agent_server', 'cloud'),
            new ConfigItem('MCP 隧道', mcpTunnelEnabled ? '已启用' : '已禁用', 'mcp_tunnel', mcpTunnelEnabled ? 'check' : 'close'),
            // 工作区信息组
            new ConfigItem('工作区名称', workspaceName, 'workspace_name', 'project'),
            new ConfigItem('代码库路径', workspaceRoot || '(未打开)', 'codebase', 'folder-opened'),
        ];
    }

    private getDefaultCodebase(): string {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        return workspaceFolder?.uri.fsPath || '';
    }

    /**
     * 获取当前 team_config（简化版，MCP 工具通过隧道提供）
     */
    getTeamConfig(): TeamConfig {
        const config = vscode.workspace.getConfiguration('aiat');
        const teamId = config.get<number>('teamConfig.id', 1);
        const codebase = config.get<string>('teamConfig.codebase', '') || this.getDefaultCodebase();

        const teamConfig: TeamConfig = {
            id: teamId,
            codebase: codebase
        };

        return teamConfig;
    }
}

/**
 * 配置项
 */
class ConfigItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly value: string,
        public readonly configKey: string,
        public readonly iconId: string,
        public readonly command?: vscode.Command
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);

        if (configKey === 'divider') {
            this.label = '─────────────';
            this.description = '';
        } else if (configKey === 'header') {
            this.description = '';
            this.contextValue = 'header';
            this.tooltip = '';
        } else if (configKey === 'copy') {
            this.contextValue = 'copyConfig';
        } else {
            this.description = value;
            this.tooltip = `${label}: ${value}\n点击编辑设置`;
            this.contextValue = 'configItem';
            this.command = {
                command: 'aiat.openSettings',
                title: '打开设置'
            };
        }

        if (iconId) {
            this.iconPath = new vscode.ThemeIcon(iconId.replace('$(', '').replace(')', ''));
        }
    }
}

/**
 * 复制服务器配置信息到剪贴板
 */
export async function copyServerInfo(configProvider: ConfigViewProvider): Promise<void> {
    const teamConfig = configProvider.getTeamConfig();
    
    const configJson = JSON.stringify({
        type: 'start',
        task: 'Your task description here',
        files: [],
        team_config: teamConfig
    }, null, 2);

    await vscode.env.clipboard.writeText(configJson);
    vscode.window.showInformationMessage('team_config 已复制到剪贴板');
}

/**
 * 打开设置页面
 */
export function openSettings(): void {
    vscode.commands.executeCommand('workbench.action.openSettings', 'aiat');
}
