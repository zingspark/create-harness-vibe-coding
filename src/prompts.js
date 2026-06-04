import * as p from '@clack/prompts';
import pc from 'picocolors';

export async function askProjectName() {
  const name = await p.text({
    message: 'Project name?',
    placeholder: 'my-vibe-project',
    defaultValue: 'my-vibe-project',
    validate(value) {
      if (!value.trim()) return 'Project name is required';
      if (!/^[a-zA-Z0-9_-]+$/.test(value)) return 'Only letters, numbers, hyphens, and underscores allowed';
      return;
    },
  });

  if (p.isCancel(name)) {
    p.cancel('Cancelled');
    process.exit(0);
  }

  return name.trim();
}

export async function askTargetDir(projectName) {
  const dir = await p.text({
    message: 'Target directory?',
    placeholder: `./${projectName}`,
    defaultValue: `./${projectName}`,
    validate(value) {
      if (!value.trim()) return 'Directory is required';
      return;
    },
  });

  if (p.isCancel(dir)) {
    p.cancel('Cancelled');
    process.exit(0);
  }

  return dir.trim();
}
