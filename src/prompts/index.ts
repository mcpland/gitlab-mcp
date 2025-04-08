import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { debug } from '../utils/logger';

/**
 * Register all prompts with the MCP server
 * 
 * @param server - The MCP server instance
 */
export const registerPrompts = (server: McpServer): void => {
    debug('Registering prompts...');
    
    // TODO: Implement GitLab prompts registration
    
    debug('Prompts registered successfully');
}; 