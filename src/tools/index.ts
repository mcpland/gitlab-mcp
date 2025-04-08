import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { debug } from '../utils/logger';

/**
 * Register all tools with the MCP server
 * 
 * @param server - The MCP server instance
 */
export const registerTools = (server: McpServer): void => {
    debug('Registering tools...');
    
    // TODO: Implement GitLab tools registration
    
    debug('Tools registered successfully');
}; 