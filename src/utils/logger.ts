import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";

// Global reference to the server instance for sending logging messages
let serverInstance: McpServer | null = null;

/**
 * Activate MCP context for logging without necessarily setting a server instance
 * This is useful for early startup before server initialization to prevent stdout logs
 */
export const activateMcpContext = (): void => {
  isMcpContextActive = true;
};

// Flag to indicate whether we're running in an MCP context or standalone
let isMcpContextActive = false;

// Flag to indicate if server is connected and ready for logging
let isServerConnected = false;

// Log levels matching the MCP protocol
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  NOTICE = 2,
  WARNING = 3,
  ERROR = 4,
  CRITICAL = 5,
  ALERT = 6,
  EMERGENCY = 7,
}

/**
 * Convert our LogLevel to MCP log level string
 */
const toMcpLogLevel = (level: LogLevel): string => {
  switch (level) {
    case LogLevel.DEBUG:
      return "debug";
    case LogLevel.INFO:
      return "info";
    case LogLevel.NOTICE:
      return "notice";
    case LogLevel.WARNING:
      return "warning";
    case LogLevel.ERROR:
      return "error";
    case LogLevel.CRITICAL:
      return "critical";
    case LogLevel.ALERT:
      return "alert";
    case LogLevel.EMERGENCY:
      return "emergency";
  }
};

/**
 * Set the MCP server instance for logging and activate MCP context
 *
 * @param server - The MCP server instance
 */
export const setLoggerServer = (server: McpServer): void => {
  serverInstance = server;
  isMcpContextActive = true;
};

/**
 * Mark the server as connected and ready for logging
 */
export const markServerConnected = (): void => {
  isServerConnected = true;
};

/**
 * Safely check if the server is ready for logging
 */
const canUseServerLogging = (): boolean => {
  if (!serverInstance || !isServerConnected) {
    return false;
  }

  try {
    return (
      serverInstance.server !== undefined &&
      typeof serverInstance.server.sendLoggingMessage === "function"
    );
  } catch (error) {
    return false;
  }
};

/**
 * Send a logging message through MCP protocol
 *
 * @param level - Log level
 * @param message - Log message
 * @param logger - Logger name (optional)
 */
export const log = (
  level: LogLevel,
  message: string,
  logger = "gitlab-mcp"
): void => {
  // When the MCP context is active, we ONLY use stderr for critical errors
  // and send everything else through the MCP protocol
  if (isMcpContextActive) {
    // Always write errors and above to stderr
    if (level >= LogLevel.ERROR) {
      process.stderr.write(`[${logger}] ${LogLevel[level]}: ${message}\n`);
    }

    // Only try to send through MCP protocol if server is definitely connected
    if (canUseServerLogging()) {
      try {
        // Use the underlying server's sendLoggingMessage method
        serverInstance!.server.sendLoggingMessage({
          level: toMcpLogLevel(level),
          message,
          logger,
        });
      } catch (error) {
        // If sending the log message through MCP fails, fall back to stderr
        // Only log warnings and above to avoid flooding
        if (level >= LogLevel.WARNING) {
          process.stderr.write(`[${logger}] ${LogLevel[level]}: ${message}\n`);
        }
      }
    } else if (level >= LogLevel.WARNING) {
      // If server isn't properly connected, still log warnings to stderr
      process.stderr.write(`[${logger}] ${LogLevel[level]}: ${message}\n`);
    }
  } else {
    // In standalone mode, write to stderr for errors and stdout for everything else
    if (level >= LogLevel.ERROR) {
      process.stderr.write(`[${logger}] ${LogLevel[level]}: ${message}\n`);
    } else {
      process.stdout.write(`[${logger}] ${LogLevel[level]}: ${message}\n`);
    }
  }
};

// Convenience methods for different log levels
export const debug = (message: string, logger?: string) =>
  log(LogLevel.DEBUG, message, logger);
export const info = (message: string, logger?: string) =>
  log(LogLevel.INFO, message, logger);
export const notice = (message: string, logger?: string) =>
  log(LogLevel.NOTICE, message, logger);
export const warning = (message: string, logger?: string) =>
  log(LogLevel.WARNING, message, logger);
export const error = (message: string, logger?: string) =>
  log(LogLevel.ERROR, message, logger);
export const critical = (message: string, logger?: string) =>
  log(LogLevel.CRITICAL, message, logger);
export const alert = (message: string, logger?: string) =>
  log(LogLevel.ALERT, message, logger);
export const emergency = (message: string, logger?: string) =>
  log(LogLevel.EMERGENCY, message, logger);
