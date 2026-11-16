// A tiny MCP server with one "echo" tool, for testing the mcpServers block of config.json.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const server = new McpServer({ name: 'echo', version: '1.0.0' });
server.tool('echo', 'Echoes the text back', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }));
server.connect(new StdioServerTransport());
