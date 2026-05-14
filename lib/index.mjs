import { execFile, spawn as spawnProcess } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_CONFIG = Object.freeze({
  appName: "app",
  host: "127.0.0.1",
  port: 3000,
  healthPath: "/healthz",
  httpsPort: null,
  serviceName: "",
  tailscaleBin: "tailscale",
  socket: "",
  serviceSocket: "",
  officialUrl: "",
  requireService: false,
  requireOfficialHealth: false,
  requireDeviceServe: null,
  allowFunnel: false,
  strictFunnel: false,
  autoServe: false,
  autoService: false,
  dependencies: [],
  startupTimeoutMs: 30000,
  timeoutMs: 5000
});

export function normalizeConfig(input = {}) {
  const config = { ...DEFAULT_CONFIG, ...input };
  const port = Number.parseInt(String(config.port), 10);
  const httpsPort =
    config.httpsPort === null || config.httpsPort === undefined || config.httpsPort === ""
      ? port
      : Number.parseInt(String(config.httpsPort), 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${config.port}`);
  }

  if (!Number.isInteger(httpsPort) || httpsPort <= 0 || httpsPort > 65535) {
    throw new Error(`invalid httpsPort: ${config.httpsPort}`);
  }

  const serviceName = normalizeServiceName(config.serviceName || "");
  const serviceSocket = String(config.serviceSocket || "");
  const requireService = Boolean(config.requireService);
  const requireDeviceServe =
    config.requireDeviceServe === null || config.requireDeviceServe === undefined || config.requireDeviceServe === ""
      ? !(serviceName && (serviceSocket || requireService))
      : Boolean(config.requireDeviceServe);

  return {
    ...config,
    appName: String(config.appName || DEFAULT_CONFIG.appName),
    host: String(config.host || DEFAULT_CONFIG.host),
    port,
    httpsPort,
    healthPath: normalizePath(config.healthPath || DEFAULT_CONFIG.healthPath),
    serviceName,
    tailscaleBin: String(config.tailscaleBin || DEFAULT_CONFIG.tailscaleBin),
    socket: String(config.socket || ""),
    serviceSocket,
    officialUrl: normalizeOptionalUrl(config.officialUrl || ""),
    requireService,
    requireOfficialHealth: Boolean(config.requireOfficialHealth),
    requireDeviceServe,
    allowFunnel: Boolean(config.allowFunnel),
    strictFunnel: Boolean(config.strictFunnel),
    autoServe: Boolean(config.autoServe),
    autoService: Boolean(config.autoService),
    dependencies: normalizeDependencies(config.dependencies),
    startupTimeoutMs: Number.parseInt(String(config.startupTimeoutMs || DEFAULT_CONFIG.startupTimeoutMs), 10),
    timeoutMs: Number.parseInt(String(config.timeoutMs || DEFAULT_CONFIG.timeoutMs), 10)
  };
}

export function localUrl(configInput = {}) {
  const config = normalizeConfig(configInput);
  return `http://${config.host}:${config.port}/`;
}

export function localHealthUrl(configInput = {}) {
  const config = normalizeConfig(configInput);
  return new URL(config.healthPath, localUrl(config)).href;
}

export function deviceTailnetUrl(dnsName, configInput = {}) {
  const config = normalizeConfig(configInput);
  const cleanDns = stripTrailingDot(dnsName || "");

  if (!cleanDns) {
    return "";
  }

  const portPart = config.httpsPort === 443 ? "" : `:${config.httpsPort}`;
  return `https://${cleanDns}${portPart}/`;
}

export function serviceTailnetUrl(serviceName, tailnetSuffix) {
  const service = normalizeServiceName(serviceName);
  const suffix = stripTrailingDot(tailnetSuffix || "");

  if (!service || !suffix) {
    return "";
  }

  return `https://${service}.${suffix}/`;
}

export async function getTailscaleStatus(configInput = {}, options = {}) {
  const config = normalizeConfig(configInput);
  const runner = options.runner || runCommand;
  const args = withSocket(["status", "--json"], config.socket);
  const result = await runner(config.tailscaleBin, args, { timeoutMs: config.timeoutMs });
  return parseJsonFromCommandOutput(result.stdout);
}

export async function getTailscaleServeStatus(configInput = {}, options = {}) {
  const config = normalizeConfig(configInput);
  const runner = options.runner || runCommand;
  const args = withSocket(["serve", "status", "--json"], config.socket);
  const result = await runner(config.tailscaleBin, args, { timeoutMs: config.timeoutMs });
  return parseJsonFromCommandOutput(result.stdout);
}

export async function getTailscaleFunnelStatus(configInput = {}, options = {}) {
  const config = normalizeConfig(configInput);
  const runner = options.runner || runCommand;
  const args = withSocket(["funnel", "status"], config.socket);
  const jsonArgs = withSocket(["funnel", "status", "--json"], config.socket);
  const [textResult, jsonResult] = await Promise.allSettled([
    runner(config.tailscaleBin, args, { timeoutMs: config.timeoutMs }),
    runner(config.tailscaleBin, jsonArgs, { timeoutMs: config.timeoutMs })
  ]);

  return {
    text: textResult.status === "fulfilled" ? textResult.value.stdout : "",
    json: jsonResult.status === "fulfilled" ? parseJsonFromCommandOutput(jsonResult.value.stdout) : null,
    textError: textResult.status === "rejected" ? textResult.reason?.message || String(textResult.reason) : "",
    jsonError: jsonResult.status === "rejected" ? jsonResult.reason?.message || String(jsonResult.reason) : ""
  };
}

export async function configureDeviceServe(configInput = {}, options = {}) {
  const config = normalizeConfig(configInput);
  const runner = options.runner || runCommand;
  const args = withSocket(
    ["serve", "--bg", "--yes", "--https", String(config.httpsPort), `http://${config.host}:${config.port}`],
    config.socket
  );

  return runner(config.tailscaleBin, args, { timeoutMs: config.timeoutMs });
}

export async function configureNamedService(configInput = {}, options = {}) {
  const config = normalizeConfig(configInput);
  const service = normalizeServiceName(config.serviceName);

  if (!service) {
    throw new Error("serviceName is required for named service setup");
  }

  const runner = options.runner || runCommand;
  const args = withSocket(
    [
      "serve",
      "--yes",
      `--service=svc:${service}`,
      "--https=443",
      `http://${config.host}:${config.port}`
    ],
    config.serviceSocket || config.socket
  );

  return runner(config.tailscaleBin, args, { timeoutMs: config.timeoutMs });
}

export async function runTailnetDoctor(configInput = {}, options = {}) {
  const config = normalizeConfig(configInput);
  const runner = options.runner || runCommand;
  const fetcher = options.fetch || globalThis.fetch;
  const checks = [];
  const warnings = [];
  const context = {
    appName: config.appName,
    localUrl: localUrl(config),
    localHealthUrl: localHealthUrl(config),
    deviceUrl: "",
    serviceUrl: "",
    officialUrl: config.officialUrl,
    officialHealthUrl: config.officialUrl ? new URL(config.healthPath, config.officialUrl).href : ""
  };

  await checkHealth({
    name: "local_health",
    url: context.localHealthUrl,
    config,
    checks,
    fetcher
  });

  let status = null;
  try {
    status = await getTailscaleStatus(config, { runner });
    const dnsName = tailscaleDnsName(status);
    const suffix = stripTrailingDot(status?.MagicDNSSuffix || "");
    context.deviceUrl = deviceTailnetUrl(dnsName, config);
    context.serviceUrl = serviceTailnetUrl(config.serviceName, suffix);
    checks.push({
      name: "tailscale_connected",
      ok: status?.BackendState === "Running",
      detail: status?.BackendState || "unknown"
    });
    checks.push({
      name: "tailscale_dns",
      ok: Boolean(dnsName),
      detail: dnsName || "missing"
    });
  } catch (error) {
    checks.push({
      name: "tailscale_status",
      ok: false,
      detail: error?.message || String(error)
    });
  }

  let serveStatus = null;
  try {
    serveStatus = await getTailscaleServeStatus(config, { runner });
    const routes = flattenServeRoutes(serveStatus);
    const expectedProxy = `http://${config.host}:${config.port}`;
    const route = routes.find((candidate) => candidate.proxy === expectedProxy);

    checks.push({
      name: "serve_device_route",
      ok: Boolean(route) || !config.requireDeviceServe,
      detail: route
        ? `${route.hostPort}${route.path} -> ${route.proxy}`
        : config.requireDeviceServe
          ? `missing proxy to ${expectedProxy}`
          : `optional device route missing; named service route will be checked for ${expectedProxy}`
    });
  } catch (error) {
    checks.push({
      name: "serve_status",
      ok: false,
      detail: error?.message || String(error)
    });
  }

  const funnel = await getTailscaleFunnelStatus(config, { runner });
  const funnelReport = analyzeFunnel({
    serveStatus,
    funnelJson: funnel.json,
    funnelText: funnel.text,
    expectedProxy: `http://${config.host}:${config.port}`,
    allowFunnel: config.allowFunnel,
    strictFunnel: config.strictFunnel
  });
  checks.push(funnelReport.check);
  warnings.push(...funnelReport.warnings);

  if (config.serviceName && context.serviceUrl) {
    checks.push({
      name: "named_service_instructions",
      ok: true,
      detail: `${context.serviceUrl} requires svc:${config.serviceName} defined in Tailscale Services`
    });
  }

  if (config.serviceName && (config.serviceSocket || config.requireService)) {
    await checkNamedService({
      config,
      runner,
      checks,
      warnings,
      tailnetSuffix: status?.MagicDNSSuffix || ""
    });
  }

  if (context.officialHealthUrl) {
    const officialChecks = [];
    await checkHealth({
      name: "official_health",
      url: context.officialHealthUrl,
      config,
      checks: officialChecks,
      fetcher
    });
    const check = officialChecks[0];

    if (check?.ok || config.requireOfficialHealth) {
      checks.push(check);
    } else {
      warnings.push(`official health unavailable: ${check?.detail || context.officialHealthUrl}`);
    }
  }

  const ok = checks.every((check) => check.ok);
  return { ok, checks, warnings, context };
}

export async function runTailnetEnsure(configInput = {}, options = {}) {
  const config = normalizeConfig(configInput);
  const runner = options.runner || runCommand;
  const fetcher = options.fetch || globalThis.fetch;
  const dependencies = normalizeDependencies(options.dependencies, config.dependencies);
  let doctor = await runTailnetDoctor(config, { runner, fetch: fetcher });
  let deviceServe = { attempted: false, ok: false, error: "" };
  let namedService = { attempted: false, ok: false, error: "" };
  const missingDeviceServe = config.requireDeviceServe && doctor.checks.some((check) => check.name === "serve_device_route" && !check.ok);
  if (config.autoServe && missingDeviceServe) {
    deviceServe = await runDeviceServeSetup(config, { runner });
    if (deviceServe.ok) {
      doctor = await runTailnetDoctor(config, { runner, fetch: fetcher });
    }
  }
  const missingNamedService =
    config.serviceName &&
    doctor.checks.some((check) => check.name === "named_service_route" && !check.ok);
  if (config.autoService && missingNamedService) {
    namedService = await runNamedServiceSetup(config, { runner });
    if (namedService.ok) {
      doctor = await runTailnetDoctor(config, { runner, fetch: fetcher });
    }
  }
  const dependencyResults = [];

  for (const dependency of dependencies) {
    dependencyResults.push(
      await ensureDependency(dependency, {
        runner,
        fetcher,
        defaultTimeoutMs: config.timeoutMs
      })
    );
  }

  const dependencyChecks = dependencyResults.map((dependency) => ({
    name: `dependency_${dependency.name}`,
    ok: dependency.ok || !dependency.required,
    detail: dependency.ok
      ? `${dependency.healthUrl} is healthy`
      : `${dependency.required ? "required" : "optional"} dependency unavailable: ${dependency.detail}`
  }));
  const localHealth = doctor.checks.find((check) => check.name === "local_health");
  const failed = dependencyResults.filter((dependency) => !dependency.ok);
  const failedRequired = failed.filter((dependency) => dependency.required);
  const started = dependencyResults.filter((dependency) => dependency.start?.attempted);
  const checks = [...doctor.checks, ...dependencyChecks];
  const ok = doctor.ok && failedRequired.length === 0;
  const ready = localHealth ? localHealth.ok : doctor.ok;
  const degraded = !doctor.ok || failed.length > 0;
  const nextSteps = [
    ...doctor.warnings,
    ...failed.map((dependency) =>
      dependency.start?.attempted && !dependency.start.ok
        ? `${dependency.name}: start command failed: ${dependency.start.error || dependency.start.stderr || dependency.detail}`
        : `${dependency.name}: ${dependency.detail}`
    )
  ];

  return {
    ok,
    ready,
    degraded,
    checks,
    warnings: doctor.warnings,
    context: doctor.context,
    deviceServe,
    namedService,
    dependencies: dependencyResults,
    started,
    failed,
    nextSteps
  };
}

export async function runTailnetSupervise(configInput = {}, options = {}) {
  const config = normalizeConfig(configInput);
  const fetcher = options.fetch || globalThis.fetch;
  const runner = options.runner || runCommand;
  const spawner = options.spawn || spawnProcess;
  const statusFile = String(options.statusFile || "").trim();
  const commandInput = options.command || options.serviceCommand || config.command || config.serviceCommand;
  const startCommand = normalizeStartCommand(commandInput);

  if (!startCommand?.command) {
    throw new Error("supervise requires a service command");
  }

  const child = spawner(startCommand.command, startCommand.args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: options.stdio || "inherit"
  });
  const startedAt = new Date().toISOString();
  let childExit = null;
  child.once?.("exit", (code, signal) => {
    childExit = { code, signal };
  });

  await writeReadinessStatus(statusFile, {
    state: "starting",
    ok: false,
    ready: false,
    degraded: false,
    blocked: false,
    startedAt,
    command: startCommand,
    config: readinessConfig(config)
  });

  const health = await waitForLocalHealth(config, { fetcher, getChildExit: () => childExit });
  if (!health.ok) {
    await stopSupervisedChild(child);
    const status = {
      state: "blocked",
      ok: false,
      ready: false,
      degraded: false,
      blocked: true,
      startedAt,
      stoppedAt: new Date().toISOString(),
      command: startCommand,
      config: readinessConfig(config),
      checks: [{ name: "local_health", ok: false, detail: health.detail }],
      nextSteps: [health.detail]
    };
    await writeReadinessStatus(statusFile, status);
    return { ...status, childExit: childExit || { code: 1, signal: "" }, exitCode: 1 };
  }

  const ensure = await runTailnetEnsure(config, { runner, fetch: fetcher });
  const readyStatus = readinessStatusFromEnsure({
    state: ensure.ok ? "ready" : ensure.ready ? "degraded" : "blocked",
    startedAt,
    command: startCommand,
    config,
    ensure
  });
  await writeReadinessStatus(statusFile, readyStatus);

  if (!ensure.ok) {
    await stopSupervisedChild(child);
    const status = {
      ...readyStatus,
      state: ensure.ready ? "degraded-blocked" : "blocked",
      blocked: true,
      stoppedAt: new Date().toISOString()
    };
    await writeReadinessStatus(statusFile, status);
    return { ...status, childExit: childExit || { code: 1, signal: "" }, exitCode: 1 };
  }

  const finalExit = await waitForChildExit(child, () => childExit);
  const stoppedStatus = {
    ...readyStatus,
    state: "stopped",
    stoppedAt: new Date().toISOString(),
    childExit: finalExit
  };
  await writeReadinessStatus(statusFile, stoppedStatus);
  return {
    ...stoppedStatus,
    exitCode: finalExit.signal ? 1 : Number.isInteger(finalExit.code) ? finalExit.code : 1
  };
}

