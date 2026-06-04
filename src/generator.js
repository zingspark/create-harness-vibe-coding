import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates', 'common');

/**
 * Copy a directory recursively, replacing {{vars}} in file contents.
 */
function copyDir(src, dest, vars) {
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, vars);
    } else {
      let content = fs.readFileSync(srcPath, 'utf-8');

      // Replace template variables
      for (const [key, value] of Object.entries(vars)) {
        content = content.replaceAll(`{{${key}}}`, value);
      }

      fs.writeFileSync(destPath, content, 'utf-8');
    }
  }
}

/**
 * Walk a directory and return relative paths of all files.
 */
function walkFiles(dir, base = dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, base));
    } else {
      results.push(path.relative(base, full));
    }
  }

  return results;
}

export function generate({ projectName, targetDir }) {
  const created = [];
  const errors = [];

  // Resolve targetDir relative to cwd
  const resolvedDir = path.resolve(process.cwd(), targetDir);

  // Check if target exists and is non-empty
  if (fs.existsSync(resolvedDir)) {
    const existing = fs.readdirSync(resolvedDir).filter(f => f !== '.git');
    if (existing.length > 0) {
      console.log(pc.yellow(`⚠ Directory "${targetDir}" already exists and is not empty. Files may be overwritten.`));
    }
  }

  const vars = { projectName };

  try {
    // 1. Copy all template files
    console.log(pc.cyan('📋 Copying templates...'));
    copyDir(TEMPLATES_DIR, resolvedDir, vars);

    // List all created files from templates
    created.push(...walkFiles(TEMPLATES_DIR).map(f => f.replace(/\\/g, '/')));

    // 2. Create empty directories
    console.log(pc.cyan('📁 Creating placeholder directories...'));
    const emptyDirs = [
      '.claude/agents',
      '.claude/skills',
      '.claude/hooks',
      'tests',
    ];

    for (const dir of emptyDirs) {
      const dirPath = path.join(resolvedDir, dir);
      fs.mkdirSync(dirPath, { recursive: true });
      created.push(`${dir}/ (empty)`);
    }

    // 3. Create .gitkeep in tests/
    const gitkeepPath = path.join(resolvedDir, 'tests', '.gitkeep');
    fs.writeFileSync(gitkeepPath, '', 'utf-8');
    created.push('tests/.gitkeep');

    return { success: true, created, errors };

  } catch (err) {
    errors.push(err.message);
    return { success: false, created, errors };
  }
}
