#!/usr/bin/env node
import readline from 'readline';
import path from 'path';
import { runLoginFlow as runAiStudioLogin } from './ai-studio.login.js';
import { runLoginFlow as runGeminiLogin } from './gemini.login.js';
import { runLoginFlow as runDeepseekLogin } from './deepseek.login.js';
import { DeepSeekProvider } from './deepseek.provider.js';
import { GeminiProvider } from './gemini.provider.js';
import { startServer, type ProviderSelection, type StartServerConfig } from './server.js';
import { AiStudioProvider } from './ai-studio.provider.js';
import { BROWSER_DATA_PATH } from './utils.js';

export interface ProviderOption extends ProviderSelection {
  runLoginFlow: (path: string, extensionPath?: string) => Promise<void>;
}

const AVAILABLE_PROVIDERS: ProviderOption[] = [
  {
    name: 'DeepSeek Chat',
    provider: new DeepSeekProvider(),
    runLoginFlow: runDeepseekLogin,
  },
  {
    name: 'Google AI Studio',
    provider: new AiStudioProvider(),
    runLoginFlow: runAiStudioLogin,
    extensionPath: '../proton_vpn'
  },
  {
    name: 'Google Gemini',
    provider: new GeminiProvider(),
    runLoginFlow: runGeminiLogin,
  },
];

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): StartServerConfig {
  const config: StartServerConfig = {
    port: Number(process.env.PORT) || 5000,
    poolSize: Number(process.env.POOL_SIZE) || 2,
    headless: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-p':
      case '--port':
        config.port = Number(argv[++i]);
        break;
      case '--pool-size':
        config.poolSize = Number(argv[++i]);
        break;
      case '--headful':
        config.headless = false;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
    }
  }

  if (Number.isNaN(config.port)) {
    throw new Error('Invalid port value');
  }
  if (Number.isNaN(config.poolSize)) {
    throw new Error('Invalid pool size value');
  }

  return config;
}

function printHelp(): void {
  console.log('Usage: npx --allow-git all -y github:Quicksilver0218/AI-Web-to-API [options]');
  console.log('');
  console.log('Options:');
  console.log('  -p, --port <number>      Port to listen on (default: 5000)');
  console.log('  --pool-size <number>     Number of browser tabs in the pool (default: 2)');
  console.log('  --headful                Run in headful mode (default: headless)');
  console.log('  -h, --help               Display this help message');
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

function promptProviderSelection(): Promise<ProviderOption> {
  return new Promise<ProviderOption>((resolve) => {
    let selectedIndex = 0;

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    const renderMenu = () => {
      console.clear();
      console.log('======================================================');
      console.log(' Select an AI Web Provider (Up/Down Arrow + Enter):');
      console.log('======================================================\n');

      AVAILABLE_PROVIDERS.forEach((item, idx) => {
        if (idx === selectedIndex) {
          console.log(` \x1b[36m> [o] ${item.name}\x1b[0m`);
        } else {
          console.log(`   [ ] ${item.name}`);
        }
      });

      console.log('\n(Press Ctrl+C to cancel)');
    };

    renderMenu();

    const handleKeypress = (_str: string, key: readline.Key) => {
      if (key.ctrl && key.name === 'c') {
        process.exit(0);
      }

      if (key.name === 'up') {
        selectedIndex = (selectedIndex - 1 + AVAILABLE_PROVIDERS.length) % AVAILABLE_PROVIDERS.length;
        renderMenu();
      } else if (key.name === 'down') {
        selectedIndex = (selectedIndex + 1) % AVAILABLE_PROVIDERS.length;
        renderMenu();
      } else if (key.name === 'return' || key.name === 'enter') {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.removeListener('keypress', handleKeypress);
        console.clear();
        resolve(AVAILABLE_PROVIDERS[selectedIndex]);
      }
    };

    process.stdin.on('keypress', handleKeypress);
  });
}

async function promptStartOrLogin(selected: ProviderOption): Promise<void> {
  const label = `${selected.name}`;
  const options = [
    { value: 'start', label: 'Start server now' },
    { value: 'login', label: `Log in to ${label}` },
  ];

  const choice = await new Promise<string>((resolve) => {
    let selectedIndex = 0;

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    const renderMenu = () => {
      console.clear();
      console.log('======================================================');
      console.log(` What would you like to do for ${label}?`);
      console.log('======================================================\n');

      options.forEach((item, idx) => {
        if (idx === selectedIndex) {
          console.log(` \x1b[36m> [o] ${item.label}\x1b[0m`);
        } else {
          console.log(`   [ ] ${item.label}`);
        }
      });

      console.log('\n(Press Ctrl+C to cancel)');
    };

    renderMenu();

    const handleKeypress = (_str: string, key: readline.Key) => {
      if (key.ctrl && key.name === 'c') {
        process.exit(0);
      }

      if (key.name === 'up') {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        renderMenu();
      } else if (key.name === 'down') {
        selectedIndex = (selectedIndex + 1) % options.length;
        renderMenu();
      } else if (key.name === 'return' || key.name === 'enter') {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.removeListener('keypress', handleKeypress);
        console.clear();
        resolve(options[selectedIndex].value);
      }
    };

    process.stdin.on('keypress', handleKeypress);
  });

  if (choice === 'login') {
    console.log(`[Login] Running login flow for ${label}...`);
    await selected.runLoginFlow(BROWSER_DATA_PATH, selected.extensionPath && path.join(import.meta.dirname, selected.extensionPath));
    console.log(`[Login] ${label} login complete.\n`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));

  const selected = await promptProviderSelection();

  console.log(`[Startup] Selected Provider: ${selected.name}`);
  await promptStartOrLogin(selected);

  await startServer(selected, config);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[Fatal Error]:', message);
  process.exit(1);
});
