/**
 * Step: environment — Detect OS, Node, container runtimes, existing config.
 * Replaces 01-check-environment.sh
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { logger } from '../src/logger.js';
import { commandExists, getPlatform, isHeadless, isWSL } from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  logger.info('Starting environment check');

  const platform = getPlatform();
  const wsl = isWSL();
  const headless = isHeadless();

  // Check Apple Container
  let appleContainer: 'installed' | 'not_found' = 'not_found';
  if (commandExists('container')) {
    appleContainer = 'installed';
  }

  // Check Docker
  let docker: 'running' | 'installed_not_running' | 'not_found' = 'not_found';
  if (commandExists('docker')) {
    try {
      const { execSync } = await import('child_process');
      execSync('docker info', { stdio: 'ignore' });
      docker = 'running';
    } catch {
      docker = 'installed_not_running';
    }
  }

  // Check acli (Rovo Dev CLI)
  let acli: 'installed' | 'not_found' = 'not_found';
  if (commandExists('acli')) {
    acli = 'installed';
  }

  // Detect configured agent backend from .env
  let agentBackend: 'claude' | 'rovodev' | 'none' = 'none';
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const match = envContent.match(/^AGENT_BACKEND=(\S+)/m);
    if (match) {
      agentBackend = match[1].toLowerCase() === 'rovodev' ? 'rovodev' : 'claude';
    }
  }

  // Check Rovo Dev auth status
  let rovodevAuth: 'authenticated' | 'not_authenticated' | 'not_installed' =
    'not_installed';
  if (acli === 'installed') {
    try {
      const { execSync } = await import('child_process');
      const authOutput = execSync('acli rovodev auth status 2>&1', {
        encoding: 'utf-8',
        timeout: 10000,
      });
      rovodevAuth = authOutput.includes('Authenticated')
        ? 'authenticated'
        : 'not_authenticated';
    } catch {
      rovodevAuth = 'not_authenticated';
    }
  }

  // Check existing config
  const hasEnv = fs.existsSync(envPath);

  const authDir = path.join(projectRoot, 'store', 'auth');
  const hasAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;

  let hasRegisteredGroups = false;
  // Check JSON file first (pre-migration)
  if (fs.existsSync(path.join(projectRoot, 'data', 'registered_groups.json'))) {
    hasRegisteredGroups = true;
  } else {
    // Check SQLite directly using better-sqlite3 (no sqlite3 CLI needed)
    const dbPath = path.join(STORE_DIR, 'messages.db');
    if (fs.existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true });
        const row = db
          .prepare('SELECT COUNT(*) as count FROM registered_groups')
          .get() as { count: number };
        if (row.count > 0) hasRegisteredGroups = true;
        db.close();
      } catch {
        // Table might not exist yet
      }
    }
  }

  logger.info(
    {
      platform,
      wsl,
      appleContainer,
      docker,
      acli,
      agentBackend,
      rovodevAuth,
      hasEnv,
      hasAuth,
      hasRegisteredGroups,
    },
    'Environment check complete',
  );

  emitStatus('CHECK_ENVIRONMENT', {
    PLATFORM: platform,
    IS_WSL: wsl,
    IS_HEADLESS: headless,
    APPLE_CONTAINER: appleContainer,
    DOCKER: docker,
    ACLI: acli,
    AGENT_BACKEND: agentBackend,
    ROVODEV_AUTH: rovodevAuth,
    HAS_ENV: hasEnv,
    HAS_AUTH: hasAuth,
    HAS_REGISTERED_GROUPS: hasRegisteredGroups,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
