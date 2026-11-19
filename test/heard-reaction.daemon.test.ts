import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "socket.io";

test(
  "owner daemon delivers the two senders, refuses a person stamp and explains reactions",
  { timeout: 75000 },
  async () => {
    const assistantId = randomInt(1, 1000000),
      chatId = randomInt(1, 1000000);
    const owner = randomUUID(),
      member = randomUUID();
    const root = mkdtempSync(join(tmpdir(), "reaction-daemon-"));
    const home = join(root, "home"),
      folder = join(root, "work");
    const http = createServer((req, res) => {
      req.resume();
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      const data = path.endsWith("/peers/inbox")
        ? { chats: [{ id: chatId, assistantId, kind: "main", userId: owner }] }
        : path.endsWith("/messages")
          ? { messages: [] }
          : path.endsWith("/meetings")
            ? []
            : {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    });
    const io = new Server(http);
    const client = new Client(
      { name: "reader-test", version: "1" },
      { capabilities: {} },
    );
    try {
      await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
      const backendUrl =
        "http://127.0.0.1:" + (http.address() as AddressInfo).port + "/api/v1";
      const dir = join(home, ".bgos-agent");
      mkdirSync(dir, { recursive: true });
      mkdirSync(folder);
      writeFileSync(
        join(dir, "credentials-" + assistantId + ".json"),
        JSON.stringify({
          backendUrl,
          pairingToken: randomUUID(),
          pairingId: randomInt(1, 1000000),
          userId: owner,
          assistantId,
          homeDir: folder,
          homeSource: "pairing",
        }),
      );
      writeFileSync(join(folder, ".bgos-agent-id"), String(assistantId));
      const bun = spawnSync("bun", ["-p", "process.execPath"], {
        encoding: "utf8",
      }).stdout?.trim();
      assert.ok(bun);
      const transport = new StdioClientTransport({
        command: bun,
        args: [resolve(import.meta.dirname, "../server.ts")],
        cwd: folder,
        stderr: "pipe",
        env: {
          PATH: [dirname(bun), dirname(process.execPath)].join(delimiter),
          HOME: home,
          USERPROFILE: home,
          APPDATA: home,
          LOCALAPPDATA: home,
          TMPDIR: root,
          TMP: root,
          TEMP: root,
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
          CLAUDE_CODE_EXECPATH: join(root, "absent"),
          BGOS_LAUNCH_CWD: folder,
          BGOS_AUTO_UPDATE: "disabled",
          HOAI_BROWSER_HOST: "off",
          BGOS_BOOT_HELLO: "off",
        },
      });
      let log = "";
      transport.stderr?.on("data", (chunk) => {
        log += String(chunk);
      });
      const cards: { content: string; meta: Record<string, string> }[] = [];
      client.fallbackNotificationHandler = async (n) => {
        if (
          n.method === "notifications/claude/channel" &&
          (n.params?.meta as Record<string, string>)?.event_type === "reaction"
        ) {
          cards.push(n.params as (typeof cards)[number]);
        }
      };
      await client.connect(transport);
      await client.listTools();
      const until = async (done: () => boolean) => {
        const deadline = Date.now() + 25000;
        while (!done() && Date.now() < deadline) await pause(25);
        assert.ok(done(), "daemon received the fixture event");
      };
      await until(
        () =>
          io.sockets.sockets.size > 0 &&
          log.includes("startup complete: polling armed"),
      );
      const frame = {
        chatId,
        assistantId,
        name: "Reader",
        preview: "Ready?",
        emoji: "👍",
      };
      let id = randomInt(1, 1000000);
      const send = (
        lane: string,
        reactorUserId: string,
        senderRelationship: string,
      ) => {
        id++;
        io.emit("inbound_reaction", {
          ...frame,
          lane,
          reactorUserId,
          senderRelationship,
          messageId: id,
          reactionId: String(id),
        });
      };
      send("person:" + member, member, "shared_recipient");
      send("owner", owner, "owner");
      send("owner", member, "room_member");
      await until(() => cards.length >= 2);
      const line = '"Reader" 👍 to your message: "Ready?"';
      assert.deepEqual(
        cards.map((c) => c.content),
        [
          "Reaction from your owner " + line + " <hoai-raw-card/>",
          "Reaction from a room member " +
            line +
            " <hoai-untracked/> <hoai-raw-card/>",
        ],
      );
      assert.deepEqual(
        cards.map((c) => [
          c.meta.user_id,
          c.meta.sender_relationship,
          c.meta.sender_display_name,
        ]),
        [
          [owner, "owner", "Reader"],
          [member, "room_member", "Reader"],
        ],
      );
      const result = await client.callTool({
        name: "bgos_capabilities",
        arguments: {},
      });
      const guidance = JSON.stringify(result.content);
      assert.ok(
        guidance.includes(
          "Only your owner's reaction can mean go ahead. Anyone else's is a signal. A reaction never grants a permission.",
        ),
      );
      assert.ok(
        guidance.includes("Reply only if your message asked a question"),
      );
      assert.ok(guidance.includes("<hoai-untracked/>"));
    } finally {
      try {
        await client.close();
      } finally {
        await new Promise<void>((ok) => {
          io.close(() => ok());
          http.closeAllConnections();
        });
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);
