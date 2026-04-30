import { execFile } from "node:child_process";
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
  allowFunnel: false,
  strictFunnel: false,
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

  return {
    ...config,
    appName: String(config.appName || DEFAULT_CONFIG.appName),
    host: String(config.host || DEFAULT_CONFIG.host),
    port,
    httpsPort,
    healthPath: normalizePath(config.healthPath || DEFAULT_CONFIG.healthPath),
    serviceName: normalizeServiceName(config.serviceName || ""),
    tailscaleBin: String(config.tailscaleBin || DEFAULT_CONFIG.tailscaleBin),
    socket: String(config.socket || ""),
    serviceSocket: String(config.serviceSocket || ""),
    allowFunnel: Boolean(config.allowFunnel),
    strictFunnel: Boolean(config.strictFunnel),
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
    serviceUrl: ""
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
      ok: Boolean(route),
      detail: route ? `${route.hostPort}${route.path} -> ${route.proxy}` : `missing proxy to ${expectedProxy}`
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

  const ok = checks.every((check) => check.ok);
  return { ok, checks, warnings, context };
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
