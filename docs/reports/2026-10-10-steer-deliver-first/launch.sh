#!/bin/sh
cd <scratch>/proj
exec claude --model sonnet --mcp-config <scratch>/mcp.json --settings <scratch>/hooks-settings.json --dangerously-load-development-channels server:bgos --permission-mode bypassPermissions
