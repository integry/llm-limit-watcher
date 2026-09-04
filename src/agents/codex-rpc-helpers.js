const { calculatePace } = require('../pace-evaluator.js');
const { CYCLE_DURATIONS } = require('../usage-formatters.js');

/**
 * Format RPC response as if it were PTY output for parseOutput compatibility
 * Or directly parse and store the usage data
 * @param {Object} rateLimits - The rate limits from RPC
 * @returns {string} - Formatted string for parseOutput
 * @throws {Error} - If the response structure is unexpected
 */
function formatRpcResponseAsOutput(rateLimits) {
  if (!rateLimits) {
    throw new Error('Empty rate limits response');
  }

  // Current app-server responses include a backwards-compatible single bucket
  // plus an optional map of model-specific buckets. Keep the entire response so
  // the parser can use both views.
  if (isRateLimitBucket(rateLimits) || isRateLimitBucket(rateLimits.rateLimits) ||
      isObject(rateLimits.rateLimitsByLimitId)) {
    return { marker: '__RPC_RESPONSE__', data: rateLimits };
  }

  // Legacy structured response.
  if (rateLimits.fiveHour || rateLimits.weekly || rateLimits.limits) {
    return { marker: '__RPC_RESPONSE__', data: rateLimits };
  }

  // Legacy nested response.
  if (rateLimits.rateLimits) {
    return { marker: '__RPC_RESPONSE__', data: rateLimits.rateLimits };
  }

  // If structure is unknown, throw to fall back to PTY
  throw new Error('Unexpected rate limits response structure');
}

/**
 * Parse usage data from JSON-RPC response
 * @param {Object} rateLimits - Rate limits from RPC
 * @param {Object} context - Context object with metadata and version info
 * @returns {Object} - Parsed usage object
 */
function parseRpcRateLimits(rateLimits, context = {}) {
  const usage = {
    fiveHour: null,
    weekly: null,
    version: context.versionInfo || null,
  };
  const metadataUpdates = {};

  if (isCurrentRateLimitsResponse(rateLimits)) {
    parseCurrentRateLimits(rateLimits, usage, metadataUpdates, context);
    return { usage, metadataUpdates };
  }

  // Parse legacy five hour limit.
  if (rateLimits.fiveHour) {
    usage.fiveHour = parseRpcLimitEntry(rateLimits.fiveHour, '5h limit', 'fiveHour', context);
  }

  // Parse legacy weekly limit.
  if (rateLimits.weekly) {
    usage.weekly = parseRpcLimitEntry(rateLimits.weekly, 'Weekly limit', 'weekly', context);
  }

  // Parse model-specific limits if present
  if (rateLimits.modelLimits && Array.isArray(rateLimits.modelLimits)) {
    usage.modelLimits = rateLimits.modelLimits.map(ml => ({
      name: ml.name || ml.model,
      fiveHour: ml.fiveHour ? parseRpcLimitEntry(ml.fiveHour, '5h limit', 'fiveHour', context) : null,
      weekly: ml.weekly ? parseRpcLimitEntry(ml.weekly, 'Weekly limit', 'weekly', context) : null,
    })).filter(ml => ml.fiveHour || ml.weekly);

    if (usage.modelLimits.length === 0) {
      delete usage.modelLimits;
    }
  }

  // Extract model and account
  if (rateLimits.model) {
    usage.model = rateLimits.model;
  }
  if (rateLimits.account || rateLimits.email) {
    usage.account = rateLimits.account || rateLimits.email;
  }

  if (rateLimits.model) {
    metadataUpdates.model = rateLimits.model;
  }
  if (rateLimits.account || rateLimits.email) {
    metadataUpdates.email = rateLimits.account || rateLimits.email;
  }
  if (rateLimits.sessionId) {
    metadataUpdates.sessionId = rateLimits.sessionId;
  }

  return { usage, metadataUpdates };
}

function parseCurrentRateLimits(rateLimits, usage, metadataUpdates, context) {
  const bucketsById = isObject(rateLimits.rateLimitsByLimitId)
    ? rateLimits.rateLimitsByLimitId
    : {};
  const mainBucket = findMainBucket(rateLimits, bucketsById);

  if (mainBucket) {
    Object.assign(usage, parseRateLimitBucket(mainBucket, context));
    if (mainBucket.planType) metadataUpdates.planType = mainBucket.planType;
  }

  const modelLimits = parseModelLimitBuckets(bucketsById, mainBucket, context);
  if (modelLimits.length > 0) usage.modelLimits = modelLimits;
}

function findMainBucket(rateLimits, bucketsById) {
  if (isRateLimitBucket(rateLimits.rateLimits)) return rateLimits.rateLimits;
  if (isRateLimitBucket(rateLimits)) return rateLimits;
  if (isRateLimitBucket(bucketsById.codex)) return bucketsById.codex;
  return Object.values(bucketsById).find(bucket =>
    isRateLimitBucket(bucket) && !bucket.limitName
  ) || null;
}

function parseModelLimitBuckets(bucketsById, mainBucket, context) {
  const modelLimits = [];
  for (const [limitId, bucket] of Object.entries(bucketsById)) {
    if (isMainBucketEntry(bucket, limitId, mainBucket)) continue;

    const parsed = parseRateLimitBucket(bucket, context);
    if (!parsed.fiveHour && !parsed.weekly) continue;
    modelLimits.push({
      name: bucket.limitName || bucket.limitId || limitId,
      ...parsed,
    });
  }
  return modelLimits;
}