export function normalizeDependencies(...values) {
  const dependencies = [];

  for (const value of values) {
    if (!value) {
      continue;
    }
    if (Array.isArray(value)) {
      dependencies.push(...value);
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        dependencies.push(trimmed);
      }
      continue;
    }
    dependencies.push(value);
  }

  return dependencies.map(normalizeDependency).filter(Boolean);
}

export function normalizeDependency(entry, index = 0) {
  if (!entry) {
    return null;
  }

  if (typeof entry === "string") {
    const separatorIndex = entry.indexOf("=");
    const name = separatorIndex > 0 ? entry.slice(0, separatorIndex).trim() : `dependency-${index + 1}`;
    const healthUrl = separatorIndex > 0 ? entry.slice(separatorIndex + 1).trim() : entry.trim();
    if (!healthUrl) {
      return null;
    }
    return {
      name,
      healthUrl,
      required: true,
      autoStart: false,
      startCommand: null,
      feature: "",
      timeoutMs: 0
    };
  }

  if (typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const healthUrl = String(entry.healthUrl || entry.url || "").trim();
  if (!healthUrl) {
    return null;
  }
  const startCommand = normalizeStartCommand(entry.startCommand || entry.command || null);

  return {
    name: String(entry.name || entry.slug || entry.service || `dependency-${index + 1}`).trim(),
    healthUrl,
    required: entry.required !== false,
    autoStart: Boolean(entry.autoStart || startCommand),
    startCommand,
    feature: String(entry.feature || "").trim(),
    timeoutMs: Number.parseInt(String(entry.timeoutMs || ""), 10) || 0
  };
}

export function flattenServeRoutes(config) {
  const routes = [];
  const appendWeb = (web, serviceName = "") => {
    if (!web || typeof web !== "object" || Array.isArray(web)) {
      return;
    }

    for (const [hostPort, entry] of Object.entries(web)) {
      const handlers = entry?.Handlers && typeof entry.Handlers === "object" ? entry.Handlers : {};

      for (const [path, handler] of Object.entries(handlers)) {
        routes.push({
          serviceName,
          hostPort,
          path,
          proxy: handler?.Proxy || ""
        });
      }
    }
  };

  appendWeb(config?.Web);

  const services = config?.Services && typeof config.Services === "object" ? config.Services : {};
  for (const [serviceName, serviceConfig] of Object.entries(services)) {
    appendWeb(serviceConfig?.Web, serviceName);
  }

  return routes;
}

export function analyzeFunnel({
  serveStatus = null,
  funnelJson = null,
  funnelText = "",
  expectedProxy = "",
  allowFunnel = false,
  strictFunnel = false
} = {}) {
  const publicRoutes = publicFunnelRoutes({ serveStatus, funnelJson, funnelText });
  const appRoutes = publicRoutes.filter((route) => !expectedProxy || route.proxy === expectedProxy);
  const warnings = [];

  if (allowFunnel) {
    return {
      check: {
        name: "funnel_policy",
        ok: true,
        detail: publicRoutes.length ? `Funnel allowed: ${formatRoutes(publicRoutes)}` : "Funnel allowed; no public routes found"
      },
      warnings
    };
  }

  if (appRoutes.length) {
    return {
      check: {
        name: "funnel_policy",
        ok: false,
        detail: `app route is public through Funnel: ${formatRoutes(appRoutes)}`
      },
      warnings
    };
  }

  if (strictFunnel && publicRoutes.length) {
    return {
      check: {
        name: "funnel_policy",
        ok: false,
        detail: `public Funnel route(s) enabled: ${formatRoutes(publicRoutes)}`
      },
      warnings
    };
  }

  if (publicRoutes.length) {
    warnings.push(`unrelated public Funnel route(s) detected: ${formatRoutes(publicRoutes)}`);
  }

  return {
    check: {
      name: "funnel_policy",
      ok: true,
      detail: publicRoutes.length ? "no public Funnel route for this app" : "no public Funnel routes"
    },
    warnings
  };
}

export function publicFunnelRoutes({ serveStatus = null, funnelJson = null, funnelText = "" } = {}) {
  const routes = [];
  const serveRoutes = flattenServeRoutes(serveStatus || funnelJson || {});
  const allowFunnel = {
    ...(serveStatus?.AllowFunnel && typeof serveStatus.AllowFunnel === "object" ? serveStatus.AllowFunnel : {}),
    ...(funnelJson?.AllowFunnel && typeof funnelJson.AllowFunnel === "object" ? funnelJson.AllowFunnel : {})
  };

  for (const route of serveRoutes) {
    if (allowFunnel[route.hostPort] === true) {
      routes.push(route);
    }
  }

  const lines = String(funnelText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("https://") && /Funnel on/i.test(line));

  for (const line of lines) {
    const match = line.match(/^https:\/\/([^ ]+)/u);
    const hostPort = normalizeHttpsHostPort(match?.[1] || "");

    if (hostPort && !routes.some((route) => route.hostPort === hostPort)) {
      routes.push({ serviceName: "", hostPort, path: "/", proxy: "" });
    }
  }

  return routes;
}

export function tailscaleDnsName(status) {
  return stripTrailingDot(status?.Self?.DNSName || "");
}

export function tailscaleLogin(status) {
  const selfUserId = status?.Self?.UserID;
  const user = selfUserId ? status?.User?.[String(selfUserId)] : null;
  return user?.LoginName || "";
}

export function hasServiceHostApproval(status, serviceName) {
  const serviceId = `svc:${normalizeServiceName(serviceName)}`;
  const capMap = status?.Self?.CapMap;
  const serviceHost =
    capMap && typeof capMap === "object"
      ? capMap["service-host"] || capMap["https://tailscale.com/cap/service-host"]
      : null;

  if (!Array.isArray(serviceHost)) {
    return false;
  }

  for (const entry of serviceHost) {
    if (entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, serviceId)) {
      return true;
    }
  }

  return false;
}

