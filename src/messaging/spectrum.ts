/**
 * Spectrum — Unified Messaging SDK Integration
 *
 * Spectrum lets you write agent logic once and deliver it across every
 * messaging platform: iMessage, WhatsApp, terminal, or custom providers.
 *
 * Docs: https://docs.photon.codes
 * SDK: https://www.npmjs.com/package/spectrum-ts
 */
import { config } from "../config/env.ts";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import type { Message } from "../types/index.ts";

/**
 * A callback that receives each incoming message and returns a reply.
 */
export type MessageHandler = (msg: Message) => Promise<string | undefined>;

/**
 * Extract plain text from Spectrum's discriminated-union `Content` type.
 */
function getText(content: { type: string; text?: string }): string {
  if (content.type === "text" && content.text) {
    return content.text;
  }
  return String(content);
}

export class MessagingService {
  private app: Awaited<ReturnType<typeof Spectrum>> | null = null;

  /**
   * Initialise Spectrum with configured providers.
   */
  async init(): Promise<void> {
    this.app = await Spectrum({
      projectId: config.spectrum.projectId,
      projectSecret: config.spectrum.projectSecret,
      providers: [
        imessage.config(),
        terminal.config(),
        // Add WhatsApp: import { whatsapp } from "spectrum-ts/providers/whatsapp"
      ],
    });

    console.log("[Spectrum] Connected — listening on iMessage and terminal");
  }

  /**
   * Start listening for messages and dispatch them to the handler.
   */
  async listen(handler: MessageHandler): Promise<void> {
    if (!this.app) {
      throw new Error("MessagingService not initialised. Call .init() first.");
    }

    for await (const [space, message] of this.app.messages) {
      // Spawn a response context for this conversation space
      space.responding(async () => {
        const incoming: Message = {
          role: "user",
          content: getText(message.content),
          user_id: message.sender?.id,
          conv_id: space.id,
        };

        const reply = await handler(incoming);
        if (reply) {
          await message.reply(reply);
        }
      });
    }
  }

  /**
   * Gracefully shut down the messaging service.
   */
  async shutdown(): Promise<void> {
    // Spectrum handles cleanup on process exit
    this.app = null;
  }
}
