/**
 * Spectrum / Photon iMessage — Integration Test
 *
 * Tests sending AND receiving messages through Spectrum Cloud's
 * managed iMessage infrastructure. Uses `spectrum-ts` directly.
 *
 * No Full Disk Access needed — Spectrum Cloud handles the iMessage relay.
 *
 * Requirements:
 *   - SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET in .env
 *   - An active Spectrum Cloud subscription (photon.codes)
 *   - The target phone number must be an allowed destination for your project
 *
 * Usage:
 *   bun test src/messaging/spectrum.test.ts
 *
 * To target a different number:
 *   PHOTON_TEST_TO="+14155551234" bun test src/messaging/spectrum.test.ts
 *
 * For the receive test, manually send a message from your phone to the
 * Spectrum Cloud iMessage number within the timeout window.
 */
import { describe, it, expect, beforeAll, afterAll, test } from "bun:test";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const TARGET = process.env["PHOTON_TEST_TO"] ?? "+14156067858";
const RECEIVE_TIMEOUT_MS = Number(process.env["PHOTON_RECEIVE_TIMEOUT_MS"] ?? 10_000);

const projectId = process.env["SPECTRUM_PROJECT_ID"];
const projectSecret = process.env["SPECTRUM_PROJECT_SECRET"];

let app: Awaited<ReturnType<typeof Spectrum>> | undefined;
let ready = false;

// ── Lifecycle ───────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!projectId || !projectSecret) {
    console.log(
      "  ⏭️  SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET not set in .env.\n" +
      "     Set them to your Spectrum Cloud project credentials to run this test.",
    );
    return;
  }

  try {
    app = await Spectrum({
      projectId,
      projectSecret,
      providers: [imessage.config()],
    });
    ready = true;
    console.log("  ✅ Spectrum connected via Spectrum Cloud");
  } catch (err) {
    console.log("  ⏭️  Spectrum init failed:", (err as Error).message);
  }
});

afterAll(async () => {
  if (app) {
    await app.stop();
    console.log("  ✅ Spectrum stopped");
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────

/** Check if an error is a Spectrum permission-denied for an unapproved target. */
function isTargetNotAllowed(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return msg.includes("Target not allowed") || msg.includes("PERMISSION_DENIED");
}

/**
 * Wait for the first inbound message from a specific phone number.
 * Returns the [space, message] tuple, or undefined on timeout.
 */
async function waitForMessage(
  im: ReturnType<typeof imessage>,
  fromPhone: string,
  timeoutMs: number,
): Promise<[unknown, unknown] | undefined> {
  const iter = im.messages[Symbol.asyncIterator]();

  const timer = new Promise<undefined>((resolve) =>
    setTimeout(() => resolve(undefined), timeoutMs),
  );

  const result = await Promise.race([
    (async () => {
      for (;;) {
        const next = await iter.next();
        if (next.done) return undefined;
        const [space, message] = next.value;

        // Wait for inbound messages from our target phone
        if ((message as { direction?: string }).direction === "inbound") {
          const sender = (message as { sender?: { id?: string } }).sender;
          if (sender?.id && sender.id.includes(fromPhone.replace(/[^0-9]/g, ""))) {
            return next.value as [unknown, unknown];
          }
        }
      }
    })(),
    timer,
  ]);

  // Ensure we clean up the iterator
  if (result === undefined) {
    iter.return?.();
  }

  return result;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("Spectrum — iMessage via Spectrum Cloud", () => {
  it("resolves a user by phone number", async () => {
    if (!ready) return;

    const im = imessage(app!);
    const user = await im.user(TARGET);

    expect(user).toHaveProperty("id");
    expect(user).toHaveProperty("__platform", "iMessage");
    console.log(`  👤 User resolved: ${user.id}`);
  });

  it("creates a conversation space for a phone number", async () => {
    if (!ready) return;

    const im = imessage(app!);
    const space = await im.space(TARGET, { phone: TARGET });

    expect(space).toHaveProperty("id");
    expect(space).toHaveProperty("send");
    expect(space).toHaveProperty("__platform", "iMessage");
    console.log(`  💬 Space created: ${space.id}`);
  });

  it(`sends "hi" to ${TARGET}`, async () => {
    if (!ready) return;

    const im = imessage(app!);
    const space = await im.space(TARGET, { phone: TARGET });

    try {
      const sent = await space.send("hi");

      expect(sent).toBeDefined();
      expect(sent).toHaveProperty("id");
      expect(sent!.direction).toBe("outbound");
      console.log(`  ✅ Message sent: id=${sent!.id}`);
    } catch (err) {
      if (isTargetNotAllowed(err)) {
        console.log(
          `  ⏭️  Target ${TARGET} is not allowed for this Spectrum Cloud project.\n` +
          "     Add it in the Spectrum Cloud dashboard (app.photon.codes) to enable sending.",
        );
      } else {
        throw err;
      }
    }
  });

  test(
    `receives a message from ${TARGET}`,
    async () => {
      if (!ready) return;

      const im = imessage(app!);

      console.log(
        `\n  📱 Send a message from your phone (${TARGET}) to the Spectrum Cloud\n` +
        `     iMessage number now. Listening for up to ${RECEIVE_TIMEOUT_MS / 1000}s…\n`,
      );

      const result = await waitForMessage(im, TARGET, RECEIVE_TIMEOUT_MS);

      if (!result) {
        console.log(
          `  ⚠️  No message received from ${TARGET} within ${RECEIVE_TIMEOUT_MS / 1000}s.\n` +
          "     Send a message from your phone to the Spectrum Cloud iMessage number and re-run.",
        );
        return;
      }

      const [space, message] = result;
      const msg = message as {
        content: { type: string; text?: string };
        direction: string;
        sender: { id: string };
      };

      expect(space).toBeDefined();
      expect(msg.direction).toBe("inbound");
      expect(msg.sender.id).toBeDefined();

      console.log(`  📨 Received: "${msg.content.text ?? "(non-text)"}" (first message)`);
      console.log(`  👤 From: ${msg.sender.id}`);

      // Reply to confirm the full send/receive loop works
      const reply = await (message as { reply: (s: string) => Promise<unknown> }).reply(
        "got it! 🤖",
      );
      expect(reply).toBeDefined();
      console.log("  ✅ Replied to confirm receipt");
    },
    // Give the test enough time for the timeout + the listen loop
    { timeout: RECEIVE_TIMEOUT_MS + 10_000 },
  );
});