export function stripTrailingDot(value) {
  return String(value || "").replace(/\.+$/u, "");
}

export function normalizeServiceName(value) {
  return String(value || "")
    .trim()
    .replace(/^svc:/u, "")
    .toLowerCase();
}

export function serviceInstructions(configInput = {}, status = null) {
  const config = normalizeConfig(configInput);
  const suffix = stripTrailingDot(status?.MagicDNSSuffix || "<your-tailnet>.ts.net");
  const service = normalizeServiceName(config.serviceName || config.appName);
  return {
    serviceName: service,
    serviceId: `svc:${service}`,
    endpoint: "tcp:443",
    adminUrl: "https://login.tailscale.com/admin/services",
    serviceUrl: serviceTailnetUrl(service, suffix),
    hostCommand: [
      config.tailscaleBin,
      ...(config.serviceSocket || config.socket ? [`--socket=${config.serviceSocket || config.socket}`] : []),
      "serve",
      "--yes",
      `--service=svc:${service}`,
      "--https=443",
      `http://${config.host}:${config.port}`
    ].join(" ")
  };
}

async function ensureDependency(dependency, { runner, fetcher, defaultTimeoutMs }) {
  const timeoutMs = dependency.timeoutMs || defaultTimeoutMs;
  const before = await fetchHealth(dependency.healthUrl, { timeoutMs, fetcher });
  if (before.ok) {
    return {
      ...dependency,
      ok: true,
      detail: before.detail,
      statusCode: before.statusCode,
      start: { attempted: false, ok: false }
    };
  }

  const result = {
    ...dependency,
    ok: false,
    detail: before.detail,
    statusCode: before.statusCode,
    start: { attempted: false, ok: false }
  };

  if (!dependency.autoStart || !dependency.startCommand) {
    return result;
  }

  result.start = await runDependencyStartCommand(dependency.startCommand, { runner, timeoutMs });
  if (!result.start.ok) {
    result.detail = result.start.error || result.start.stderr || result.detail;
    return result;
  }

  const started = Date.now();
  let after = before;
  while (Date.now() - started <= timeoutMs) {
    after = await fetchHealth(dependency.healthUrl, { timeoutMs: Math.min(1500, timeoutMs), fetcher });
    if (after.ok) {
      result.ok = true;
      result.detail = after.detail;
      result.statusCode = after.statusCode;
      return result;
    }
    await delay(500);
  }

  result.detail = after.detail || `timed out waiting for ${dependency.healthUrl}`;
  result.statusCode = after.statusCode;
  return result;
}

