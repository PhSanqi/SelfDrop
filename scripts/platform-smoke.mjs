import { showConfig } from '../selfdrop-agent.mjs';

const config = await showConfig();

if (config.endpoint !== null || config.mode !== 'default-local') {
  throw new Error(`unexpected default config state: ${JSON.stringify(config)}`);
}

const normalized = config.configPath.replace(/\\/g, '/').toLowerCase();

if (process.platform === 'win32') {
  if (!normalized.endsWith('/selfdrop/agent.json')) {
    throw new Error(`unexpected Windows config path: ${config.configPath}`);
  }
} else if (!normalized.endsWith('/selfdrop/agent.json')) {
  throw new Error(`unexpected Unix config path: ${config.configPath}`);
}

console.log(`platform-smoke: ${process.platform} ${process.arch} PASS`);
