import * as vscode from 'vscode';
import * as os from 'os';

/**
 * 获取本机 IP 地址
 */
function getLocalIP(): string {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            // 跳过内部地址和非 IPv4 地址
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

/**
 * 团队配置接口
 */
export interface TeamConfig {
    id: number;
    codebase: string;
    mcp_server: string;
    mcp_port: number;
    mcp_token?: string;
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
        const config = vscode.workspace.getConfiguration('aiAgentTools');
        const port = config.get<number>('serverPort', 9527);
        const teamId = config.get<number>('teamConfig.id', 1);
        const codebase = config.get<string>('teamConfig.codebase', '') || this.getDefaultCodebase();
        const authToken = config.get<string>('authToken', '');
        const localIP = getLocalIP();

        return [
            new ConfigItem('服务器地址', localIP, 'mcp_server', '$(globe)'),
            new ConfigItem('服务器端口', String(port), 'mcp_port', '$(plug)'),
            new ConfigItem('团队 ID', String(teamId), 'id', '$(organization)'),
            new ConfigItem('代码库路径', codebase || '(未配置)', 'codebase', '$(folder)'),
            new ConfigItem('认证令牌', authToken ? '******' : '(未设置)', 'mcp_token', '$(key)'),
            new ConfigItem('', '', 'divider', ''),
            new ConfigItem('📋 复制 team_config', '', 'copy', '$(copy)', {
                command: 'aiAgentTools.copyServerInfo',
                title: '复制配置'
            })
        ];
    }

    private getDefaultCodebase(): string {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        return workspaceFolder?.uri.fsPath || '';
    }

    /**
     * 获取当前 team_config
     */
    getTeamConfig(): TeamConfig {
        const config = vscode.workspace.getConfiguration('aiAgentTools');
        const port = config.get<number>('serverPort', 9527);
        const teamId = config.get<number>('teamConfig.id', 1);
        const codebase = config.get<string>('teamConfig.codebase', '') || this.getDefaultCodebase();
        const authToken = config.get<string>('authToken', '');
        const localIP = getLocalIP();

        const teamConfig: TeamConfig = {
            id: teamId,
            codebase: codebase,
            mcp_server: localIP,
            mcp_port: port
        };

        if (authToken) {
            teamConfig.mcp_token = authToken;
        }

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
        } else if (configKey === 'copy') {
            this.contextValue = 'copyConfig';
        } else {
            this.description = value;
            this.tooltip = `${label}: ${value}\n点击编辑设置`;
            this.contextValue = 'configItem';
            this.command = {
                command: 'aiAgentTools.openSettings',
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
    vscode.commands.executeCommand('workbench.action.openSettings', 'aiAgentTools');
}