async function runDeviceServeSetup(config, { runner }) {
  try {
    const result = await configureDeviceServe(config, { runner });
    return {
      attempted: true,
      ok: true,
      stdout: result?.stdout || "",
      stderr: result?.stderr || ""
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      stdout: error?.stdout || "",
      stderr: error?.stderr || "",
      error: error?.message || String(error)
    };
  }
}

async function runNamedServiceSetup(config, { runner }) {
  try {
    const result = await configureNamedService(config, { runner });
    return {
      attempted: true,
      ok: true,
      stdout: result?.stdout || "",
      stderr: result?.stderr || ""
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      stdout: error?.stdout || "",
      stderr: error?.stderr || "",
      error: error?.message || String(error)
    };
  }
}

async function waitForLocalHealth(config, { fetcher, getChildExit }) {
  const started = Date.now();
  let health = { ok: false, detail: "local health was not checked", statusCode: 0 };
  while (Date.now() - started <= config.startupTimeoutMs) {
    const exit = getChildExit();
    if (exit) {
      return {
        ok: false,
        detail: `service exited before local health became ready: code=${exit.code ?? ""} signal=${exit.signal || ""}`.trim(),
        statusCode: 0
      };
    }
    health = await fetchHealth(localHealthUrl(config), { timeoutMs: Math.min(1500, config.timeoutMs), fetcher });
    if (health.ok) {
      return health;
    }
    await delay(500);
  }
  return {
    ok: false,
    detail: `timed out waiting for local health at ${localHealthUrl(config)}: ${health.detail}`,
    statusCode: health.statusCode
  };
}

