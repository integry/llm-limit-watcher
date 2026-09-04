const { BaseAgent } = require('./base.js');
const logger = require('../logger.js');
const { JsonRpcClient } = require('../json-rpc-client.js');
const {
  formatRpcResponseAsOutput,
  parseRpcRateLimits,
} = require('./codex-rpc-helpers.js');
const {
  parseResetTime,
  parseLimitEntry,
  parseVersionInfo,
  parseModelLimits,
  extractMetadataFromOutput,
} = require('./codex-pty-helpers.js');
const { pingKeepalive } = require('./keepalive-helper.js');
const { version: packageVersion } = require('../../package.json');

class CodexAgent extends BaseAgent {
  constructor() {
    super('codex', 'codex');
    this._rpcClient = null;
    this._rpcSupported = null; // null = unknown, true/false = tested
  }

  getTimeout() { return 25000; }

  /**
   * Override runCommand to attempt JSON-RPC first, then fall back to PTY
   */
  async runCommand() {
    if (this._rpcSupported === false) {
      return this._runWithPty();
    }

    try {
      const result = await this._runWithJsonRpc();
      this._rpcSupported = true;
      return result;
    } catch (err) {
      if (this._rpcSupported === null) {
        console.log(`[${this.name}] JSON-RPC not available, falling back to PTY: ${err.message}`);
        this._rpcSupported = false;
      }
      return this._runWithPty();
    }
  }

  /**
   * Run using JSON-RPC app-server mode
   */
  async _runWithJsonRpc() {
    console.log(`[${this.name}] Attempting JSON-RPC mode...`);

    if (this._rpcClient) {
      this._rpcClient.stop();
      this._rpcClient = null;
    }

    this._rpcClient = new JsonRpcClient('codex', ['app-server'], {
      cwd: '/tmp',
      timeout: this.getTimeout(),
    });

    try {
      await this._rpcClient.start();
      console.log(`[${this.name}] JSON-RPC server started`);

      await this._rpcClient.call('initialize', {
        clientInfo: {
          name: 'agent_tank',
          title: 'Agent Tank',
          version: packageVersion,
        },
      });
      this._rpcClient.notify('initialized', {});

      const rateLimits = await this._rpcClient.call('account/rateLimits/read', {});
      console.log(`[${this.name}] Received rate limits via JSON-RPC:`, JSON.stringify(rateLimits));

      const { marker, data } = formatRpcResponseAsOutput(rateLimits);
      this._rpcRateLimits = data;
      return marker;
    } finally {
      if (this._rpcClient) {
        this._rpcClient.stop();
        this._rpcClient = null;
      }
    }
  }

  async _runWithPty() {
    if (this.freshProcess) return this._runCommandFresh();
    if (!this.shell || !this.processReady) await this.spawnProcess();
    return this.sendCommandAndWait();
  }

  handleTrustPrompt(shell, output) {
    if (!shell) return false;
    const patterns = ['Do you trust', 'trust the files', 'trust this folder', 'Trust this workspace', 'allow access'];
    if (!patterns.some(p => output.toLowerCase().includes(p.toLowerCase()))) return false;
    logger.agent(this.name, 'Detected trust prompt, auto-accepting...');
    shell.write('y\r');
    setTimeout(() => { if (shell) { logger.agent(this.name, 'Sending Enter to proceed...'); shell.write('\r'); } }, 500);
    return true;
  }
  handleUpdateScreen(shell, output) {
    if (!shell) return false;
    const clean = this.stripAnsi(output);
    if (!(/u?pdate available/i.test(clean) && /[\d.]+\s*->\s*[\d.]+/.test(clean))) return false;
    logger.agent(this.name, 'Detected update screen, skipping...');
    // v0.115+: may show numbered menu (1. Update, 2. Skip) or just info box
    // Send "2" to select Skip, Enter to confirm, then Escape + Enter to clear any leftover
    shell.write('2');
    setTimeout(() => { if (shell) shell.write('\r'); }, 300);
    setTimeout(() => { if (shell) shell.write('\x1b'); }, 1000);
    setTimeout(() => { if (shell) shell.write('\r'); }, 1500);
    return true;
  }
  parseVersionInfo(output) { return parseVersionInfo(output, this.stripAnsi.bind(this)); }
  isReadyForCommands(output) { return this.isReadyForStatus(output); }
  isReadyForStatus(output) {
    return output.includes('? for shortcuts') || output.includes('To get started') ||
           output.includes('% left') || /›\s*\S/.test(this.stripAnsi(output));
  }
  sendCommands(shell, _output) { logger.agent(this.name, 'Sending /status command...'); setTimeout(() => { if (shell) shell.write('/status\r'); }, 100); }

