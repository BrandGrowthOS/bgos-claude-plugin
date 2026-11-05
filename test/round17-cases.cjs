"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const text = r => (r?.content || []).filter(p => p.type === "text").map(p => p.text).join("\n");
const ref = (tree, role) => new RegExp(`${role}[^\\n]*ref=((?:f\\d+)?e\\d+)`).exec(tree)?.[1];
module.exports = (rig, host) => {
  for (const language of ["en", "ar"]) {
    const using = language === "ar" ? /الشخص يستخدم|يستخدم الشخص/ : /The person is using this tab/;
    const check = (name, work, timeout = 60000) => test(`${host} ${language} round17 ${name}`, {timeout}, async t => {
      const r = await rig(t), set = r.set;
      r.set = html => set(`<html lang="${language}">${html}</html>`);
      r.capture = async (phase, reply) => {
        if (!process.env.BROWSER17_EVIDENCE_DIR) return;
        await r.page.evaluate(({reply, language}) => {
          const note = document.createElement("pre");
          note.id = "browser17-proof";
          note.textContent = (language === "ar" ? "إجابة الأداة: " : "Tool reply: ") + reply;
          note.style = "position:fixed;inset:0 0 auto;z-index:2147483647;background:#163b2d;color:white;padding:16px;white-space:pre-wrap;font:16px sans-serif";
          document.documentElement.append(note);
        }, {reply, language});
        try {
          const shot = await r.raw(send => send("Page.captureScreenshot", {format:"png"}), r.page);
          fs.writeFileSync(path.join(process.env.BROWSER17_EVIDENCE_DIR, `${host}-${language}-${name.replace(/[^a-z0-9]+/gi,"-")}-${phase}.png`), Buffer.from(shot.data,"base64"));
        } finally { await r.page.evaluate(() => document.getElementById("browser17-proof")?.remove()); }
      };
      await work(r, t);
      await r.capture("final", r.evidenceReply || text(await r.call("browser_snapshot")));
    });
    const ordinary = async r => {
      assert.equal(r.engine._privacy.personMode(r.page), false);
      assert.match(text(await r.call("browser_snapshot")), /Public/);
    };
    const blind = async r => {
      for (const name of ["browser_snapshot", "browser_take_screenshot", "browser_tabs"]) {
        const reply = await r.call(name, name === "browser_tabs" ? {action:"list"} : {});
        assert.doesNotMatch(text(reply), /MADEUP/);
        assert.match(text(reply), using);
        assert.equal(reply.content?.some(p => p.type === "image"), false);
      }
      assert.equal(r.engine._privacy.personMode(r.page), true);
    };
    check("plain trusted click and phone tap stay ordinary", async r => {
      await r.set("<h1>Public</h1><button>Tap</button>");
      await r.raw(async send => {
        await send("Input.dispatchMouseEvent", {type:"mousePressed",x:20,y:20,button:"left",clickCount:1});
        await send("Input.dispatchMouseEvent", {type:"mouseReleased",x:20,y:20,button:"left",clickCount:1});
      });
      await ordinary(r);
      await r.capture("click-readable", text(await r.call("browser_snapshot")));
      await r.raw(async send => {
        await send("Emulation.setTouchEmulationEnabled", {enabled:true});
        await send("Input.dispatchTouchEvent", {type:"touchStart",touchPoints:[{x:20,y:20}]});
        await send("Input.dispatchTouchEvent", {type:"touchEnd",touchPoints:[]});
      });
      await ordinary(r);
      await r.capture("tap-readable", text(await r.call("browser_snapshot")));
      await r.raw(send => send("Input.dispatchKeyEvent", {type:"rawKeyDown",key:"Shift",code:"ShiftLeft"}));
      await blind(r);
    });
    check("capture watcher keeps priority over page blockers after mutations", async r => {
      await r.set(`<h1>Public</h1><input aria-label=Membership><script>
        for(const type of ['keydown','keypress','keyup','beforeinput','input','paste','drop'])
          window.addEventListener(type,event=>event.stopImmediatePropagation(),true);
        document.appendChild(document.createComment('replacement trigger'));
      </script>`);
      await r.person('document.querySelector("input").focus()');
      assert.match(await r.page.locator("input").inputValue(), /MADEUP/);
      await blind(r);
    });
    check("document replacement with page blockers withholds person text", async r => {
      await r.set("<h1>Public</h1>");
      await r.page.evaluate(language => {
        document.open();
        document.write(`<html lang="${language}"><h1>Public</h1><input aria-label=Membership><script>
          for(const type of ['keydown','keypress','keyup','beforeinput','input','paste','drop'])
            window.addEventListener(type,event=>event.stopImmediatePropagation(),true);
        <` + `/script></html>`);
        document.close();
      }, language);
      await r.person('document.querySelector("input").focus()');
      await blind(r);
      await r.page.evaluate(() => document.querySelector("input").value = "");
      await r.handBack();
      await r.person('document.querySelector("input").focus()');
      await blind(r);
    });
    check("a written iframe with page blockers keeps parent metadata private", async r => {
      await r.set('<h1>Public</h1><iframe></iframe>');
      await r.page.evaluate(language => {
        const doc = document.querySelector("iframe").contentDocument;
        doc.open();
        doc.write(`<html lang="${language}"><input><script>
          for(const type of ['keydown','keypress','keyup','beforeinput','input','paste','drop'])
            window.addEventListener(type,event=>event.stopImmediatePropagation(),true);
        <` + `/script></html>`);
        doc.close();
      }, language);
      await r.person('document.querySelector("iframe").contentDocument.querySelector("input").focus()');
      await r.page.evaluate(() => { document.title = "MADEUP-PARENT9876"; history.replaceState(null,"","/search?q=MADEUP-PARENT9876"); });
      await blind(r);
    });
    check("agent paste and editing shortcuts never lock", async r => {
      await r.set("<h1>Public</h1><input aria-label=Reference>");
      const tree = text(await r.call("browser_snapshot")), target = ref(tree, "textbox");
      assert.ok(target, tree);
      await r.route("browser_type", {target,element:"Reference",text:"ATLAS",slowly:true}, ["allow_once"]);
      // Seed only invented clipboard data before any paste. Never inspect an existing clipboard.
      await r.raw(send => send("Browser.grantPermissions", {origin:r.origin,permissions:["clipboardReadWrite","clipboardSanitizedWrite"]}));
      await r.page.evaluate(() => navigator.clipboard.writeText("MADEUP-AGENT-PASTE9876"));
      for (const key of ["ControlOrMeta+v", "Control+k", "Control+h"]) {
        const result = await r.route("browser_press_key", {key}, ["allow_once"]);
        assert.doesNotMatch(text(result.result), /Hand back|إعادة التحكم/, key);
        if (key === "ControlOrMeta+v") {
          await r.page.waitForFunction(() => document.querySelector("input").value.includes("MADEUP-AGENT-PASTE9876"));
          assert.match(await r.page.locator("input").inputValue(), /MADEUP-AGENT-PASTE9876/);
        }
        await ordinary(r);
        await r.capture(key.replace(/[^a-z]+/gi,"-"), text(await r.call("browser_snapshot")));
      }
      await r.person('document.querySelector("input").focus()');
      await blind(r);
    });
    check("bare postal PIN code stays ordinary and card PIN stays secret", async r => {
      await r.set('<h1>Public</h1><input aria-label="PIN code" value="MADEUP-POSTAL9876">');
      assert.match(text(await r.call("browser_snapshot")), /MADEUP-POSTAL9876/);
      await ordinary(r);
      await r.capture("postal-readable", text(await r.call("browser_snapshot")));
      await r.set('<input aria-label="Card PIN code" value="MADEUP-SECRET9876">');
      assert.doesNotMatch(text(await r.call("browser_snapshot")), /MADEUP/);
    });
    check("financial PIN code qualifiers remain sealed", async r => {
      for (const label of ["Bank PIN code", "Debit PIN code", "Security PIN code", "PIN code password"]) {
        await r.set(`<input aria-label="${label}" value="MADEUP-SECRET9876">`);
        assert.doesNotMatch(text(await r.call("browser_snapshot")), /MADEUP/, label);
        await r.page.evaluate(() => document.querySelector("input").value = "");
        await r.handBack();
      }
    });
    check("agent key removing a frame and submitting a document stays ordinary", async r => {
      await r.set(`<h1>Public</h1><form action=/saved><input aria-label=Reference><button>Save</button></form>
        <iframe srcdoc="<p>Child</p>"></iframe><script>
        addEventListener('keydown',()=>document.querySelector('iframe')?.remove());
      </script>`);
      const tree = text(await r.call("browser_snapshot")), target = ref(tree,"textbox");
      assert.ok(target, tree);
      await r.route("browser_type", {target,element:"Reference",text:"ATLAS"}, ["allow_once"]);
      await r.route("browser_press_key", {key:"ArrowLeft"}, ["allow_once"]);
      assert.equal(await r.page.locator("iframe").count(), 0);
      await ordinary(r);
      await r.route("browser_press_key", {key:"Enter"}, ["allow_once"]);
      await r.page.waitForURL(/saved/);
      await ordinary(r);
      await r.person('document.querySelector("input").focus()');
      await blind(r);
    });
    check("every reply and tab list redacts a different person tab title and URL", async r => {
      await r.set('<input aria-label=Membership><h1>Public</h1>');
      const personPage = r.page;
      const opened = await r.call("browser_tabs", {action:"new",url:r.origin+"/agent"});
      assert.notEqual(opened.isError, true, text(opened));
      assert.equal(r.engine.pages().length, 2, "a separate agent tab was created");
      assert.match(text(await r.call("browser_snapshot")), /Public/, "the agent tab stays readable");
      await r.person('document.querySelector("input").focus()', personPage);
      await personPage.evaluate(language => {
        document.documentElement.lang = language;
        document.title = "MADEUP-TITLE9876";
        history.replaceState(null,"","/search?q=MADEUP-ADDRESS9876");
      }, language);
      for (const [name,args] of [["browser_snapshot",{}],["browser_navigate",{url:r.origin+"/agent2"}],["browser_tabs",{action:"list"}]]) {
        const reply = text(await r.call(name,args));
        assert.doesNotMatch(reply, /MADEUP/, name);
        if (name === "browser_snapshot") assert.match(reply, /Public/, "the agent can still read its own tab");
        if (name === "browser_navigate") {
          assert.match(r.page.url(), /agent2$/);
          assert.match(text(await r.call("browser_snapshot")), /Public/, "the agent can read its new document");
        }
        if (name === "browser_tabs") {
          assert.match(reply, /^### Open tabs/);
          assert.match(reply, /- 1: \(current\).*agent2/);
        }
        if (name === "browser_tabs" || reply.includes("### Open tabs")) assert.match(reply, using, name);
        if (name === "browser_tabs") r.evidenceReply = reply;
      }
    });
    check("native agent dispatch ignores isolated clock skew", async r => {
      await r.set('<h1>Public</h1><input aria-label=Reference>');
      const client = r.page._connection.toImpl(r.page).delegate._mainFrameSession._client;
      const worlds = [];
      const collect = ({context}) => { if (context.name.startsWith("hoaiPersonWorld")) worlds.push(context); };
      client.on("Runtime.executionContextCreated", collect);
      await client.send("Runtime.disable");
      await client.send("Runtime.enable");
      client.removeListener("Runtime.executionContextCreated", collect);
      assert.ok(worlds.length, "the real isolated input observer world exists");
      for (const context of worlds) {
        // Runtime.disable removes bindings. Restore the real host binding after the inventory replay.
        await client.send("Runtime.addBinding", {name:context.name.replace("hoaiPersonWorld","hoaiPerson"),executionContextName:context.name});
        await client.send("Runtime.evaluate", {contextId:context.id,
          expression:'Object.defineProperty(performance,"timeOrigin",{value:performance.timeOrigin + 3600000})'});
      }
      await r.page.keyboard.press("ArrowLeft");
      await ordinary(r);
      await r.capture("skew-readable", text(await r.call("browser_snapshot")));
      await r.person('document.querySelector("input").focus()');
      await blind(r);
    });
    check("a stale observer proof cannot release a newer rewritten document", async r => {
      await r.set('<h1>Public</h1>');
      const client = r.page._connection.toImpl(r.page).delegate._mainFrameSession._client;
      const worlds = [];
      const collect = ({context}) => { if (context.name.startsWith("hoaiPersonWorld")) worlds.push(context); };
      client.on("Runtime.executionContextCreated", collect);
      await client.send("Runtime.disable");
      await client.send("Runtime.enable");
      client.removeListener("Runtime.executionContextCreated", collect);
      for (const context of worlds) await client.send("Runtime.addBinding", {
        name:context.name.replace("hoaiPersonWorld","hoaiPerson"),executionContextName:context.name});
      assert.ok(worlds.length);
      await r.page.evaluate(language => {
        document.open();
        document.write(`<html lang="${language}"><h1>Public</h1><input><script>
          for(const type of ['keydown','keypress','keyup','beforeinput','input','paste','drop'])
            window.addEventListener(type,event=>event.stopImmediatePropagation(),true);
        <` + `/script></html>`);
        document.close();
      }, language);
      for (const context of worlds) {
        const stale = await client.send("Runtime.evaluate", {contextId:context.id,returnByValue:true,
          expression:'globalThis[Symbol.for("hoai.personInput")].proved(-1)'});
        assert.equal(stale.result.value, false, "a proof from an older generation cannot clear this document's requirement");
      }
      await r.person('document.querySelector("input").focus()');
      await blind(r);
      await r.page.evaluate(() => document.querySelector("input").value = "");
      await r.handBack();
      await r.person('document.querySelector("input").focus()');
      await blind(r);
    });
    check("a rejected injected-script cache recovers without releasing sealed fields", async r => {
      await r.set('<h1>Public</h1><input aria-label=Reference value=MADEUP-ORDINARY9876>');
      assert.match(text(await r.call("browser_snapshot")), /MADEUP-ORDINARY9876/);
      const utility = await r.page._connection.toImpl(r.page.mainFrame()).utilityContext();
      const poisoned = Promise.reject(new Error("Execution context was destroyed, most likely because of a navigation."));
      poisoned.catch(() => {});
      utility._injectedScriptPromise = poisoned;
      assert.match(text(await r.call("browser_snapshot")), /MADEUP-ORDINARY9876/);
      await r.page.evaluate(() => { const input = document.querySelector("input"); input.type = "password"; input.value = "MADEUP-SECRET9876"; });
      const reply = await r.call("browser_snapshot");
      assert.doesNotMatch(text(reply), /MADEUP/);
      assert.match(text(reply), /Hand back|إعادة التحكم/);
    });
    check("failed native dispatch clears its action token", async r => {
      await r.set('<h1>Public</h1><input aria-label=Reference>');
      const client = r.page._connection.toImpl(r.page).delegate._mainFrameSession._client;
      await assert.rejects(client.send("Input.dispatchKeyEvent", {type:"invalid",key:"A"}));
      await ordinary(r);
      await r.person('document.querySelector("input").focus()');
      await blind(r);
    });
    if (process.env.BROWSER17_LONG_RUN === "1" && language === "en") check("agent session stays readable beyond ten minutes then person text locks", async r => {
      const start = performance.now();
      let iteration = 0;
      while (performance.now() - start < 610000 || iteration < 11) {
        await r.set('<h1>Public</h1><input aria-label=Reference><button>Choice</button>');
        const tree = text(await r.call("browser_snapshot"));
        await r.route("browser_click", {target:ref(tree,"button"),element:"Choice"}, ["allow_once"]);
        await r.route("browser_type", {target:ref(tree,"textbox"),element:"Reference",text:"ATLAS",slowly:true}, ["allow_once"]);
        await r.route("browser_press_key", {key:"Control+h"}, ["allow_once"]);
        await ordinary(r);
        console.log(`${host} uptime ${Math.round(performance.now()-start)} ms, iteration ${++iteration}, readable`);
        if (performance.now()-start < 610000) await new Promise(resolve => setTimeout(resolve, 30000));
      }
      await r.capture("uptime-readable", text(await r.call("browser_snapshot")) + `\n${language === "ar" ? "زمن التشغيل" : "Uptime"}: ${Math.round(performance.now()-start)} ms`);
      await r.person('document.querySelector("input").focus()');
      await blind(r);
    }, 700000);
  }
};
