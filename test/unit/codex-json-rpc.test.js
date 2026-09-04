/**
 * Unit tests for CodexAgent JSON-RPC integration
 *
 * Tests the JSON-RPC mode of CodexAgent, including:
 * - RPC response parsing
 * - Fallback to PTY mode
 * - Mode detection and switching
 */

// Mock node-pty to avoid native module issues in unit tests
jest.mock('node-pty', () => ({
  spawn: jest.fn(),
}));

// Mock the JsonRpcClient
jest.mock('../../src/json-rpc-client.js', () => {
  const mockClient = {
    start: jest.fn(),
    call: jest.fn(),
    notify: jest.fn(),
    stop: jest.fn(),
    isConnected: true,
  };

  return {
    JsonRpcClient: jest.fn(() => mockClient),
    JsonRpcError: class JsonRpcError extends Error {
      constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
      }
    },
    __mockClient: mockClient,
  };
});

const { CodexAgent } = require('../../src/agents/codex.js');
const { JsonRpcClient, __mockClient } = require('../../src/json-rpc-client.js');
const { version: packageVersion } = require('../../package.json');
const { formatCodexUsage } = require('../../src/usage-formatters.js');
const {
  formatRpcResponseAsOutput,
  parseRpcRateLimits,
  parseRpcLimitEntry,
  formatDuration,
} = require('../../src/agents/codex-rpc-helpers.js');

