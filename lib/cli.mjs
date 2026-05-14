import { readFile } from "node:fs/promises";
import {
  configureDeviceServe,
  configureNamedService,
  deviceTailnetUrl,
  getTailscaleStatus,
  localUrl,
  normalizeConfig,
  runTailnetEnsure,
  runTailnetDoctor,
  runTailnetSupervise,
  serviceInstructions,
  tailscaleDnsName,
  tailscaleLogin
} from "./index.mjs";

const HELP = `tailnet-app

Usage:
  tailnet-app status [options]
  tailnet-app doctor [options]
  tailnet-app ensure [options]
  tailnet-app supervise [options] -- <service command...>
  tailnet-app serve-device [options]
  tailnet-app serve-service [options]
  tailnet-app service-instructions [options]

Options:
  --config <path>             Read JSON config
  --app-name <name>           App name for output
  --host <host>               Local app host (default: 127.0.0.1)
  --port <port>               Local app port
  --health-path <path>        Health path (default: /healthz)
  --https-port <port>         Tailscale device Serve HTTPS port (default: app port)
  --service-name <name>       Named Tailscale Service name
  --tailscale-bin <path>      Tailscale CLI path (default: tailscale)
  --socket <path>             Tailscale socket for device Serve/status
  --service-socket <path>     Tailscale socket for named service host
  --official-url <url>        Canonical named service URL to health-check
  --require-service           Fail doctor when named service is not approved/routed
  --require-official-health   Fail doctor when official URL health is unavailable
  --require-device-serve      Require a per-device Serve route even for service-host apps
  --auto-serve                Configure private device Serve when its route is missing
  --auto-service              Configure named Service host route when missing
  --dependency <name=url>      Health dependency to check before serving features
  --optional-dependency <name=url> Optional dependency that degrades readiness
  --start-command <name=cmd>   Start command for a dependency
  --status-file <path>         Write supervise readiness JSON to this path
  --startup-timeout-ms <ms>    Time to wait for supervised local health
  --allow-funnel              Do not fail if this app is public through Funnel
  --strict-funnel             Fail if any public Funnel route exists on the node
  --json                      Emit JSON
  -h, --help                  Show help`;

export async function main(argv = []) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "doctor";
  const args = command === argv[0] ? argv.slice(1) : argv;

  if (command === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  const { config, json, statusFile, serviceCommand } = await parseConfig(args);

  switch (command) {
    case "status":
      await statusCommand(config, { json });
      return;
    case "doctor":
      await doctorCommand(config, { json });
      return;
    case "ensure":
      await ensureCommand(config, { json });
      return;
    case "supervise":
      await superviseCommand(config, { json, statusFile, serviceCommand });
      return;
    case "serve-device":
      await serveDeviceCommand(config, { json });
      return;
    case "serve-service":
      await serveServiceCommand(config, { json });
      return;
    case "service-instructions":
      await serviceInstructionsCommand(config, { json });
      return;
    default:
      throw new Error(`unknown command: ${command}\n\n${HELP}`);
  }
}

async function statusCommand(config, { json }) {
  const status = await getTailscaleStatus(config);
  const resolved = normalizeConfig(config);
  const payload = {
    appName: resolved.appName,
    localUrl: localUrl(resolved),
    login: tailscaleLogin(status),
    backendState: status?.BackendState || "",
    dnsName: tailscaleDnsName(status),
    tailnet: status?.MagicDNSSuffix || "",
    deviceUrl: deviceTailnetUrl(tailscaleDnsName(status), resolved)
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`${payload.appName} tailnet status`);
  console.log(`Local:     ${payload.localUrl}`);
  console.log(`Tailscale: ${payload.deviceUrl || "unavailable"}`);
  console.log(`State:     ${payload.backendState || "unknown"}`);
  console.log(`Login:     ${payload.login || "unknown"}`);
}

