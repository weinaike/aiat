import * as vscode from 'vscode';
import * as path from 'path';
import { BaseTool } from './baseTool';
import { ToolDefinition, FileInfo } from '../types';

/**
 * 读取文件工具
 */
export class ReadFileTool extends BaseTool {
    definition: ToolDefinition = {
        name: 'read_file',
        description: '读取指定文件的内容',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '文件的绝对路径或相对于工作区的路径'
                },
                startLine: {
                    type: 'number',
                    description: '开始读取的行号（从1开始）',
                    default: 1
                },
                endLine: {
                    type: 'number',
                    description: '结束读取的行号（包含）',
                    default: -1
                }
            },
            required: ['path']
        }
    };

    async execute(params: Record<string, unknown>): Promise<unknown> {
        this.validateParams(params);
        
        const filePath = params.path as string;
        const startLine = (params.startLine as number) || 1;
        const endLine = (params.endLine as number) || -1;

        const uri = this.resolveUri(filePath);
        const content = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(content).toString('utf8');
        
        const lines = text.split('\n');
        const start = Math.max(0, startLine - 1);
        const end = endLine === -1 ? lines.length : Math.min(lines.length, endLine);
        
        return {
            content: lines.slice(start, end).join('\n'),
            totalLines: lines.length,
            startLine: start + 1,
            endLine: end
        };
    }

    private resolveUri(filePath: string): vscode.Uri {
        if (path.isAbsolute(filePath)) {
            return vscode.Uri.file(filePath);
        }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('没有打开的工作区');
        }
        return vscode.Uri.joinPath(workspaceFolder.uri, filePath);
    }
}

/**
 * 写入文件工具
 */
export class WriteFileTool extends BaseTool {
    definition: ToolDefinition = {
        name: 'write_file',
        description: '创建或覆盖文件内容',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '文件的绝对路径或相对于工作区的路径'
                },
                content: {
                    type: 'string',
                    description: '要写入的内容'
                }
            },
            required: ['path', 'content']
        }
    };

    async execute(params: Record<string, unknown>): Promise<unknown> {
        this.validateParams(params);
        
        const filePath = params.path as string;
        const content = params.content as string;

        const uri = this.resolveUri(filePath);
        const data = Buffer.from(content, 'utf8');
        await vscode.workspace.fs.writeFile(uri, data);

        return { success: true, path: uri.fsPath };
    }

    private resolveUri(filePath: string): vscode.Uri {
        if (path.isAbsolute(filePath)) {
            return vscode.Uri.file(filePath);
        }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('没有打开的工作区');
        }
        return vscode.Uri.joinPath(workspaceFolder.uri, filePath);
    }
}

/**
 * 列出目录工具
 */
export class ListDirectoryTool extends BaseTool {
    definition: ToolDefinition = {
        name: 'list_directory',
        description: '列出目录中的文件和子目录',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '目录的绝对路径或相对于工作区的路径'
                },
                recursive: {
                    type: 'boolean',
                    description: '是否递归列出子目录',
                    default: false
                }
            },
            required: ['path']
        }
    };

    async execute(params: Record<string, unknown>): Promise<unknown> {
        this.validateParams(params);
        
        const dirPath = params.path as string;
        const recursive = params.recursive as boolean || false;

        const uri = this.resolveUri(dirPath);
        const entries = await this.listDir(uri, recursive);

        return { entries };
    }

    private async listDir(uri: vscode.Uri, recursive: boolean): Promise<FileInfo[]> {
        const entries = await vscode.workspace.fs.readDirectory(uri);
        const result: FileInfo[] = [];

        for (const [name, type] of entries) {
            const entryUri = vscode.Uri.joinPath(uri, name);
            const isDirectory = type === vscode.FileType.Directory;
            
            const info: FileInfo = {
                path: entryUri.fsPath,
                name,
                isDirectory
            };

            if (!isDirectory) {
                try {
                    const stat = await vscode.workspace.fs.stat(entryUri);
                    info.size = stat.size;
                    info.modifiedTime = new Date(stat.mtime).toISOString();
                } catch {
                    // 忽略无法获取状态的文件
                }
            }

            result.push(info);

            if (recursive && isDirectory) {
                const subEntries = await this.listDir(entryUri, true);
                result.push(...subEntries);
            }
        }

        return result;
    }

    private resolveUri(filePath: string): vscode.Uri {
        if (path.isAbsolute(filePath)) {
            return vscode.Uri.file(filePath);
        }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('没有打开的工作区');
        }
        return vscode.Uri.joinPath(workspaceFolder.uri, filePath);
    }
}

/**
 * 删除文件工具
 */
export class DeleteFileTool extends BaseTool {
    definition: ToolDefinition = {
        name: 'delete_file',
        description: '删除指定的文件或目录',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '文件或目录的绝对路径或相对于工作区的路径'
                },
                recursive: {
                    type: 'boolean',
                    description: '如果是目录，是否递归删除',
                    default: false
                }
            },
            required: ['path']
        }
    };

    async execute(params: Record<string, unknown>): Promise<unknown> {
        this.validateParams(params);
        
        const filePath = params.path as string;
        const recursive = params.recursive as boolean || false;

        const uri = this.resolveUri(filePath);
        await vscode.workspace.fs.delete(uri, { recursive });

        return { success: true, path: uri.fsPath };
    }

    private resolveUri(filePath: string): vscode.Uri {
        if (path.isAbsolute(filePath)) {
            return vscode.Uri.file(filePath);
        }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('没有打开的工作区');
        }
        return vscode.Uri.joinPath(workspaceFolder.uri, filePath);
    }
}