describe('CodexAgent JSON-RPC Integration', () => {
  let agent;

  beforeEach(() => {
    jest.clearAllMocks();
    __mockClient.start.mockResolvedValue();
    __mockClient.notify.mockClear();
    __mockClient.stop.mockClear();
    __mockClient.isConnected = true;

    agent = new CodexAgent();
  });

  afterEach(() => {
    if (agent) {
      agent.killProcess();
    }
  });

  describe('runCommand with JSON-RPC', () => {
    it('attempts JSON-RPC first when mode is unknown', async () => {
      __mockClient.call.mockResolvedValue({
        fiveHour: { percentLeft: 80, resetsAt: '14:30' },
        weekly: { percentLeft: 95, resetsAt: '10:00 on 20 Mar' },
      });

      const result = await agent.runCommand();

      expect(JsonRpcClient).toHaveBeenCalledWith(
        'codex',
        ['app-server'],
        expect.objectContaining({ timeout: 25000 })
      );
      expect(__mockClient.start).toHaveBeenCalled();
      expect(__mockClient.call).toHaveBeenNthCalledWith(1, 'initialize', {
        clientInfo: {
          name: 'agent_tank',
          title: 'Agent Tank',
          version: packageVersion,
        },
      });
      expect(__mockClient.notify).toHaveBeenCalledWith('initialized', {});
      expect(__mockClient.call).toHaveBeenCalledWith('account/rateLimits/read', {});
      expect(result).toBe('__RPC_RESPONSE__');
    });

    it('marks RPC as supported after successful call', async () => {
      __mockClient.call.mockResolvedValue({
        fiveHour: { percentLeft: 80, resetsAt: '14:30' },
        weekly: { percentLeft: 95, resetsAt: '10:00 on 20 Mar' },
      });

      expect(agent.usingJsonRpc).toBeNull();

      await agent.runCommand();

      expect(agent.usingJsonRpc).toBe(true);
    });

    it('cleans up RPC client after call', async () => {
      __mockClient.call.mockResolvedValue({
        fiveHour: { percentLeft: 80, resetsAt: '14:30' },
        weekly: { percentLeft: 95, resetsAt: '10:00 on 20 Mar' },
      });

      await agent.runCommand();

      expect(__mockClient.stop).toHaveBeenCalled();
    });

    it('skips JSON-RPC when mode is set to PTY', async () => {
      agent.setRpcMode(false);

      // Mock the PTY method
      const mockPtyRun = jest.spyOn(agent, '_runWithPty').mockResolvedValue('PTY output');

      await agent.runCommand();

      expect(JsonRpcClient).not.toHaveBeenCalled();
      expect(mockPtyRun).toHaveBeenCalled();

      mockPtyRun.mockRestore();
    });
  });

  describe('JSON-RPC fallback to PTY', () => {
    it('falls back to PTY when JSON-RPC fails', async () => {
      __mockClient.start.mockRejectedValue(new Error('spawn ENOENT'));

      // Mock the PTY method
      const mockPtyRun = jest.spyOn(agent, '_runWithPty').mockResolvedValue('PTY output');

      const result = await agent.runCommand();

      expect(result).toBe('PTY output');
      expect(agent.usingJsonRpc).toBe(false);

      mockPtyRun.mockRestore();
    });

    it('falls back to PTY when RPC call fails', async () => {
      __mockClient.call.mockRejectedValue(new Error('Method not found'));

      // Mock the PTY method
      const mockPtyRun = jest.spyOn(agent, '_runWithPty').mockResolvedValue('PTY output');

      const result = await agent.runCommand();

      expect(result).toBe('PTY output');
      expect(agent.usingJsonRpc).toBe(false);

      mockPtyRun.mockRestore();
    });

    it('uses PTY directly on subsequent calls after fallback', async () => {
      __mockClient.start.mockRejectedValue(new Error('spawn ENOENT'));

      // Mock the PTY method
      const mockPtyRun = jest.spyOn(agent, '_runWithPty').mockResolvedValue('PTY output');

      // First call - triggers fallback
      await agent.runCommand();
      expect(agent.usingJsonRpc).toBe(false);

      // Clear mocks
      jest.clearAllMocks();

      // Second call - should skip JSON-RPC entirely
      await agent.runCommand();

      expect(JsonRpcClient).not.toHaveBeenCalled();
      expect(mockPtyRun).toHaveBeenCalledTimes(1);

      mockPtyRun.mockRestore();
    });
  });

  describe('parseOutput with RPC response', () => {
    it('parses RPC response marker correctly', () => {
      agent._rpcRateLimits = {
        fiveHour: { percentLeft: 80, resetsAt: '14:30' },
        weekly: { percentLeft: 95, resetsAt: '10:00 on 20 Mar' },
      };

      const result = agent.parseOutput('__RPC_RESPONSE__');

      expect(result.fiveHour).not.toBeNull();
      expect(result.fiveHour.percentLeft).toBe(80);
      expect(result.fiveHour.percentUsed).toBe(20);
      expect(result.fiveHour.label).toBe('5h limit');

      expect(result.weekly).not.toBeNull();
      expect(result.weekly.percentLeft).toBe(95);
      expect(result.weekly.percentUsed).toBe(5);
      expect(result.weekly.label).toBe('Weekly limit');
    });

    it('clears RPC rate limits after parsing', () => {
      agent._rpcRateLimits = {
        fiveHour: { percentLeft: 80, resetsAt: '14:30' },
        weekly: { percentLeft: 95, resetsAt: '10:00 on 20 Mar' },
      };

      agent.parseOutput('__RPC_RESPONSE__');

      expect(agent._rpcRateLimits).toBeNull();
    });

    it('falls back to PTY parsing for non-RPC output', () => {
      const ptyOutput = `
        5h limit: [████████░░] 80% left (resets 14:30)
        Weekly limit: [██████████] 100% left (resets 10:00 on 15 Mar)
      `;

      const result = agent.parseOutput(ptyOutput);

      expect(result.fiveHour).not.toBeNull();
      expect(result.fiveHour.percentLeft).toBe(80);
      expect(result.weekly).not.toBeNull();
      expect(result.weekly.percentLeft).toBe(100);
    });
  });

  describe('parseRpcRateLimits', () => {
    it('maps a Pro account weekly-only primary window without inventing a session limit', () => {
      const resetsAt = Math.floor(Date.now() / 1000) + 86400;
      const response = {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 82, windowDurationMins: 10080, resetsAt },
          secondary: null,
          planType: 'pro',
        },
      };

      const { usage, metadataUpdates } = parseRpcRateLimits(response);

      expect(usage.fiveHour).toBeNull();
      expect(usage.weekly.percentUsed).toBe(82);
      expect(usage.weekly.percentLeft).toBe(18);
      expect(usage.weekly.windowDurationMins).toBe(10080);
      expect(usage.weekly.resetsInSeconds).toBeGreaterThan(86000);
      expect(metadataUpdates.planType).toBe('pro');
    });

    it('renders a Pro weekly-only bucket without a 5h usage row', () => {
      const response = {
        rateLimits: {
          limitId: 'codex',
          primary: {
            usedPercent: 82,
            windowDurationMins: 10080,
            resetsAt: Math.floor(Date.now() / 1000) + 86400,
          },
          secondary: null,
          planType: 'pro',
        },
      };

      const { usage } = parseRpcRateLimits(response);
      const html = formatCodexUsage(usage);

      expect(html).toContain('Weekly');
      expect(html).toContain('data-percent="82"');
      expect(html).not.toContain('5h limit');
    });

    it('maps current primary and secondary windows and model-specific buckets', () => {
      const resetsAt = Math.floor(Date.now() / 1000) + 3600;
      const response = {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt },
          secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt },
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: 12, windowDurationMins: 300, resetsAt },
            secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt },
          },
          codex_spark: {
            limitId: 'codex_spark',
            limitName: 'GPT-5.3-Codex-Spark',
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt },
            secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt },
          },
        },
      };

      const { usage } = parseRpcRateLimits(response);

      expect(usage.fiveHour.percentUsed).toBe(12);
      expect(usage.weekly.percentUsed).toBe(34);
      expect(usage.modelLimits).toHaveLength(1);
      expect(usage.modelLimits[0].name).toBe('GPT-5.3-Codex-Spark');
      expect(usage.modelLimits[0].fiveHour.percentUsed).toBe(20);
      expect(usage.modelLimits[0].weekly.percentUsed).toBe(45);
    });

    it('parses fiveHour and weekly limits', () => {
      const rateLimits = {
        fiveHour: { percentLeft: 75, resetsAt: '15:00', resetsInSeconds: 3600 },
        weekly: { percentLeft: 90, resetsAt: '10:00 on 22 Mar', resetsInSeconds: 604800 },
      };

      const { usage } = parseRpcRateLimits(rateLimits);

      expect(usage.fiveHour.percentLeft).toBe(75);
      expect(usage.fiveHour.percentUsed).toBe(25);
      expect(usage.fiveHour.resetsIn).toBe('1h 0m');

      expect(usage.weekly.percentLeft).toBe(90);
      expect(usage.weekly.percentUsed).toBe(10);
    });

    it('handles model-specific limits', () => {
      const rateLimits = {
        fiveHour: { percentLeft: 80, resetsAt: '14:30' },
        weekly: { percentLeft: 95, resetsAt: '10:00 on 20 Mar' },
        modelLimits: [
          {
            name: 'GPT-5.3-Codex',
            fiveHour: { percentLeft: 70, resetsAt: '14:30' },
            weekly: { percentLeft: 85, resetsAt: '10:00 on 20 Mar' },
          },
        ],
      };

      const { usage } = parseRpcRateLimits(rateLimits);

      expect(usage.modelLimits).toBeDefined();
      expect(usage.modelLimits).toHaveLength(1);
      expect(usage.modelLimits[0].name).toBe('GPT-5.3-Codex');
      expect(usage.modelLimits[0].fiveHour.percentLeft).toBe(70);
    });

    it('extracts model and account info', () => {
      const rateLimits = {
        fiveHour: { percentLeft: 80, resetsAt: '14:30' },
        weekly: { percentLeft: 95, resetsAt: '10:00 on 20 Mar' },
        model: 'gpt-5.3-codex',
        account: 'user@example.com',
        sessionId: 'abc-123',
      };

      const { usage, metadataUpdates } = parseRpcRateLimits(rateLimits);

      expect(usage.model).toBe('gpt-5.3-codex');
      expect(usage.account).toBe('user@example.com');
      expect(metadataUpdates.model).toBe('gpt-5.3-codex');
      expect(metadataUpdates.email).toBe('user@example.com');
      expect(metadataUpdates.sessionId).toBe('abc-123');
    });

    it('handles alternative field names', () => {
      const rateLimits = {
        fiveHour: { remaining: 60, resetAt: '16:00', secondsUntilReset: 7200 },
        weekly: { percent: 85, reset: '10:00 on 25 Mar' },
      };

      const { usage } = parseRpcRateLimits(rateLimits);

      expect(usage.fiveHour.percentLeft).toBe(60);
      expect(usage.fiveHour.resetsAt).toBe('16:00');
      expect(usage.fiveHour.resetsInSeconds).toBe(7200);

      expect(usage.weekly.percentLeft).toBe(85);
    });

    it('includes pace data when resetsInSeconds is available', () => {
      const rateLimits = {
        fiveHour: { percentLeft: 50, resetsAt: '14:30', resetsInSeconds: 9000 },
        weekly: { percentLeft: 80, resetsAt: '10:00 on 22 Mar', resetsInSeconds: 302400 },
      };

      const { usage } = parseRpcRateLimits(rateLimits);

      expect(usage.fiveHour.pace).toBeDefined();
      expect(typeof usage.fiveHour.pace.paceRatio).toBe('number');

      expect(usage.weekly.pace).toBeDefined();
      expect(typeof usage.weekly.pace.paceRatio).toBe('number');
    });
  });

  describe('parseRpcLimitEntry', () => {
    it('uses usedPercent directly for current app-server windows', () => {
      const resetsAt = Math.floor(Date.now() / 1000) + 3600;
      const result = parseRpcLimitEntry(
        { usedPercent: 82, windowDurationMins: 10080, resetsAt },
        'Weekly limit',
        'weekly'
      );

      expect(result.percentUsed).toBe(82);
      expect(result.percentLeft).toBe(18);
      expect(result.resetsInSeconds).toBeGreaterThan(3500);
    });

    it('does not turn a window with no percentage into 0% usage', () => {
      expect(parseRpcLimitEntry({}, '5h limit', 'fiveHour')).toBeNull();
    });

    it('parses limit with percentLeft', () => {
      const limit = { percentLeft: 75, resetsAt: '15:00' };
      const result = parseRpcLimitEntry(limit, '5h limit', 'fiveHour');

      expect(result.percentLeft).toBe(75);
      expect(result.percentUsed).toBe(25);
      expect(result.label).toBe('5h limit');
      expect(result.resetsAt).toBe('15:00');
    });

    it('parses limit with remaining field', () => {
      const limit = { remaining: 60, resetAt: '16:00' };
      const result = parseRpcLimitEntry(limit, 'Weekly limit', 'weekly');

      expect(result.percentLeft).toBe(60);
      expect(result.percentUsed).toBe(40);
    });

    it('parses limit with percent field', () => {
      const limit = { percent: 85, reset: '17:00' };
      const result = parseRpcLimitEntry(limit, '5h limit', 'fiveHour');

      expect(result.percentLeft).toBe(85);
    });

    it('calculates resetsIn from resetsInSeconds', () => {
      const limit = { percentLeft: 80, resetsAt: '14:30', resetsInSeconds: 5400 };
      const result = parseRpcLimitEntry(limit, '5h limit', 'fiveHour');

      expect(result.resetsIn).toBe('1h 30m');
      expect(result.resetsInSeconds).toBe(5400);
    });

    it('calculates resetsIn from secondsUntilReset', () => {
      const limit = { percentLeft: 80, resetsAt: '14:30', secondsUntilReset: 3600 };
      const result = parseRpcLimitEntry(limit, '5h limit', 'fiveHour');

      expect(result.resetsIn).toBe('1h 0m');
      expect(result.resetsInSeconds).toBe(3600);
    });
  });

  describe('formatDuration', () => {
    it('formats minutes only', () => {
      expect(formatDuration(1800)).toBe('30m');
    });

    it('formats hours and minutes', () => {
      expect(formatDuration(5400)).toBe('1h 30m');
    });

    it('formats days and hours', () => {
      expect(formatDuration(90000)).toBe('1d 1h');
    });

    it('formats 0 minutes', () => {
      expect(formatDuration(30)).toBe('0m');
    });
  });

  describe('formatRpcResponseAsOutput', () => {
    it('preserves the full current response including model-specific buckets', () => {
      const response = {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 82, windowDurationMins: 10080 },
          secondary: null,
        },
        rateLimitsByLimitId: {
          codex: { limitId: 'codex', primary: { usedPercent: 82 } },
        },
      };

      expect(formatRpcResponseAsOutput(response)).toEqual({
        marker: '__RPC_RESPONSE__',
        data: response,
      });
    });

    it('returns marker for structured response with fiveHour', () => {
      const rateLimits = { fiveHour: { percentLeft: 80 } };
      const result = formatRpcResponseAsOutput(rateLimits);

      expect(result).toEqual({ marker: '__RPC_RESPONSE__', data: rateLimits });
    });

    it('returns marker for structured response with weekly', () => {
      const rateLimits = { weekly: { percentLeft: 90 } };
      const result = formatRpcResponseAsOutput(rateLimits);

      expect(result).toEqual({ marker: '__RPC_RESPONSE__', data: rateLimits });
    });

    it('returns marker for nested rateLimits structure', () => {
      const rateLimits = {
        rateLimits: {
          fiveHour: { percentLeft: 80 },
          weekly: { percentLeft: 90 },
        },
      };
      const result = formatRpcResponseAsOutput(rateLimits);

      expect(result).toEqual({ marker: '__RPC_RESPONSE__', data: rateLimits.rateLimits });
    });

    it('throws for empty response', () => {
      expect(() => formatRpcResponseAsOutput(null)).toThrow('Empty rate limits response');
    });

    it('throws for unexpected structure', () => {
      const rateLimits = { unexpected: 'data' };
      expect(() => formatRpcResponseAsOutput(rateLimits)).toThrow('Unexpected rate limits response structure');
    });
  });

  describe('setRpcMode', () => {
    it('forces RPC mode', () => {
      agent.setRpcMode(true);
      expect(agent.usingJsonRpc).toBe(true);
    });

    it('forces PTY mode', () => {
      agent.setRpcMode(false);
      expect(agent.usingJsonRpc).toBe(false);
    });

    it('resets to auto-detect', () => {
      agent.setRpcMode(true);
      agent.setRpcMode(null);
      expect(agent.usingJsonRpc).toBeNull();
    });
  });

  describe('killProcess', () => {
    it('stops RPC client if active', async () => {
      __mockClient.call.mockResolvedValue({
        fiveHour: { percentLeft: 80, resetsAt: '14:30' },
        weekly: { percentLeft: 95, resetsAt: '10:00 on 20 Mar' },
      });

      await agent.runCommand();

      // The RPC client should already be stopped after runCommand
      expect(__mockClient.stop).toHaveBeenCalled();
    });
  });
});