async function doctorCommand(config, { json }) {
  const result = await runTailnetDoctor(config);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printDoctor(result);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function ensureCommand(config, { json }) {
  const result = await runTailnetEnsure(config);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printEnsure(result);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function superviseCommand(config, { json, statusFile, serviceCommand }) {
  if (!serviceCommand.length) {
    throw new Error("supervise requires -- followed by a service command");
  }

  const result = await runTailnetSupervise(config, {
    command: serviceCommand,
    statusFile: statusFile || config.statusFile || ""
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Tailnet app supervise: ${result.state || "stopped"}`);
    if (statusFile || config.statusFile) {
      console.log(`Status:    ${statusFile || config.statusFile}`);
    }
    console.log(`Exit code: ${result.exitCode}`);
  }

  process.exitCode = result.exitCode;
}

async function serveDeviceCommand(config, { json }) {
  const resolved = normalizeConfig(config);
  const result = await configureDeviceServe(resolved);
  const status = await getTailscaleStatus(resolved);
  const payload = {
    ok: true,
    stdout: result.stdout,
    stderr: result.stderr,
    localUrl: localUrl(resolved),
    deviceUrl: deviceTailnetUrl(tailscaleDnsName(status), resolved)
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("Tailnet device Serve configured.");
  console.log(`Local:     ${payload.localUrl}`);
  console.log(`Tailscale: ${payload.deviceUrl || "unavailable"}`);
}

async function serveServiceCommand(config, { json }) {
  const resolved = normalizeConfig(config);
  const result = await configureNamedService(resolved);
  let status = null;

  try {
    status = await getTailscaleStatus({ ...resolved, socket: resolved.serviceSocket || resolved.socket });
  } catch {
    status = null;
  }

  const instructions = serviceInstructions(resolved, status);
  const payload = { ok: true, stdout: result.stdout, stderr: result.stderr, instructions };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("Named service host route configured.");
  printServiceInstructions(instructions);
}

async function serviceInstructionsCommand(config, { json }) {
  const resolved = normalizeConfig(config);
  let status = null;

  try {
    status = await getTailscaleStatus(resolved);
  } catch {
    status = null;
  }

  const instructions = serviceInstructions(resolved, status);

  if (json) {
    console.log(JSON.stringify(instructions, null, 2));
    return;
  }

  printServiceInstructions(instructions);
}

async function parseConfig(args) {
  const cli = {};
  const dependencyStartCommands = new Map();
  const separatorIndex = args.indexOf("--");
  const optionArgs = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
  const serviceCommand = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];
  let configPath = "";
  let json = false;
  let statusFile = "";

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];

    switch (arg) {
      case "--config":
        configPath = requireValue(optionArgs, ++index, arg);
        break;
      case "--app-name":
        cli.appName = requireValue(optionArgs, ++index, arg);
        break;
      case "--host":
        cli.host = requireValue(optionArgs, ++index, arg);
        break;
      case "--port":
        cli.port = requireValue(optionArgs, ++index, arg);
        break;
      case "--health-path":
        cli.healthPath = requireValue(optionArgs, ++index, arg);
        break;
      case "--https-port":
        cli.httpsPort = requireValue(optionArgs, ++index, arg);
        break;
      case "--service-name":
        cli.serviceName = requireValue(optionArgs, ++index, arg);
        break;
      case "--tailscale-bin":
        cli.tailscaleBin = requireValue(optionArgs, ++index, arg);
        break;
      case "--socket":
        cli.socket = requireValue(optionArgs, ++index, arg);
        break;
      case "--service-socket":
        cli.serviceSocket = requireValue(optionArgs, ++index, arg);
        break;
      case "--official-url":
        cli.officialUrl = requireValue(optionArgs, ++index, arg);
        break;
      case "--dependency":
      case "--required-dependency": {
        cli.dependencies ||= [];
        cli.dependencies.push(requireValue(optionArgs, ++index, arg));
        break;
      }
      case "--optional-dependency": {
        cli.dependencies ||= [];
        const value = requireValue(optionArgs, ++index, arg);
        const separatorIndex = value.indexOf("=");
        cli.dependencies.push({
          name: separatorIndex > 0 ? value.slice(0, separatorIndex).trim() : "",
          healthUrl: separatorIndex > 0 ? value.slice(separatorIndex + 1).trim() : value,
          required: false
        });
        break;
      }
      case "--start-command": {
        const value = requireValue(optionArgs, ++index, arg);
        const separatorIndex = value.indexOf("=");
        if (separatorIndex <= 0) {
          throw new Error("--start-command requires name=command");
        }
        dependencyStartCommands.set(value.slice(0, separatorIndex).trim(), value.slice(separatorIndex + 1).trim());
        break;
      }
      case "--require-service":
        cli.requireService = true;
        break;
      case "--require-official-health":
        cli.requireOfficialHealth = true;
        break;
      case "--require-device-serve":
        cli.requireDeviceServe = true;
        break;
      case "--auto-serve":
        cli.autoServe = true;
        break;
      case "--auto-service":
        cli.autoService = true;
        break;
      case "--status-file":
        statusFile = requireValue(optionArgs, ++index, arg);
        break;
      case "--startup-timeout-ms":
        cli.startupTimeoutMs = requireValue(optionArgs, ++index, arg);
        break;
      case "--allow-funnel":
        cli.allowFunnel = true;
        break;
      case "--strict-funnel":
        cli.strictFunnel = true;
        break;
      case "--json":
        json = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  const fileConfig = configPath ? JSON.parse(await readFile(configPath, "utf8")) : {};
  const merged = { ...fileConfig, ...cli };
  if (dependencyStartCommands.size > 0) {
    const dependencies = Array.isArray(merged.dependencies) ? [...merged.dependencies] : [];
    merged.dependencies = dependencies.map((dependency) => {
      const name = typeof dependency === "string"
        ? dependency.split("=")[0]
        : dependency?.name || dependency?.slug || dependency?.service || "";
      const startCommand = dependencyStartCommands.get(String(name).trim());
      return startCommand && dependency && typeof dependency === "object"
        ? { ...dependency, startCommand, autoStart: true }
        : startCommand
          ? { name, healthUrl: String(dependency).split("=").slice(1).join("="), startCommand, autoStart: true }
          : dependency;
    });
  }
  return { config: normalizeConfig(merged), json, statusFile, serviceCommand };
}

function printDoctor(result) {
  console.log(`Tailnet app doctor: ${result.ok ? "OK" : "FAIL"}`);
  console.log(`Local:     ${result.context.localUrl}`);
  console.log(`Health:    ${result.context.localHealthUrl}`);
  if (result.context.deviceUrl) {
    console.log(`Tailscale: ${result.context.deviceUrl}`);
  }
  if (result.context.serviceUrl) {
    console.log(`Service:   ${result.context.serviceUrl}`);
  }
  if (result.context.officialUrl) {
    console.log(`Official:  ${result.context.officialUrl}`);
  }

  for (const check of result.checks) {
    console.log(`- ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  if (result.deviceServe?.attempted) {
    console.log(`- ${result.deviceServe.ok ? "PASS" : "FAIL"} device_serve_setup: ${result.deviceServe.ok ? "configured private Tailscale Serve" : result.deviceServe.error}`);
  }

  for (const warning of result.warnings) {
    console.log(`- WARN ${warning}`);
  }
}

function printEnsure(result) {
  console.log(`Tailnet app ensure: ${result.ok ? "OK" : result.ready ? "DEGRADED" : "FAIL"}`);
  console.log(`Local:     ${result.context.localUrl}`);
  console.log(`Health:    ${result.context.localHealthUrl}`);
  if (result.context.deviceUrl) {
    console.log(`Tailscale: ${result.context.deviceUrl}`);
  }
  if (result.context.serviceUrl) {
    console.log(`Service:   ${result.context.serviceUrl}`);
  }

  for (const check of result.checks) {
    console.log(`- ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  for (const dependency of result.dependencies) {
    const state = dependency.ok ? "ready" : dependency.required ? "blocked" : "degraded";
    const started = dependency.start?.attempted ? `; start ${dependency.start.ok ? "ok" : "failed"}` : "";
    console.log(`- ${state.toUpperCase()} dependency ${dependency.name}: ${dependency.detail}${started}`);
  }
  for (const nextStep of result.nextSteps) {
    console.log(`- NEXT ${nextStep}`);
  }
}

function printServiceInstructions(instructions) {
  console.log(`Admin URL:    ${instructions.adminUrl}`);
  console.log(`Name:         ${instructions.serviceName}`);
  console.log(`Service ID:   ${instructions.serviceId}`);
  console.log(`Endpoint:     ${instructions.endpoint}`);
  console.log(`Expected URL: ${instructions.serviceUrl}`);
  console.log("");
  console.log("If the service is not already defined, open the admin URL, define the service,");
  console.log("then approve/allow the advertised host for tcp:443.");
  console.log("");
  console.log("Host command:");
  console.log(instructions.hostCommand);
}

function requireValue(args, index, flag) {
  const value = args[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}