async function stopSupervisedChild(child) {
  if (!child || child.killed) {
    return;
  }
  try {
    child.kill?.("SIGTERM");
  } catch {
    return;
  }
  await delay(250);
}

function waitForChildExit(child, getChildExit) {
  const existing = getChildExit();
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve) => {
    child.once?.("exit", (code, signal) => resolve({ code, signal }));
  });
}

function readinessStatusFromEnsure({ state, startedAt, command, config, ensure }) {
  return {
    schema: "tailnet-app.readiness/1",
    appName: config.appName,
    generatedAt: new Date().toISOString(),
    state,
    ok: ensure.ok,
    ready: ensure.ready,
    degraded: ensure.degraded,
    blocked: !ensure.ok,
    startedAt,
    command,
    config: readinessConfig(config),
    context: ensure.context,
    checks: ensure.checks,
    dependencies: ensure.dependencies,
    started: ensure.started,
    failed: ensure.failed,
    nextSteps: ensure.nextSteps
  };
}

function readinessConfig(config) {
  return {
    appName: config.appName,
    host: config.host,
    port: config.port,
    healthPath: config.healthPath,
    officialUrl: config.officialUrl,
    serviceName: config.serviceName,
    requireService: config.requireService,
    requireDeviceServe: config.requireDeviceServe
  };
}

