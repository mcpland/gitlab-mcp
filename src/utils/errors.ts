/**
 * Base application error class
 */
export class AppError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.name = this.constructor.name;
  }
}

/**
 * Error for configuration issues
 */
export class ConfigError extends AppError {
  constructor(message: string) {
    super(`Configuration error: ${message}`, 500);
  }
}

/**
 * Error for GitLab API related issues
 */
export class GitLabApiError extends AppError {
  constructor(message: string, statusCode = 400) {
    super(`GitLab API error: ${message}`, statusCode);
  }
}

/**
 * Error for authentication issues
 */
export class AuthenticationError extends AppError {
  constructor(message: string) {
    super(`Authentication error: ${message}`, 401);
  }
}

/**
 * Error for resource not found
 */
export class NotFoundError extends AppError {
  constructor(resource: string, identifier?: string | number) {
    const message = identifier
      ? `${resource} with identifier "${identifier}" not found`
      : `${resource} not found`;
    super(message, 404);
  }
}

/**
 * Global error handler function
 *
 * @param error - The error to handle
 * @returns Formatted error object
 */
export const handleError = (
  error: unknown
): { message: string; statusCode: number } => {
  if (error instanceof AppError) {
    return {
      message: error.message,
      statusCode: error.statusCode,
    };
  }

  // Handle generic errors
  const message = error instanceof Error ? error.message : String(error);
  return {
    message: `Unexpected error: ${message}`,
    statusCode: 500,
  };
};