function isMainBucketEntry(bucket, limitId, mainBucket) {
  if (!isRateLimitBucket(bucket) || bucket === mainBucket) return true;
  return Boolean(mainBucket?.limitId && (bucket.limitId || limitId) === mainBucket.limitId);
}

function parseRateLimitBucket(bucket, context) {
  const parsed = { fiveHour: null, weekly: null };
  const windows = [
    { data: bucket.primary, fallbackCycle: 'fiveHour' },
    { data: bucket.secondary, fallbackCycle: 'weekly' },
  ];

  for (const { data, fallbackCycle } of windows) {
    if (!isObject(data)) continue;
    const cycle = classifyWindow(data.windowDurationMins) || fallbackCycle;
    if (parsed[cycle]) continue;
    const label = cycle === 'weekly' ? 'Weekly limit' : '5h limit';
    parsed[cycle] = parseRpcLimitEntry(data, label, cycle, context);
  }

  return parsed;
}

function classifyWindow(windowDurationMins) {
  const duration = Number(windowDurationMins);
  if (!Number.isFinite(duration)) return null;
  if (duration === CYCLE_DURATIONS.fiveHour / 60) return 'fiveHour';
  if (duration === CYCLE_DURATIONS.weekly / 60) return 'weekly';
  return null;
}

function isCurrentRateLimitsResponse(rateLimits) {
  return isRateLimitBucket(rateLimits) || isRateLimitBucket(rateLimits?.rateLimits) ||
    isObject(rateLimits?.rateLimitsByLimitId);
}

function isRateLimitBucket(value) {
  return isObject(value) && ('primary' in value || 'secondary' in value);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse a single limit entry from RPC response
 * @param {Object} limit - Limit data from RPC
 * @param {string} label - Label for the limit
 * @param {string} cycleType - Cycle type for pace calculation
 * @param {Object} context - Context with parseResetTime function
 * @returns {Object} - Parsed limit entry
 */
function parseRpcLimitEntry(limit, label, cycleType, context = {}) {
  if (!isObject(limit)) return null;

  const percentages = parsePercentages(limit);
  if (!percentages) return null;
  const resetInfo = parseRpcResetInfo(limit, context);

  const entry = {
    ...percentages,
    resetsAt: resetInfo.resetsAt,
    label,
    resetsIn: resetInfo.resetsIn,
    resetsInSeconds: resetInfo.resetsInSeconds,
  };
  if (limit.windowDurationMins != null) {
    entry.windowDurationMins = limit.windowDurationMins;
  }

  // Calculate pace if we have the necessary data
  const cycleDuration = CYCLE_DURATIONS[cycleType];
  if (cycleDuration && resetInfo.resetsInSeconds != null) {
    const paceData = calculatePace({
      usagePercent: percentages.percentUsed,
      resetsInSeconds: resetInfo.resetsInSeconds,
      cycleDurationSeconds: cycleDuration,
    });
    if (paceData) entry.pace = paceData;
  }

  return entry;
}

function parsePercentages(limit) {
  const usedValue = toFiniteNumber(limit.usedPercent ?? limit.percentUsed);
  const leftValue = toFiniteNumber(limit.percentLeft ?? limit.remaining ?? limit.percent);
  if (usedValue === null && leftValue === null) return null;

  const percentUsed = usedValue ?? (100 - leftValue);
  return {
    percentUsed,
    percentLeft: leftValue ?? (100 - percentUsed),
  };
}

function parseRpcResetInfo(limit, context) {
  const resetsAt = limit.resetsAt || limit.resetAt || limit.reset || null;
  const suppliedSeconds = toFiniteNumber(limit.resetsInSeconds ?? limit.secondsUntilReset);
  if (suppliedSeconds !== null) {
    return { resetsAt, resetsIn: formatDuration(suppliedSeconds), resetsInSeconds: suppliedSeconds };
  }
  if (isUnixTimestamp(resetsAt)) return parseUnixResetTime(resetsAt);

  const parsed = resetsAt && context.parseResetTime ? context.parseResetTime(resetsAt) : null;
  return {
    resetsAt,
    resetsIn: parsed?.text || null,
    resetsInSeconds: parsed?.seconds ?? null,
  };
}

function parseUnixResetTime(resetsAt) {
  const timestamp = Number(resetsAt);
  const resetTimeMs = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  const resetsInSeconds = Math.max(0, Math.floor((resetTimeMs - Date.now()) / 1000));
  return {
    resetsAt,
    resetsIn: resetsInSeconds === 0 ? 'soon' : formatDuration(resetsInSeconds),
    resetsInSeconds,
  };
}

function isUnixTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim());
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Format seconds as duration string
 * @param {number} seconds - Seconds to format
 * @returns {string} - Formatted duration
 */
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  } else if (hours > 0) {
    return `${hours}h ${mins}m`;
  } else {
    return `${mins}m`;
  }
}

module.exports = {
  formatRpcResponseAsOutput,
  parseRpcRateLimits,
  parseRpcLimitEntry,
  formatDuration,
};
