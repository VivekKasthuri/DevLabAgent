// electron/server-entry.js — CJS wrapper so Electron can spawn the ESM server
// This file is CommonJS so it can be spawned directly by Electron's node
import('../ui/server.js').then(({ startUI }) => {
  const projectPath = process.env.PROJECT_PATH || process.cwd();
  return startUI(projectPath);
}).catch(err => {
  console.error('Server error:', err.message);
  process.exit(1);
});
