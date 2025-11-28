#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 颜色输出工具
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// 读取package.json获取版本信息
function getPackageInfo() {
  const packagePath = path.join(__dirname, '..', 'package.json');
  return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
}

// 检查当前分支是否为main/master
function checkBranch() {
  try {
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    if (currentBranch !== 'main' && currentBranch !== 'master') {
      log(`警告: 当前分支为 '${currentBranch}'，建议在 main/master 分支发布`, 'yellow');
      return false;
    }
    return true;
  } catch (error) {
    log('无法获取当前分支信息', 'red');
    return false;
  }
}

// 检查工作区是否干净
function checkWorkingTreeClean() {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf8' });
    if (status.trim()) {
      log('工作区存在未提交的更改:', 'yellow');
      log(status);
      log('请先提交所有更改后再发布', 'red');
      return false;
    }
    return true;
  } catch (error) {
    log('无法检查git状态', 'red');
    return false;
  }
}

// 运行测试
function runTests() {
  log('🧪 运行测试...', 'blue');
  try {
    execSync('npm test', { stdio: 'inherit' });
    log('✅ 所有测试通过', 'green');
    return true;
  } catch (error) {
    log('❌ 测试失败', 'red');
    return false;
  }
}

// 代码检查
function runLint() {
  log('🔍 运行代码检查...', 'blue');
  try {
    execSync('npm run lint', { stdio: 'inherit' });
    log('✅ 代码检查通过', 'green');
    return true;
  } catch (error) {
    log('❌ 代码检查失败', 'red');
    return false;
  }
}

// 构建项目
function buildProject() {
  log('🔨 构建项目...', 'blue');
  try {
    execSync('npm run package', { stdio: 'inherit' });
    log('✅ 项目构建成功', 'green');
    return true;
  } catch (error) {
    log('❌ 项目构建失败', 'red');
    return false;
  }
}

// 更新CHANGELOG版本号
function updateChangelog(version) {
  const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    log('⚠️ CHANGELOG.md 不存在，跳过更新', 'yellow');
    return true;
  }

  log('📝 更新CHANGELOG...', 'blue');
  try {
    let content = fs.readFileSync(changelogPath, 'utf8');
    const today = new Date().toISOString().split('T')[0];

    // 检查是否已有当前版本的changelog
    const versionHeader = `## [${version}]`;
    if (!content.includes(versionHeader)) {
      // 在第一个版本条目之前插入新版本
      const insertIndex = content.indexOf('## [');
      const newVersionEntry = `${versionHeader} - ${today}\n\n### 新增功能\n\n### 修复问题\n\n### 技术细节\n\n`;

      if (insertIndex !== -1) {
        content = content.slice(0, insertIndex) + newVersionEntry + content.slice(insertIndex);
      } else {
        content += newVersionEntry;
      }

      fs.writeFileSync(changelogPath, content);
      log(`✅ CHANGELOG已更新至版本 ${version}`, 'green');
    } else {
      log(`✅ CHANGELOG中已存在版本 ${version}`, 'green');
    }
    return true;
  } catch (error) {
    log(`❌ 更新CHANGELOG失败: ${error.message}`, 'red');
    return false;
  }
}

// 创建Git标签
function createGitTag(version) {
  log(`🏷️ 创建Git标签 v${version}...`, 'blue');
  try {
    execSync(`git tag -a v${version} -m "发布版本 v${version}"`, { stdio: 'inherit' });
    log(`✅ Git标签 v${version} 创建成功`, 'green');
    return true;
  } catch (error) {
    log(`❌ 创建Git标签失败: ${error.message}`, 'red');
    return false;
  }
}

// 提交CHANGELOG和标签
function commitChanges(version) {
  log('📤 提交更改...', 'blue');
  try {
    execSync('git add CHANGELOG.md', { stdio: 'inherit' });
    execSync(`git commit -m "更新CHANGELOG至版本 v${version}"`, { stdio: 'inherit' });
    log('✅ 更改提交成功', 'green');
    return true;
  } catch (error) {
    log(`❌ 提交更改失败: ${error.message}`, 'red');
    return false;
  }
}

// 推送到远程仓库
function pushToRemote(version) {
  log(`🚀 推送到远程仓库...`, 'blue');
  try {
    execSync('git push', { stdio: 'inherit' });
    execSync(`git push origin v${version}`, { stdio: 'inherit' });
    log('✅ 推送成功', 'green');
    return true;
  } catch (error) {
    log(`❌ 推送失败: ${error.message}`, 'red');
    return false;
  }
}

// 发布到VS Code市场
function publishToVSCode() {
  log('📦 发布到VS Code市场...', 'blue');
  try {
    // 检查是否安装了vsce
    execSync('vsce --version', { stdio: 'pipe' });

    execSync('vsce publish', { stdio: 'inherit' });
    log('✅ 成功发布到VS Code市场', 'green');
    return true;
  } catch (error) {
    if (error.stderr && error.stderr.includes('vsce: command not found')) {
      log('❌ 未找到vsce工具，请先安装: npm install -g vsce', 'red');
    } else {
      log(`❌ 发布到VS Code市场失败: ${error.message}`, 'red');
    }
    return false;
  }
}

// 主发布流程
async function main() {
  const startTime = Date.now();

  log('🚀 AIAT VS Code扩展一键发布工具', 'cyan');
  log('='.repeat(50), 'cyan');

  const packageInfo = getPackageInfo();
  const version = packageInfo.version;

  log(`📦 当前版本: ${packageInfo.displayName} v${version}`, 'blue');
  log(`👤 发布者: ${packageInfo.publisher}`, 'blue');

  // 检查步骤
  const checks = [
    { name: '检查分支', fn: checkBranch, required: false },
    { name: '检查工作区', fn: checkWorkingTreeClean, required: true },
    { name: '运行测试', fn: runTests, required: true },
    { name: '代码检查', fn: runLint, required: true },
    { name: '构建项目', fn: buildProject, required: true }
  ];

  for (const check of checks) {
    if (!check.fn()) {
      if (check.required) {
        log(`❌ ${check.name}失败，发布中断`, 'red');
        process.exit(1);
      }
    }
  }

  // 发布步骤
  const publishSteps = [
    { name: '更新CHANGELOG', fn: () => updateChangelog(version) },
    { name: '创建Git标签', fn: () => createGitTag(version) },
    { name: '提交更改', fn: () => commitChanges(version) },
    { name: '推送到远程', fn: () => pushToRemote(version) },
    { name: '发布到VS Code市场', fn: publishToVSCode, required: false }
  ];

  for (const step of publishSteps) {
    if (!step.fn()) {
      if (step.required) {
        log(`❌ ${step.name}失败，发布中断`, 'red');
        process.exit(1);
      } else {
        log(`⚠️ ${step.name}失败，但继续发布流程`, 'yellow');
      }
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  log(`🎉 发布完成！用时: ${duration}秒`, 'green');
  log(`📱 扩展将在几分钟后在VS Code市场可用: https://marketplace.visualstudio.com/items?itemName=${packageInfo.publisher}.${packageInfo.name}`, 'cyan');
}

// 运行主程序
if (require.main === module) {
  main().catch(error => {
    log(`❌ 发布过程中发生错误: ${error.message}`, 'red');
    process.exit(1);
  });
}

module.exports = { main };