import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolDefinition } from '../types';
import * as cp from 'child_process';
import * as util from 'util';

/**
 * 运行命令工具
 */
export class RunCommandTool extends BaseTool {
    definition: ToolDefinition = {
        name: 'run_command',
        description: '在终端中运行命令，自动获取命令输出结果。对于简单的命令（如ls, cat, grep等）将直接返回输出；对于交互式命令（如vim, python等）将在VS Code终端中执行',
        inputSchema: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: '要执行的命令'
                },
                cwd: {
                    type: 'string',
                    description: '工作目录（可选，默认为工作区根目录）'
                },
                name: {
                    type: 'string',
                    description: '终端名称（可选）',
                    default: 'AI Agent'
                },
                use_terminal: {
                    type: 'boolean',
                    description: '强制在VS Code终端中执行命令（可选，默认false。设为true时将在终端中执行，不会直接返回输出）',
                    default: false
                }
            },
            required: ['command']
        }
    };

    async execute(params: Record<string, unknown>): Promise<unknown> {
        this.validateParams(params);

        const command = params.command as string;
        let cwd = params.cwd as string;
        if (!cwd) {
            cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        }
        const name = params.name as string || 'AI Agent';
        const useTerminal = params.use_terminal as boolean ?? false;

        // 如果用户明确要求使用终端，或者命令是交互式的，则使用终端模式
        if (useTerminal || this.isInteractiveCommand(command)) {
            return this.executeInTerminal(command, cwd, name);
        }

        // 否则使用child_process直接执行并获取输出
        return this.executeWithOutput(command, cwd);
    }

    private isInteractiveCommand(command: string): boolean {
        const interactiveCommands = [
            'vim', 'nano', 'emacs', 'code', 'vi', 'top', 'htop',
            'ssh', 'ftp', 'sftp', 'telnet', 'python', 'node',
            'bash', 'zsh', 'fish', 'less', 'more', 'man'
        ];

        const firstWord = command.trim().split(/\s+/)[0];
        return interactiveCommands.includes(firstWord) || command.includes('&&') || command.includes('||');
    }

    private async executeInTerminal(command: string, cwd: string, name: string): Promise<unknown> {
        // 创建或获取终端
        let terminal = vscode.window.terminals.find(t => t.name === name);
        if (!terminal) {
            terminal = vscode.window.createTerminal({
                name,
                cwd
            });
        }

        terminal.show();
        terminal.sendText(command);

        return {
            success: true,
            message: `命令已发送到终端: ${command}`,
            terminalName: name,
            mode: 'terminal',
            note: '交互式命令已在终端中执行，请查看终端输出'
        };
    }

    private async executeWithOutput(command: string, cwd: string): Promise<unknown> {
        try {
            // 使用exec执行命令并获取输出
            const exec = util.promisify(cp.exec);

            const { stdout, stderr } = await exec(command, {
                cwd: cwd,
                encoding: 'utf8',
                maxBuffer: 1024 * 1024 * 10, // 10MB buffer
                timeout: 30000 // 30 seconds timeout
            });

            const hasOutput = stdout && stdout.trim().length > 0;
            const hasError = stderr && stderr.trim().length > 0;

            return {
                success: true,
                command: command,
                workingDirectory: cwd,
                output: hasOutput ? stdout : null,
                error: hasError ? stderr : null,
                exitCode: 0,
                mode: 'direct'
            };
        } catch (error: any) {
            return {
                success: false,
                command: command,
                workingDirectory: cwd,
                output: error.stdout || null,
                error: error.stderr || error.message,
                exitCode: error.code || 1,
                mode: 'direct'
            };
        }
    }
}

/**
 * 获取诊断信息工具
 */
export class GetDiagnosticsTool extends BaseTool {
    definition: ToolDefinition = {
        name: 'get_diagnostics',
        description: '获取文件或工作区的诊断信息（错误、警告等）',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '文件路径（可选，不填则获取所有诊断）'
                },
                severity: {
                    type: 'string',
                    description: '严重性过滤：error, warning, information, hint',
                    default: 'all'
                }
            },
            required: []
        }
    };

    async execute(params: Record<string, unknown>): Promise<unknown> {
        const filePath = params.path as string | undefined;
        const severity = params.severity as string || 'all';

        let diagnostics: [vscode.Uri, vscode.Diagnostic[]][];

        if (filePath) {
            const uri = vscode.Uri.file(filePath);
            const fileDiagnostics = vscode.languages.getDiagnostics(uri);
            diagnostics = [[uri, fileDiagnostics]];
        } else {
            diagnostics = vscode.languages.getDiagnostics();
        }

        const results = diagnostics.flatMap(([uri, diags]) => 
            diags
                .filter(d => this.matchSeverity(d.severity, severity))
                .map(d => ({
                    file: uri.fsPath,
                    line: d.range.start.line + 1,
                    column: d.range.start.character + 1,
                    message: d.message,
                    severity: this.getSeverityString(d.severity),
                    source: d.source
                }))
        );

        return { diagnostics: results, totalCount: results.length };
    }

    private matchSeverity(diagSeverity: vscode.DiagnosticSeverity, filter: string): boolean {
        if (filter === 'all') {return true;}
        const severityMap: Record<string, vscode.DiagnosticSeverity> = {
            'error': vscode.DiagnosticSeverity.Error,
            'warning': vscode.DiagnosticSeverity.Warning,
            'information': vscode.DiagnosticSeverity.Information,
            'hint': vscode.DiagnosticSeverity.Hint
        };
        return severityMap[filter] === diagSeverity;
    }

    private getSeverityString(severity: vscode.DiagnosticSeverity): string {
        const map = ['Error', 'Warning', 'Information', 'Hint'];
        return map[severity] || 'Unknown';
    }
}

/**
 * 打开文件工具
 */
export class OpenFileTool extends BaseTool {
    definition: ToolDefinition = {
        name: 'open_file',
        description: '在编辑器中打开文件',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '文件路径'
                },
                line: {
                    type: 'number',
                    description: '跳转到指定行（可选）'
                },
                column: {
                    type: 'number',
                    description: '跳转到指定列（可选）'
                },
                preview: {
                    type: 'boolean',
                    description: '是否以预览模式打开',
                    default: true
                }
            },
            required: ['path']
        }
    };

    async execute(params: Record<string, unknown>): Promise<unknown> {
        this.validateParams(params);
        
        const filePath = params.path as string;
        const line = params.line as number | undefined;
        const column = params.column as number | undefined;
        const preview = params.preview as boolean ?? true;

        const uri = vscode.Uri.file(filePath);
        const options: vscode.TextDocumentShowOptions = {
            preview
        };

        if (line !== undefined) {
            const position = new vscode.Position(
                Math.max(0, line - 1),
                Math.max(0, (column || 1) - 1)
            );
            options.selection = new vscode.Range(position, position);
        }

        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, options);

        return { success: true, path: uri.fsPath };
    }
}
