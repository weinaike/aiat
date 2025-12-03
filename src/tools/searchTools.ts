import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolDefinition, SearchResult } from '../types';

/**
 * 文本搜索工具
 */
export class TextSearchTool extends BaseTool {
    definition: ToolDefinition = {
        name: 'text_search',
        description: '在工作区中搜索文本内容',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: '搜索的文本或正则表达式'
                },
                isRegex: {
                    type: 'boolean',
                    description: '是否使用正则表达式',
                    default: false
                },
                includePattern: {
                    type: 'string',
                    description: '包含的文件模式（glob）',
                    default: '**/*'
                },
                excludePattern: {
                    type: 'string',
                    description: '排除的文件模式（glob）',
                    default: '**/node_modules/**'
                },
                maxResults: {
                    type: 'number',
                    description: '最大结果数',
                    default: 100
                }
            },
            required: ['query']
        }
    };

    async execute(params: Record<string, unknown>): Promise<unknown> {
        this.validateParams(params);
        
        const query = params.query as string;
        const isRegex = params.isRegex as boolean || false;
        const includePattern = params.includePattern as string || '**/*';
        const excludePattern = params.excludePattern as string || '**/node_modules/**';
        const maxResults = params.maxResults as number || 100;

        const results: SearchResult[] = [];
        
        // 使用 vscode.workspace.findFiles 和文件读取来实现搜索
        const files = await vscode.workspace.findFiles(includePattern, excludePattern, 1000);
        
        const pattern = isRegex ? new RegExp(query, 'gi') : null;
        
        for (const file of files) {
            if (results.length >= maxResults) {break;}
            
            try {
                const content = await vscode.workspace.fs.readFile(file);
                const text = Buffer.from(content).toString('utf8');
                const lines = text.split('\n');
                
                for (let i = 0; i < lines.length; i++) {
                    if (results.length >= maxResults) {break;}
                    
                    const line = lines[i];
                    let match = false;
                    let column = 0;
                    
                    if (pattern) {
                        const m = pattern.exec(line);
                        if (m) {
                            match = true;
                            column = m.index + 1;
                        }
                        pattern.lastIndex = 0; // 重置正则状态
                    } else {
                        const idx = line.toLowerCase().indexOf(query.toLowerCase());
                        if (idx !== -1) {
                            match = true;
                            column = idx + 1;
                        }
                    }
                    
                    if (match) {
                        results.push({
                            file: file.fsPath,
                            line: i + 1,
                            column,
                            content: line,
                            preview: line.trim().substring(0, 200)
                        });
                    }
                }
            } catch {
                // 忽略无法读取的文件
            }
        }

        return { results, totalCount: results.length };
    }
}

/**
 * 文件搜索工具
 */
export class FileSearchTool extends BaseTool {
    definition: ToolDefinition = {
        name: 'glob_search',
        description: '按文件名模式搜索文件',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: '文件名匹配模式（glob）'
                },
                excludePattern: {
                    type: 'string',
                    description: '排除的文件模式（glob）',
                    default: '**/node_modules/**'
                },
                maxResults: {
                    type: 'number',
                    description: '最大结果数',
                    default: 100
                }
            },
            required: ['pattern']
        }
    };

    async execute(params: Record<string, unknown>): Promise<unknown> {
        this.validateParams(params);
        
        const pattern = params.pattern as string;
        const excludePattern = params.excludePattern as string || '**/node_modules/**';
        const maxResults = params.maxResults as number || 100;

        const files = await vscode.workspace.findFiles(
            pattern,
            excludePattern,
            maxResults
        );

        return {
            files: files.map(uri => ({
                path: uri.fsPath,
                name: uri.path.split('/').pop()
            })),
            totalCount: files.length
        };
    }
}

/**
 * 符号搜索工具
 */
export class SymbolSearchTool extends BaseTool {
    definition: ToolDefinition = {
        name: 'symbol_search',
        description: '搜索代码符号（函数、类、变量等）',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: '符号名称或部分名称'
                },
                maxResults: {
                    type: 'number',
                    description: '最大结果数',
                    default: 50
                }
            },
            required: ['query']
        }
    };

    async execute(params: Record<string, unknown>): Promise<unknown> {
        this.validateParams(params);
        
        const query = params.query as string;
        const maxResults = params.maxResults as number || 50;

        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            query
        );

        const results = (symbols || []).slice(0, maxResults).map(symbol => ({
            name: symbol.name,
            kind: vscode.SymbolKind[symbol.kind],
            containerName: symbol.containerName,
            location: {
                file: symbol.location.uri.fsPath,
                line: symbol.location.range.start.line + 1,
                column: symbol.location.range.start.character + 1
            }
        }));

        return { results, totalCount: results.length };
    }
}

/**
 * 环境信息工具
 */
export class GetEnvironmentTool extends BaseTool {
    definition: ToolDefinition = {
        name: 'get_environment',
        description: '获取系统与开发环境信息',
        inputSchema: {
            type: 'object',
            properties: {},
        }
    };

    async execute(_params: any): Promise<any> {
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        const activeTextEditor = vscode.window.activeTextEditor;

        // 获取环境信息
        const env = process.env;

        // 获取Node.js版本
        const nodeVersion = process.version;

        // 获取平台信息
        const platform = {
            os: process.platform,
            arch: process.arch,
            version: require('os').release(),
            hostname: require('os').hostname(),
            totalMemory: require('os').totalmem(),
            freeMemory: require('os').freemem(),
            cpus: require('os').cpus().length
        };

        // 获取VS Code版本
        const vscodeVersion = vscode.version;

        // 获取工作区信息
        const workspaceInfo = workspaceFolders.map(folder => ({
            name: folder.name,
            path: folder.uri.fsPath,
            uri: folder.uri.toString()
        }));

        // 获取当前文件信息
        const currentFile = activeTextEditor ? {
            path: activeTextEditor.document.uri.fsPath,
            language: activeTextEditor.document.languageId,
            lineCount: activeTextEditor.document.lineCount,
            fileName: activeTextEditor.document.fileName
        } : null;

        // 获取配置信息
        const config = vscode.workspace.getConfiguration();
        const aiatConfig = {
            agentServer: config.get('aiat.agentServer.url'),
            autoConnect: config.get('aiat.agentServer.autoConnect'),
            mcpTunnel: 'always enabled'
        };

        // 获取扩展信息
        const extensions = vscode.extensions.all.map(ext => ({
            name: ext.id,
            version: ext.packageJSON?.version,
            isActive: ext.isActive
        }));

        return {
            timestamp: new Date().toISOString(),
            environment: {
                node: nodeVersion,
                vscode: vscodeVersion,
                platform
            },
            workspace: {
                folders: workspaceInfo,
                currentFile,
                config: aiatConfig
            },
            system: {
                path: env.PATH,
                home: env.HOME || env.USERPROFILE,
                shell: env.SHELL || env.COMSPEC,
                workspaceRoot: workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : null
            },
            extensions: {
                total: extensions.length,
                active: extensions.filter(ext => ext.isActive).length,
                installed: extensions.slice(0, 50) // 限制返回数量
            }
        };
    }
}
