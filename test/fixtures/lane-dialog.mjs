import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
const server = new McpServer({ name: 'ask', version: '0.0.0' })
server.registerTool('question', { inputSchema: {} }, async () => {
  await server.server.elicitInput({ message: 'Made up lane question', requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } } })
  return { content: [{ type: 'text', text: 'Answered' }] }
})
await server.connect(new StdioServerTransport())