async function writeReadinessStatus(statusFile, payload) {
  if (!statusFile) {
    return;
  }
  const fullPayload = {
    schema: "tailnet-app.readiness/1",
    generatedAt: new Date().toISOString(),
    ...payload
  };
  const tempPath = `${statusFile}.${process.pid}.tmp`;
  await mkdir(dirname(statusFile), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(fullPayload, null, 2)}\n`, "utf8");
  await rename(tempPath, statusFile);
}

async function runDependencyStartCommand(startCommand, { runner, timeoutMs }) {
  const command = startCommand?.command || "";
  const args = Array.isArray(startCommand?.args) ? startCommand.args : [];
  if (!command) {
    return { attempted: true, ok: false, error: "empty start command" };
  }

  try {
    const result = await runner(command, args, { timeoutMs });
    return {
      attempted: true,
      ok: true,
      command,
      args,
      stdout: result?.stdout || "",
      stderr: result?.stderr || ""
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      command,
      args,
      stdout: error?.stdout || "",
      stderr: error?.stderr || "",
      error: error?.message || String(error)
    };
  }
}

async function fetchHealth(url, { timeoutMs, fetcher }) {
  if (!fetcher) {
    return { ok: false, detail: "fetch is unavailable in this Node runtime", statusCode: 0 };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    const contentType = response.headers?.get?.("content-type") || "";
    const payload = /json/u.test(contentType) ? await response.json() : null;
    const payloadOk = payload === null || payload.ok === true || payload.status === "ok";
    return {
      ok: Boolean(response.ok && payloadOk),
      detail: payload === null ? `${url} returned HTTP ${response.status}` : `${url} -> ${JSON.stringify(payload)}`,
      statusCode: response.status || 0
    };
  } catch (error) {
    return { ok: false, detail: error?.message || String(error), statusCode: 0 };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeStartCommand(value) {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    const [command, ...args] = value.map((part) => String(part));
    return command ? { command, args } : null;
  }
  if (typeof value === "object") {
    const command = String(value.command || value.cmd || "").trim();
    const args = Array.isArray(value.args) ? value.args.map((part) => String(part)) : [];
    return command ? { command, args } : null;
  }
  if (typeof value === "string") {
    const parts = parseCommandLine(value);
    const [command, ...args] = parts;
    return command ? { command, args } : null;
  }
  return null;
}

function parseCommandLine(value) {
  const parts = [];
  let current = "";
  let quote = "";
  let escaping = false;

  for (const char of String(value || "")) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    parts.push(current);
  }
  return parts;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCommand(command, args = [], options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: options.timeoutMs || DEFAULT_CONFIG.timeoutMs,
      maxBuffer: options.maxBuffer || 1024 * 1024
    });
    return { stdout: result.stdout || "", stderr: result.stderr || "", code: 0 };
  } catch (error) {
    const message = error?.stderr || error?.stdout || error?.message || String(error);
    const wrapped = new Error(message.trim() || `command failed: ${command} ${args.join(" ")}`);
    wrapped.cause = error;
    wrapped.stdout = error?.stdout || "";
    wrapped.stderr = error?.stderr || "";
    wrapped.code = error?.code ?? 1;
    throw wrapped;
  }
}

export function parseJsonFromCommandOutput(output) {
  const text = String(output || "");
  const start = text.indexOf("{");

  if (start === -1) {
    throw new Error("command output did not contain JSON");
  }

  return JSON.parse(text.slice(start));
}

function withSocket(args, socket) {
  return socket ? [`--socket=${socket}`, ...args] : args;
}

function normalizePath(value) {
  const path = String(value || "/");
  return path.startsWith("/") ? path : `/${path}`;
}

function normalizeOptionalUrl(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    return "";
  }

  const url = new URL(raw);
  url.pathname = url.pathname || "/";
  return url.href;
}

function normalizeHttpsHostPort(value) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(`https://${value}`);
    return `${url.hostname}:${url.port || "443"}`;
  } catch {
    return value;
  }
}