  _handleAdditionalPrompts(shell, _data, output) {
    if (!shell) return;
    if (!this._updateHandled && this.handleUpdateScreen(shell, output)) { this._updateHandled = true; return; }
    const cleanOutput = this.stripAnsi(output);
    const isUpdateScreen = /u?pdate available/i.test(cleanOutput) && /[\d.]+\s*->\s*[\d.]+/.test(cleanOutput);
    if (!this._continuationHandled && !isUpdateScreen && output.includes('Press enter to continue')) {
      logger.agent(this.name, 'Detected continuation prompt');
      this._continuationHandled = true;
      shell.write('\r');
    }
  }
  handleInteractivePrompts(shell, data, output, state) {
    if (!shell) return false;
    if (!state.trustHandled && this.handleTrustPrompt(shell, output)) { state.trustHandled = true; return true; }
    if (!state.updateHandled && this.handleUpdateScreen(shell, output)) { state.updateHandled = true; return true; }
    this._respondToTerminalQueries(data, shell);
    const cleanOutput = this.stripAnsi(output);
    const isUpdateScreen = /u?pdate available/i.test(cleanOutput) && /[\d.]+\s*->\s*[\d.]+/.test(cleanOutput);
    if (!state.continuationHandled && !isUpdateScreen && output.includes('Press enter to continue')) {
      logger.agent(this.name, 'Detected continuation prompt');
      state.continuationHandled = true;
      shell.write('\r');
    }
    return false;
  }

