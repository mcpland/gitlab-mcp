import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../src/config/env.js";

const undiciMocks = vi.hoisted(() => ({
  Agent: vi.fn(function MockAgent(options?: unknown) {
    return { kind: "agent", options };
  }),
  EnvHttpProxyAgent: vi.fn(function MockEnvHttpProxyAgent(options?: unknown) {
    return { kind: "proxy", options };
  }),
  setGlobalDispatcher: vi.fn()
}));

vi.mock("undici", () => ({
  Agent: undiciMocks.Agent,
  EnvHttpProxyAgent: undiciMocks.EnvHttpProxyAgent,
  setGlobalDispatcher: undiciMocks.setGlobalDispatcher
}));

describe("configureNetworkRuntime", () => {
  beforeEach(() => {
    vi.resetModules();
    undiciMocks.Agent.mockClear();
    undiciMocks.EnvHttpProxyAgent.mockClear();
    undiciMocks.setGlobalDispatcher.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the direct agent when no proxy is configured", async () => {
    const { configureNetworkRuntime } = await import("../src/lib/network.js");

    configureNetworkRuntime(buildEnv(), buildLogger());

    expect(undiciMocks.Agent).toHaveBeenCalledWith({
      connect: {
        rejectUnauthorized: true,
        ca: undefined
      }
    });
    expect(undiciMocks.EnvHttpProxyAgent).not.toHaveBeenCalled();
    expect(undiciMocks.setGlobalDispatcher).toHaveBeenCalledWith({
      kind: "agent",
      options: {
        connect: {
          rejectUnauthorized: true,
          ca: undefined
        }
      }
    });
  });

  it("uses EnvHttpProxyAgent and forwards NO_PROXY when a proxy is configured", async () => {
    const { configureNetworkRuntime } = await import("../src/lib/network.js");
    const logger = buildLogger();

    configureNetworkRuntime(
      buildEnv({
        HTTP_PROXY: "http://proxy-user:proxy-password@proxy.internal:8080",
        HTTPS_PROXY: "http://proxy-user:proxy-password@proxy.internal:8080",
        NO_PROXY: "localhost,.corp.internal,gitlab.example.com:8443"
      }),
      logger
    );

    expect(undiciMocks.EnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: "http://proxy-user:proxy-password@proxy.internal:8080",
      httpsProxy: "http://proxy-user:proxy-password@proxy.internal:8080",
      noProxy: "localhost,.corp.internal,gitlab.example.com:8443",
      connect: {
        rejectUnauthorized: true,
        ca: undefined
      },
      requestTls: {
        rejectUnauthorized: true,
        ca: undefined
      }
    });
    expect(undiciMocks.Agent).not.toHaveBeenCalled();
    expect(undiciMocks.setGlobalDispatcher).toHaveBeenCalledWith({
      kind: "proxy",
      options: {
        httpProxy: "http://proxy-user:proxy-password@proxy.internal:8080",
        httpsProxy: "http://proxy-user:proxy-password@proxy.internal:8080",
        noProxy: "localhost,.corp.internal,gitlab.example.com:8443",
        connect: {
          rejectUnauthorized: true,
          ca: undefined
        },
        requestTls: {
          rejectUnauthorized: true,
          ca: undefined
        }
      }
    });
    expect(logger.info).toHaveBeenCalledWith(
      {
        httpProxyConfigured: true,
        httpsProxyConfigured: true,
        noProxyConfigured: true,
        rejectUnauthorized: true
      },
      "Configured global proxy dispatcher"
    );
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("proxy-password");
  });
});

function buildEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    NODE_TLS_REJECT_UNAUTHORIZED: undefined,
    HTTP_PROXY: undefined,
    HTTPS_PROXY: undefined,
    NO_PROXY: undefined,
    GITLAB_CA_CERT_PATH: undefined,
    ...overrides
  } as AppEnv;
}

function buildLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn()
  } as unknown as Logger;
}