async function checkHealth({ name, url, config, checks, fetcher }) {
  if (!fetcher) {
    checks.push({ name, ok: false, detail: "fetch is unavailable in this Node runtime" });
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const response = await fetcher(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      checks.push({ name, ok: false, detail: `${url} returned HTTP ${response.status}` });
      return;
    }

    const contentType = response.headers?.get?.("content-type") || "";
    const payload = /json/u.test(contentType) ? await response.json() : null;
    const payloadOk = payload === null || payload.ok === true || payload.status === "ok";
    checks.push({
      name,
      ok: payloadOk,
      detail: payload === null ? `${url} returned HTTP ${response.status}` : `${url} -> ${JSON.stringify(payload)}`
    });
  } catch (error) {
    checks.push({ name, ok: false, detail: error?.message || String(error) });
  }
}

function formatRoutes(routes) {
  return routes.map((route) => `${route.hostPort}${route.path} -> ${route.proxy || "unknown"}`).join(", ");
}

async function checkNamedService({ config, runner, checks, warnings }) {
  const expectedProxy = `http://${config.host}:${config.port}`;
  const serviceId = `svc:${config.serviceName}`;
  const serviceConfig = {
    ...config,
    socket: config.serviceSocket || config.socket
  };

  let serviceStatus = null;
  try {
    serviceStatus = await getTailscaleStatus(serviceConfig, { runner });
    const approved = hasServiceHostApproval(serviceStatus, config.serviceName);
    checks.push({
      name: "named_service_approval",
      ok: approved || !config.requireService,
      detail: approved
        ? `${serviceId} approved for this service host`
        : `${serviceId} is not approved in this service host capability map`
    });
  } catch (error) {
    checks.push({
      name: "named_service_approval",
      ok: !config.requireService,
      detail: error?.message || String(error)
    });
  }

  try {
    const serveStatus = await getTailscaleServeStatus(serviceConfig, { runner });
    const routes = flattenServeRoutes(serveStatus);
    const route = routes.find(
      (candidate) =>
        normalizeServiceName(candidate.serviceName) === config.serviceName &&
        candidate.path === "/" &&
        candidate.proxy === expectedProxy
    );
    checks.push({
      name: "named_service_route",
      ok: Boolean(route) || !config.requireService,
      detail: route ? `${route.serviceName} ${route.hostPort}/ -> ${route.proxy}` : `${serviceId} missing route to ${expectedProxy}`
    });
  } catch (error) {
    const message = error?.message || String(error);
    if (config.requireService) {
      checks.push({ name: "named_service_route", ok: false, detail: message });
    } else {
      warnings.push(`named service route not checked: ${message}`);
    }
  }
}
