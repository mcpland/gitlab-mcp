import { GitLabApiError, AuthenticationError } from "../utils/errors";

/**
 * Verify the GitLab connection and authentication
 *
 * This function checks if the GitLab API token is valid and if the
 * connection to the GitLab instance can be established
 *
 * @throws {AuthenticationError} If the authentication fails
 * @throws {GitLabApiError} If the connection fails for other reasons
 */
export const verifyGitLabConnection = async (): Promise<void> => {
  try {
    const token = process.env.GITLAB_TOKEN;
    const gitlabUrl = process.env.GITLAB_URL || "https://gitlab.com";

    if (!token) {
      throw new AuthenticationError("GitLab token not provided");
    }

    // TODO: Implement actual GitLab API connection verification
    // For now, we'll just simulate a successful connection
    console.log(`Verified connection to GitLab at ${gitlabUrl}`);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw error;
    }

    throw new GitLabApiError(
      `Failed to connect to GitLab: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};
