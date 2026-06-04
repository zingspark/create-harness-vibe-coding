#!/usr/bin/env node
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { askProjectName, askTargetDir } from './prompts.js';
import { generate } from './generator.js';

// Parse CLI args for non-interactive mode
const args = process.argv.slice(2);
const argName = args[0];
const argDir = args[1];

console.log('');
console.log(pc.magenta('╔══════════════════════════════════════════╗'));
console.log(pc.magenta('║   🎯 create-harness-vibe-coding          ║'));
console.log(pc.magenta('║   Agentic Harness — Vibe Coding Ready    ║'));
console.log(pc.magenta('╚══════════════════════════════════════════╝'));
console.log('');

let projectName, targetDir;

// Non-interactive mode: use CLI args or defaults
if (argName) {
  projectName = argName;
  targetDir = argDir || `./${projectName}`;

  console.log(pc.dim('────────────────────────────────────────────'));
  console.log(`  Project     ${pc.green(projectName)}`);
  console.log(`  Directory   ${pc.green(targetDir)}`);
  console.log(`  Creates     ${pc.cyan('CLAUDE.md, docs/, .claude/, SETUP.md, tests/')}`);
  console.log(pc.dim('────────────────────────────────────────────'));
  console.log('');

  const result = generate({ projectName, targetDir });
  printResult(result, targetDir);
} else {
  // Interactive mode
  try {
    projectName = await askProjectName();
  } catch {
    projectName = 'my-vibe-project';
    console.log(pc.dim(`  Project: ${projectName} (default)`));
  }

  try {
    targetDir = await askTargetDir(projectName);
  } catch {
    targetDir = `./${projectName}`;
    console.log(pc.dim(`  Directory: ${targetDir} (default)`));
  }

  console.log('');
  console.log(pc.dim('────────────────────────────────────────────'));
  console.log(`  Project     ${pc.green(projectName)}`);
  console.log(`  Directory   ${pc.green(targetDir)}`);
  console.log(`  Creates     ${pc.cyan('CLAUDE.md, docs/, .claude/, SETUP.md, tests/')}`);
  console.log(pc.dim('────────────────────────────────────────────'));
  console.log('');

  let proceed = true;
  try {
    proceed = await p.confirm({
      message: 'Confirm generation?',
      initialValue: true,
    });
    if (p.isCancel(proceed)) proceed = false;
  } catch {
    proceed = true;
  }

  if (!proceed) {
    p.cancel('Cancelled');
    process.exit(0);
  }

  console.log('');
  const result = generate({ projectName, targetDir });
  printResult(result, targetDir);
}

function printResult(result, targetDir) {
  if (result.success) {
    console.log(pc.green(`\n✅ Project created! ${result.created.length} files\n`));

    console.log(pc.bold('Next steps:'));
    console.log(`  ${pc.cyan(`cd ${targetDir}`)}`);
    console.log(`  ${pc.cyan('claude')}                          # Start Claude Code`);
    console.log(`  Tell Claude: "${pc.yellow('Read SETUP.md and initialize this project')}"`);
    console.log('');
    console.log(pc.dim('  SETUP.md is temporary. Delete it after initialization.'));
    console.log('');

    if (result.errors.length > 0) {
      console.log(pc.red(`\n⚠ ${result.errors.length} warning(s):`));
      for (const err of result.errors) {
        console.log(pc.red(`  - ${err}`));
      }
    }
  } else {
    console.log(pc.red('\n❌ Generation failed:'));
    for (const err of result.errors) {
      console.log(pc.red(`  - ${err}`));
    }
    process.exit(1);
  }
}