  async spawnProcess() {
    return new Promise((resolve, reject) => {
      const pty = require('node-pty');
      let spawnOutput = '';
      const state = { trustHandled: false, continuationHandled: false, updateHandled: false };

      logger.agent(this.name, 'Spawning persistent process:', logger.dim(`${this.command} ${this.args.join(' ')}`));

      try {
        this.shell = pty.spawn(this.command, this.args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: '/tmp',
          env: { ...process.env, TERM: 'xterm-256color' },
        });
        if (typeof this.shell.pid === 'number') {
          logger.agent(this.name, 'Persistent process pid:', logger.dim(String(this.shell.pid)));
        }
      } catch (spawnErr) {
        logger.error(`[${this.name}] Failed to spawn:`, spawnErr.message);
        reject(new Error(`Failed to spawn ${this.command}: ${spawnErr.message}`));
        return;
      }

      const timer = setTimeout(() => {
        logger.error(`[${this.name}] Spawn timeout after ${this.getTimeout()}ms`);
        this.killProcess();
        reject(new Error('Timeout waiting for process to become ready'));
      }, this.getTimeout());

      let postPromptOutput = '';
      const spawnDataHandler = this.shell.onData((data) => {
        spawnOutput += data;
        if (this.handleInteractivePrompts(this.shell, data, spawnOutput, state)) {
          postPromptOutput = '';
          return;
        }
        postPromptOutput += data;
        const checkOutput = (state.updateHandled || state.trustHandled) ? postPromptOutput : spawnOutput;
        if (this.isReadyForStatus(checkOutput)) {
          logger.agent(this.name, 'Process ready for commands');
          const versionFromSpawn = this.parseVersionInfo(spawnOutput);
          if (versionFromSpawn) {
            this._spawnVersionInfo = versionFromSpawn;
            logger.agent(this.name, 'Version info from spawn:', logger.json(versionFromSpawn));
          }
          clearTimeout(timer);
          spawnDataHandler.dispose();
          this.processReady = true;
          this._setupPersistentDataHandler();
          this._setupPersistentExitHandler();
          resolve();
        }
      });

      const spawnExitHandler = this.shell.onExit(({ exitCode }) => {
        clearTimeout(timer);
        spawnDataHandler.dispose();
        spawnExitHandler.dispose();
        this.shell = null;
        this.processReady = false;
        reject(new Error(`Process exited during spawn with code ${exitCode}`));
      });
    });
  }

  async sendCommandAndWait() {
    return new Promise((resolve, reject) => {
      this.output = '';
      this._commandInFlight = true;
      let retryTimer = null;
      let settleTimer = null;

      const finish = (result) => {
        this._commandInFlight = false;
        this._onDataCallback = null;
        clearTimeout(timer);
        if (retryTimer) clearInterval(retryTimer);
        if (settleTimer) clearTimeout(settleTimer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        if (retryTimer) clearInterval(retryTimer);
        if (settleTimer) clearTimeout(settleTimer);
        logger.agent(this.name, 'Command timeout after', logger.dim(`${this.getTimeout()}ms`), ', output length:', logger.dim(`${this.output.length}`));
        if (this.output.length > 0) {
          logger.agent(this.name, 'Partial output:', logger.dim(this.stripAnsi(this.output).substring(0, 500)));
          this.writeDebugOutput(this.output);
        }
        if (this.output.length > 100) {
          finish(this.output);
        } else {
          this._commandInFlight = false;
          this._onDataCallback = null;
          reject(new Error('Timeout waiting for usage data'));
        }
      }, this.getTimeout());

      retryTimer = setInterval(() => {
        if (!this.hasCompleteOutput(this.output) && this.shell) {
          logger.agent(this.name, 'Retrying /status...');
          this.output = '';
          this.shell.write('/status');
          setTimeout(() => { if (this.shell) this.shell.write('\r'); }, 200);
        }
      }, 5000);

      this._onDataCallback = () => {
        if (this.hasCompleteOutput(this.output)) {
          if (!settleTimer) {
            logger.agent(this.name, 'Complete output detected, waiting to settle...');
            settleTimer = setTimeout(() => finish(this.output), 200);
          }
        }
      };

      logger.agent(this.name, 'Sending /status to persistent process...');
      setTimeout(() => { if (this.shell) this.shell.write('/status\r'); }, 100);
    });
  }

  hasCompleteOutput(output) {
    if (output.includes('5h limit') && output.includes('Weekly limit')) return true;
    return false;
  }

  parseResetTime(resetStr) {
    return parseResetTime(resetStr);
  }

  parseLimitEntry(match, label, cycleType) {
    return parseLimitEntry(match, label, cycleType);
  }

  parseOutput(output) {
    // Check if this is an RPC response marker
    if (output === '__RPC_RESPONSE__' && this._rpcRateLimits) {
      const context = {
        versionInfo: this._spawnVersionInfo || null,
        parseResetTime: this.parseResetTime.bind(this),
      };
      const { usage, metadataUpdates } = parseRpcRateLimits(this._rpcRateLimits, context);
      this._rpcRateLimits = null;

      // Apply metadata updates
      if (!this.metadata) this.metadata = {};
      Object.assign(this.metadata, metadataUpdates);

      return usage;
    }

    const clean = this.stripAnsi(output);
    const usage = {
      fiveHour: null,
      weekly: null,
      version: (() => {
        const v = { ...this._spawnVersionInfo, ...this.parseVersionInfo(output) };
        return Object.keys(v).length > 0 ? v : null;
      })(),
    };

    const fiveHourMatch = clean.match(/5h limit:\s*\[.*?\]\s*(\d+)%\s*left\s*\(resets\s*([^)]+)\)/i);
    if (fiveHourMatch) {
      usage.fiveHour = this.parseLimitEntry(fiveHourMatch, '5h limit', 'fiveHour');
    }

    const weeklyMatch = clean.match(/Weekly limit:\s*\[.*?\]\s*(\d+)%\s*left\s*\(resets\s*([^)]+)\)/i);
    if (weeklyMatch) {
      usage.weekly = this.parseLimitEntry(weeklyMatch, 'Weekly limit', 'weekly');
    }

    const modelLimits = parseModelLimits(clean);
    if (modelLimits.length > 0) {
      usage.modelLimits = modelLimits;
    }

    const modelMatch = clean.match(/Model:\s*([\w.-]+)/i);
    if (modelMatch) {
      usage.model = this.stripBoxChars(modelMatch[1]);
    }

    const accountMatch = clean.match(/Account:\s*(\S+@\S+)/i);
    if (accountMatch) {
      usage.account = this.stripBoxChars(accountMatch[1]);
    }

    this._updateMetadataFromOutput(clean);

    return usage;
  }

  _updateMetadataFromOutput(clean) {
    if (!this.metadata) this.metadata = {};
    const extracted = extractMetadataFromOutput(clean, this.stripBoxChars.bind(this));
    Object.assign(this.metadata, extracted);
  }

  get usingJsonRpc() {
    return this._rpcSupported;
  }

  setRpcMode(useRpc) {
    this._rpcSupported = useRpc;
  }

  killProcess(options = {}) {
    if (this._rpcClient) {
      this._rpcClient.stop();
      this._rpcClient = null;
    }
    super.killProcess(options);
  }

  /** Lightweight keepalive to prevent session expiration. @returns {Promise<boolean>} True if keepalive succeeded */
  async keepalive() {
    if (this._rpcSupported === true) { console.log(`[${this.name}] Keepalive skipped (JSON-RPC mode)`); return true; }
    if (this.freshProcess) { console.log(`[${this.name}] Keepalive skipped (fresh process mode)`); return true; }
    if (!this.shell || !this.processReady) { console.log(`[${this.name}] Keepalive: spawning process...`); await this.spawnProcess(); }
    if (this.shell) { console.log(`[${this.name}] Keepalive: sending ping...`); this.shell.write('\x1b'); return true; }
    return false;
  }

  /** Spawns fresh CLI, sends /status to refresh session, then tears down cleanly. @returns {Promise<boolean>} */
  async pingKeepalive() {
    if (this._rpcSupported === true) { console.log(`[${this.name}] pingKeepalive: skipped (JSON-RPC mode)`); return true; }
    const state = { trustHandled: false, continuationHandled: false, updateHandled: false };
    return pingKeepalive({
      name: this.name,
      command: this.command,
      args: this.args,
      env: { ...process.env, TERM: 'xterm-256color' },
      termName: 'xterm-256color',
      isReady: (output) => this.isReadyForStatus(output),
      sendCommand: (shell) => setTimeout(() => shell.write('/status\r'), 100),
      isComplete: (output) => this.hasCompleteOutput(output),
      handlePrompts: (shell, data, output) => this.handleInteractivePrompts(shell, data, output, state),
      respondToTerminalQueries: (data, shell) => this._respondToTerminalQueries(data, shell),
    });
  }
}

module.exports = { CodexAgent };
